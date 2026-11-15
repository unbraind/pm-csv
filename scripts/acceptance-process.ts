import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

/** One stalled install/CLI operation gets five minutes; a whole acceptance run gets six such budgets. */
export const ACCEPTANCE_CHILD_BUDGET_MS = 5 * 60_000;
/** Bound the entire finite scenario matrix as well as each individual operation. */
export const ACCEPTANCE_TOTAL_BUDGET_MS = 6 * ACCEPTANCE_CHILD_BUDGET_MS;
/** Let a timed-out acceptance parent forward termination to its detached active operation. */
export const ACCEPTANCE_CLEANUP_GRACE_MS = 1_000;

/** Scale watchdog budgets for slower hardware; invalid values fail instead of disabling deadlines. */
export function scaledBudget(milliseconds: number, scale = process.env.PM_TEST_TIME_SCALE): number {
  const factor = scale === undefined ? 1 : Number(scale);
  const budget = Math.ceil(milliseconds * factor);
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isSafeInteger(budget) || budget < 1 || budget > 2_147_483_647) {
    throw new Error("PM_TEST_TIME_SCALE must produce a positive finite timer budget (at most 2147483647 ms)");
  }
  return budget;
}

/** Captured command outcome; callers retain their own expected-exit-status assertions. */
export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** An explicit command deadline and optional grace period for a nested acceptance supervisor. */
interface CommandOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly terminationGraceMs?: number;
}

/** Platform facts are injected so launcher selection can be tested without Windows. */
interface CommandHost {
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly npmExecPath?: string;
  readonly exists: (path: string) => boolean;
}

/** Exact spawn arguments; the shell fallback is restricted to quoted, non-interpolating values. */
interface CommandSelection {
  readonly command: string;
  readonly args: string[];
  readonly shell: boolean;
}

/** Prefer npm/npx JavaScript entries on Windows; preserve direct spawning on other platforms. */
export function selectCommand(command: string, args: string[], host: CommandHost): CommandSelection {
  const name = win32.basename(command).match(/^(npm|npx)(?:\.cmd|\.bat)?$/i)?.[1].toLowerCase();
  if (host.platform !== "win32" || name === undefined) return { command, args, shell: false };
  const entries = [
    ...(host.npmExecPath && /\.[cm]?js$/i.test(host.npmExecPath)
      ? [name === "npm" ? host.npmExecPath : win32.join(win32.dirname(host.npmExecPath), "npx-cli.js")] : []),
    win32.join(win32.dirname(host.execPath), "node_modules", "npm", "bin", `${name}-cli.js`),
  ];
  const entry = entries.find(host.exists);
  if (entry !== undefined) return { command: host.execPath, args: [entry, ...args], shell: false };

  // Only our fixed npm/npx invocation may use cmd.exe. Reject expansion/control
  // characters instead of attempting to make arbitrary input safe for a shell.
  const quoted = [command, ...args].map(value => {
    if (/["%!^&|<>\r\n]/.test(value)) throw new Error("Unsafe Windows npm shell fallback argument");
    return `"${value.replace(/(\\+)$/g, "$1$1")}"`;
  });
  return { command: quoted[0], args: quoted.slice(1), shell: true };
}

/** Classify taskkill failures without hiding real cleanup errors behind a timeout. */
export function taskkillError(result: { readonly error?: Error; readonly status: number | null; readonly stderr: string | null }): Error | undefined {
  if (result.error) return result.error;
  if (result.status === 0) return undefined;
  const stderr = (result.stderr ?? "").trim();
  // A root that exited between the deadline and taskkill needs no second kill;
  // retain the original timeout. Other statuses/messages must expose failed cleanup.
  if (result.status === 128 && /not found|not exist|no running instance/i.test(stderr)) return undefined;
  return new Error(`taskkill failed with status ${String(result.status)}: ${stderr}`);
}

/**
 * Capture a command with a bounded output buffer and a deadline that kills its process tree.
 * POSIX children own a process group, including npm/Bun grandchildren; Windows uses taskkill /T.
 * A nested supervisor may get SIGTERM first so it can kill its own detached operation before
 * the final group SIGKILL. External termination is forwarded to the active operation too.
 */
export function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const selected = selectCommand(command, args, {
      platform: process.platform, execPath: process.execPath,
      npmExecPath: (options.env ?? process.env).npm_execpath, exists: existsSync,
    });
    const child = spawn(selected.command, selected.args, {
      cwd: options.cwd, env: options.env, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: selected.shell,
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(expire, options.timeoutMs);

    /** Stop every member of the command's group, even if its immediate parent has exited. */
    function killTree(): void {
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, timeout: 10_000, encoding: "utf8" });
        const error = taskkillError(result);
        if (error) throw error;
      } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }

    /** Settle once and release pipes/listeners so inherited descriptors cannot keep a timeout pending. */
    function finish(error?: Error, status: number | null = null): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      process.removeListener("SIGTERM", terminate);
      process.removeListener("SIGINT", interrupt);
      child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error);
      else resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    }

    /** Kill before rejecting; timeout diagnostics name the operation and measured elapsed time. */
    function hardExpire(): void {
      try { killTree(); }
      catch (error) { finish(error as Error); return; }
      finish(new Error(`${command} ${args.join(" ")} timed out after ${Math.round(performance.now() - started)} ms (budget ${options.timeoutMs} ms)`));
    }

    /** Give only nested supervisors a short chance to forward termination across process groups. */
    function expire(afterGrace = hardExpire): void {
      if (options.terminationGraceMs && process.platform !== "win32" && child.pid !== undefined) {
        // Keep the timeout error even if the supervisor exits during the cleanup grace.
        child.removeAllListeners("close");
        try { process.kill(-child.pid, "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") { finish(error as Error); return; } }
        escalation = setTimeout(afterGrace, options.terminationGraceMs);
      } else afterGrace();
    }

    /** Share deadline escalation so a nested supervisor can forward cancellation before exiting. */
    function cancel(exitCode: number): void {
      clearTimeout(deadline);
      expire(() => {
        try { killTree(); }
        catch (error) { console.error(error); process.exit(1); }
        process.exit(exitCode);
      });
    }
    /** Preserve the conventional signal exit code after descendant cleanup completes. */
    function terminate(): void { cancel(143); }
    /** Interactive cancellation uses the same bounded cleanup as external termination. */
    function interrupt(): void { cancel(130); }
    process.once("SIGTERM", terminate);
    process.once("SIGINT", interrupt);

    /** Refuse unlimited diagnostics from a misbehaving child. */
    function capture(chunk: Buffer, target: Buffer[]): void {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        killTree(); finish(new Error(`${command} exceeded the 64 MiB acceptance output budget`));
      } else target.push(chunk);
    }
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, stdout));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, stderr));
    child.once("error", finish);
    child.once("close", status => finish(undefined, status));
  });
}

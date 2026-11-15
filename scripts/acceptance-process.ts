import { spawn, spawnSync } from "node:child_process";

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

/**
 * Capture a command with a bounded output buffer and a deadline that kills its process tree.
 * POSIX children own a process group, including npm/Bun grandchildren; Windows uses taskkill /T.
 * A nested supervisor may get SIGTERM first so it can kill its own detached operation before
 * the final group SIGKILL. External termination is forwarded to the active operation too.
 */
export function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
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
        const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, timeout: 10_000 });
        if (result.error) throw result.error;
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
    function expire(): void {
      if (options.terminationGraceMs && process.platform !== "win32" && child.pid !== undefined) {
        // Keep the timeout error even if the supervisor exits during the cleanup grace.
        child.removeAllListeners("close");
        try { process.kill(-child.pid, "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") { finish(error as Error); return; } }
        escalation = setTimeout(hardExpire, options.terminationGraceMs);
      } else hardExpire();
    }

    /** Forward an outer supervisor's termination before restoring normal signal termination. */
    function terminate(): void { killTree(); process.exit(143); }
    /** Forward interactive cancellation so local acceptance leaves no install processes behind. */
    function interrupt(): void { killTree(); process.exit(130); }
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

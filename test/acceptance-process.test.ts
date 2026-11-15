import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  runCommand, selectCommand, taskkillError, scaledBudget, ACCEPTANCE_CHILD_BUDGET_MS, ACCEPTANCE_TOTAL_BUDGET_MS, ACCEPTANCE_CLEANUP_GRACE_MS,
} from "../scripts/acceptance-process.ts";

const cwd = resolve(import.meta.dirname, "..");

/** A killed orphan can briefly remain a zombie; it cannot execute or hold pipes open. */
function running(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  if (process.platform === "linux") {
    try { return !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  if (process.platform === "darwin") return !spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().startsWith("Z");
  return true;
}

/** Observe every descendant twice after scheduling a turn; transient procfs absence is not a stable exit receipt. */
async function assertProcessesStopped(pids: number[], inspect = running): Promise<void> {
  let stopped = 0;
  let states: boolean[] = [];
  for (let attempt = 0; attempt < scaledBudget(5_000) / 10; attempt++) {
    states = pids.map(pid => inspect(pid));
    stopped = states.some(Boolean) ? 0 : stopped + 1;
    if (stopped === 2) return;
    await delay(10);
  }
  assert.ok(!states[0], "stalled child must be dead");
  assert.ok(!states[1], "sleeping grandchild must be dead");
  assert.fail("descendant exit observations must settle before cleanup");
}

/** Clean up even when deliberately reverting group termination to prove the regression. */
function cleanup(pid: number): void {
  try { process.kill(pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

test("acceptance watchdog budgets default to one, scale together, and reject invalid factors", () => {
  const original = process.env.PM_TEST_TIME_SCALE;
  delete process.env.PM_TEST_TIME_SCALE;
  try { assert.equal(scaledBudget(ACCEPTANCE_CHILD_BUDGET_MS), ACCEPTANCE_CHILD_BUDGET_MS); }
  finally {
    if (original === undefined) delete process.env.PM_TEST_TIME_SCALE;
    else process.env.PM_TEST_TIME_SCALE = original;
  }
  assert.equal(scaledBudget(ACCEPTANCE_CHILD_BUDGET_MS, "3"), 3 * ACCEPTANCE_CHILD_BUDGET_MS);
  assert.equal(scaledBudget(ACCEPTANCE_TOTAL_BUDGET_MS, "3"), 3 * ACCEPTANCE_TOTAL_BUDGET_MS);
  for (const scale of ["", "0", "-1", "NaN", "Infinity", "10000000"]) {
    assert.throws(() => scaledBudget(ACCEPTANCE_CHILD_BUDGET_MS, scale), /PM_TEST_TIME_SCALE/);
  }
});

test("acceptance runner captures output and status and reports spawn failures", async () => {
  assert.deepEqual(await runCommand(process.execPath, ["-e", "console.log('out'); console.error('err'); process.exit(7)"], {
    cwd, timeoutMs: scaledBudget(10_000),
  }), { status: 7, stdout: "out\n", stderr: "err\n" });
  await assert.rejects(runCommand(join(cwd, "missing-acceptance-executable"), [], {
    cwd, timeoutMs: scaledBudget(10_000),
  }), /ENOENT/);
});

for (const nested of [false, true]) test(`acceptance ${nested ? "outer" : "child"} deadline kills a sleeping child and its grandchild`, {
  timeout: scaledBudget(60_000),
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "acceptance-process-tree-"));
  const pidsFile = join(root, "pids.json");
  let pids: number[] = [];
  const budget = scaledBudget(10_000);
  const started = performance.now();
  const args = ["test/fixtures/sleeping-process-tree.mjs", ...(nested ? ["supervisor"] : []), pidsFile];
  try {
    await assert.rejects(runCommand(process.execPath, args, {
      cwd, timeoutMs: budget, terminationGraceMs: nested ? ACCEPTANCE_CLEANUP_GRACE_MS : 0,
    }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /sleeping-process-tree\.mjs.*timed out after \d+ ms/);
      assert.ok(error.message.includes(`budget ${budget} ms`));
      return true;
    });
    assert.ok(performance.now() - started < budget + scaledBudget(5_000), "deadline must settle promptly, even with inherited pipes");
    pids = JSON.parse(readFileSync(pidsFile, "utf8")) as number[];
    assert.equal(pids.length, 2);
    await assertProcessesStopped(pids);
  } finally {
    if (pids.length === 0) {
      try { pids = JSON.parse(readFileSync(pidsFile, "utf8")) as number[]; } catch { /* Fixture may not have started. */ }
    }
    for (const pid of pids) cleanup(pid);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows npm command selection prefers JavaScript entries and preserves direct Linux spawning", () => {
  const execPath = "C:\\Program Files\\nodejs\\node.exe";
  const npmEntry = "C:\\sandbox\\npm\\bin\\npm-cli.js";
  const npxEntry = "C:\\sandbox\\npm\\bin\\npx-cli.js";
  const bundled = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const bundledNpx = bundled.replace("npm-cli.js", "npx-cli.js");
  const entries = new Set([npmEntry, npxEntry, bundled, bundledNpx]);
  const host = { platform: "win32" as const, execPath, npmExecPath: npmEntry, exists: (path: string) => entries.has(path) };
  const args = ["install", "--ignore-scripts", "package@1.0.0"];
  assert.deepEqual(selectCommand("npm.cmd", args, host), { command: execPath, args: [npmEntry, ...args], shell: false });
  assert.deepEqual(selectCommand("npx.cmd", args, host), { command: execPath, args: [npxEntry, ...args], shell: false });
  for (const npmExecPath of [undefined, "missing.js", "C:\\tools\\bun.exe"]) {
    assert.deepEqual(selectCommand("npm.cmd", args, { ...host, npmExecPath }), { command: execPath, args: [bundled, ...args], shell: false });
    assert.deepEqual(selectCommand("npx.cmd", args, { ...host, npmExecPath }), { command: execPath, args: [bundledNpx, ...args], shell: false });
  }
  assert.deepEqual(selectCommand("npm", args, { ...host, platform: "linux" }), { command: "npm", args, shell: false });
  assert.deepEqual(selectCommand("npm.cmd", args, { ...host, platform: "linux" }), { command: "npm.cmd", args, shell: false });
  assert.deepEqual(selectCommand("bun.exe", args, host), { command: "bun.exe", args, shell: false });
});

test("Windows npm shell fallback quotes fixed arguments and refuses shell expansion", () => {
  const host = { platform: "win32" as const, execPath: "C:\\node\\node.exe", exists: () => false };
  assert.deepEqual(selectCommand("npm.cmd", ["pack", "--pack-destination", "C:\\fixture space"], host), {
    command: '"npm.cmd"', args: ['"pack"', '"--pack-destination"', '"C:\\fixture space"'], shell: true,
  });
  for (const unsafe of ['x"y', "%TEMP%", "!value!", "x&echo", "x|echo", "x>file", "x<file", "x^y", "x\nexit"]) {
    assert.throws(() => selectCommand("npm.cmd", [unsafe], host), /Unsafe Windows npm shell fallback/);
  }
});

test("taskkill outcome classification preserves root-exited timeouts and surfaces cleanup failures", () => {
  assert.equal(taskkillError({ status: 0, stderr: "" }), undefined);
  const spawnError = new Error("could not start taskkill");
  assert.equal(taskkillError({ error: spawnError, status: null, stderr: null }), spawnError);
  assert.equal(taskkillError({ status: 128, stderr: 'ERROR: The process "123" not found.' }), undefined);
  assert.equal(taskkillError({ status: 128, stderr: 'ERROR: No running instance of the task.' }), undefined);
  for (const status of [1, 5, 128, null]) {
    const error = taskkillError({ status, stderr: "ERROR: Access is denied." });
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(`status ${String(status)}`));
    assert.match(error.message, /Access is denied/);
  }
  assert.match(taskkillError({ status: 1, stderr: "process not found" })?.message ?? "", /status 1/);
});

// Cross-process POSIX signal delivery is not exposed by Node on Windows.
for (const signal of ["SIGTERM", "SIGINT"] as const) test(`external ${signal} cancels a nested runner and both fixture descendants`, {
  skip: process.platform === "win32", timeout: scaledBudget(60_000),
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "acceptance-cancellation-"));
  const pidsFile = join(root, "pids.json");
  const outer = spawn(process.execPath, ["test/fixtures/sleeping-process-tree.mjs", "outer", pidsFile], {
    cwd, detached: true, stdio: "ignore",
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    outer.once("error", reject);
    outer.once("close", code => resolve(code));
  });
  let pids: number[] = [];
  try {
    for (let attempt = 0; attempt < scaledBudget(20_000) / 25 && !existsSync(pidsFile); attempt++) await delay(25);
    assert.ok(existsSync(pidsFile), "nested descendants must become ready within the startup watchdog");
    pids = JSON.parse(readFileSync(pidsFile, "utf8")) as number[];
    assert.equal(pids.length, 2, "nested child and grandchild must start before cancellation");
    assert.ok(outer.kill(signal));
    const code = await Promise.race([closed, delay(scaledBudget(10_000), undefined, { ref: false }).then(() => {
      throw new Error("outer cancellation did not finish within its bounded cleanup");
    })]);
    assert.equal(code, signal === "SIGTERM" ? 143 : 130);
    await assertProcessesStopped(pids);
  } finally {
    if (existsSync(pidsFile)) pids = JSON.parse(readFileSync(pidsFile, "utf8")) as number[];
    const supervisor = `${pidsFile}.supervisor`;
    if (existsSync(supervisor)) pids.push(Number(readFileSync(supervisor, "utf8")));
    if (outer.pid !== undefined) pids.push(outer.pid);
    for (const pid of pids) cleanup(pid);
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});


test("descendant cleanup requires stable observations and checks both processes on every turn", async () => {
  const visits: number[] = [];
  const snapshots = [[false, false], [false, true], [false, false], [false, false]];
  await assertProcessesStopped([101, 102], pid => {
    visits.push(pid);
    return snapshots[Math.floor((visits.length - 1) / 2)][pid - 101];
  });
  assert.deepEqual(visits, [101, 102, 101, 102, 101, 102, 101, 102]);
});

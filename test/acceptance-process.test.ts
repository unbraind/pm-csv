import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  runCommand, scaledBudget, ACCEPTANCE_CHILD_BUDGET_MS, ACCEPTANCE_TOTAL_BUDGET_MS, ACCEPTANCE_CLEANUP_GRACE_MS,
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
  timeout: scaledBudget(15_000),
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "acceptance-process-tree-"));
  const pidsFile = join(root, "pids.json");
  let pids: number[] = [];
  const budget = scaledBudget(3_000);
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
    // The kernel may not yet have scheduled both exits when kill(2) returns.
    for (let attempt = 0; attempt < 50 && pids.some(running); attempt++) await delay(10);
    assert.ok(!running(pids[0]), "stalled child must be dead");
    assert.ok(!running(pids[1]), "sleeping grandchild must be dead");
  } finally {
    if (pids.length === 0) {
      try { pids = JSON.parse(readFileSync(pidsFile, "utf8")) as number[]; } catch { /* Fixture may not have started. */ }
    }
    for (const pid of pids) cleanup(pid);
    rmSync(root, { recursive: true, force: true });
  }
});

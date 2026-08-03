import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

import extension, { atomicTransactionId } from "../index.ts";

// ---------------------------------------------------------------------------
// Integration tests for the `--atomic` CSV import path (pm-cli >= 2026.7.19
// commitWorkspaceTransaction). These exercise the real `pm` CLI against an
// isolated temp tracker, mirroring how the command is invoked at runtime:
// they capture the registered command's `run` handler via a mock extension
// api and call it with a constructed CommandHandlerContext.
//
// Each test uses a fresh temp tracker (`pm init --defaults`) so nothing ever
// touches the repo's own `.agents`. `pm` must be on PATH (it is in CI and dev).
// ---------------------------------------------------------------------------

/** Shape of the command context the `csv import` run() handler consumes. */
interface RunCtx {
  pm_root: string;
  args: string[];
  options: Record<string, unknown>;
  global?: { author?: string };
  sdk?: { commitWorkspaceTransaction?: unknown };
}

/** Activate the extension against a mock api, returning the registered commands. */
function captureCommands(): any[] {
  const commands: any[] = [];
  const noop = () => {};
  const api = {
    registerCommand: (def: any) => commands.push(def),
    registerParser: noop,
    registerPreflight: noop,
    registerService: noop,
    registerFlags: noop,
    registerItemFields: noop,
    registerItemTypes: noop,
    registerMigration: noop,
    registerRenderer: noop,
    registerImporter: noop,
    registerExporter: noop,
    registerSearchProvider: noop,
    registerVectorStoreAdapter: noop,
    hooks: {
      beforeCommand: noop,
      afterCommand: noop,
      onWrite: noop,
      onRead: noop,
      onIndex: noop,
    },
  };
  extension.activate(api as any);
  return commands;
}

/** Create a fresh isolated pm tracker root and return its path. */
function freshTracker(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-csv-atomic-"));
  const r = spawnSync("pm", ["init", "--defaults", "--path", root], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`pm init failed: ${r.stderr || r.stdout}`);
  }
  return root;
}

/** List all items in a tracker as JSON. */
function listItems(pmRoot: string): any[] {
  const r = spawnSync("pm", ["--path", pmRoot, "list-all", "--json"], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`pm list-all failed: ${r.stderr}`);
  return (JSON.parse(r.stdout).items ?? []) as any[];
}

/** Run the `csv import` command handler and return { result?, error? }. */
async function runImport(
  pmRoot: string,
  file: string,
  options: Record<string, unknown>,
): Promise<{ result?: any; error?: Error }> {
  const commands = captureCommands();
  const cmd = commands.find((c) => c.name === "csv import");
  assert.ok(cmd, "csv import command should be registered");
  const ctx: RunCtx = {
    pm_root: pmRoot,
    args: [file],
    options,
    global: { author: "pi-agent" },
  };
  try {
    const result = await cmd.run(ctx);
    return { result };
  } catch (err) {
    return { error: err as Error };
  }
}

/** Resolve the absolute path of the real `pm` executable (before any PATH mutation). */
function realPmPath(): string {
  const r = spawnSync("sh", ["-c", "command -v pm"], { encoding: "utf-8" });
  const p = r.stdout.trim();
  if (!p) throw new Error("could not resolve real pm on PATH for fake-pm wrapper");
  return p;
}

/**
 * Install a transparent `pm` wrapper as the FIRST entry on PATH. It delegates
 * every invocation to the real `pm` EXCEPT for two opt-in, tracker-scoped
 * intercepts used only by the close-failure regression tests below. The wrapper
 * reads the target tracker root from --path/--pm-path and only acts when a
 * marker file is present in THAT root, so concurrent test files (whose trackers
 * never carry a marker) are unaffected even while PATH is temporarily mutated.
 *
 *   - `<root>/fake-create-no-id`: `pm create --json` exits 0 with `{}` (valid
 *     JSON, no id) to simulate "create succeeded but the id could not be
 *     recovered". No real item is created.
 *   - `<root>/fake-close-fail`: every `pm close ...` exits 1 with a simulated
 *     error, to exercise the close-failure / compensation paths.
 *
 * Returns a cleanup function that restores PATH/PM_CSV_REAL_PM and removes the
 * wrapper bin.
 */
function installFakePm(): () => void {
  const bin = mkdtempSync(join(tmpdir(), "pm-csv-fakepm-"));
  // No template literals / ${} in the wrapper source on purpose, so it embeds
  // cleanly in this template literal without escaping.
  const wrapper = [
    "#!/usr/bin/env node",
    "const { spawnSync } = require('child_process');",
    "const { existsSync } = require('fs');",
    "const args = process.argv.slice(2);",
    "let root = '';",
    "for (let i = 0; i < args.length; i++) {",
    "  if (args[i] === '--path' || args[i] === '--pm-path') root = args[i + 1] || '';",
    "}",
    "function has(s) { return args.indexOf(s) !== -1; }",
    "if (root && existsSync(root + '/fake-create-no-id') && has('create') && has('--json')) {",
    "  process.stdout.write('{}\\n');",
    "  process.exit(0);",
    "}",
    "if (root && existsSync(root + '/fake-close-fail') && has('close')) {",
    "  process.stderr.write('simulated pm close failure (test)\\n');",
    "  process.exit(1);",
    "}",
    // Makes the status LOOKUP itself fail, so itemStatus() returns undefined.
    // An unknown status must never be read as proof that compensation worked.
    "if (root && existsSync(root + '/fake-get-fail') && has('get')) {",
    "  process.stderr.write('simulated pm get failure (test)\\n');",
    "  process.exit(1);",
    "}",
    "const realPm = process.env.PM_CSV_REAL_PM;",
    "const r = spawnSync(realPm, args, { stdio: 'inherit' });",
    "process.exit(r.status == null ? 1 : r.status);",
    "",
  ].join("\n");
  const wrapperPath = join(bin, "pm");
  writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  chmodSync(wrapperPath, 0o755);
  const origPath = process.env.PATH;
  const origRealPm = process.env.PM_CSV_REAL_PM;
  process.env.PM_CSV_REAL_PM = realPmPath();
  process.env.PATH = `${bin}${delimiter}${origPath ?? ""}`;
  return () => {
    process.env.PATH = origPath;
    if (origRealPm === undefined) delete process.env.PM_CSV_REAL_PM;
    else process.env.PM_CSV_REAL_PM = origRealPm;
    rmSync(bin, { recursive: true, force: true });
  };
}

/** Toggle strict closure-validation on a tracker so `pm close --reason` fails. */
function enableStrictCloseValidation(pmRoot: string): void {
  const r = spawnSync(
    "pm",
    ["--path", pmRoot, "config", "project", "set", "governance-close-validation-default", "strict"],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`pm config set strict failed: ${r.stderr || r.stdout}`);
}

// ---------------------------------------------------------------------------

test("csv import declares --atomic flag", () => {
  const commands = captureCommands();
  const importCmd = commands.find((c) => c.name === "csv import");
  assert.ok(importCmd, "csv import command should be registered");
  const longs = (importCmd.flags ?? []).map((f: any) => f.long);
  assert.ok(longs.includes("--atomic"), "csv import should expose --atomic");
});

test("--atomic happy path: N valid rows create N items with correct ImportResult", async () => {
  const root = freshTracker();
  const file = join(root, "good.csv");
  writeFileSync(file, "title,status,priority\nAtomic A,open,2\nAtomic B,open,3\nAtomic C,open,1\n");
  try {
    const { result, error } = await runImport(root, file, { atomic: true });
    assert.ifError(error);
    assert.deepEqual(
      { imported: result.imported, updated: result.updated, skipped: result.skipped },
      { imported: 3, updated: 0, skipped: 0 },
    );
    const items = listItems(root);
    assert.equal(items.length, 3, "exactly 3 items should exist");
    assert.ok(items.every((i) => i.status === "open"), "all created items should be open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--atomic mid-import failure: ZERO uncompensated items remain (all compensated)", async () => {
  const root = freshTracker();
  const file = join(root, "mixed.csv");
  // Row 3 has priority 99 which passes the importer's parseInt parse but is
  // rejected by `pm create` (out of 0..4 range), so apply() throws mid-import.
  writeFileSync(
    file,
    "title,status,priority\nGood Row 1,open,2\nGood Row 2,open,3\nBad Row,open,99\nGood Row 3,open,1\n",
  );
  try {
    const { result, error } = await runImport(root, file, { atomic: true });
    // Atomic failure surfaces as a non-zero exit (CommandError), no result.
    assert.ok(error, "atomic import with a failing row should error");
    assert.equal((error as any).exitCode, 1, "exit code should be 1");
    assert.match(
      error!.message,
      /rolled back/i,
      "error should clearly state the import was rolled back",
    );

    const items = listItems(root);
    // Every item created by the transaction before the failure must be
    // compensated (closed). No committed (open) items from this import remain.
    const open = items.filter((i) => i.status !== "closed");
    assert.equal(open.length, 0, "zero uncompensated (non-closed) items should remain");
    // The bad row was never created; the good rows before it were compensated.
    const compensated = items.filter((i) => i.status === "closed");
    assert.ok(compensated.length >= 2, "at least the two pre-failure rows are compensated");
    assert.ok(
      !items.some((i) => i.title === "Bad Row"),
      "the failing row was never committed",
    );
    // No Good Row 3 (after the failure) was created either.
    assert.ok(!items.some((i) => i.title === "Good Row 3"), "rows after the failure were not created");
    // Compensation STRIPS the tx markers, so a same-content retry after a
    // transient failure re-imports rather than treating these tombstones as
    // already-applied. No compensated item retains a csv-tx/csv-txrow marker.
    assert.ok(
      !items.some((i) => (i.tags ?? []).some((t: string) => t.startsWith("csv-tx"))),
      "compensated items have their transaction markers stripped",
    );
    void result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default (non-atomic) path unchanged: same failing input leaves earlier rows present", async () => {
  const root = freshTracker();
  const file = join(root, "mixed.csv");
  writeFileSync(
    file,
    "title,status,priority\nGood Row 1,open,2\nGood Row 2,open,3\nBad Row,open,99\nGood Row 3,open,1\n",
  );
  try {
    const { result, error } = await runImport(root, file, {});
    // Non-atomic does NOT abort the whole import; it logs the row error and
    // continues, so no CommandError is thrown — it returns a result.
    assert.ifError(error);
    // 3 good rows created (the bad row is skipped); the import continues past
    // the failure, leaving earlier AND later good rows present and open.
    assert.equal(result.imported, 3, "non-atomic continues past the failure");
    assert.equal(result.skipped, 1, "the bad row is counted as skipped");

    const items = listItems(root);
    const open = items.filter((i) => i.status !== "closed");
    // All three good rows remain OPEN (none compensated) — the documented
    // difference from --atomic, which would have rolled them back.
    assert.equal(open.length, 3, "earlier rows remain present and open without --atomic");
    assert.ok(
      items.some((i) => i.title === "Good Row 1" && i.status === "open"),
      "Good Row 1 remains open",
    );
    assert.ok(
      items.some((i) => i.title === "Good Row 3" && i.status === "open"),
      "Good Row 3 (after the failure) also remains open",
    );
    assert.ok(!items.some((i) => i.title === "Bad Row"), "the bad row was never created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--atomic resumability: re-running the same import does not duplicate (inspect skips applied rows)", async () => {
  const root = freshTracker();
  const file = join(root, "good4.csv");
  writeFileSync(
    file,
    "title,status,priority\nResume 1,open,2\nResume 2,open,3\nResume 3,open,1\nResume 4,open,2\n",
  );
  try {
    // First run: all 4 created.
    const first = await runImport(root, file, { atomic: true });
    assert.ifError(first.error);
    assert.equal(first.result.imported, 4, "first run creates 4");
    assert.equal(listItems(root).length, 4, "4 items exist after first run");

    // Second run (same file/transactionId): inspect() detects the 4 already
    // applied rows, skips them, and creates nothing new.
    const second = await runImport(root, file, { atomic: true });
    assert.ifError(second.error);
    assert.equal(second.result.imported, 0, "resumed run imports 0 (nothing new)");
    assert.equal(listItems(root).length, 4, "no duplicate items after resume");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--atomic resumability: partial application resumes without duplicating", async () => {
  const root = freshTracker();
  const file = join(root, "good4.csv");
  writeFileSync(
    file,
    "title,status,priority\nPartial 1,open,2\nPartial 2,open,3\nPartial 3,open,1\nPartial 4,open,2\n",
  );
  try {
    // Simulate a prior interrupted run that applied only the first 2 rows by
    // creating them with the transaction's per-row ownership tags. The
    // transaction id is derived from the absolute file path
    // (csv-import-<sha1(absPath)[:12]>); resume matches via the per-row marker
    // `csv-txrow:<txId>#<rowIndex>` (source of truth) plus the batch marker
    // `csv-tx:<txId>` (for scanning), so we stamp both exactly as the importer
    // would.
    const txId = atomicTransactionId(file);
    const batchTag = `csv-tx:${txId}`;
    const rowTag = (i: number) => `csv-txrow:${txId}#${i}`;
    const preTitles = ["Partial 1", "Partial 2"];
    for (let i = 0; i < preTitles.length; i++) {
      const r = spawnSync(
        "pm",
        ["--path", root, "create", "--title", preTitles[i], "--status", "open", "--priority", "2", "--tags", `${batchTag},${rowTag(i)}`, "--json"],
        { encoding: "utf-8" },
      );
      assert.equal(r.status, 0, `pre-create ${preTitles[i]} should succeed: ${r.stderr}`);
    }
    assert.equal(listItems(root).length, 2, "2 items pre-exist (simulated partial run)");

    // Resume: the importer detects the 2 applied rows and creates only the
    // remaining 2, ending with 4 total (no duplicates).
    const resumed = await runImport(root, file, { atomic: true });
    assert.ifError(resumed.error);
    assert.equal(resumed.result.imported, 2, "resume creates only the 2 missing rows");
    assert.equal(listItems(root).length, 4, "exactly 4 items after resume (no duplicates)");
    const titles = listItems(root).map((i) => i.title).sort();
    assert.deepEqual(titles, ["Partial 1", "Partial 2", "Partial 3", "Partial 4"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--atomic combined with --stream fails fast with a clear usage error", async () => {
  const root = freshTracker();
  const file = join(root, "good.csv");
  writeFileSync(file, "title,status\nX,open\n");
  try {
    const { error } = await runImport(root, file, { atomic: true, stream: true });
    assert.ok(error, "--atomic + --stream should error");
    assert.equal((error as any).exitCode, 2, "usage error exit code");
    assert.match(error!.message, /--atomic cannot be combined with --stream/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// New tests for the per-row ownership tag + in-batch duplicate-key guard
// (pm-csv 2026.7.19-1: resume/compensation correctness for duplicate titles
// and duplicate keys).
// ---------------------------------------------------------------------------

test("--atomic duplicate-title creates: two rows same title yield TWO items; resume does not skip or duplicate", async () => {
  const root = freshTracker();
  const file = join(root, "duptitles.csv");
  writeFileSync(file, "title,status,priority\nDup,open,2\nDup,open,3\n");
  try {
    // Fresh run: two rows same title, no --key. Both must create (titles are
    // NOT a uniqueness key). With the old title-based resume match this would
    // also create two on a fresh run; the bug only manifests on resume.
    const first = await runImport(root, file, { atomic: true });
    assert.ifError(first.error);
    assert.equal(first.result.imported, 2, "fresh run creates both duplicate-title rows");
    assert.equal(listItems(root).length, 2, "two items exist for two same-titled rows");

    // Re-run (resume): both rows already applied; inspect() must skip BOTH via
    // the per-row marker (not byTitle, which would map the shared title to a
    // single id). No duplication, no spurious create.
    const second = await runImport(root, file, { atomic: true });
    assert.ifError(second.error);
    assert.equal(second.result.imported, 0, "resume imports 0 (both rows already applied)");
    assert.equal(listItems(root).length, 2, "still exactly 2 items after resume");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--atomic duplicate-title partial resume: only row 0 tagged => resume creates row 1 (per-row tag, not title)", async () => {
  const root = freshTracker();
  const file = join(root, "duptitles2.csv");
  writeFileSync(file, "title,status,priority\nDup,open,2\nDup,open,3\n");
  try {
    // Simulate a prior interrupted run that applied ONLY row 0 by stamping its
    // per-row marker. With the OLD title-based matching, row 1's inspect()
    // would find row 0's item via byTitle and WRONGLY skip it, leaving just one
    // item. With per-row matching, row 1 is pending and gets created.
    const txId = atomicTransactionId(file);
    const batchTag = `csv-tx:${txId}`;
    const rowTag = (i: number) => `csv-txrow:${txId}#${i}`;
    const r = spawnSync(
      "pm",
      ["--path", root, "create", "--title", "Dup", "--status", "open", "--priority", "2", "--tags", `${batchTag},${rowTag(0)}`, "--json"],
      { encoding: "utf-8" },
    );
    assert.equal(r.status, 0, `pre-create row 0 should succeed: ${r.stderr}`);
    assert.equal(listItems(root).length, 1, "1 item pre-exists (only row 0 applied)");

    const resumed = await runImport(root, file, { atomic: true });
    assert.ifError(resumed.error);
    assert.equal(resumed.result.imported, 1, "resume creates the missing row 1 (NOT skipped by title)");
    assert.equal(listItems(root).length, 2, "exactly 2 items after resume — row 1 not skipped, row 0 not duplicated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--atomic --key upsert mid-import failure: created rows compensated, pre-existing updated rows NOT rolled back", async () => {
  const root = freshTracker();
  // Pre-create an item carrying a csv-key tag so it is matched as an UPDATE.
  const preR = spawnSync(
    "pm",
    ["--path", root, "create", "--title", "Pre Existing", "--status", "open", "--priority", "1", "--tags", "csv-key:keepme", "--json"],
    { encoding: "utf-8" },
  );
  assert.equal(preR.status, 0, "pre-create existing item should succeed");
  const preId = (JSON.parse(preR.stdout).item ?? JSON.parse(preR.stdout)).id;
  assert.ok(preId, "pre-existing item has an id");

  const file = join(root, "upsert-fail.csv");
  // Row 0: key 'keepme' matches pre-existing => UPDATE (priority 3).
  // Row 1: key 'newkey' does not exist => CREATE (priority 2).
  // Row 2: key 'badkey' does not exist => CREATE with priority 99 (rejected by
  //   `pm create`, out of 0..4 range) => apply() throws mid-import.
  writeFileSync(
    file,
    "title,status,priority,key\nUpdate Me,open,3,keepme\nNew One,open,2,newkey\nBad One,open,99,badkey\n",
  );
  try {
    const { error } = await runImport(root, file, { atomic: true, key: "key" });
    assert.ok(error, "atomic upsert with a failing row should error");
    assert.match(error!.message, /rolled back/i);

    const items = listItems(root);
    // The pre-existing updated item must remain OPEN (update not reverted) and
    // retain the updated priority (3). Compensation does NOT roll back updates.
    const updated = items.find((i) => i.id === preId);
    assert.ok(updated, "the pre-existing updated item still exists");
    assert.equal(updated!.status, "open", "pre-existing updated item is NOT rolled back (still open)");
    assert.equal(updated!.priority, 3, "pre-existing updated item retains the updated priority");

    // The created row (New One) was compensated (closed); the bad row was never
    // created. No committed (open) items from this import remain.
    const newOne = items.find((i) => i.title === "New One");
    assert.ok(newOne, "the created row exists (compensated, not deleted)");
    assert.equal(newOne!.status, "closed", "the created row was compensated (closed)");
    assert.ok(!items.some((i) => i.title === "Bad One"), "the failing row was never created");

    const openFromImport = items.filter(
      (i) => i.status !== "closed" && i.id !== preId,
    );
    assert.equal(openFromImport.length, 0, "no uncompensated created items remain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--atomic resume detection via per-row tag (not title or key): partial run with distinct keys resumes correctly", async () => {
  const root = freshTracker();
  const file = join(root, "resumekeys.csv");
  writeFileSync(
    file,
    "title,status,priority,key\nA,open,2,k1\nB,open,3,k2\nC,open,1,k3\nD,open,2,k4\n",
  );
  try {
    // Simulate a prior interrupted run that applied rows 0 and 2 (NOT 1 and 3)
    // by stamping their per-row markers. A title- or key-based matcher would
    // not be able to express this sparse partial application; only the per-row
    // tag does. Resume must create exactly rows 1 and 3.
    const txId = atomicTransactionId(file);
    const batchTag = `csv-tx:${txId}`;
    const rowTag = (i: number) => `csv-txrow:${txId}#${i}`;
    const seed = [
      { i: 0, title: "A", key: "k1", pri: "2" },
      { i: 2, title: "C", key: "k3", pri: "1" },
    ];
    for (const s of seed) {
      const r = spawnSync(
        "pm",
        ["--path", root, "create", "--title", s.title, "--status", "open", "--priority", s.pri, "--tags", `csv-key:${s.key},${batchTag},${rowTag(s.i)}`, "--json"],
        { encoding: "utf-8" },
      );
      assert.equal(r.status, 0, `pre-create row ${s.i} should succeed: ${r.stderr}`);
    }
    assert.equal(listItems(root).length, 2, "2 items pre-exist (rows 0 and 2 applied)");

    const resumed = await runImport(root, file, { atomic: true, key: "key" });
    assert.ifError(resumed.error);
    assert.equal(resumed.result.imported, 2, "resume creates exactly the 2 missing rows (1 and 3)");
    assert.equal(resumed.result.updated, 0, "already-applied rows are skipped, not re-updated");
    assert.equal(listItems(root).length, 4, "exactly 4 items after resume (no duplicates)");
    const titles = listItems(root).map((i) => i.title).sort();
    assert.deepEqual(titles, ["A", "B", "C", "D"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--atomic in-batch duplicate-key guard: a repeated NEW key is skipped, not double-created", async () => {
  const root = freshTracker();
  const file = join(root, "dupkeys.csv");
  // Two rows share key 'dup' which does NOT pre-exist in the tracker. Without
  // the in-batch guard both would plan as create (keyIndex is not updated during
  // planning) and produce two items with the same csv-key tag. The guard skips
  // the second occurrence with a clear warning.
  writeFileSync(file, "title,status,priority,key\nFirst,open,2,dup\nSecond,open,3,dup\n");
  try {
    const { result, error } = await runImport(root, file, { atomic: true, key: "key" });
    assert.ifError(error);
    assert.equal(result.imported, 1, "only the first duplicate-key row creates an item");
    assert.equal(result.skipped, 1, "the second duplicate-key row is skipped");

    const items = listItems(root);
    assert.equal(items.length, 1, "exactly one item exists (no duplicate creation)");
    assert.ok(items.some((i) => i.title === "First"), "the first row was created");
    assert.ok(!items.some((i) => i.title === "Second"), "the second row was not created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--atomic post-rollback retry re-imports the FULL batch (compensated rows are not skipped)", async () => {
  const root = freshTracker();
  // Same file path across both runs => same derived transactionId, so this
  // exercises resume detection (not a fresh transaction).
  const file = join(root, "retry.csv");

  // Run 1: row 3 (priority 99) is rejected by `pm create` mid-import, so the
  // whole batch is rolled back — every applied create is compensated (closed).
  writeFileSync(
    file,
    "title,status,priority\nRetry 1,open,2\nRetry 2,open,3\nBad,open,99\nRetry 3,open,1\n",
  );
  try {
    const first = await runImport(root, file, { atomic: true });
    assert.ok(first.error, "run 1 fails and rolls back");
    const openAfterRollback = listItems(root).filter((i) => i.status !== "closed");
    assert.equal(openAfterRollback.length, 0, "rollback leaves zero open items");

    // Run 2: same file path (same transactionId), now all rows valid. The
    // compensated (closed) items from run 1 still carry csv-txrow tags; they
    // must NOT be treated as already-applied, so the retry re-imports the
    // WHOLE batch rather than only the rows after the original failure.
    writeFileSync(
      file,
      "title,status,priority\nRetry 1,open,2\nRetry 2,open,3\nRetry 3fixed,open,1\nRetry 4,open,1\n",
    );
    const second = await runImport(root, file, { atomic: true });
    assert.ifError(second.error);
    assert.equal(second.result.imported, 4, "retry re-imports all 4 rows, not a partial tail");

    const open = listItems(root).filter((i) => i.status !== "closed");
    assert.equal(open.length, 4, "all 4 rows exist as open items after the retry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--atomic closed-status rows resume idempotently (marker presence, not status, is the applied signal)", async () => {
  const root = freshTracker();
  // A row whose CSV status is `closed` is legitimately imported as a closed
  // item. Resume must recognize it via its csv-txrow marker and NOT re-import
  // it — matching by marker presence rather than excluding closed items.
  const file = join(root, "closed-rows.csv");
  writeFileSync(
    file,
    "title,status,priority\nDone task,closed,2\nActive task,open,3\n",
  );
  try {
    const first = await runImport(root, file, { atomic: true });
    assert.ifError(first.error);
    assert.equal(first.result.imported, 2, "first run imports both rows");
    const afterFirst = listItems(root);
    assert.equal(afterFirst.length, 2, "two items exist after the first run");
    assert.equal(
      afterFirst.filter((i) => i.status === "closed").length,
      1,
      "the closed-status row was imported as a closed item",
    );

    // Re-run the same file: both rows (including the closed one) are already
    // applied and must be skipped, with no duplicates.
    const second = await runImport(root, file, { atomic: true });
    assert.ifError(second.error);
    assert.equal(second.result.imported, 0, "resumed run imports nothing new");
    assert.equal(listItems(root).length, 2, "no duplicate of the closed-status row");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--atomic editing the file in place re-imports new content (transaction id folds a content fingerprint)", async () => {
  const root = freshTracker();
  // Import succeeds, then the SAME path is overwritten with different rows.
  // Because the transaction id folds a content fingerprint, the second import
  // gets a fresh id and applies the new content instead of matching the old
  // per-row markers and skipping the changed rows.
  const file = join(root, "tasks.csv");
  writeFileSync(file, "title,status,priority\nOld A,open,2\nOld B,open,3\n");
  try {
    const first = await runImport(root, file, { atomic: true });
    assert.ifError(first.error);
    assert.equal(first.result.imported, 2, "first import creates the original rows");

    // Overwrite the same path with entirely different rows.
    writeFileSync(file, "title,status,priority\nNew C,open,1\nNew D,open,2\n");
    const second = await runImport(root, file, { atomic: true });
    assert.ifError(second.error);
    assert.equal(second.result.imported, 2, "edited content is imported, not skipped as 'already applied'");

    const titles = listItems(root).map((i) => i.title).sort();
    assert.deepEqual(titles, ["New C", "New D", "Old A", "Old B"], "the new rows are present, not silently dropped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression: non-atomic `closed`-row partial-import leak (Greptile P1).
//
// `upsertCreate` creates a `closed` row as `open` then transitions it via
// `pm close --reason`. That sequence is not atomic. Two defects were found:
//   (1) when the create id could not be recovered, the close was silently
//       skipped and the row was reported as imported while actually open;
//   (2) when `pm close` failed, the already-persisted open orphan was left
//       behind, undiscoverable by a retry without --key-field.
// The fix makes (1) a hard failure and compensates (closes) the orphan for (2),
// falling back to an id-carrying error when compensation also fails.
// ---------------------------------------------------------------------------

test("non-atomic closed row whose pm close fails: the persisted open orphan is compensated (closed), not left behind", async () => {
  const root = freshTracker();
  // Strict closure-validation makes `pm close --reason` fail (missing
  // resolution/expected/actual) while `pm create` still succeeds under the
  // minimal preset — exactly the gap: the item is persisted open, then the
  // terminal close fails.
  enableStrictCloseValidation(root);
  const file = join(root, "closed.csv");
  writeFileSync(file, "title,status\nGood Open,open\nBad Closed,closed\n");
  try {
    const { result, error } = await runImport(root, file, {});
    assert.ifError(error);

    // The open row imports normally; the closed row's terminal close failed.
    assert.equal(result.imported, 1, "the open row is imported");
    assert.equal(result.skipped, 1, "the failed closed row is counted as skipped");
    assert.equal(result.errors.length, 1, "the closed-row failure is reported");

    // The fix compensates (closes) the orphan rather than leaving it open.
    assert.match(
      result.errors[0],
      /compensated \(verified closed\)/,
      "error must state the orphan was compensated AND that the closed status was verified — an unchecked claim of compensation is what let an unverifiable status pass as success",
    );

    // The compensation actually happened on disk: the closed row's item exists
    // and is CLOSED (rolled back), not left as an open orphan.
    const items = listItems(root);
    const orphan = items.find((i) => i.title === "Bad Closed");
    assert.ok(orphan, "the closed row's created item exists");
    assert.equal(orphan!.status, "closed", "the orphan was compensated (closed), not left open");
    const good = items.find((i) => i.title === "Good Open");
    assert.ok(good, "the open row was imported");
    assert.equal(good!.status, "open", "the open row remains open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-atomic closed row whose create id cannot be recovered: hard failure, not a silent open import", async () => {
  const root = freshTracker();
  // Marker makes the fake `pm create --json` exit 0 with `{}` (no id) for this
  // tracker only, simulating "create succeeded but the id could not be parsed".
  writeFileSync(join(root, "fake-create-no-id"), "");
  const file = join(root, "noid.csv");
  writeFileSync(file, "title,status\nUnrecoverable Closed,closed\n");
  const restorePm = installFakePm();
  try {
    const { result, error } = await runImport(root, file, {});
    assert.ifError(error);

    // The defect: with the old code the empty id silently skipped the close and
    // returned "" — the row was counted as IMPORTED while actually open. The
    // fix makes it a hard failure: imported is NOT incremented for this row.
    assert.equal(result.imported, 0, "a closed row with no recoverable id is NOT silently imported");
    assert.equal(result.skipped, 1, "the row is counted as skipped (hard failure)");
    assert.equal(result.errors.length, 1, "the unrecoverable id is reported as an error");
    assert.match(
      result.errors[0],
      /returned no id.*cannot be applied/i,
      "error must name the unrecoverable id rather than returning silently",
    );

    // No item was created for this row (the fake create emitted no id and the
    // row is reported as failed, never as a silent open success).
    const items = listItems(root);
    assert.equal(items.length, 0, "no silent open orphan was recorded as imported");
  } finally {
    restorePm();
    rmSync(root, { recursive: true, force: true });
  }
});

// Review follow-up (Greptile P1): an UNKNOWN status must not be read as proof
// that compensation succeeded.
//
// `itemStatus()` returns undefined whenever the lookup itself fails — non-zero
// exit, malformed JSON, or an absent status field. The verification originally
// asked "is it still open?", so undefined fell through to the success path and
// the row was reported as compensated (closed) even though the orphan might
// still be open. A retry without --key-field would then duplicate it, which is
// precisely the leak this branch exists to prevent. The check now demands a
// status of exactly `closed` as positive evidence.
test("non-atomic closed row: an unverifiable status is not treated as successful compensation", async () => {
  const root = freshTracker();
  // Both closes fail AND the status lookup fails, so compensation cannot be
  // verified either way — the orphan really is left open underneath.
  writeFileSync(join(root, "fake-close-fail"), "");
  writeFileSync(join(root, "fake-get-fail"), "");
  const file = join(root, "unverifiable.csv");
  writeFileSync(file, "title,status\nUnverifiable Closed,closed\n");
  const restorePm = installFakePm();
  try {
    const { result, error } = await runImport(root, file, {});
    assert.ifError(error);

    assert.equal(result.imported, 0, "the failed closed row is not counted as imported");
    assert.equal(result.skipped, 1, "the failed closed row is counted as skipped");
    assert.equal(result.errors.length, 1, "the failure is reported");

    const msg = result.errors[0];
    assert.match(
      msg,
      /could not be verified/i,
      "an unreadable status must be reported as unverified, never as a successful compensation",
    );
    assert.doesNotMatch(
      msg,
      /verified closed/i,
      "the success wording must not appear when compensation could not be verified",
    );
    assert.match(msg, /id pm-[a-z0-9]+/i, "the created id is carried so the partial state is actionable");
  } finally {
    restorePm();
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-atomic closed row: when compensation also fails, the error carries the created id so the partial state is actionable", async () => {
  const root = freshTracker();
  // Marker makes every `pm close` fail for this tracker only — both the row's
  // terminal close AND the compensation close. `pm create`/`pm get` delegate to
  // the real pm, so a real open orphan is persisted, then both closes fail.
  writeFileSync(join(root, "fake-close-fail"), "");
  const file = join(root, "closefail.csv");
  writeFileSync(file, "title,status\nGood Open,open\nOrphan Closed,closed\n");
  const restorePm = installFakePm();
  try {
    const { result, error } = await runImport(root, file, {});
    assert.ifError(error);

    assert.equal(result.imported, 1, "the open row is imported");
    assert.equal(result.skipped, 1, "the failed closed row is counted as skipped");
    assert.equal(result.errors.length, 1, "the closed-row failure is reported");

    // Compensation also failed: the error MUST carry the created id and state
    // the item was left OPEN, so a retry/operator can reconcile it by id.
    const msg = result.errors[0];
    assert.match(msg, /left OPEN/i, "error must state the orphan was left open when compensation failed");
    assert.match(msg, /id pm-[a-z0-9]+/i, "error must carry the created item id so the partial state is actionable");

    // The orphan really is left open (compensation could not close it).
    const orphan = listItems(root).find((i) => i.title === "Orphan Closed");
    assert.ok(orphan, "the closed row's created item exists");
    assert.equal(orphan!.status, "open", "the orphan is left open when compensation fails");
  } finally {
    restorePm();
    rmSync(root, { recursive: true, force: true });
  }
});

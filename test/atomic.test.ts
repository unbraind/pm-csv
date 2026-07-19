import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import extension from "../dist/index.js";

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
    const { createHash } = await import("node:crypto");
    const txId = `csv-import-${createHash("sha1").update(file).digest("hex").slice(0, 12)}`;
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
    const { createHash } = await import("node:crypto");
    const txId = `csv-import-${createHash("sha1").update(file).digest("hex").slice(0, 12)}`;
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
    const { createHash } = await import("node:crypto");
    const txId = `csv-import-${createHash("sha1").update(file).digest("hex").slice(0, 12)}`;
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

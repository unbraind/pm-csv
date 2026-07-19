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
    // creating them with the transaction's ownership tag. The transaction id is
    // derived from the absolute file path (csv-import-<sha1(absPath)[:12]>),
    // so we compute the same tag the importer would stamp.
    const { createHash } = await import("node:crypto");
    const txId = `csv-import-${createHash("sha1").update(file).digest("hex").slice(0, 12)}`;
    const tag = `csv-tx:${txId}`;
    for (const title of ["Partial 1", "Partial 2"]) {
      const r = spawnSync(
        "pm",
        ["--path", root, "create", "--title", title, "--status", "open", "--priority", "2", "--tags", tag, "--json"],
        { encoding: "utf-8" },
      );
      assert.equal(r.status, 0, `pre-create ${title} should succeed: ${r.stderr}`);
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
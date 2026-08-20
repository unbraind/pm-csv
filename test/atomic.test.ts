import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

import { commitWorkspaceTransaction } from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";

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

/** Minimal command definition retained by the focused atomic integration harness. */
interface CapturedCommand {
  name: string;
  flags?: Array<{ long: string }>;
  run(context: RunCtx): Promise<ImportCommandResult>;
}

/** Structured import receipt returned by the csv import command. */
interface ImportCommandResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/** Item fields inspected by the atomic integration assertions. */
interface ListedItem {
  id: string;
  title: string;
  status: string;
  priority?: number;
  tags?: string[];
}

/** Command failure shape exposed by package command errors. */
interface CommandFailure extends Error {
  exitCode?: number;
}

/** Success or failure from invoking the captured import handler. */
type ImportOutcome =
  | { result: ImportCommandResult; error?: never }
  | { result?: never; error: CommandFailure };

/** Activate the extension against a mock api, returning the registered commands. */
function captureCommands(): CapturedCommand[] {
  const commands: CapturedCommand[] = [];
  const noop = () => {};
  const api = {
    registerCommand: (def: CapturedCommand) => commands.push(def),
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
  extension.activate(api as unknown as ExtensionApi);
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
function listItems(pmRoot: string): ListedItem[] {
  const r = spawnSync("pm", ["--path", pmRoot, "list-all", "--json"], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`pm list-all failed: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { items?: ListedItem[] }).items ?? [];
}

/** Run the `csv import` command handler and return { result?, error? }. */
async function runImport(
  pmRoot: string,
  file: string,
  options: Record<string, unknown>,
): Promise<ImportOutcome> {
  const commands = captureCommands();
  const cmd = commands.find((c) => c.name === "csv import");
  assert.ok(cmd, "csv import command should be registered");
  const ctx: RunCtx = {
    pm_root: pmRoot,
    args: [file],
    options,
    global: { author: "pi-agent" },
    sdk: {
      commitWorkspaceTransaction: (options: Parameters<typeof commitWorkspaceTransaction>[0]) =>
        commitWorkspaceTransaction({ ...options, pmRoot }),
    },
  };
  try {
    const result = await cmd.run(ctx);
    return { result };
  } catch (err) {
    return { error: err as CommandFailure };
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
 *   - `<root>/fake-create-kill`: `pm create --json` is terminated by SIGKILL
 *     before it writes anything (no output, no persisted item), so spawnSync
 *     reports `status: null`, `signal: "SIGKILL"`, no `error`, empty `stdout` —
 *     a create whose receipt cannot be recovered at all (the signal-kill arm of
 *     the write-overrun fix).
 *   - `<root>/fake-close-kill`: every `pm close ...` is terminated by SIGKILL
 *     before it writes anything, so its `status: null` routes into the
 *     close-failure compensation branch instead of bypassing it (a null close
 *     status is not a buffer abort).
 *   - `<root>/fake-update-fail`: every `pm update ...` exits 1 with a simulated
 *     error, to exercise the non-zero arm of the update path — a failed update
 *     is not proof nothing was written, so the error must still name the item.
 *   - `<root>/fake-update-kill`: every `pm update ...` is terminated by SIGKILL,
 *     so it returns `status: null` — the arm where the mutation may already have
 *     been applied and only the id makes it reconcilable.
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
    "const { existsSync, writeSync } = require('fs');",
    "const args = process.argv.slice(2);",
    "let root = '';",
    "for (let i = 0; i < args.length; i++) {",
    "  if (args[i] === '--path' || args[i] === '--pm-path') root = args[i + 1] || '';",
    "}",
    "function has(s) { return args.indexOf(s) !== -1; }",
    "const realPm = process.env.PM_CSV_REAL_PM;",
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
    // Kills `pm create --json` with SIGKILL before any output/persist, so the
    // create returns status null + signal SIGKILL + empty stdout: the receipt
    // cannot be recovered at all (the write-overrun signal-kill arm).
    "if (root && existsSync(root + '/fake-create-kill') && has('create') && has('--json')) {",
    "  process.kill(process.pid, 'SIGKILL');",
    "}",
    // Simulates a create whose receipt "overran" with a RECOVERABLE id: delegates
    // to the real pm so the item is really created (and a real id assigned),
    // writes the full --json receipt to stdout, then SIGKILLs so spawnSync
    // reports status:null + signal SIGKILL with the full receipt captured. This
    // deterministically exercises the recovered-id recovery-close path WITHOUT
    // depending on a real buffer cap (which would also cap the recovery close
    // and prevent testing its success/non-zero-failure outcomes).
    "if (root && existsSync(root + '/fake-create-overrun') && has('create') && has('--json')) {",
    "  const r = spawnSync(realPm, args, { encoding: 'utf-8' });",
    // writeSync, NOT process.stdout.write: on a pipe the latter is asynchronous
    // and the SIGKILL on the next statement cannot be handled, so a queued chunk
    // is discarded and the id is silently unrecoverable — the test would then
    // assert the wrong branch, intermittently. writeSync returns only once the
    // bytes are handed to the fd, so the receipt is always in the pipe first.
    "  if (r.stdout) writeSync(1, r.stdout);",
    "  process.kill(process.pid, 'SIGKILL');",
    "}",
    // Kills `pm close` with SIGKILL before any output/persist, so the close
    // returns status null and routes into the compensation branch (a null close
    // is not a buffer abort that bypasses compensation).
    "if (root && existsSync(root + '/fake-close-kill') && has('close')) {",
    "  process.kill(process.pid, 'SIGKILL');",
    "}",
    // Makes `pm update` exit 1 with a simulated stderr, to exercise the
    // update-failure arm of upsertUpdate (the mutation may already have been
    // applied, so the failure must carry the item id).
    "if (root && existsSync(root + '/fake-update-fail') && has('update')) {",
    "  process.stderr.write('simulated pm update failure (test)\\n');",
    "  process.exit(1);",
    "}",
    // Kills `pm update` with SIGKILL before it exits, so it returns status null
    // (the receipt-overrun / signal-kill arm of the update path: the mutation
    // may already have been applied and must be reported with the id).
    "if (root && existsSync(root + '/fake-update-kill') && has('update')) {",
    "  process.kill(process.pid, 'SIGKILL');",
    "}",
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
  const longs = (importCmd.flags ?? []).map((flag) => flag.long);
  assert.ok(longs.includes("--atomic"), "csv import should expose --atomic");
});

test("--atomic refuses an incompatible host that omits the transaction SDK", async () => {
  const root = freshTracker();
  try {
    const file = join(root, "one.csv");
    writeFileSync(file, "title\nOne\n", "utf8");
    const command = captureCommands().find((candidate) => candidate.name === "csv import");
    assert.ok(command, "csv import command should be registered");
    await assert.rejects(
      command.run({ pm_root: root, args: [file], options: { atomic: true } } satisfies RunCtx),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("host-injected commitWorkspaceTransaction SDK primitive"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    assert.equal(error.exitCode, 1, "exit code should be 1");
    assert.match(
      error!.message,
      /cannot claim a clean tracker/i,
      "error must not overstate best-effort compensation as a proven rollback",
    );
    assert.match(error!.message, /may remain.*reconcile/is);

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
    assert.equal(error.exitCode, 2, "usage error exit code");
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
    assert.match(error!.message, /pre-existing item updates are intentionally not reverted/i);
    assert.match(error!.message, /cannot claim a clean tracker/i);
    assert.match(error!.message, /may remain.*reconcile/is);

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

// ---------------------------------------------------------------------------
// Review follow-up (PR #59): the write-overrun guard must never abandon a write
// that may already have taken effect. `pm create` is a WRITE — by the time its
// receipt overruns the buffer (or the child is killed) the item may already be
// persisted. Asserting before the id is parsed would strand an UN-IDENTIFIABLE
// orphan compensation cannot roll back, and asserting on the close receipt
// bypassed the close-failure compensation branch. The fix parses the id first,
// closes a recovered orphan directly, and lets a null close status route into
// compensation. Each test below is mutation-tested (revert its fix -> it fails).
// ---------------------------------------------------------------------------

/**
 * Run an async `body` with `PM_LIST_MAX_BUFFER` temporarily set to `cap`,
 * restoring the prior value (including "unset") on exit.
 *
 * The cap is read by `pmListMaxBuffer()` at each `spawnSync`, so it must stay
 * set for the duration of the awaited body (whose synchronous `spawnSync` calls
 * run during the await), not just around the call that starts it.
 */
async function withCappedReadBufferAsync<T>(cap: string, body: () => Promise<T>): Promise<T> {
  const prev = process.env.PM_LIST_MAX_BUFFER;
  process.env.PM_LIST_MAX_BUFFER = cap;
  try {
    return await body();
  } finally {
    if (prev === undefined) delete process.env.PM_LIST_MAX_BUFFER;
    else process.env.PM_LIST_MAX_BUFFER = prev;
  }
}

test("F2: create overrun never strands an un-identifiable orphan — the id is recovered and the recovery close inspected", async () => {
  // PM_LIST_MAX_BUFFER smaller than BOTH the create receipt and the recovery
  // `pm close` output: `pm create` persists the item then its receipt overruns
  // (status null, id recoverable); the direct recovery `pm close` is issued under
  // the SAME cap, so it overruns identically (status null) every time. Before
  // the fix the recovery close's result was DISCARDED and the error asserted the
  // orphan "was best-effort closed" — an outcome that could not be confirmed
  // (status null) and that stopped the operator looking for an item still open.
  // The fix INSPECTS the recovery close result and, for a null status, reports
  // the orphan as still open and to-be-closed manually, carrying the close's own
  // overrun cause: the window is always REPORTED WITH THE ID, never assumed away.
  const root = freshTracker();
  const file = join(root, "one.csv");
  writeFileSync(file, "title,status\nOverrun Orphan,open\n");
  try {
    const { result, error } = await withCappedReadBufferAsync("16", () => runImport(root, file, {}));
    assert.ifError(error);

    // The overrun row was NOT counted as imported; it was skipped with a named
    // error that carries the recovered id.
    assert.equal(result.imported, 0, "the overrun create is not counted as imported");
    assert.equal(result.skipped, 1, "the overrun row is counted as skipped");
    assert.equal(result.errors.length, 1, "the overrun is reported once");
    const msg = result.errors[0];
    assert.match(msg, /id pm-[a-z0-9]+/i, "the recovered id is carried so the state is identifiable");

    // The CREATE overrun is named (its real cause) ...
    assert.match(msg, /pm create overran/i, "the error names the create overrun");
    // ... and so is the RECOVERY close's: it returned status null under the same
    // cap, so the error must NOT claim the orphan was closed. It must report the
    // orphan as still open, tell the operator to close it manually, and carry the
    // close's own overrun cause — an accurate report, not an assumed outcome.
    assert.match(msg, /still open/i, "a null recovery-close status is reported as still-open, never as closed");
    assert.match(msg, /must be closed manually/i, "the operator is told to close the orphan by id");
    assert.match(msg, /pm close overran/i, "the recovery close's own overrun cause is carried");
    assert.doesNotMatch(msg, /was closed/i, "the error never asserts the close succeeded when its status is null");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F2: create overrun whose recovery close SUCCEEDS reports the orphan was closed", async () => {
  // With the id recovered, the direct recovery close is attempted and its result
  // inspected. When it succeeds (status 0) the error must say the orphan WAS
  // closed and that the import can be retried — the accurate report for the
  // confirmed outcome. The create overrun is simulated deterministically by the
  // fake-pm wrapper (it delegates the create to real pm so a real item and id
  // exist, emits the full receipt, then signals itself); the recovery close then
  // runs against real pm unmodified, so it succeeds normally. This outcome is
  // unreachable under a real buffer cap (which would also cap the recovery
  // close), so it is exercised only through the deterministic wrapper.
  const root = freshTracker();
  writeFileSync(join(root, "fake-create-overrun"), "");
  const file = join(root, "one.csv");
  writeFileSync(file, "title,status\nOverrun Orphan,open\n");
  const restorePm = installFakePm();
  try {
    const { result, error } = await runImport(root, file, {});
    assert.ifError(error);

    assert.equal(result.imported, 0, "the overrun create is not counted as imported");
    assert.equal(result.skipped, 1, "the overrun row is counted as skipped");
    assert.equal(result.errors.length, 1, "the overrun is reported once");
    const msg = result.errors[0];
    assert.match(msg, /id pm-[a-z0-9]+/i, "the recovered id is carried");
    assert.match(msg, /was closed/i, "a successful recovery close is reported as closed");
    assert.match(msg, /retry the import/i, "the operator is told the import can be retried");
    assert.doesNotMatch(msg, /still open/i, "a successful close is not reported as still-open");

    // The recovery close really took effect: the orphan is closed on disk.
    const orphan = listItems(root).find((i) => i.title === "Overrun Orphan");
    assert.ok(orphan, "the created item exists (it was identified, not stranded)");
    assert.equal(orphan!.status, "closed", "the orphan was closed by the recovery close");
  } finally {
    restorePm();
    rmSync(root, { recursive: true, force: true });
  }
});

test("F2: create overrun whose recovery close FAILS reports the orphan still open, carrying the close's stderr", async () => {
  // When the recovery close returns a non-zero status, the error must report the
  // orphan as still open, carry the close's own failure cause (its stderr), and
  // tell the operator to close it manually — never claim it was closed. The
  // orphan really is left open, because the failed close had no effect.
  const root = freshTracker();
  writeFileSync(join(root, "fake-create-overrun"), "");
  writeFileSync(join(root, "fake-close-fail"), "");
  const file = join(root, "one.csv");
  writeFileSync(file, "title,status\nOverrun Orphan,open\n");
  const restorePm = installFakePm();
  try {
    const { result, error } = await runImport(root, file, {});
    assert.ifError(error);

    assert.equal(result.imported, 0, "the overrun create is not counted as imported");
    assert.equal(result.skipped, 1, "the overrun row is counted as skipped");
    assert.equal(result.errors.length, 1, "the overrun is reported once");
    const msg = result.errors[0];
    assert.match(msg, /id pm-[a-z0-9]+/i, "the recovered id is carried");
    assert.match(msg, /still open/i, "a failed recovery close is reported as still-open");
    assert.match(msg, /must be closed manually/i, "the operator is told to close the orphan by id");
    assert.match(msg, /simulated pm close failure \(test\)/i, "the close's own stderr is carried as the cause");
    assert.doesNotMatch(msg, /was closed/i, "a failed close is never reported as closed");

    // The failed close had no effect: the orphan is open on disk.
    const orphan = listItems(root).find((i) => i.title === "Overrun Orphan");
    assert.ok(orphan, "the created item exists (it was identified, not stranded)");
    assert.equal(orphan!.status, "open", "the orphan is left open because the recovery close failed");
  } finally {
    restorePm();
    rmSync(root, { recursive: true, force: true });
  }
});

test("F2: a create killed before it writes cannot strand an orphan — the title is named for manual reconcile", async () => {
  // A create terminated by a signal before writing anything reports status null
  // with EMPTY stdout, so NO id can be recovered. Before the fix the overrun
  // guard threw a raw buffer/signal abort; the fix instead throws a named error
  // carrying the title (the only identifying clue), so the operator can
  // reconcile. Nothing was persisted, so no orphan exists.
  const root = freshTracker();
  writeFileSync(join(root, "fake-create-kill"), "");
  const file = join(root, "killed.csv");
  writeFileSync(file, "title,status\nKilled Create,open\n");
  const restorePm = installFakePm();
  try {
    const { result, error } = await runImport(root, file, {});
    assert.ifError(error);

    assert.equal(result.imported, 0, "the killed create is not counted as imported");
    assert.equal(result.skipped, 1, "the killed row is counted as skipped");
    assert.equal(result.errors.length, 1, "the failure is reported once");
    // Worded for the REAL cause (a signal, not a buffer) and naming the title:
    assert.match(result.errors[0], /signal/i, "the error names the signal cause, not a buffer overrun");
    assert.match(result.errors[0], /Killed Create/, "the error names the title so the row is identifiable");
    assert.match(result.errors[0], /reconcile manually/i, "the error tells the operator how to recover the unrecoverable id");

    // The create was killed before it persisted, so nothing was left behind.
    assert.equal(listItems(root).length, 0, "no item was created — nothing to strand");
  } finally {
    restorePm();
    rmSync(root, { recursive: true, force: true });
  }
});

test("F2: a null close status routes into compensation, never bypasses it", async () => {
  // A closed row whose `pm close` is terminated by a signal reports status null.
  // Before the fix the close-result guard threw a raw signal abort and BYPASSED
  // the close-failure compensation branch, leaving the orphan un-compensated and
  // the failure mis-reported as a buffer/signal error. The fix drops that guard
  // so a null close routes into compensation: the orphan is compensated (closing
  // is also killed, so it cannot take effect) and the failure is reported as a
  // compensation outcome (left OPEN), not as a raw signal abort.
  const root = freshTracker();
  writeFileSync(join(root, "fake-close-kill"), "");
  const file = join(root, "closekill.csv");
  writeFileSync(file, "title,status\nClose Killed,closed\n");
  const restorePm = installFakePm();
  try {
    const { result, error } = await runImport(root, file, {});
    assert.ifError(error);

    assert.equal(result.imported, 0, "the failed closed row is not counted as imported");
    assert.equal(result.skipped, 1, "the failed closed row is counted as skipped");
    assert.equal(result.errors.length, 1, "the failure is reported once");

    // The compensation branch ran (the error is a compensation outcome), NOT a
    // raw signal/buffer abort from a bypassed guard.
    const msg = result.errors[0];
    assert.match(msg, /left OPEN/i, "compensation ran and reported the orphan left open");
    assert.match(msg, /id pm-[a-z0-9]+/i, "the created id is carried so the partial state is actionable");
    assert.doesNotMatch(msg, /terminated by signal.*will not help/i, "the error is not a raw signal abort that bypassed compensation");

    // The close never took effect (killed before persist): the orphan is open.
    const orphan = listItems(root).find((i) => i.title === "Close Killed");
    assert.ok(orphan, "the closed row's created item exists");
    assert.equal(orphan!.status, "open", "the orphan is left open because the close was killed");
  } finally {
    restorePm();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Pre-create an item carrying a `csv-key` tag so a CSV row with the same key is
 * matched as an UPDATE rather than a create.
 *
 * Runs before {@link installFakePm}, so the seeding create always reaches the
 * real `pm` even in tests whose fake intercepts `update`/`close`.
 *
 * @param root - Tracker root to seed.
 * @param key - Value written into the item's `csv-key:` tag.
 * @returns The seeded item's id, which the update-path assertions expect the
 *   thrown error to name.
 */
function seedKeyedItem(root: string, key: string): string {
  const r = spawnSync(
    "pm",
    ["--path", root, "create", "--title", "Seeded Row", "--status", "open", "--priority", "1", "--tags", `csv-key:${key}`, "--json"],
    { encoding: "utf-8" },
  );
  assert.equal(r.status, 0, "seeding the keyed item should succeed");
  const id = JSON.parse(r.stdout).id;
  assert.ok(id, "the seeded item has an id");
  return id;
}

test("F-B: an update killed mid-flight names the item, because the mutation may already have been applied", async () => {
  // `pm update` is a WRITE. A SIGKILL yields status null with no stderr, which
  // the old code routed onto a generic "pm update failed" branch — a row-level
  // failure the operator could not reconcile against anything. The row may
  // nonetheless have been written. The guarantee this asserts is deliberately
  // the narrow one: not that no mutation is left behind (an update has no
  // inverse without prior field values, which this extension does not capture),
  // but that no mutation is left UN-IDENTIFIED.
  const root = freshTracker();
  const id = seedKeyedItem(root, "upd-kill");
  writeFileSync(join(root, "fake-update-kill"), "");
  const file = join(root, "updkill.csv");
  writeFileSync(file, "title,status,priority,key\nSeeded Row,open,3,upd-kill\n");
  const restorePm = installFakePm();
  try {
    const { result, error } = await runImport(root, file, { key: "key" });
    assert.ifError(error);
    assert.equal(result.errors.length, 1, "the killed update is reported once");
    const msg = result.errors[0];
    assert.ok(msg.includes(id), "the error names the item id so the state is reconcilable");
    assert.match(msg, /may already have been applied/i, "the error states the mutation may have landed");
    assert.match(msg, /NOT a stdout buffer overrun/i, "a signal kill is not misreported as a buffer overrun");
  } finally {
    restorePm();
    rmSync(root, { recursive: true, force: true });
  }
});

test("F-B: an update that exits non-zero still names the item — a failed write is not proof nothing landed", async () => {
  // A non-zero exit is weaker evidence than it looks: `pm update` may have
  // persisted part of its work before failing. The error therefore carries the
  // id and the same "may already have been applied" caveat as the null-status
  // arm, rather than implying the item is untouched.
  const root = freshTracker();
  const id = seedKeyedItem(root, "upd-fail");
  writeFileSync(join(root, "fake-update-fail"), "");
  const file = join(root, "updfail.csv");
  writeFileSync(file, "title,status,priority,key\nSeeded Row,open,3,upd-fail\n");
  const restorePm = installFakePm();
  try {
    const { result, error } = await runImport(root, file, { key: "key" });
    assert.ifError(error);
    assert.equal(result.errors.length, 1, "the failed update is reported once");
    const msg = result.errors[0];
    assert.ok(msg.includes(id), "the error names the item id");
    assert.match(msg, /simulated pm update failure/i, "the underlying stderr is preserved, not swallowed");
    assert.match(msg, /may already have been applied/i, "the error does not imply the item is untouched");
  } finally {
    restorePm();
    rmSync(root, { recursive: true, force: true });
  }
});

test("F-B: a terminal close killed after a successful update reports BOTH mutations by id", async () => {
  // The update landed and the terminal close was then killed. Reporting only
  // the close would hide that the row's other fields were already mutated, so
  // the error must state that the update WAS applied and that the close may
  // have been too — one message covering both halves of the same row.
  const root = freshTracker();
  const id = seedKeyedItem(root, "cls-kill");
  writeFileSync(join(root, "fake-close-kill"), "");
  const file = join(root, "clskill.csv");
  writeFileSync(file, "title,status,priority,key\nSeeded Row,closed,3,cls-kill\n");
  const restorePm = installFakePm();
  try {
    const { result, error } = await runImport(root, file, { key: "key" });
    assert.ifError(error);
    assert.equal(result.errors.length, 1, "the killed close is reported once");
    const msg = result.errors[0];
    assert.ok(msg.includes(id), "the error names the item id");
    assert.match(msg, /update for item .* was applied/i, "the already-applied update is stated, not hidden behind the close failure");
    assert.match(msg, /close may already have been applied/i, "the close's own uncertainty is stated");
  } finally {
    restorePm();
    rmSync(root, { recursive: true, force: true });
  }
});

test("F-B: a terminal close that exits non-zero after a successful update also reports both by id", async () => {
  // Same row-level shape as the killed close, reached through the non-zero arm:
  // the update is known applied, the close is uncertain, and the operator gets
  // the id plus the close's real stderr rather than a bare row failure.
  const root = freshTracker();
  const id = seedKeyedItem(root, "cls-fail");
  writeFileSync(join(root, "fake-close-fail"), "");
  const file = join(root, "clsfail.csv");
  writeFileSync(file, "title,status,priority,key\nSeeded Row,closed,3,cls-fail\n");
  const restorePm = installFakePm();
  try {
    const { result, error } = await runImport(root, file, { key: "key" });
    assert.ifError(error);
    assert.equal(result.errors.length, 1, "the failed close is reported once");
    const msg = result.errors[0];
    assert.ok(msg.includes(id), "the error names the item id");
    assert.match(msg, /update was applied/i, "the already-applied update is stated");
    assert.match(msg, /close may already have been applied/i, "the close's uncertainty is stated");
  } finally {
    restorePm();
    rmSync(root, { recursive: true, force: true });
  }
});

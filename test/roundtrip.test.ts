import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, symlinkSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { create, getHistoryPath, update, WorkspaceTransactionInterruptedError } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { parseCSV, serializeCSV } from "../index.ts";
import { applyEditSession, EditRefusal, exportEditSession, parseEditSession } from "../roundtrip.ts";
import type { EditSession } from "../roundtrip.ts";
import { readUpdateDocument, readUpdateSnapshot } from "../atomic-update.ts";

/** Initialize a real tracker outside git, including a stable keyed terminal item. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "csv-edits-"));
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  const initialized = spawnSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "--defaults", "--path", root], {
    encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const one = await create({ title: "First", body: "Body\nwith \"quotes\", café 😀", tags: "csv-key:first", priority: 1 }, { pmRoot: root });
  const two = await create({ title: "Terminal", status: "closed", closeReason: "Finished", priority: 2, tags: "csv-key:second" }, { pmRoot: root });
  const ids = [one.item.id, two.item.id];
  return { root, ids, ...await exportEditSession(root, ids) };
}

/** Change one cell through its declared header; digests remain untouched. */
function edit(table: string[][], row: number, field: string, value: string): void {
  table[row][table[0].indexOf(field)] = value;
}

/** Compare exact source documents and immutable history rather than receipts alone. */
async function evidence(root: string, ids: string[]) {
  return Promise.all(ids.map(async id => ({
    raw: (await readUpdateSnapshot(root, id)).raw,
    history: readFileSync(getHistoryPath(root, id), "utf8"),
  })));
}

/** Assert typed actionable refusal codes independent of human message wording. */
function refusal(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof EditRefusal);
    assert.equal(error.code, code);
    assert.equal(error.context.code, code);
    assert.ok(error.remedy.length > 10);
    assert.equal(error.exitCode, 2);
    return true;
  };
}

test("three-way edits preserve concurrent unedited values and terminal evidence; retries perform zero writes without git", async () => {
  const f = await fixture();
  const savedPath = process.env.PATH;
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    process.env.PATH = "";
    process.env.GIT_CEILING_DIRECTORIES = dirname(f.root);
    const first = await readUpdateDocument(f.root, f.ids[0]);
    assert.equal(first.body, f.session.rows[0].values.body);
    await update(f.ids[0], { sprint: "newer-tracker-value" }, { pmRoot: f.root });
    edit(f.table, 1, "title", "Edited spreadsheet");
    edit(f.table, 1, "body", "  Edited\nbody, \"escaped\" 😀  ");
    edit(f.table, 1, "priority", "4");
    edit(f.table, 1, "assignee", "editor");
    edit(f.table, 1, "release", "next");
    edit(f.table, 2, "title", "Edited terminal");
    const closed = await readUpdateDocument(f.root, f.ids[1]);
    const beforePreview = await evidence(f.root, f.ids);
    assert.deepEqual(await applyEditSession(f.root, f.session, f.table, { author: "csv-test", dryRun: true }),
      { rows: 2, changed: 2, unchanged: 0, concurrent: 1, applied: 0 });
    assert.deepEqual(await evidence(f.root, f.ids), beforePreview);
    assert.equal(existsSync(join(f.root, "transactions", "sdk")), false);
    const applied = await applyEditSession(f.root, f.session, f.table, { author: "csv-test" });
    assert.equal(applied.applied, 2);
    assert.match(applied.transaction!, /^csv-edit-/);
    const changed = await readUpdateDocument(f.root, f.ids[0]);
    assert.equal(changed.metadata.title, "Edited spreadsheet");
    assert.equal(changed.body, "  Edited\nbody, \"escaped\" 😀");
    assert.equal(changed.metadata.priority, 4);
    assert.equal(changed.metadata.assignee, "editor");
    assert.equal(changed.metadata.release, "next");
    assert.equal(changed.metadata.sprint, "newer-tracker-value");
    assert.deepEqual(changed.metadata.tags, first.metadata.tags);
    const terminal = await readUpdateDocument(f.root, f.ids[1]);
    assert.equal(terminal.metadata.status, "closed");
    assert.equal(terminal.metadata.closed_at, closed.metadata.closed_at);
    assert.equal(terminal.metadata.close_reason, closed.metadata.close_reason);
    const after = await evidence(f.root, f.ids);
    const replay = await applyEditSession(f.root, f.session, f.table, { author: "csv-test" });
    assert.equal(replay.applied, 0);
    assert.equal(replay.unchanged, 2);
    assert.deepEqual(await evidence(f.root, f.ids), after);
    // Clearing optional cells unsets their metadata, preserving all other state.
    const fresh = await exportEditSession(f.root, [f.ids[0]]);
    for (const field of ["assignee", "release", "sprint"]) edit(fresh.table, 1, field, "");
    await applyEditSession(f.root, fresh.session, fresh.table, { author: "csv-test" });
    const cleared = await readUpdateDocument(f.root, f.ids[0]);
    for (const field of ["assignee", "release", "sprint"]) assert.equal(Object.hasOwn(cleared.metadata, field), false);
  } finally {
    process.env.PATH = savedPath;
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("two editors and stale field digests refuse the whole table before any item/history/journal writes", async () => {
  const f = await fixture();
  try {
    const editorA = structuredClone(f.table);
    edit(editorA, 2, "title", "Editor A");
    await applyEditSession(f.root, f.session, editorA, { author: "csv-test" });
    edit(f.table, 1, "title", "Should never apply");
    edit(f.table, 2, "title", "Editor B");
    const before = await evidence(f.root, f.ids);
    await assert.rejects(applyEditSession(f.root, f.session, f.table, { author: "csv-test" }), error => {
      assert.ok(error instanceof EditRefusal);
      assert.equal(error.code, "csv_edit_conflict");
      assert.deepEqual(error.conflicts, [{ id: f.ids[1], fields: ["title"] }]);
      return true;
    });
    assert.deepEqual(await evidence(f.root, f.ids), before);
    assert.equal((await readUpdateDocument(f.root, f.ids[1])).metadata.title, "Editor A");
    // A later native writer restoring the baseline must not be overwritten by an old committed session.
    await update(f.ids[1], { title: "Terminal" }, { pmRoot: f.root });
    await assert.rejects(applyEditSession(f.root, f.session, editorA, { author: "csv-test" }), refusal("csv_edit_conflict"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a convergent external edit and reordered/subset rows are idempotent", async () => {
  const f = await fixture();
  try {
    await update(f.ids[0], { title: "Convergent" }, { pmRoot: f.root });
    edit(f.table, 1, "title", "Convergent");
    f.table = [f.table[0], f.table[2], f.table[1]];
    const before = await evidence(f.root, f.ids);
    assert.equal((await applyEditSession(f.root, f.session, f.table, { author: "csv-test" })).unchanged, 2);
    assert.deepEqual(await evidence(f.root, f.ids), before);
    assert.equal((await applyEditSession(f.root, f.session, [f.table[0]], { author: "csv-test" })).rows, 0);
    assert.equal((await exportEditSession(f.root, [])).session.rows.length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("conflict diagnostics are bounded and never contain cell values", () => {
  const error = new EditRefusal("csv_edit_conflict", "Re-export", Array.from({ length: 30 }, (_, i) => ({ id: `item-${i}`, fields: ["body"] })));
  assert.equal(error.conflictCount, 30);
  assert.equal(error.conflicts.length, 20);
  assert.match(error.message, /total=30/);
});

test("untrusted session structures and inconsistent field digests fail closed", async () => {
  const f = await fixture();
  try {
    const inputs: unknown[] = [null, {}, [], { ...f.session, version: 2 }, { ...f.session, id: 1 }, { ...f.session, rows: {} },
      { ...f.session, rows: Array(1001).fill(f.session.rows[0]) }, { ...f.session, digest: "stale" }];
    for (const modify of [
      (s: EditSession) => { s.rows.push(s.rows[0]); },
      (s: EditSession) => { s.rows[0].id = "../invalid"; },
      (s: EditSession) => { s.rows[0].status = null as unknown as string; },
      (s: EditSession) => { s.rows[0].revision = "bad"; },
      (s: EditSession) => { s.rows[0].itemDigest = "bad"; },
      (s: EditSession) => { s.rows[0].values.title = 9 as unknown as string; },
      (s: EditSession) => { s.rows[0].digests.body = "bad"; },
    ]) {
      const s = structuredClone(f.session);
      modify(s);
      s.digest = createHash("sha256").update(JSON.stringify({ version: s.version, id: s.id, rows: s.rows })).digest("hex");
      inputs.push(s);
    }
    for (const input of inputs) assert.throws(() => parseEditSession(input), refusal("csv_session_invalid"));
    assert.deepEqual(parseEditSession(f.session), f.session);
    await assert.rejects(exportEditSession(f.root, [f.ids[0].slice(-4)]), refusal("csv_session_invalid"));
    for (const ids of [[...f.ids, f.ids[0]], ["../invalid"], Array(1001).fill(f.ids[0]) as string[]]) {
      await assert.rejects(exportEditSession(f.root, ids), refusal("csv_session_invalid"));
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("altered table schema, identity/digests, lifecycle and invalid values cause zero writes", async () => {
  const f = await fixture();
  try {
    const before = await evidence(f.root, f.ids);
    const mutations = [
      (t: string[][]) => { t.length = 0; },
      (t: string[][]) => { t[0][0] = "renamed"; },
      (t: string[][]) => { t[1].pop(); },
      (t: string[][]) => { t[1][0] = "wrong-session"; },
      (t: string[][]) => { t[1][1] = "missing-id"; },
      (t: string[][]) => { t[1][2] = "stale-revision"; },
      (t: string[][]) => { t[1][3] = "stale-item"; },
      (t: string[][]) => { t[1][6] = "stale-field"; },
      (t: string[][]) => { t.push(t[1]); },
      (t: string[][]) => { edit(t, 2, "status", "open"); },
      (t: string[][]) => { edit(t, 1, "title", " "); },
      (t: string[][]) => { edit(t, 1, "priority", "5"); },
      (t: string[][]) => { edit(t, 1, "assignee", " untrimmed "); },
    ];
    for (const mutate of mutations) {
      const table = structuredClone(f.table);
      mutate(table);
      await assert.rejects(applyEditSession(f.root, f.session, table, { author: "csv-test" }), refusal("csv_edit_invalid"));
    }
    assert.deepEqual(await evidence(f.root, f.ids), before);
    assert.equal(existsSync(join(f.root, "transactions", "sdk")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("missing and history-drifted items refuse with remedies", async () => {
  const f = await fixture();
  try {
    const item = await readUpdateSnapshot(f.root, f.ids[0]);
    writeFileSync(item.located.itemPath, item.raw.replace("First", "Unaudited"));
    await assert.rejects(exportEditSession(f.root, f.ids), refusal("csv_session_invalid"));
    rmSync(item.located.itemPath);
    await assert.rejects(applyEditSession(f.root, f.session, f.table, { author: "csv-test" }), refusal("csv_session_invalid"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a native writer after preflight is checked inside the item lock and prior rows compensate", async () => {
  const f = await fixture();
  try {
    edit(f.table, 1, "title", "First spreadsheet patch");
    edit(f.table, 2, "title", "Second spreadsheet patch");
    let injected = false;
    await assert.rejects(applyEditSession(f.root, f.session, f.table, { author: "csv-test", async onTransition(event) {
      if (event.transition === "step_recorded" && !injected) {
        injected = true;
        await update(f.ids[1], { title: "Native writer wins" }, { pmRoot: f.root });
      }
    } }), refusal("csv_edit_apply_failed"));
    assert.equal(injected, true);
    assert.equal((await readUpdateDocument(f.root, f.ids[0])).metadata.title, "First");
    assert.equal((await readUpdateDocument(f.root, f.ids[1])).metadata.title, "Native writer wins");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("interrupted transaction resumes stable row identities when earlier rows already converged", async () => {
  const f = await fixture();
  try {
    edit(f.table, 1, "sprint", "next");
    edit(f.table, 2, "title", "Terminal retry");
    await assert.rejects(applyEditSession(f.root, f.session, f.table, { author: "csv-test", onTransition(event) {
      if (event.transition === "step_applied") throw new WorkspaceTransactionInterruptedError();
    } }), refusal("csv_edit_apply_failed"));
    const result = await applyEditSession(f.root, f.session, f.table, { author: "csv-test" });
    assert.equal(result.applied, 1);
    assert.equal((await readUpdateDocument(f.root, f.ids[0])).metadata.sprint, "next");
    assert.equal((await readUpdateDocument(f.root, f.ids[1])).metadata.title, "Terminal retry");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("command checkout/apply shares the typed protocol and emits compact data", async () => {
  const f = await fixture();
  const harness = await createExtensionTestHarness(extension, { name: "pm-csv", capabilities: ["commands", "importers", "schema"] });
  try {
    const file = join(f.root, "items.csv");
    await assert.rejects(harness.runCommand({ command: "csv checkout", pmRoot: f.root }), refusal("csv_edit_invalid"));
    await assert.rejects(harness.runCommand({ command: "csv apply", pmRoot: f.root }), refusal("csv_edit_invalid"));
    await assert.rejects(harness.runCommand({ command: "csv apply", args: [file], pmRoot: f.root }), refusal("csv_session_invalid"));
    const exported = await harness.runCommand({ command: "csv checkout", options: { output: file }, pmRoot: f.root });
    assert.ok(JSON.stringify(exported.result).length < 200);
    const table = parseCSV(readFileSync(file, "utf8"));
    assert.equal(table.length, 3);
    assert.ok(table[0].includes("_revision"));
    edit(table, 1, "body", "Command body\nquoted, café");
    writeFileSync(file, "\ufeff" + serializeCSV(table, { delimiter: ",", eol: "\r\n" }) + "\r\n");
    const preview = await harness.runCommand({ command: "csv apply", args: [file], options: { dryRun: true }, pmRoot: f.root });
    assert.equal((preview.result as Record<string, unknown>).applied, 0);
    const applied = await harness.runCommand({ command: "csv apply", args: [file], options: { session: `${file}.session.json` }, global: { author: "csv-test" }, pmRoot: f.root });
    assert.equal((applied.result as Record<string, unknown>).applied, 1);
    assert.ok(JSON.stringify(applied.result).length < 300);
    const selected = join(f.root, "one.csv");
    const selection = await harness.runCommand({ command: "csv checkout", options: { ids: f.ids[1], output: selected }, pmRoot: f.root });
    assert.equal((selection.result as Record<string, unknown>).exported, 1);
    // Existing files must never be overwritten by checkout.
    await assert.rejects(harness.runCommand({ command: "csv checkout", options: { ids: f.ids[1], output: selected }, pmRoot: f.root }), refusal("csv_edit_invalid"));
  } finally { await harness.deactivate(); rmSync(f.root, { recursive: true, force: true }); }
});


test("convergence after preflight skips equal cells inside the item lock", async () => {
  const f = await fixture();
  try {
    edit(f.table, 1, "title", "Converged race");
    edit(f.table, 1, "sprint", "still-patch");
    const result = await applyEditSession(f.root, f.session, f.table, { author: "csv-test", async onTransition(event) {
      if (event.transition === "prepared") await update(f.ids[0], { title: "Converged race" }, { pmRoot: f.root });
    } });
    assert.equal(result.applied, 1);
    const current = await readUpdateDocument(f.root, f.ids[0]);
    assert.equal(current.metadata.title, "Converged race");
    assert.equal(current.metadata.sprint, "still-patch");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("built CLI round trips real non-git tracker data as JSON/TOON with no git executable", async () => {
  const f = await fixture();
  try {
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), join(bin, "pm"));
    symlinkSync(join(process.cwd(), "node_modules"), join(f.root, "node_modules"), "dir");
    const installed = join(f.root, "extensions/pm-csv");
    mkdirSync(installed, { recursive: true });
    cpSync("dist", join(installed, "dist"), { recursive: true });
    cpSync("manifest.json", join(installed, "manifest.json"));
    /** Invoke the pinned host with only Node and pm available on PATH. */
    function pm(args: string[]) {
      return spawnSync(join(bin, "pm"), ["--pm-path", f.root, ...args], {
        cwd: f.root, encoding: "utf8", env: { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: dirname(f.root) },
      });
    }
    const out = pm(["csv", "checkout", "--output", "cli.csv", "--json"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).exported, 2);
    const file = join(f.root, "cli.csv");
    const table = parseCSV(readFileSync(file, "utf8"));
    edit(table, 1, "title", "CLI patch");
    writeFileSync(file, serializeCSV(table, ","));
    const result = pm(["csv", "apply", "cli.csv", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).applied, 1);
    const repeat = pm(["csv", "apply", "cli.csv"]);
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.match(repeat.stdout, /applied: 0/);
    edit(table, 2, "_revision", "invalid");
    writeFileSync(file, serializeCSV(table, ","));
    const rejected = pm(["csv", "apply", "cli.csv", "--json"]);
    assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr);
    assert.match(rejected.stdout + rejected.stderr, /csv_edit_invalid/);
    assert.match(rejected.stdout + rejected.stderr, /Restore item\/revision\/field digests/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test("fully convergent native race reports zero applied rows and appends no patch history", async () => {
  const f = await fixture();
  try {
    edit(f.table, 1, "title", "Native convergence");
    let nativeHistory = "";
    const result = await applyEditSession(f.root, f.session, f.table, { author: "csv-test", async onTransition(event) {
      if (event.transition === "prepared") {
        await update(f.ids[0], { title: "Native convergence" }, { pmRoot: f.root });
        nativeHistory = readFileSync(getHistoryPath(f.root, f.ids[0]), "utf8");
      }
    } });
    assert.equal(result.changed, 1);
    assert.equal(result.applied, 0);
    assert.equal(readFileSync(getHistoryPath(f.root, f.ids[0]), "utf8"), nativeHistory);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

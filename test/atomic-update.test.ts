import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { decode, encode } from "@toon-format/toon";
import {
  commitWorkspaceTransaction, createExtensionCommandSdk, create, getHistoryPath, locateItem,
  mutateItem, PmClient, readHistoryEntries, readSettings, update,
  WorkspaceTransactionInterruptedError,
} from "@unbrained/pm-cli/sdk";
import type { CommitWorkspaceTransactionOptions, WorkspaceTransactionJsonValue, WorkspaceTransactionTransition } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import sourceExtension, { atomicTransactionId } from "../index.ts";
import builtExtension from "../dist/index.js";
import { captureUpdateCompensation, compensateUpdate, inspectUpdate, priorRepresentation, readUpdateDocument, readUpdateSnapshot } from "../atomic-update.ts";

const author = "csv-test";

/** Build real tracker fixtures with distinct absent, empty and populated fields. */
async function fixture(empty = false, allFields = false) {
  const root = mkdtempSync(join(tmpdir(), "csv-prior-"));
  const initialized = spawnSync("pm", ["init", "--defaults", "--path", root], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const parent = await create({ title: "Parent" }, { pmRoot: root });
  const item = await create({ title: "Original", priority: 1, tags: "csv-key:existing,original", body: empty ? "" : "Original body" }, { pmRoot: root });
  const id = item.item.id;
  await mutateItem({ pmRoot: root, settings: await readSettings(root), id, op: "update", author,
    mutate(document) {
      document.metadata.notes = [{ author, created_at: document.metadata.created_at, text: "Keep annotation" }];
      return { changedFields: ["assignee", "dependencies", "notes"] };
    },
  });
  const original = await readUpdateSnapshot(root, id);
  const physical = decode(original.raw) as Record<string, unknown>;
  if (empty) {
    physical.assignee = "";
    physical.dependencies = [];
    physical.body = "";
    writeFileSync(original.located.itemPath, `${encode(physical)}\n`);
  }
  const before = await readUpdateDocument(root, id);
  assert.equal(Object.hasOwn(physical, "assignee"), empty);
  assert.equal(Object.hasOwn(physical, "dependencies"), empty);
  const file = join(root, "batch.csv");
  writeFileSync(file, `title,priority,key,body,tags,deadline,parent,sprint,release,blocked_by,status,type,assignee\nChanged,3,existing,Changed body,added,2027-01-01,${parent.item.id},next,next,${parent.item.id},${empty ? "canceled" : "closed"},Feature,${allFields ? author : ""}\nInvalid,99,new,,,,,,,,open,Task,\n`);
  return { root, id, before, physical, file, marker: `csv-txrow:${atomicTransactionId(file)}#0` };
}

/** Compare domain state exactly, permitting only the append-only mutation time. */
function domain(document: Awaited<ReturnType<typeof readUpdateDocument>>) {
  const { updated_at: _updated, ...metadata } = document.metadata;
  return { metadata, body: document.body };
}

/** Run the real host coordinator with optional transition or step fault injection. */
async function importBatch(
  root: string, file: string,
  instrument: (options: CommitWorkspaceTransactionOptions) => CommitWorkspaceTransactionOptions = options => options,
  built = false,
) {
  const harness = await createExtensionTestHarness(built ? builtExtension : sourceExtension, {
    name: "pm-csv", capabilities: ["commands", "importers", "schema"],
  });
  try {
    const sdk = createExtensionCommandSdk(root, new PmClient({ pmRoot: root }), author);
    return await harness.runCommand({ command: "csv import", args: [file], options: { atomic: true, key: "key", source: "acceptance" },
      pmRoot: root, global: { author },
      sdk: { ...sdk, commitWorkspaceTransaction: options => commitWorkspaceTransaction(instrument({ ...options, pmRoot: root })) },
    });
  } finally {
    await harness.deactivate();
  }
}

for (const empty of [false, true]) {
  test(`built package failure restores prior fields exactly (${empty ? "empty" : "unset"})`, async () => {
    const f = await fixture(empty, true);
    try {
      await assert.rejects(importBatch(f.root, f.file, options => options, true), /Atomic CSV import failed/);
      assert.deepEqual(domain(await readUpdateDocument(f.root, f.id)), domain(f.before));
      const restored = decode((await readUpdateSnapshot(f.root, f.id)).raw) as Record<string, unknown>;
      const { updated_at: _oldTime, ...oldFields } = f.physical;
      const { updated_at: _newTime, ...restoredFields } = restored;
      assert.deepEqual(restoredFields, oldFields);
      const history = await readHistoryEntries(getHistoryPath(f.root, f.id), f.id);
      assert.equal(history.at(-1)?.message, `${f.marker}:compensate`);
      assert.equal(history.at(-1)?.op, "restore");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("prior values are durable before update; compensation replay appends no second restore", async () => {
  const f = await fixture();
  let saved: WorkspaceTransactionJsonValue | undefined;
  try {
    await assert.rejects(importBatch(f.root, f.file, options => ({ ...options, steps: options.steps.map((step, index) => index ? step : {
      ...step,
      async apply() {
        const journal = JSON.parse(readFileSync(join(f.root, "transactions", "sdk", `${atomicTransactionId(f.file)}.json`), "utf8")) as { compensationData: Record<string, WorkspaceTransactionJsonValue> };
        saved = journal.compensationData[step.id];
        assert.ok(saved && typeof saved === "object" && !Array.isArray(saved));
        assert.deepEqual(JSON.parse(String(saved.prior)), f.before);
        const applied = await step.apply();
        const written = await readUpdateDocument(f.root, f.id);
        assert.equal(written.body, "Changed body");
        assert.equal(written.metadata.priority, 3);
        return applied;
      },
    }) })), /Atomic CSV import failed/);
    assert.deepEqual(domain(await readUpdateDocument(f.root, f.id)), domain(f.before));
    const first = await readHistoryEntries(getHistoryPath(f.root, f.id), f.id);
    await compensateUpdate(f.root, f.id, f.marker, author, saved);
    assert.deepEqual(await readHistoryEntries(getHistoryPath(f.root, f.id), f.id), first);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

const transitions: WorkspaceTransactionTransition[] = ["prepared", "step_applied", "step_recorded", "committing", "committed", "compensating", "step_compensating", "step_compensated", "compensated"];
for (const transition of transitions) {
  test(`crash at ${transition} resumes with exact compensation or one committed update`, async () => {
    const f = await fixture();
    let hit = false;
    const success = ["committing", "committed"].includes(transition);
    if (success) writeFileSync(f.file, "title,priority,key\nChanged,3,existing\n");
    try {
      await assert.rejects(importBatch(f.root, f.file, options => ({ ...options,
        onTransition(context) {
          if (context.transition === transition && (!context.stepId || context.stepId.endsWith("row-0"))) {
            hit = true;
            throw new WorkspaceTransactionInterruptedError(`crash ${transition}`);
          }
        },
      })), /Atomic CSV import failed/);
      assert.equal(hit, true);
      if (success) {
        await importBatch(f.root, f.file);
        assert.equal((await readUpdateDocument(f.root, f.id)).metadata.priority, 3);
        const history = await readHistoryEntries(getHistoryPath(f.root, f.id), f.id);
        assert.equal(history.filter(entry => entry.message?.endsWith(":apply")).length, 1);
      } else {
        await assert.rejects(importBatch(f.root, f.file), /Atomic CSV import failed/);
        assert.deepEqual(domain(await readUpdateDocument(f.root, f.id)), domain(f.before));
      }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const phase of ["before-apply", "after-apply", "after-restore"] as const) {
  test(`crash ${phase} crosses journal/mutation gap safely`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(importBatch(f.root, f.file, options => ({ ...options, steps: options.steps.map((step, index) => index ? step : {
        ...step,
        async apply() {
          if (phase === "before-apply") throw new WorkspaceTransactionInterruptedError();
          const result = await step.apply();
          if (phase === "after-apply") throw new WorkspaceTransactionInterruptedError();
          return result;
        },
        async compensate(data) {
          await step.compensate(data);
          throw new WorkspaceTransactionInterruptedError();
        },
      }) })), /Atomic CSV import failed/);
      await assert.rejects(importBatch(f.root, f.file), /Atomic CSV import failed/);
      assert.deepEqual(domain(await readUpdateDocument(f.root, f.id)), domain(f.before));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("concurrent subprocess writer between update and compensation is preserved and refused on resume", async () => {
  const f = await fixture();
  try {
    await assert.rejects(importBatch(f.root, f.file, options => ({ ...options,
      onTransition(context) {
        if (context.transition === "step_applied" && context.stepId?.endsWith("row-0")) {
          const result = spawnSync("pm", ["--path", f.root, "update", f.id, "--body", "Another agent's write", "--message", "independent edit", "--author", "independent-writer"], { encoding: "utf8" });
          assert.equal(result.status, 0, result.stderr);
        }
      },
    })), /concurrent writer; refusing compensation/);
    assert.equal((await readUpdateDocument(f.root, f.id)).body, "Another agent's write");
    await assert.rejects(importBatch(f.root, f.file), /concurrent writer; refusing compensation/);
    assert.equal((await readUpdateDocument(f.root, f.id)).body, "Another agent's write");
    const journal = JSON.parse(readFileSync(join(f.root, "transactions", "sdk", `${atomicTransactionId(f.file)}.json`), "utf8")) as { status: string };
    assert.equal(journal.status, "compensating");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("duplicate existing keys restore in reverse order, including earlier row markers", async () => {
  const f = await fixture();
  writeFileSync(f.file, "title,priority,key\nFirst,3,existing\nSecond,4,existing\nInvalid,99,new\n");
  try {
    await assert.rejects(importBatch(f.root, f.file), /Atomic CSV import failed/);
    assert.deepEqual(domain(await readUpdateDocument(f.root, f.id)), domain(f.before));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy in-flight step format is refused before mutation", async () => {
  const f = await fixture();
  try {
    await assert.rejects(importBatch(f.root, f.file, options => ({ ...options, steps: options.steps.map((step, i) => ({ ...step, id: `csv-import-row-${i}` })),
      onTransition() { throw new WorkspaceTransactionInterruptedError(); },
    })), /Atomic CSV import failed/);
    await assert.rejects(importBatch(f.root, f.file), /journal does not match the supplied plan/);
    assert.deepEqual(domain(await readUpdateDocument(f.root, f.id)), domain(f.before));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("missing, incompatible or tampered prior records refuse restoration", async () => {
  const f = await fixture();
  try {
    const good = await captureUpdateCompensation(f.root, f.id, f.marker, author);
    assert.ok(good && typeof good === "object" && !Array.isArray(good));
    for (const data of [undefined, null, false, [], {}, { ...good, version: 1 }, { ...good, id: "other" }, { ...good, marker: "other" }, { ...good, raw: 1 }, { ...good, format: "unknown" }, { ...good, prior: 1 }, { ...good, historyLength: "0" }, { ...good, historyHash: 1 }]) {
      await assert.rejects(compensateUpdate(f.root, f.id, f.marker, author, data), /incompatible prior values/);
    }
    for (const data of [{ ...good, historyHash: "corrupt" }, { ...good, prior: JSON.stringify({ ...f.before, body: "invented" }) }]) {
      await assert.rejects(compensateUpdate(f.root, f.id, f.marker, author, data), /changed history or state/);
    }
    await assert.rejects(readUpdateDocument(f.root, "missing"), /is missing/);
    // Simulate an unaudited filesystem edit; SDK history verification fails closed.
    await update(f.id, { title: "Independent", message: "external" }, { pmRoot: f.root });
    await assert.rejects(compensateUpdate(f.root, f.id, f.marker, author, good), /concurrent writer/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

/** Install transparent failure injection that always delegates normal PM writes. */
function installFaultPm(root: string) {
  const bin = join(root, "fault-bin");
  mkdirSync(bin);
  const realPm = spawnSync("sh", ["-c", "command -v pm"], { encoding: "utf8" }).stdout.trim();
  const wrapper = join(bin, "pm");
  writeFileSync(wrapper, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const command = args[2];
const mode = process.env.CSV_FAULT_MODE;
if (command === 'close' && mode === 'crash-before-close') { process.kill(process.ppid, 'SIGKILL'); process.exit(1); }
if (mode === command + '-before') { console.error('Injected failure ' + mode); process.exit(1); }
const r = spawnSync(process.env.CSV_REAL_PM, args, { encoding: 'utf8' });
if (command === 'create' && mode === 'create-silent') { process.stdout.write(r.stdout || ''); process.exit(r.status ?? 1); }
process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
if (mode === command + '-after') { console.error('Injected failure ' + mode); process.exit(1); }
process.exit(r.status ?? 1);
`);
  chmodSync(wrapper, 0o755);
  return { bin, realPm };
}

/** Run a built importer in another process with transparent subprocess failures. */
function faultedChild(root: string, file: string, mode: string) {
  const { bin, realPm } = installFaultPm(root);
  const script = `
import extension from './dist/index.js';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import { commitWorkspaceTransaction, createExtensionCommandSdk, PmClient } from '@unbrained/pm-cli/sdk';
const [root, file] = process.argv.slice(1);
const harness = await createExtensionTestHarness(extension, { name: 'pm-csv', capabilities: ['commands','importers','schema'] });
const sdk = createExtensionCommandSdk(root, new PmClient({ pmRoot: root }), 'csv-test');
try { await harness.runCommand({ command: 'csv import', args: [file], options: { atomic: true, key: 'key' }, pmRoot: root,
  global: { author: 'csv-test' }, sdk: { ...sdk, commitWorkspaceTransaction: options => commitWorkspaceTransaction({ ...options, pmRoot: root, lockTtlSeconds: 1 }) } }); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await harness.deactivate(); }
`;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script, root, file], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CSV_REAL_PM: realPm, CSV_FAULT_MODE: mode },
    timeout: 60_000,
  });
}

test("silent real create failure still restores a preceding update exactly", async () => {
  const f = await fixture();
  const { bin, realPm } = installFaultPm(f.root);
  const previous = { PATH: process.env.PATH, CSV_REAL_PM: process.env.CSV_REAL_PM, CSV_FAULT_MODE: process.env.CSV_FAULT_MODE };
  process.env.PATH = `${bin}${delimiter}${previous.PATH}`;
  process.env.CSV_REAL_PM = realPm;
  process.env.CSV_FAULT_MODE = "create-silent";
  try {
    await assert.rejects(importBatch(f.root, f.file), /pm create failed/);
    assert.deepEqual(domain(await readUpdateDocument(f.root, f.id)), domain(f.before));
    const history = await readHistoryEntries(getHistoryPath(f.root, f.id), f.id);
    assert.equal(history.at(-1)?.message, `${f.marker}:compensate`);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const mode of ["update-before", "update-after", "close-before", "close-after"]) {
  test(`built package subprocess failure ${mode} restores exact prior state`, async () => {
    const f = await fixture();
    try {
      const failed = faultedChild(f.root, f.file, mode);
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(failed.stderr, new RegExp(`Injected failure ${mode}`));
      if (mode !== "update-before") {
        const history = await readHistoryEntries(getHistoryPath(f.root, f.id), f.id);
        assert.equal(history.at(-1)?.message, `${f.marker}:compensate`);
      }
      assert.deepEqual(domain(await readUpdateDocument(f.root, f.id)), domain(f.before));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("SIGKILL between update and terminal close compensates from the original journal on restart", async () => {
  const f = await fixture();
  try {
    const killed = faultedChild(f.root, f.file, "crash-before-close");
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    const partial = await readUpdateDocument(f.root, f.id);
    assert.equal(partial.metadata.priority, 3);
    assert.equal(partial.metadata.status, "open");
    await new Promise<void>(resolve => { setTimeout(resolve, 1_100); });
    await assert.rejects(importBatch(f.root, f.file, options => ({ ...options, lockTtlSeconds: 1 })), /compensation required/);
    assert.deepEqual(domain(await readUpdateDocument(f.root, f.id)), domain(f.before));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("history guards cover unaudited edits, absent messages, invalid batch suffixes and terminal states", async () => {
  const f = await fixture();
  try {
    const good = await captureUpdateCompensation(f.root, f.id, f.marker, author);
    await update(f.id, { title: "Independent" }, { pmRoot: f.root });
    await assert.rejects(compensateUpdate(f.root, f.id, f.marker, author, good), /concurrent writer/);
    const next = await captureUpdateCompensation(f.root, f.id, f.marker, author);
    await update(f.id, { title: "Invalid marker", message: `${f.marker}:unknown` }, { pmRoot: f.root });
    await assert.rejects(compensateUpdate(f.root, f.id, f.marker, author, next), /concurrent writer/);
    await mutateItem({ pmRoot: f.root, settings: await readSettings(f.root), id: f.id, op: "update", author, message: `${f.marker}:apply`,
      mutate(document) { document.metadata.status = "canceled"; return { changedFields: ["status"] }; },
    });
    assert.equal((await inspectUpdate(f.root, f.id, f.marker, true)).state, "applied");
    const canceled = await captureUpdateCompensation(f.root, f.id, f.marker, author);
    await update(f.id, { title: "Owned", message: `${f.marker}:apply` }, { pmRoot: f.root });
    await compensateUpdate(f.root, f.id, f.marker, author, canceled);
    await update(f.id, { body: "Edit after restore", message: "another writer" }, { pmRoot: f.root });
    await compensateUpdate(f.root, f.id, f.marker, author, canceled);
    assert.equal((await readUpdateDocument(f.root, f.id)).body, "Edit after restore");
    const located = await locateItem(f.root, f.id);
    assert.ok(located);
    const raw = readFileSync(located.itemPath, "utf8");
    assert.match(raw, /title: Invalid marker/);
    writeFileSync(located.itemPath, raw.replace("title: Invalid marker", "title: Untracked edit"));
    await assert.rejects(captureUpdateCompensation(f.root, f.id, f.marker, author), /unverified history/);
    await assert.rejects(compensateUpdate(f.root, f.id, f.marker, author, canceled), /changed history or state/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const phase of ["canonical_restored", "representation_written", "compensation_recorded"] as const) {
  test(`compensation crash at ${phase} preserves empty representation on restart`, async () => {
    const f = await fixture(true, true);
    try {
      await assert.rejects(importBatch(f.root, f.file, options => ({ ...options, steps: options.steps.map((step, index) => index ? step : {
        ...step,
        compensate: data => compensateUpdate(f.root, f.id, f.marker, author, data, reached => {
          if (reached === phase) throw new WorkspaceTransactionInterruptedError(`crash ${phase}`);
        }),
      }) })), /Atomic CSV import failed/);
      await assert.rejects(importBatch(f.root, f.file), /Atomic CSV import failed/);
      const restored = decode((await readUpdateSnapshot(f.root, f.id)).raw) as Record<string, unknown>;
      assert.equal(restored.assignee, "");
      assert.deepEqual(restored.dependencies, []);
      assert.deepEqual(domain(await readUpdateDocument(f.root, f.id)), domain(f.before));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("representation phase refuses a writer after canonical restoration", async () => {
  const f = await fixture();
  try {
    await assert.rejects(importBatch(f.root, f.file, options => ({ ...options, steps: options.steps.map((step, index) => index ? step : {
      ...step,
      compensate: data => compensateUpdate(f.root, f.id, f.marker, author, data, async reached => {
        if (reached === "canonical_restored") await update(f.id, { body: "Write in representation gap", author: "independent-writer", message: "independent" }, { pmRoot: f.root });
      }),
    }) })), /changed during representation restoration/);
    assert.equal((await readUpdateDocument(f.root, f.id)).body, "Write in representation gap");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("JSON Markdown and nested TOON prior representations retain empty values", () => {
  const metadata = { id: "pm-example", title: "Example", type: "Task", status: "open", assignee: "", dependencies: [], updated_at: "old" };
  const markdown = `${JSON.stringify(metadata)}\n\nBody\n`;
  const restored = decode(priorRepresentation(markdown, "json_markdown", "new")) as Record<string, unknown>;
  assert.equal(restored.updated_at, "new");
  assert.equal(restored.assignee, "");
  assert.deepEqual(restored.dependencies, []);
  const nested = { front_matter: metadata, body: "" };
  assert.deepEqual(decode(priorRepresentation(encode(nested), "toon", "new")), { front_matter: { ...metadata, updated_at: "new" }, body: "" });
});

for (const injection of ["unaudited-current", "tampered-prior"] as const) {
  test(`representation verification refuses ${injection}`, async () => {
    const f = await fixture();
    try {
      const data = await captureUpdateCompensation(f.root, f.id, f.marker, author);
      assert.ok(data && typeof data === "object" && !Array.isArray(data));
      await update(f.id, { title: "Owned update", message: `${f.marker}:apply` }, { pmRoot: f.root });
      const raw = decode(String(data.raw)) as Record<string, unknown>;
      raw.body = "Invented prior body";
      const supplied = injection === "tampered-prior" ? { ...data, raw: encode(raw) } : data;
      await assert.rejects(compensateUpdate(f.root, f.id, f.marker, author, supplied, async phase => {
        if (phase === "canonical_restored" && injection === "unaudited-current") {
          const snapshot = await readUpdateSnapshot(f.root, f.id);
          const edited = decode(snapshot.raw) as Record<string, unknown>;
          edited.body = "Unaudited concurrent edit";
          writeFileSync(snapshot.located.itemPath, encode(edited));
        }
      }), /changed during representation restoration/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("a concurrent writer removing CSV tags cannot retarget compensation on restart", async () => {
  const f = await fixture();
  try {
    await assert.rejects(importBatch(f.root, f.file, options => ({ ...options,
      onTransition(context) {
        if (context.transition === "step_applied" && context.stepId?.endsWith("row-0")) {
          const written = spawnSync("pm", ["--path", f.root, "update", f.id, "--tags", "independent-only", "--author", "independent-writer", "--message", "independent tag replacement"], { encoding: "utf8" });
          assert.equal(written.status, 0, written.stderr);
        }
      },
    })), /concurrent writer; refusing compensation/);
    await assert.rejects(importBatch(f.root, f.file), /concurrent writer; refusing compensation/);
    assert.deepEqual((await readUpdateDocument(f.root, f.id)).metadata.tags, ["independent-only"]);
    const journal = JSON.parse(readFileSync(join(f.root, "transactions", "sdk", `${atomicTransactionId(f.file)}.json`), "utf8")) as { status: string };
    assert.equal(journal.status, "compensating");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { commitWorkspaceTransaction, create, get, getHistoryPath, readHistoryEntries, readSettings, writeSettings, verifyHistoryEntries,
  runWithActiveExtensions, createExtensionCommandSdk, PmClient, getItemPath, serializeItemDocument,
  collectRegisteredItemFieldNames, getActiveExtensionRegistrations, mutateItem, locateItem, readLocatedItem, resolveItemTypeRegistry, emptyImportedDocument } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { importCSV } from "../index.ts";
import { admitCSV, admissionTargetRevision, admissionTargetSequence, withAdmissionTargetChecks } from "../admission.ts";
import { exportEditSession, applyEditSession } from "../roundtrip.ts";
import { applyJoins, previewJoins, JoinRefusal } from "../join-plans.ts";
import type { JoinInput } from "../join-plans.ts";
import { readUpdateSnapshot, captureUpdateCompensation, compensateUpdate } from "../atomic-update.ts";

/** Install a real schema extension in a plain tracker; schema files alone are insufficient. */
async function fixture(format: "toon" | "json_markdown", name: string) {
  const root = mkdtempSync(join(tmpdir(), "csv-extension-"));
  const result = spawnSync(process.execPath, ["node_modules/@unbrained/pm-cli/dist/cli.js", "init", "--defaults", "--path", root], {
    encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
  });
  assert.equal(result.status, 0, result.stderr);
  const settings = await readSettings(root);
  settings.item_format = format;
  settings.schema.unknown_field_policy = "reject";
  await writeSettings(root, settings);
  const installed = join(root, "extensions/fixture-schema");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "manifest.json"), JSON.stringify({ name: "fixture-schema", version: "1.0.0", entry: "./index.ts", capabilities: ["schema"] }));
  writeFileSync(join(installed, "index.ts"), `import { appendFileSync } from "node:fs";
  export default { activate(api: { registerItemTypes: (value: unknown[]) => void; registerItemFields: (value: unknown[]) => void }) {
    appendFileSync(new URL("../../activations.log", import.meta.url), "activate\\n");
    api.registerItemTypes([{ name: "${name}", folder: "fixture-bridges" }]);
    api.registerItemFields([{ name: "opaque_text", type: "string", default: "Extension default" }, { name: "opaque_object", type: "object", default: { nested: [false, 0, "default"] } }]);
  } };\n`);
  const item = await create({ title: "Original", type: name, tags: "csv-key:existing",
    field: ['opaque_text=  Opaque text  ', 'opaque_object={"nested":[false,0,"x"]}'] }, { pmRoot: root });
  await runWithActiveExtensions({ path: root }, async () => {
    const fieldNames = collectRegisteredItemFieldNames(getActiveExtensionRegistrations());
    const located = await locateItem(root, item.item.id, settings.id_prefix, format,
      resolveItemTypeRegistry(settings, getActiveExtensionRegistrations()).type_to_folder);
    assert.ok(located);
    const snapshot = { ...await readLocatedItem(located, { schema: settings.schema, extensionFieldNames: fieldNames }), located };
    if (format === "json_markdown") {
      const target = getItemPath(root, name, item.item.id, format, { [name]: "fixture-bridges" });
      writeFileSync(target, serializeItemDocument(snapshot.document, { format, schema: settings.schema,
        extensionFieldNames: collectRegisteredItemFieldNames(getActiveExtensionRegistrations()) }));
      rmSync(snapshot.located.itemPath);
    }
    assert.equal((await locateItem(root, item.item.id, settings.id_prefix, format, { [name]: "fixture-bridges" }))?.item_format, format);
  });
  return { root, id: item.item.id, file: join(root, "input.csv"), activations: join(root, "activations.log") };
}

for (const format of ["toon", "json_markdown"] as const) for (const injected of [false, true]) {
  test(`installed schema admission preserves opaque fields/history (${format}, ${injected ? "injected" : "direct"})`, async () => {
    const f = await fixture(format, "FixtureBridge");
    const harness = await createExtensionTestHarness(extension, { name: "pm-csv", capabilities: ["commands", "importers", "schema"] });
    try {
      const before = await get(f.id, { full: true }, { pmRoot: f.root });
      const revision = await admissionTargetRevision(f.root, f.id);
      assert.match(revision, /^[a-f0-9]{64}$/);
      writeFileSync(f.file, "title,type,key\nChanged,FixtureBridge,existing\n");
      assert.equal((await admitCSV(f.root, f.file)).admitted, true);
      if (injected) {
        const sdk = createExtensionCommandSdk(f.root, new PmClient({ pmRoot: f.root }), "csv-test");
        const result = await harness.runCommand({ command: "csv import", args: [f.file], pmRoot: f.root,
          options: { atomic: true, admission: true, key: "key" }, sdk });
        assert.equal(result.handled, true);
        assert.equal((result.result as { updated: number }).updated, 1);
      } else {
        const result = await importCSV(f.root, f.file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {}, keyField: "key",
          commitTransaction: options => commitWorkspaceTransaction({ ...options, pmRoot: f.root }) });
        assert.equal(result.updated, 1);
      }
      const historyAfterApply = await readHistoryEntries(getHistoryPath(f.root, f.id), f.id);
      assert.equal((await importCSV(f.root, f.file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {}, keyField: "key",
        commitTransaction: options => commitWorkspaceTransaction({ ...options, pmRoot: f.root }) })).updated, 0);
      assert.deepEqual(await readHistoryEntries(getHistoryPath(f.root, f.id), f.id), historyAfterApply);
      const after = await get(f.id, { full: true }, { pmRoot: f.root });
      assert.equal(after.item.title, "Changed");
      for (const field of ["opaque_text", "opaque_object"]) assert.deepEqual(after.item[field], before.item[field]);
      assert.notEqual(await admissionTargetRevision(f.root, f.id), revision);
      await runWithActiveExtensions({ path: f.root }, async () => {
        const snapshot = await readUpdateSnapshot(f.root, f.id);
        assert.equal(verifyHistoryEntries(await readHistoryEntries(getHistoryPath(f.root, f.id), f.id), snapshot.document).ok, true);
      });
      const admittedRevision = await admissionTargetRevision(f.root, f.id);
      const peer = spawnSync(process.execPath, ["node_modules/@unbrained/pm-cli/dist/cli.js", "--pm-path", f.root, "update", f.id,
        "--title", "Foreign writer", "--author", "peer-test"], { encoding: "utf8" });
      assert.equal(peer.status, 0, peer.stderr);
      await assert.rejects(admissionTargetRevision(f.root, f.id, admittedRevision), /csv_admission_target_changed/);
      const historyBeforeRefusal = await readHistoryEntries(getHistoryPath(f.root, f.id), f.id);
      writeFileSync(f.file, "title,type,key\nGood,FixtureBridge,new\nBad,UnregisteredType,invalid\n");
      assert.equal((await admitCSV(f.root, f.file)).invalidRows, 1);
      await assert.rejects(importCSV(f.root, f.file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {}, keyField: "key",
        commitTransaction: options => commitWorkspaceTransaction({ ...options, pmRoot: f.root }) }), /csv_admission_invalid/);
      assert.equal((await get(f.id, {}, { pmRoot: f.root })).item.title, "Foreign writer");
      assert.deepEqual(await readHistoryEntries(getHistoryPath(f.root, f.id), f.id), historyBeforeRefusal);
    } finally { await harness.deactivate(); rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("explicit target schemas do not bleed between sequential or concurrent workspace calls", async () => {
  const a = await fixture("toon", "BridgeAlpha"), b = await fixture("toon", "BridgeBeta");
  try {
    writeFileSync(a.file, "title,type\nA,BridgeAlpha\n");
    writeFileSync(b.file, "title,type\nB,BridgeAlpha\n");
    for (let i = 0; i < 2; i++) {
      const results = await Promise.all([admitCSV(a.root, a.file), admitCSV(b.root, b.file)]);
      assert.deepEqual(results.map(result => result.admitted), [true, false]);
      assert.match(await admissionTargetRevision(a.root, a.id), /^[a-f0-9]{64}$/);
      assert.match(await admissionTargetRevision(b.root, b.id), /^[a-f0-9]{64}$/);
    }
  } finally { rmSync(a.root, { recursive: true, force: true }); rmSync(b.root, { recursive: true, force: true }); }
});

test("installed fields survive interrupted representation compensation and append-only replay", async () => {
  const f = await fixture("json_markdown", "FixtureBridge");
  try {
    await runWithActiveExtensions({ path: f.root }, async () => {
      const marker = "csv-txrow:extension-recovery#0", before = await readUpdateSnapshot(f.root, f.id);
      const data = await captureUpdateCompensation(f.root, f.id, marker, "csv-test");
      await mutateItem({ pmRoot: f.root, settings: await readSettings(f.root), id: f.id, extensionFieldNames: collectRegisteredItemFieldNames(getActiveExtensionRegistrations()),
        typeToFolder: resolveItemTypeRegistry(await readSettings(f.root), getActiveExtensionRegistrations()).type_to_folder, op: "update", author: "csv-test", message: `${marker}:apply`,
        mutate(document) { document.metadata.title = "Changed"; return { changedFields: ["title"] }; },
      });
      await assert.rejects(compensateUpdate(f.root, f.id, marker, "csv-test", data, phase => {
        if (phase === "representation_written") throw new Error("interrupt representation");
      }), /interrupt representation/);
      await compensateUpdate(f.root, f.id, marker, "csv-test", data);
      const after = await readUpdateSnapshot(f.root, f.id);
      for (const field of ["title", "opaque_text", "opaque_object"]) assert.deepEqual(after.document.metadata[field], before.document.metadata[field]);
      const history = await readHistoryEntries(getHistoryPath(f.root, f.id), f.id);
      assert.equal(history.at(-1)?.message, `${marker}:compensate`);
      assert.equal(verifyHistoryEntries(history, after.document).ok, true);
      await compensateUpdate(f.root, f.id, marker, "csv-test", data);
      assert.deepEqual(await readHistoryEntries(getHistoryPath(f.root, f.id), f.id), history);
    });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

/** Two extension-owned rows exercise complete scope reads and joined rollback. */
function joinInput(explicit: boolean): JoinInput {
  return { version: 1, tables: [{ name: "bridges", key: "key",
    csv: "key,title,type,parent\na,Join first,FixtureBridge,\nb,Join second,FixtureBridge,a\n",
    fields: { title: "title", ...(explicit ? { type: "type" } : {}) },
    references: [{ column: "parent", table: "bridges", kind: "parent" }] }] };
}

for (const explicit of [false, true]) test(`installed extension joins apply, replay and resume compensation (${explicit ? "explicit" : "default"} type)`, async () => {
  const f = await fixture("toon", "FixtureBridge");
  try {
    const settings = await readSettings(f.root);
    settings.governance.create_default_type = "FixtureBridge";
    await writeSettings(f.root, settings);
    const planned = await previewJoins(f.root, joinInput(explicit));
    assert.equal(planned.receipt.ok, true); assert.ok(planned.plan);
    assert.equal((await applyJoins(f.root, planned.plan, { author: "csv-test" })).applied, 2);
    for (const id of planned.plan.ids) {
      const saved = await get(id, { full: true }, { pmRoot: f.root });
      assert.equal(saved.item.type, "FixtureBridge");
      assert.equal(saved.item.opaque_text, "Extension default");
      assert.deepEqual(saved.item.opaque_object, { nested: [false, 0, "default"] });
    }
    assert.equal((await applyJoins(f.root, planned.plan, { author: "csv-test" })).unchanged, 2);
    for (const id of planned.plan.ids) assert.equal((await readHistoryEntries(getHistoryPath(f.root, id), id)).length, 1);

    const failed = await previewJoins(f.root, joinInput(explicit)); assert.ok(failed.plan);
    const ids = failed.plan.ids;
    let interrupted = false;
    await assert.rejects(applyJoins(f.root, failed.plan, { author: "csv-test", onBoundary(phase, id) {
      if (phase === "before_create" && id === ids[1]) throw new Error("Fail second joined row");
      if (phase === "compensation_recorded" && !interrupted) { interrupted = true; throw new Error("Interrupt joined tombstone"); }
    } }), error => error instanceof JoinRefusal && error.code === "csv_join_apply_failed");
    assert.equal(interrupted, true);
    await assert.rejects(applyJoins(f.root, failed.plan, { author: "csv-test" }), error => error instanceof JoinRefusal && error.code === "csv_join_reconcile");
    await assert.rejects(get(ids[0], {}, { pmRoot: f.root }), /was deleted.*history is retained/i);
    const history = await readHistoryEntries(getHistoryPath(f.root, ids[0]), ids[0]);
    assert.deepEqual(history.map(entry => entry.op), ["create", "delete"]);
    assert.equal(verifyHistoryEntries(history, emptyImportedDocument()).ok, true);
    assert.match(JSON.stringify(history[0]), /opaque_object/);
    assert.equal((await readHistoryEntries(getHistoryPath(f.root, ids[1]), ids[1])).length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("installed extension join compensation preserves a separate-process foreign writer", async () => {
  const f = await fixture("toon", "FixtureBridge");
  try {
    const planned = await previewJoins(f.root, joinInput(true)); assert.ok(planned.plan);
    const ids = planned.plan.ids;
    let changed = false;
    await assert.rejects(applyJoins(f.root, planned.plan, { author: "csv-test", onBoundary(phase, id) {
      if (phase !== "before_create" || id !== ids[1]) return;
      const peer = spawnSync(process.execPath, ["node_modules/@unbrained/pm-cli/dist/cli.js", "--pm-path", f.root,
        "update", ids[0], "--field", "opaque_text=Foreign retained", "--author", "peer-test"], { encoding: "utf8" });
      assert.equal(peer.status, 0, peer.stderr); changed = true;
      throw new Error("Fail after foreign update");
    } }), error => error instanceof JoinRefusal && error.code === "csv_join_apply_failed");
    assert.equal(changed, true);
    assert.equal((await get(ids[0], { full: true }, { pmRoot: f.root })).item.opaque_text, "Foreign retained");
    const history = await readHistoryEntries(getHistoryPath(f.root, ids[0]), ids[0]);
    assert.deepEqual(history.map(entry => entry.op), ["create", "update"]);
    await assert.rejects(applyJoins(f.root, planned.plan, { author: "csv-test" }), /csv_join_target_changed/);
    assert.deepEqual(await readHistoryEntries(getHistoryPath(f.root, ids[0]), ids[0]), history);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test("target checks share one activation while standalone revision and sequence activate their workspace", async () => {
  const f = await fixture("toon", "FixtureBridge");
  try {
    writeFileSync(f.activations, "");
    const revision = await admissionTargetRevision(f.root, f.id);
    assert.deepEqual(await admissionTargetSequence(f.root, f.id, revision, []), { revision, completed: -1 });
    assert.equal(readFileSync(f.activations, "utf8").trim().split("\n").length, 2);
    writeFileSync(f.activations, "");
    await withAdmissionTargetChecks(f.root, async checks => {
      for (let i = 0; i < 8; i++) {
        assert.equal(await checks.revision(f.id, revision), revision);
        assert.deepEqual(await checks.sequence(f.id, revision, []), { revision, completed: -1 });
      }
    });
    assert.equal(readFileSync(f.activations, "utf8"), "activate\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const format of ["toon", "json_markdown"] as const) test(`direct spreadsheet APIs activate installed types and preserve opaque fields (${format})`, async () => {
  const f = await fixture(format, "FixtureBridge");
  try {
    const before = await get(f.id, { full: true }, { pmRoot: f.root });
    const exported = await exportEditSession(f.root, [f.id]);
    exported.table[1][exported.table[0].indexOf("title")] = "Direct spreadsheet edit";
    assert.equal((await applyEditSession(f.root, exported.session, exported.table, { author: "csv-test", dryRun: true })).changed, 1);
    assert.equal((await applyEditSession(f.root, exported.session, exported.table, { author: "csv-test" })).applied, 1);
    assert.equal((await applyEditSession(f.root, exported.session, exported.table, { author: "csv-test" })).applied, 0);
    const after = await get(f.id, { full: true }, { pmRoot: f.root });
    assert.equal(after.item.title, "Direct spreadsheet edit");
    for (const field of ["opaque_text", "opaque_object"]) assert.deepEqual(after.item[field], before.item[field]);
    assert.match(await admissionTargetRevision(f.root, f.id), /^[a-f0-9]{64}$/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const admitted of [false, true]) test(`direct atomic import preserves installed fields (${admitted ? "admitted checks reuse activation" : "legacy"})`, async () => {
  const f = await fixture("toon", "FixtureBridge");
  try {
    const before = await get(f.id, { full: true }, { pmRoot: f.root });
    writeFileSync(f.file, "title,type,key\n" + Array.from({ length: 8 }, (_, i) => `Direct ${i},FixtureBridge,existing`).join("\n") + "\n");
    writeFileSync(f.activations, "");
    const result = await importCSV(f.root, f.file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true,
      ...(admitted ? { admission: {} } : {}), keyField: "key",
      commitTransaction: options => commitWorkspaceTransaction({ ...options, pmRoot: f.root }) });
    assert.equal(result.updated, 8);
    const activations = readFileSync(f.activations, "utf8").trim().split("\n").length;
    if (admitted) assert.ok(activations <= 3, `Target checks must not reactivate per row: ${activations}`);
    const after = await get(f.id, { full: true }, { pmRoot: f.root });
    assert.equal(after.item.title, "Direct 7");
    for (const field of ["opaque_text", "opaque_object"]) assert.deepEqual(after.item[field], before.item[field]);
    assert.match(await admissionTargetRevision(f.root, f.id), /^[a-f0-9]{64}$/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { create, get, schemaAddType, schemaAddStatus, readSettings, writeSettings, locateItem, resolveItemTypeRegistry, listAllComplete, readHistoryEntries, getHistoryPath, PmCliError, commitWorkspaceTransaction, generateItemId, deleteItem } from "@unbrained/pm-cli/sdk";
import { previewJoins, applyJoins, JoinRefusal } from "../join-plans.ts";
import type { JoinInput } from "../join-plans.ts";
import { captureSettings, inSettingsTransaction, readPinnedSettings, settingsChangedIn, useSettings, verifySettings, withSettings, withSettingsFence, pinCreateDefaults } from "../settings-snapshot.ts";
import { exportEditSession, applyEditSession, EditRefusal } from "../roundtrip.ts";
import { describeTable, previewTable, importNegotiatedTable, TableSchemaRefusal } from "../table-schema.ts";
import { importLineage, LineageRefusal } from "../lineage.ts";
import type { LineageOptions } from "../lineage.ts";
import { importCSV, CommandError } from "../index.ts";
import { readUpdateDocument } from "../atomic-update.ts";

/** Low-level native lookup needs the tracker's configured custom-type folders. */
async function nativeLocation(root: string, id: string) {
  const settings = await readSettings(root);
  return locateItem(root, id, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder);
}

/** A native tracker outside Git, with a configured type whose default is editable. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "csv-settings-"));
  const init = spawnSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "--defaults", "--path", root], { encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } });
  assert.equal(init.status, 0, init.stderr);
  await schemaAddType("Work", { folder: "work", defaultStatus: "open" }, { pmRoot: root });
  return root;
}
/** Four rows exercise every between-row boundary, including the final commit check. */
function source(): JoinInput {
  return { version: 1, tables: [{ name: "tasks", key: "key", csv: "key,title,type,parent\na,First,Work,\nb,Second,Work,a\nc,Third,Work,b\nd,Fourth,Work,c\n", fields: { title: "title", type: "type" }, references: [{ column: "parent", table: "tasks", kind: "parent" }] }] };
}
/** Require settings drift to stay in the public join refusal family. */
function changed(error: unknown): boolean {
  assert.ok(error instanceof JoinRefusal); assert.equal(error.code, "csv_join_settings_changed"); return true;
}

test("settings changes at every row boundary refuse and compensate without mixed native defaults", { timeout: 180000 }, async () => {
  const root = await fixture();
  try {
    for (let boundary = 0; boundary <= 4; boundary++) {
      await schemaAddType("Work", { folder: "work", defaultStatus: "open" }, { pmRoot: root });
      const oracle = await create({ title: "Native baseline", type: "Work", unset: ["parent"] }, { pmRoot: root });
      const expected = (await get(oracle.item.id, {}, { pmRoot: root })).item.status;
      const baseline = (await listAllComplete({}, { pmRoot: root })).items.length;
      const plan = (await previewJoins(root, source())).plan!; let injected = false;
      await assert.rejects(applyJoins(root, plan, { author: "snapshot-test",
        onBoundary: async (phase, id) => {
          if (boundary === 0 && phase === "before_create" && id === plan.ids[0] && !injected) {
            injected = true; await schemaAddType("Work", { folder: "work", defaultStatus: "in_progress" }, { pmRoot: root });
          }
        },
        onTransition: async event => {
          if (boundary > 0 && event.transition === "step_applied" && event.stepId === plan.ids[boundary - 1] && !injected) {
            injected = true;
            for (const id of plan.ids.slice(0, boundary)) assert.equal((await get(id, {}, { pmRoot: root })).item.status, expected);
            await schemaAddType("Work", { folder: "work", defaultStatus: "in_progress" }, { pmRoot: root });
          }
        },
      }), changed);
      assert.equal(injected, true);
      assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, baseline);
      for (const [index, id] of plan.ids.entries()) {
        assert.equal(await nativeLocation(root, id), null);
        const history = await readHistoryEntries(getHistoryPath(root, id), id);
        assert.equal(history.length, index < boundary ? 2 : 0);
      }
      await assert.rejects(applyJoins(root, plan, { author: "snapshot-test" }), changed);
      const nextOracle = await create({ title: "Native changed default", type: "Work", unset: ["parent"] }, { pmRoot: root });
      const nextExpected = (await get(nextOracle.item.id, {}, { pmRoot: root })).item.status;
      const fresh = (await previewJoins(root, source())).plan!;
      assert.equal((await applyJoins(root, fresh, { author: "snapshot-test" })).applied, 4);
      for (const id of fresh.ids) assert.equal((await get(id, {}, { pmRoot: root })).item.status, nextExpected);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("snapshot scopes isolate trackers and concurrent operations; SDK settings writers contend inside fences", async () => {
  const root = await fixture(), other = await fixture();
  const refuse = () => new Error("Expected settings drift");
  try {
    await schemaAddStatus("other-only", { role: ["active"] }, { pmRoot: other });
    const otherExpected = await readSettings(other);
    const snapshot = await captureSettings(root, refuse);
    await useSettings(root, snapshot, async () => {
      assert.deepEqual(await readPinnedSettings(root), snapshot.settings);
      await withSettings(root, refuse, async () => assert.deepEqual(await readPinnedSettings(root), snapshot.settings));
      await withSettings(other, refuse, async () => assert.deepEqual(await readPinnedSettings(other), otherExpected));
      assert.deepEqual(await readPinnedSettings(other), otherExpected);
      await withSettingsFence(root, async () => {
        await withSettingsFence(root, async () => assert.deepEqual(await readPinnedSettings(root), snapshot.settings));
        await assert.rejects(schemaAddStatus("peer-attempt", { role: ["active"] }, { pmRoot: root }),
          (error: unknown) => error instanceof PmCliError && error.context?.code === "lock_conflict");
      });
      await schemaAddStatus("changed", { role: ["active"] }, { pmRoot: root });
      assert.deepEqual(await readPinnedSettings(root), snapshot.settings);
      await assert.rejects(verifySettings(root), /Expected settings drift/);
      await assert.rejects(withSettingsFence(root, async () => {}), /Expected settings drift/);
    });
    await verifySettings(root);
    assert.notDeepEqual(await readPinnedSettings(root), snapshot.settings);
    const newer = await captureSettings(root, refuse);
    await Promise.all([snapshot, newer].map(value => useSettings(root, value, async () => {
      await Promise.resolve(); assert.deepEqual(await readPinnedSettings(root), value.settings);
    })));
    await withSettingsFence(other, async () => {});
    const settingsPath = join(other, "settings.json"), original = readFileSync(settingsPath, "utf8");
    try {
      await assert.rejects(withSettingsFence(other, async () => {
        // An out-of-band writer is not entitled to bypass the SDK lease silently.
        writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(original), author_default: "changed-peer" }));
      }), (error: unknown) => error instanceof PmCliError && error.code === "csv_settings_changed");
    } finally { writeFileSync(settingsPath, original); }
    const settings = await readSettings(root);
    const oracles = new Map<string, string>();
    for (const type of ["Work", "work", "WORK"]) for (const status of [undefined, "in_progress"]) {
      const native = await create({ title: "Default oracle", type, status, unset: ["parent"] }, { pmRoot: root });
      const value = (await get(native.item.id, {}, { pmRoot: root })).item.status;
      assert.ok(typeof value === "string"); oracles.set(JSON.stringify([type, status]), value);
    }
    for (let seed = 1; seed <= 500; seed++) {
      const type = ["Work", "work", "WORK"][seed % 3];
      const explicit = seed % 2 ? {} : { status: "in_progress" };
      const pinned = pinCreateDefaults({ title: "Seed", type, ...explicit }, settings);
      assert.equal(pinned.status, oracles.get(JSON.stringify([type, explicit.status])));
    }
    for (const configured of ["", "Unknown", "Work"]) {
      const next = await readSettings(root); next.governance.create_default_type = configured;
      await writeSettings(root, next);
      const native = await create({ title: "Configured oracle", unset: ["parent"] }, { pmRoot: root });
      const saved = (await get(native.item.id, {}, { pmRoot: root })).item;
      const pinned = pinCreateDefaults({ title: "Configured oracle" }, await readSettings(root));
      assert.equal(pinned.type, saved.type); assert.equal(pinned.status, saved.status);
    }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test("settings refusal detection follows SDK aggregate/cause graphs without inherited categories", () => {
  const cycle = new Error("cycle"); cycle.cause = cycle;
  for (const value of [undefined, 7, {}, cycle, Object.assign(new Error("numeric"), { code: 7 }), new CommandError("other", 2, "other"), Object.create(Object.assign(new Error("inherited"), { code: "csv_settings_changed" }))]) {
    assert.equal(settingsChangedIn(new AggregateError([value, value], "wrapper")), false);
  }
  const typed = new CommandError("changed", 2, "csv_settings_changed");
  assert.equal(settingsChangedIn(new Error("outer", { cause: new AggregateError([cycle, typed], "nested") })), true);
});

test("a settings change after native persistence still throws and compensates inside the SDK transaction", async () => {
  const root = await fixture();
  try {
    const settings = await readSettings(root), id = await generateItemId(root, settings.id_prefix);
    await assert.rejects(withSettings(root, () => new PmCliError("changed", 2, { code: "csv_settings_changed" }), () => commitWorkspaceTransaction({
      pmRoot: root, transactionId: "snapshot-after-native", author: "snapshot-test", steps: [{ id,
        inspect: async () => ({ state: await nativeLocation(root, id) ? "applied" : "pending" }),
        apply: () => inSettingsTransaction(root, () => withSettingsFence(root, async () => {
          await create(pinCreateDefaults({ id, title: "First", unset: ["parent"] }, settings), { pmRoot: root });
          await schemaAddStatus("during-native", { role: ["active"] }, { pmRoot: root }); return id;
        })),
        compensate: async () => { await deleteItem(id, { force: true }, { pmRoot: root }); },
      }],
    })), (error: unknown) => error instanceof PmCliError && error.code === "csv_settings_changed");
    assert.equal(await nativeLocation(root, id), null);
    assert.equal((await readHistoryEntries(getHistoryPath(root, id), id)).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("input snapshots are captured before SDK reads across joins, lineage, edits and schema imports", async () => {
  const root = await fixture(), previous = process.env.PATH;
  try {
    const selected = source(), original = selected.tables[0].csv;
    const preview = previewJoins(root, selected); selected.tables[0].csv = "changed";
    const plan = (await preview).plan!; assert.equal(plan.input.tables[0].csv, original);
    const ids = [...plan.ids], apply = applyJoins(root, plan, { author: "snapshot-test" });
    plan.input.tables[0].csv = "changed"; plan.ids.length = 0;
    assert.equal((await apply).applied, 4);
    assert.equal((await get(ids[0], {}, { pmRoot: root })).item.title, "First");
    const table = [["title"], ["Lineage original"]], columns: Array<"title"> = ["title"];
    const importing = importLineage(root, table, { columns }); table[1][0] = "Changed"; columns.length = 0;
    const imported = await importing;
    assert.equal((await get(imported.manifest.rows[0].item!, {}, { pmRoot: root })).item.title, "Lineage original");
    const selection = [...ids], checkout = exportEditSession(root, selection); selection.length = 0;
    const edit = await checkout; assert.equal(edit.session.rows.length, 4);
    edit.table[1][edit.table[0].indexOf("title")] = "Edited original";
    const editing = applyEditSession(root, edit.session, edit.table, { author: "snapshot-test" });
    edit.session.rows.length = 0; edit.table.length = 0;
    assert.equal((await editing).applied, 1);
    assert.equal((await get(ids[0], {}, { pmRoot: root })).item.title, "Edited original");
    const bin = join(root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), join(bin, "pm")); process.env.PATH = bin;
    const text = "title,body\nSchema original,Original body\n", schema = (await describeTable(root, text)).schema;
    const negotiated = importNegotiatedTable(root, text, schema); schema.columns.length = 0;
    assert.equal((await negotiated).imported, 1);
    assert.ok((await listAllComplete({ includeBody: true }, { pmRoot: root })).items.some(item => item.title === "Schema original" && item.body === "Original body"));
  } finally { process.env.PATH = previous; rmSync(root, { recursive: true, force: true }); }
});

test("relative tracker selection stays fixed when ambient working directory changes during apply", async () => {
  const root = await fixture(), previous = process.cwd();
  try {
    const alternate = join(root, "alternate"); mkdirSync(alternate);
    process.chdir(dirname(root));
    const plan = (await previewJoins(basename(root), source())).plan!;
    const applying = applyJoins(basename(root), plan, { author: "snapshot-test", onBoundary: phase => {
      if (phase === "before_create") process.chdir(alternate);
    } });
    assert.equal((await applying).applied, 4);
    for (const id of plan.ids) assert.equal((await get(id, {}, { pmRoot: root })).item.id, id);
  } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
});

test("capturing inputs preserves typed refusal families for malformed and sparse tables", async () => {
  const root = await fixture();
  try {
    const id = (await create({ title: "Untouched", unset: ["parent"] }, { pmRoot: root })).item.id;
    const edit = await exportEditSession(root, [id]), history = readFileSync(getHistoryPath(root, id), "utf8");
    const sparse = new Array<string[]>(2);
    for (const value of [undefined, {}, [null], [["title"], [7]], sparse, [["title"], new Array<string>(1)]]) {
      await assert.rejects(importLineage(root, value as string[][], { columns: ["title"] }), (error: unknown) => error instanceof LineageRefusal && error.code === "csv_lineage_invalid");
      await assert.rejects(applyEditSession(root, edit.session, value as string[][], { author: "snapshot-test" }), (error: unknown) => error instanceof EditRefusal && error.code === "csv_edit_invalid");
    }
    for (const options of [undefined, null, {}, { columns: "title" }, { columns: new Array<string>(1) }]) {
      await assert.rejects(importLineage(root, [["title"], ["Unused"]], options as LineageOptions), (error: unknown) => error instanceof LineageRefusal && error.code === "csv_lineage_invalid");
    }
    assert.equal((await get(id, {}, { pmRoot: root })).item.title, "Untouched");
    assert.equal(readFileSync(getHistoryPath(root, id), "utf8"), history);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("all reviewed API boundaries refuse a changed enclosing snapshot before writes", async () => {
  const root = await fixture();
  try {
    const id = (await create({ title: "Original", unset: ["parent"] }, { pmRoot: root })).item.id;
    const edit = await exportEditSession(root, [id]); edit.table[1][edit.table[0].indexOf("title")] = "Edited";
    const text = "title\nNew item\n", schema = (await describeTable(root, text)).schema;
    const join = (await previewJoins(root, source())).plan!;
    const calls: Array<[() => PmCliError, () => Promise<unknown>]> = [
      [() => new JoinRefusal("csv_join_settings_changed", "Review settings"), () => previewJoins(root, source())],
      [() => new JoinRefusal("csv_join_settings_changed", "Review settings"), () => applyJoins(root, join, { author: "snapshot-test" })],
      [() => new LineageRefusal("csv_lineage_settings_changed", "Review settings"), () => importLineage(root, [["title"], ["New item"]], { columns: ["title"] })],
      [() => new EditRefusal("csv_edit_settings_changed", "Review settings"), () => exportEditSession(root, [id])],
      [() => new EditRefusal("csv_edit_settings_changed", "Review settings"), () => applyEditSession(root, edit.session, edit.table, { author: "snapshot-test" })],
      ...[() => describeTable(root, text), () => previewTable(root, text, schema), () => importNegotiatedTable(root, text, schema)].map(run =>
        [() => new TableSchemaRefusal("csv_table_settings_changed", "Review settings"), run] as [() => PmCliError, () => Promise<unknown>]),
    ];
    for (const [index, [refuse, run]] of calls.entries()) {
      const snapshot = await captureSettings(root, refuse);
      await schemaAddStatus(`changed-${index}`, { role: ["active"] }, { pmRoot: root });
      const before = (await listAllComplete({}, { pmRoot: root })).items.length;
      await assert.rejects(useSettings(root, snapshot, run), (error: unknown) => {
        assert.ok(error instanceof PmCliError); assert.equal(error.code, refuse().code); return true;
      });
      assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, before);
      assert.equal((await get(id, {}, { pmRoot: root })).item.title, "Original");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("spreadsheet and atomic CSV batches compensate settings changes before each following row", { timeout: 180000 }, async () => {
  const root = await fixture(), previous = process.env.PATH;
  try {
    const bin = join(root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), join(bin, "pm")); process.env.PATH = bin;
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await create({ title: `Original ${i}`, priority: 2, unset: ["parent"] }, { pmRoot: root })).item.id);
    for (let boundary = 1; boundary <= 3; boundary++) {
      const edit = await exportEditSession(root, ids);
      for (const row of edit.table.slice(1)) row[edit.table[0].indexOf("title")] += " edited";
      let seen = 0;
      await assert.rejects(applyEditSession(root, edit.session, edit.table, { author: "snapshot-test", onTransition: async event => {
        if (event.transition === "step_applied" && ++seen === boundary) await schemaAddStatus(`edit-${boundary}`, { role: ["active"] }, { pmRoot: root });
      } }), (error: unknown) => error instanceof EditRefusal && error.code === "csv_edit_settings_changed");
      for (const [i, id] of ids.entries()) assert.equal((await get(id, {}, { pmRoot: root })).item.title, `Original ${i}`);
    }
    const csv = join(root, "source.csv"); writeFileSync(csv, "title,priority\nOriginal 0,3\nOriginal 1,3\nOriginal 2,3\n");
    for (let boundary = 0; boundary < 3; boundary++) {
      // Each attempt uses fresh bytes so an old committed/compensated journal cannot stand in for this run.
      writeFileSync(csv, readFileSync(csv, "utf8") + "\n");
      await assert.rejects(importCSV(root, csv, { delimiter: ",", dryRun: false, fieldMap: {}, atomic: true, keyField: "title", filter: boundary % 2 ? { priority: 3 } : undefined,
        commitTransaction: options => commitWorkspaceTransaction({ ...options, pmRoot: root, steps: options.steps.map((step, index) => ({ ...step,
          apply: async () => { if (index === boundary) await schemaAddStatus(`atomic-${boundary}`, { role: ["active"] }, { pmRoot: root }); return step.apply(); },
        })) }),
      }), (error: unknown) => error instanceof CommandError && error.code === "csv_settings_changed");
      for (const id of ids) assert.equal((await readUpdateDocument(root, id)).metadata.priority, 2);
    }
  } finally { process.env.PATH = previous; rmSync(root, { recursive: true, force: true }); }
});

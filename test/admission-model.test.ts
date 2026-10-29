import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { create, update, focus, schemaAddStatus, listAllComplete, commitWorkspaceTransaction, runWorkspaceTransactionGc } from "@unbrained/pm-cli/sdk";
import { importCSV, parseCSV, serializeCSV, IMPORT_COLUMNS, buildCsvExport, EXPORT_COLUMNS } from "../index.ts";
import type { CsvImportOptions } from "../index.ts";
import { admitCSV, AdmissionRefusal } from "../admission.ts";
import { readUpdateDocument } from "../atomic-update.ts";

/** A reproducible operation generator, independent of the SDK's normalization. */
function random(seed: number): () => number {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}
/** Compare every native field the legacy CSV mutation adapter touches through SDK readback. */
async function state(root: string, id: string): Promise<unknown> {
  const doc = await readUpdateDocument(root, id);
  const fields = ["title", "type", "status", "priority", "tags", "deadline", "parent", "assignee", "sprint", "release", "blocked_by", "close_reason"];
  return { body: doc.body, ...Object.fromEntries(fields.map(key => [key, doc.metadata[key]])),
    dependencies: doc.metadata.dependencies?.map(edge => ({ id: edge.id, kind: edge.kind })) };
}

/** Import an exported projection in disposable native trackers and compare every selected field against independent SDK creates. */
async function roundTrip(base: string, root: string, oracle: string, csv: string, ordinal: number): Promise<void> {
  const target = join(base, `roundtrip-${ordinal}`), reference = join(base, `roundtrip-reference-${ordinal}`);
  cpSync(root, target, { recursive: true }); cpSync(oracle, reference, { recursive: true });
  try {
    const references = new Map(await Promise.all((await listAllComplete({}, { pmRoot: oracle })).items.map(async item => [item.id, await readUpdateDocument(oracle, item.id)] as const)));
    const table = parseCSV(csv), idColumn = table[0].indexOf("id"); assert.ok(idColumn >= 0);
    assert.deepEqual(new Set(table.slice(1).map(row => row[idColumn])), new Set(references.keys()));
    const source = join(target, "roundtrip.csv"); writeFileSync(source, csv);
    const prior = new Set((await listAllComplete({}, { pmRoot: target })).items.map(item => item.id));
    const journals = new Set((await runWorkspaceTransactionGc(target, { dryRun: true, retentionDays: Infinity })).entries.map(entry => entry.file));
    const options: CsvImportOptions = { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {},
      commitTransaction: input => commitWorkspaceTransaction({ ...input, pmRoot: target }) };
    assert.equal((await importCSV(target, source, options)).imported, references.size);
    const copies = (await listAllComplete({}, { pmRoot: target })).items.filter(item => !prior.has(item.id));
    assert.equal(copies.length, references.size);
    const journal = (await runWorkspaceTransactionGc(target, { dryRun: true, retentionDays: Infinity })).entries.find(entry => !journals.has(entry.file) && basename(entry.file).startsWith("csv-import-"))!;
    const transactionId = basename(journal.file, ".json");
    for (const [index, row] of table.slice(1).entries()) {
      const document = references.get(row[idColumn])!; assert.ok(document);
      const m = document.metadata, marker = `csv-txrow:${transactionId}#${index}`;
      const id = copies.find(item => item.tags?.includes(marker))!.id;
      const userTags = (m.tags ?? []).filter(tag => !["csv-key:", "csv-source:", "csv-tx:", "csv-txrow:"].some(prefix => tag.startsWith(prefix)));
      const scope = { parent: m.parent, assignee: m.assignee, sprint: m.sprint, release: m.release, blockedBy: m.blocked_by };
      const unset = Object.entries({ parent: m.parent, assignee: m.assignee, sprint: m.sprint, release: m.release, blocked_by: m.blocked_by }).filter(([, value]) => value === undefined).map(([field]) => field);
      await create({ id, title: m.title, type: m.type, status: m.status, priority: m.priority, body: document.body, deadline: m.deadline,
        tags: [...userTags, `csv-tx:${transactionId}`, marker].join(","), ...scope, unset: [...unset, "reviewer", "goal", "objective"],
        clearDeps: true, clearFiles: true, clearDocs: true, clearTests: true, author: "pm-csv" }, { pmRoot: reference });
      assert.deepEqual(await state(target, id), await state(reference, id));
    }
    assert.equal((await importCSV(target, source, options)).imported, 0);
    const id = copies[0].id;
    const current = await readUpdateDocument(reference, id);
    const scope = { parent: current.metadata.parent, assignee: current.metadata.assignee, sprint: current.metadata.sprint, release: current.metadata.release, blockedBy: current.metadata.blocked_by };
    const unset = Object.entries({ parent: current.metadata.parent, assignee: current.metadata.assignee, sprint: current.metadata.sprint, release: current.metadata.release, blocked_by: current.metadata.blocked_by }).filter(([, value]) => value === undefined).map(([field]) => field);
    const edit = { body: "Round-trip peer value\r\n tail\n", ...scope, unset: [...unset, "reviewer", "goal", "objective"] };
    await update(id, edit, { pmRoot: target }); await update(id, edit, { pmRoot: reference });
    await assert.rejects(importCSV(target, source, options), error => error instanceof AdmissionRefusal && error.code === "csv_admission_target_changed");
    for (const item of copies) assert.deepEqual(await state(target, item.id), await state(reference, item.id));
  } finally { rmSync(target, { recursive: true, force: true }); rmSync(reference, { recursive: true, force: true }); }
}

test("500 seeded admission/import/export sequences compare SDK state to a native reference, including old inputs and ambient focus", { timeout: 900000 }, async t => {
  const base = mkdtempSync(join(tmpdir(), "csv-admission-model-")), template = join(base, "template");
  const initialized = spawnSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "--defaults", "--path", template],
    { encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(base) } });
  assert.equal(initialized.status, 0, initialized.stderr);
  const pool: { root: string; oracle: string; id: string; file: string; row: string[]; stale: boolean; ambient: string[] }[] = [];
  let operations = 0, exports = 0, roundTrips = 0;
  try {
    for (let seed = 1; seed <= 500; seed++) {
      const rng = random(seed), slot = (seed - 1) % 4;
      let model = pool[slot];
      if (!model) {
        const root = join(base, `target-${slot}`), oracle = join(base, `oracle-${slot}`), file = join(root, "input.csv");
        cpSync(template, root, { recursive: true });
        const custom = (await schemaAddStatus(`custom-${slot}`, { role: [slot % 2 ? "active" : "blocked"] }, { pmRoot: root })).status.id;
        cpSync(root, oracle, { recursive: true });
        const ambient: string[] = [];
        for (let n = 0; n < 2; n++) {
          const options = { id: `ambient-${slot}-${n}`, title: `Ambient ${slot} ${n}`, unset: ["parent", "assignee", "sprint", "release", "blocked_by"], clearDeps: true };
          ambient.push((await create(options, { pmRoot: root })).item.id);
          await create(options, { pmRoot: oracle });
        }
        await focus(ambient[1], {}, { pmRoot: root });
        const parent = slot % 2 ? ambient[0] : "", blocked = slot % 2 ? "" : ambient[1];
        const raw = { title: ` Model ${slot} `, type: "Task", status: custom, priority: String(slot), tags: "Alpha,Beta",
          deadline: "2027-01-02", body: `\n Body ${slot} \r\n tail \n`, parent, assignee: " User ", sprint: " Sprint ", release: " Release ", blocked_by: blocked };
        const row = IMPORT_COLUMNS.map(key => raw[key]);
        writeFileSync(file, serializeCSV([[...IMPORT_COLUMNS], row], { delimiter: ",", eol: "\r\n" }));
        const options: CsvImportOptions = { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {}, commitTransaction: opts => commitWorkspaceTransaction({ ...opts, pmRoot: root }) };
        assert.equal((await importCSV(root, file, options)).imported, 1);
        const list = await listAllComplete({}, { pmRoot: root });
        const id = list.items.find(item => item.title === `Model ${slot}`)!.id;
        const journal = (await runWorkspaceTransactionGc(root, { dryRun: true, retentionDays: Infinity })).entries.find(e => basename(e.file).startsWith("csv-import-"))!;
        const transactionId = basename(journal.file, ".json");
        // The reference transition passes original field values through the SDK itself; protocol tags come from the SDK-owned transaction identity.
        await create({ id, title: raw.title, type: raw.type, status: custom, priority: raw.priority, deadline: raw.deadline, body: raw.body,
          tags: `Alpha,Beta,csv-tx:${transactionId},csv-txrow:${transactionId}#0`,
          parent: parent || undefined, assignee: raw.assignee, sprint: raw.sprint, release: raw.release,
          blockedBy: blocked || undefined, unset: [...(!parent ? ["parent"] : []), ...(!blocked ? ["blocked_by"] : [])], clearDeps: !blocked,
          clearFiles: true, clearDocs: true, clearTests: true }, { pmRoot: oracle });
        model = { root, oracle, id, file, row, stale: false, ambient }; pool[slot] = model;
        assert.deepEqual(await state(root, id), await state(oracle, id));
      }
      const { root, oracle, id, file } = model;
      for (let step = 0; step < 4; step++) {
        await focus(model.ambient[Math.floor(rng() * 2)], {}, { pmRoot: root });
        const operation = Math.floor(rng() * 5);
        writeFileSync(file, serializeCSV([[...IMPORT_COLUMNS], model.row], { delimiter: ",", eol: rng() < .5 ? "\n" : "\r\n" }));
        if (operation === 0) {
          const receipt = await admitCSV(root, file);
          assert.equal(receipt.admitted, true); assert.equal(receipt.rows.value, 1);
        } else if (operation === 1) {
          const receipt = await admitCSV(root, file, { mode: "initial", initialRows: 1 });
          assert.equal(receipt.admitted, false); assert.equal(receipt.rows.kind, "lower_bound");
        } else if (operation === 2) {
          const invoke = () => importCSV(root, file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {},
            commitTransaction: opts => commitWorkspaceTransaction({ ...opts, pmRoot: root }) });
          if (model.stale) await assert.rejects(invoke(), error => error instanceof AdmissionRefusal && error.code === "csv_admission_target_changed");
          else assert.equal((await invoke()).imported, 0);
        } else if (operation === 3) {
          const parent = rng() < .5 ? model.ambient[0] : undefined, blockedBy = rng() < .5 ? model.ambient[1] : undefined;
          const fields = { priority: Math.floor(rng() * 5), body: `Native edit ${seed}-${step}\r\n tail\n`,
            parent, blockedBy, clearDeps: blockedBy === undefined,
            assignee: " User ", sprint: " Sprint ", release: " Release ",
            unset: ["reviewer", "goal", "objective", ...(parent === undefined ? ["parent"] : []), ...(blockedBy === undefined ? ["blocked_by"] : [])] };
          await update(id, fields, { pmRoot: root }); await update(id, fields, { pmRoot: oracle }); model.stale = true;
        } else {
          // Render an actual SDK corpus through the production exporter. Packed/command tests cover process transport separately.
          const packet = await listAllComplete({ includeBody: true }, { pmRoot: root }), stdout = JSON.stringify(packet);
          const exported = buildCsvExport(root, { delimiter: ",", columns: EXPORT_COLUMNS }, () => ({
            pid: 0, status: 0, signal: null, stdout, stderr: "", output: [null, stdout, ""],
          }));
          const output = join(root, "export.csv"); writeFileSync(output, exported.csvText);
          const receipt = await admitCSV(root, output);
          assert.equal(receipt.ok, true); assert.equal(receipt.rows.value, exported.count);
          exports++;
          if (exports % 8 === 0) { roundTrips++; await roundTrip(base, root, oracle, exported.csvText, roundTrips); }
        }
        operations++;
        assert.deepEqual(await state(root, id), await state(oracle, id), `seed=${seed} step=${step} operation=${operation}`);
      }
      if (seed % 100 === 0) t.diagnostic(`sequences=${seed}; operations=${operations}`);
    }
    assert.equal(operations, 2000);
    assert.ok(roundTrips >= 20); t.diagnostic(`exports=${exports}; full SDK-reference round trips=${roundTrips}`);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

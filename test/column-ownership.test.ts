import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { create, update, focus, mutateItem, readSettings, commitWorkspaceTransaction } from "@unbrained/pm-cli/sdk";
import { importCSV, buildCsvExport, parseCSV, serializeCSV, atomicTransactionId } from "../index.ts";
import { readUpdateDocument } from "../atomic-update.ts";
import type { CsvImportOptions } from "../index.ts";

/** Initialize a native tracker outside Git and install only the pinned host executable. */
function fixture(): { base: string; root: string; oracle: string; bin: string } {
  const base = mkdtempSync(join(tmpdir(), "csv-columns-")), root = join(base, "tracker"), oracle = join(base, "oracle"), bin = join(base, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), join(bin, "pm"));
  const initialized = spawnSync(process.execPath, [join(bin, "pm"), "init", "--defaults", "--path", root], {
    encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(base) },
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  return { base, root, oracle, bin };
}
/** Stable seed source; inputs and model transitions do not call package normalizers. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}
/** Read native values without generated mutation/edge clocks; source values remain SDK-defined. */
async function state(root: string, id: string, ignoreEdgeClocks = true) {
  const document = await readUpdateDocument(root, id);
  const { updated_at: _clock, ...metadata } = document.metadata;
  return { metadata: { ...metadata, dependencies: ignoreEdgeClocks ? metadata.dependencies?.map(({ created_at: _edgeClock, ...edge }) => edge) : metadata.dependencies }, body: document.body };
}
/** Invoke the production importer without a Git executable and require every keyed row to update. */
async function ingest(root: string, file: string, table: string[][], key: string, mode: number): Promise<string | undefined> {
  writeFileSync(file, serializeCSV(table, { delimiter: ",", eol: mode % 2 ? "\r\n" : "\n" }));
  const options: CsvImportOptions = { delimiter: ",", fieldMap: {}, dryRun: false, keyField: key, stream: mode % 3 === 1, atomic: mode % 3 === 2,
    commitTransaction: options => commitWorkspaceTransaction({ ...options, pmRoot: root }) };
  const result = await importCSV(root, file, options);
  assert.deepEqual(result.errors, []);
  assert.equal(result.imported, 0);
  assert.equal(result.updated, table.length - 1);
  return options.atomic ? atomicTransactionId(file) : undefined;
}

const FIELDS = ["title", "type", "status", "priority", "tags", "deadline", "body", "parent", "assignee", "sprint", "release", "blocked_by"];
const KEYS = [...FIELDS, "id", "external_key", "custom_code"];

/** Build a simple source-owned patch independently of package mutation builders. */
async function modelEdit(root: string, id: string, row: Record<string, string>, selected: string[], transaction?: string, index = 0): Promise<void> {
  const options: Parameters<typeof update>[1] & Record<string, unknown> = {};
  for (const field of selected) {
    const value = row[field];
    if (!value || !FIELDS.includes(field)) continue;
    if (field === "tags") options.addTags = value.split(",");
    else if (field === "blocked_by") options.blockedBy = value;
    else if (field === "priority") options.priority = Number(value);
    else options[field] = value;
  }
  if (transaction) options.addTags = [...(options.addTags ?? []), `csv-tx:${transaction}`, `csv-txrow:${transaction}#${index}`];
  await update(id, options, { pmRoot: root });
}

test("review regression: title-only keyed updates preserve scope, links, custom fields and status; every header can be the key", { timeout: 300000 }, async () => {
  const f = fixture(), oldPath = process.env.PATH;
  try {
    process.env.PATH = f.bin;
    const parent = (await create({ title: "Parent", unset: ["parent"] }, { pmRoot: f.root })).item.id;
    const id = (await create({ title: "Review case", status: "in_progress", parent, assignee: "Owner", sprint: "Sprint", release: "Release",
      body: " leading body\ntrailing  \n", dep: [`kind=blocked_by,id=${parent}`], doc: ["path=guide.md"],
      tags: "csv-key:review%20case" }, { pmRoot: f.root })).item.id;
    await focus(parent, {}, { pmRoot: f.root });
    const before = await state(f.root, id, false);
    await ingest(f.root, join(f.base, "review.csv"), [["title"], ["Review case"]], "title", 0);
    assert.deepEqual(await state(f.root, id, false), before, "silence preserves: fixed review case");
    // --key accepts any named header, including scalar, relationship and custom/foreign keys.
    for (const [index, key] of KEYS.entries()) {
      const values: Record<string, string> = { title: "Review case", type: "Task", status: "in_progress", priority: "2", tags: "shared",
        deadline: "2030-01-01", body: " leading body\ntrailing  \n", parent, blocked_by: parent, assignee: "Owner", sprint: "Sprint", release: "Release", id };
      const value = values[key] ?? `key-${index}`;
      await update(id, { addTags: [`csv-key:${encodeURIComponent(value.trim().toLowerCase())}`] }, { pmRoot: f.root });
      const selected = key === "title" ? ["title"] : ["title", key];
      const snapshot = await state(f.root, id);
      rmSync(f.oracle, { recursive: true, force: true }); cpSync(f.root, f.oracle, { recursive: true });
      await ingest(f.root, join(f.base, `key-${index}.csv`), [selected, selected.map(column => column === "title" ? "Review case" : value)], key, index % 2);
      // Every key reaches this same target and applies exactly its selected cells.
      await modelEdit(f.oracle, id, Object.fromEntries(selected.map(column => [column, column === "title" ? "Review case" : value])), selected);
      assert.equal((await state(f.root, id)).metadata.id, snapshot.metadata.id);
      assert.deepEqual(await state(f.root, id), await state(f.oracle, id), `key=${key}`);
    }
  } finally { process.env.PATH = oldPath; rmSync(f.base, { recursive: true, force: true }); }
});

test("500 seeded column-ownership sequences obey silence, unchanged roundtrip, exact edits and old-input replay with SDK read-back", { timeout: 2400000 }, async t => {
  const f = fixture(), oldPath = process.env.PATH;
  let sequences = 0, transitions = 0;
  try {
    process.env.PATH = f.bin;
    const parents: string[] = [];
    for (let i = 0; i < 3; i++) parents.push((await create({ title: `Parent ${i}`, unset: ["parent"] }, { pmRoot: f.root })).item.id);
    for (let batch = 0; batch < 25; batch++) {
      const key = ["title", "id", "external_key", "custom_code"][batch % 4];
      const subsetRandom = random(Math.imul(batch + 1, 2654435761));
      const selected = ["title", key, ...FIELDS.filter(field => field !== "title" && subsetRandom() < .6)];
      const headers = [...new Set([...selected, "custom_data"])];
      const rows: { id: string; values: Record<string, string>; original: Record<string, string> }[] = [];
      for (let i = 0; i < 20; i++) {
        const seed = batch * 20 + i + 1, rng = random(seed * 2654435761);
        const title = `Seed ${seed}`, external = `external-${seed}`, custom = `code-${seed}`;
        const created = await create({ title, parent: parents[i % 3], status: "in_progress", priority: i % 5,
          body: ` leading ${seed}\r\ntrailing  \n`, assignee: `Owner-${seed}`, sprint: `Sprint-${seed}`, release: `Release-${seed}`,
          deadline: "2030-01-01", tags: "shared", dep: [`kind=blocked_by,id=${parents[(i + 1) % 3]}`],
          doc: ["path=guide.md"], file: ["path=source.ts"], test: ["command=node --version"] }, { pmRoot: f.root });
        const id = created.item.id;
        const original: Record<string, string> = { title, id, external_key: external, custom_code: custom };
        await update(id, { addTags: [`csv-key:${encodeURIComponent(original[key].toLowerCase())}`] }, { pmRoot: f.root });
        await mutateItem({ pmRoot: f.root, settings: await readSettings(f.root), id, op: "update", author: "column-test", mutate: document => {
          document.metadata.external_key = external;
          document.metadata.custom_code = custom;
          document.metadata.custom_data = { seed, nested: [" untouched ", i] };
          document.metadata.reviewer = `Reviewer-${seed}`;
          document.metadata.goal = `Goal-${seed}`;
          return { changedFields: ["external_key", "custom_code", "custom_data", "reviewer", "goal"] };
        } });
        const values: Record<string, string> = { ...original, type: rng() < .5 ? "Task" : "Feature", status: rng() < .5 ? "open" : "in_progress",
          priority: String(Math.floor(rng() * 5)), tags: `edit-${seed}`, deadline: "2031-02-03", body: ` edited ${seed}\r\n tail  \n`,
          parent: parents[Math.floor(rng() * 3)], assignee: `Edited-${seed}`, sprint: `Edited-${seed}`, release: `Edited-${seed}`,
          blocked_by: parents[Math.floor(rng() * 3)], custom_data: "must remain read-only" };
        // Explicit empty cells preserve existing values; each batch has a random subset header.
        for (const field of headers) if (field !== "title" && field !== key && rng() < .3) values[field] = "";
        rows.push({ id, values, original });
      }
      // Clone only initial public SDK state; the reference then evolves through native updates.
      rmSync(f.oracle, { recursive: true, force: true }); cpSync(f.root, f.oracle, { recursive: true });
      const older = [headers, ...rows.map(row => headers.map(field => row.values[field] ?? ""))];
      const preservedEdges = await Promise.all(rows.map(async row => (await readUpdateDocument(f.root, row.id)).metadata.dependencies));
      await focus(parents[(batch + 1) % 3], {}, { pmRoot: f.root });
      const subsetTransaction = await ingest(f.root, join(f.base, `subset-${batch}.csv`), older, key, batch);
      for (const [index, row] of rows.entries()) {
        await modelEdit(f.oracle, row.id, row.values, headers, subsetTransaction, index);
        assert.deepEqual(await state(f.root, row.id), await state(f.oracle, row.id), `silence/exact edits seed=${++sequences}`);
        if (!headers.includes("blocked_by") || !row.values.blocked_by) {
          assert.equal(JSON.stringify((await readUpdateDocument(f.root, row.id)).metadata.dependencies), JSON.stringify(preservedEdges[index]), `byte-identical silent edges seed=${sequences}`);
        }
        transitions++;
      }
      // Export all native and custom fields, but reimport only this batch's rows.
      const columns = [...FIELDS, "id", "custom_code", "custom_data", "external_key"];
      const exported = parseCSV(buildCsvExport(f.root, { columns, delimiter: ",", crlf: batch % 2 === 1 }).csvText, ",");
      const exportedRows = exported.slice(1).filter(row => rows.some(target => target.id === row[columns.indexOf("id")]));
      const roundtripBefore = await Promise.all(rows.map(row => state(f.root, row.id, false)));
      await ingest(f.root, join(f.base, `roundtrip-${batch}.csv`), [columns, ...exportedRows], key, batch % 2);
      for (const [index, row] of rows.entries()) {
        assert.deepEqual(await state(f.root, row.id), await state(f.oracle, row.id), `unchanged roundtrip seed=${row.original.title}`);
        assert.deepEqual(await state(f.root, row.id, false), roundtripBefore[index], `byte-identical roundtrip values/edges seed=${row.original.title}`);
        transitions++;
      }
      const editHeaders = [...new Set(["title", key, "priority", "assignee", "body", "parent", "sprint", "release", "blocked_by"])];
      const edits = rows.map(row => ({ ...row.original, title: key === "title" ? row.original.title : `${row.original.title} later`, priority: String((batch + 2) % 5), assignee: `Later-${batch}`, body: ` later ${batch}\r\n kept  \n`,
        parent: batch % 2 ? "none" : parents[2], sprint: batch % 2 ? "none" : "Later", release: batch % 2 ? "none" : "Later", blocked_by: parents[0] }));
      const editTransaction = await ingest(f.root, join(f.base, `edit-${batch}.csv`), [editHeaders, ...edits.map(row => editHeaders.map(field => row[field as keyof typeof row] ?? ""))], key, batch + 2);
      for (const [i, row] of rows.entries()) { await modelEdit(f.oracle, row.id, edits[i], editHeaders, editTransaction, i);
        assert.deepEqual(await state(f.root, row.id), await state(f.oracle, row.id), `explicit edits seed=${row.original.title}`); transitions++; }
      const replayTransaction = await ingest(f.root, join(f.base, `older-${batch}.csv`), older, key, batch + 3);
      for (const [index, row] of rows.entries()) { await modelEdit(f.oracle, row.id, row.values, headers, replayTransaction, index);
        assert.deepEqual(await state(f.root, row.id), await state(f.oracle, row.id), `older replay seed=${row.original.title}`); transitions++; }
      t.diagnostic(`column sequences=${sequences}; transitions=${transitions}; seeds=1..${sequences}`);
    }
    assert.equal(sequences, 500); assert.equal(transitions, 2000);
  } finally { process.env.PATH = oldPath; rmSync(f.base, { recursive: true, force: true }); }
});

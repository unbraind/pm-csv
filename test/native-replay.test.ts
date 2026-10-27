import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { create, commitWorkspaceTransaction, getHistoryPath, readSettings, normalizeItemId, normalizeParentReferenceValue } from "@unbrained/pm-cli/sdk";
import { importCSV, importLineage, serializeCSV, IMPORT_COLUMNS } from "../index.ts";
import { buildMutationIntent, matchesMutationScope, normalizeMutationInput, normalizeMutationReference, normalizeMutationParent } from "../mutation-intent.ts";
import { applyEditSession, exportEditSession } from "../roundtrip.ts";
import { previewJoins, applyJoins } from "../join-plans.ts";
import { describeTable, importNegotiatedTable } from "../table-schema.ts";
import { readUpdateDocument } from "../atomic-update.ts";

/** A real native tracker with no Git executable and an independent SDK oracle. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "csv-native-replay-")), root = join(base, "tracker"), bin = join(base, "bin");
  mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), join(bin, "pm"));
  const result = spawnSync(process.execPath, [join(bin, "pm"), "init", "--defaults", "--path", root], {
    encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(base) },
  });
  assert.equal(result.status, 0, result.stderr);
  return { base, root, bin };
}
/** Preserve clocks and history so a successful replay must truly perform zero writes. */
async function evidence(root: string, ids: string[]) {
  return Promise.all(ids.map(async id => [await readUpdateDocument(root, id), readFileSync(getHistoryPath(root, id), "utf8")]));
}
/** Stable operation generator; SDK read-back, rather than package helpers, supplies expected state. */
function random(seed: number): () => number {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}

test("native reference forms compare like SDK writes, including bare/prefixed/hash IDs, remote case, clears and custom prefixes", async () => {
  const f = fixture();
  try {
    const settings = await readSettings(f.root);
    const parent = (await create({ id: "abcd", title: "Parent", unset: ["parent"] }, { pmRoot: f.root })).item.id;
    for (const value of ["abcd", "#ABCD", ` ${parent.toUpperCase()} `, "github:Owner/Repo#12", "https://Example.COM/A", "none", " NuLl "]) {
      const options = { title: "Native reference", parent: value, assignee: "\tCafé 😀 ", sprint: " Sprint ", release: " Release " };
      // The oracle is the SDK write itself, independent of our comparison adapter.
      const saved = await create(options, { pmRoot: f.root });
      const document = await readUpdateDocument(f.root, saved.item.id);
      assert.equal(matchesMutationScope(document, options, settings), true, value);
      assert.equal(matchesMutationScope(document, { ...options, parent: "https://Other.COM/A" }, settings), false);
    }
    const linked = await create({ title: "Native dependency", dep: ["kind=related,id=#ABCD"], unset: ["parent"] }, { pmRoot: f.root });
    assert.equal(matchesMutationScope(await readUpdateDocument(f.root, linked.item.id), {}, settings, [{ id: "#ABCD", kind: "related" }]), true);
    assert.equal(normalizeMutationInput({ parent: "#ABCD" }, { ...settings, id_prefix: "custom" }).parent, "custom-abcd");
    assert.equal(normalizeMutationReference("#ABCD", "custom", { normalizeItemId }), "custom-abcd");
    assert.equal(normalizeMutationParent(" #ABCD ", "custom", { normalizeParentReferenceValue }), "#ABCD");
    assert.equal(normalizeMutationInput({}, settings, "patch").parent, undefined);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("unchanged atomic CSV with every importable field and accepted native forms succeeds with zero replay writes", { timeout: 600000 }, async () => {
  const f = fixture(), oldPath = process.env.PATH;
  try {
    process.env.PATH = f.bin;
    const parent = (await create({ id: "abcd", title: "Parent", unset: ["parent"] }, { pmRoot: f.root })).item.id;
    // Fixed review reproduction: no key or other columns can mask bare-parent recovery.
    const file = join(f.base, "review.csv"); writeFileSync(file, "title,parent\nChild,abcd\n");
    const options = { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true,
      commitTransaction: (options: Omit<Parameters<typeof commitWorkspaceTransaction>[0], "pmRoot">) => commitWorkspaceTransaction({ ...options, pmRoot: f.root }) };
    assert.equal((await importCSV(f.root, file, options)).imported, 1);
    assert.equal((await importCSV(f.root, file, options)).imported, 0, "bare-parent review case");
    const refs = ["abcd", "#ABCD", parent.toUpperCase(), ` ${parent} `, "none", " NuLl "];
    const scopes = ["none", " NuLl ", " Owner ", "Café 😀", "\tMiXeD\t", ""];
    const rows = Array.from({ length: 12 }, (_, i) => [`Replay ${i}`, ["Task", "task"][i % 2], ["open", "todo", "doing", "blocked"][i % 4],
      String(i % 5), " Alpha,α,ALPHA ", "2030-01-01", `\n\n Body ${i}\nUnicode 😀  \n`, refs[i % refs.length], scopes[i % scopes.length], scopes[(i + 1) % scopes.length], scopes[(i + 2) % scopes.length], refs[(i + 1) % refs.length]]);
    assert.equal(rows[0].length, IMPORT_COLUMNS.length, "the matrix owns every importable field");
    const matrix = join(f.base, "matrix.csv"); writeFileSync(matrix, serializeCSV([[...IMPORT_COLUMNS], ...rows], { delimiter: ",", eol: "\r\n" }));
    assert.equal((await importCSV(f.root, matrix, options)).imported, rows.length);
    const exported = spawnSync(join(f.bin, "pm"), ["--path", f.root, "list", "--all", "--full", "--json"], { encoding: "utf8" });
    assert.equal(exported.status, 0, exported.stderr);
    const ids = (JSON.parse(exported.stdout) as { items: { id: string }[] }).items.map(item => item.id);
    const before = await evidence(f.root, ids);
    assert.equal((await importCSV(f.root, matrix, options)).imported, 0);
    assert.deepEqual(await evidence(f.root, ids), before);
    // Every legacy engine and schema negotiation also accepts its unchanged keyed input.
    const keyed = { ...options, atomic: false, keyField: "title" };
    for (const stream of [false, true]) {
      assert.deepEqual((await importCSV(f.root, matrix, { ...keyed, stream })).errors, []);
      const settled = (await evidence(f.root, ids)).map(([document]) => document);
      assert.deepEqual((await importCSV(f.root, matrix, { ...keyed, stream })).errors, []);
      const current = (await evidence(f.root, ids)).map(([document]) => document);
      // Native no-op updates leave even updated_at unchanged.
      assert.deepEqual(current, settled);
    }
    // Negotiated schemas require canonical type names, while the legacy importer accepts aliases.
    const csv = serializeCSV([[...IMPORT_COLUMNS], ...rows.map(row => row.map((value, i) => i === 1 ? "Task" : value))], ","), schema = (await describeTable(f.root, csv)).schema;
    assert.equal((await importNegotiatedTable(f.root, csv, schema, { keyField: "title" })).updated, rows.length);
  } finally { process.env.PATH = oldPath; rmSync(f.base, { recursive: true, force: true }); }
});

test("500 seeded accepted-value sequences replay joins and lineage without SDK state changes", { timeout: 600000 }, async () => {
  // Bound each native corpus so graph/index work does not grow quadratically.
  // Each seed still imports and replays both APIs, including immutable history.
  for (let batch = 0; batch < 20; batch++) {
    const f = fixture();
    try {
      const variants = ["none", "null", " NONE ", "\tNuLl\t", "Café 😀", " MiXeD ", "e\u0301", ""];
      const table = [["key", "title", "body", "type", "status", "priority", "tags", "assignee", "sprint", "release", "estimatedMinutes", "acceptanceCriteria"]];
      for (let seed = batch * 25 + 1; seed <= (batch + 1) * 25; seed++) {
        const rng = random(seed), pick = () => variants[Math.floor(rng() * variants.length)];
        table.push([`k${seed}`, `Seed ${seed} café`, `\n\nBody ${seed}\r\n😀  \n`, "Task", "open", String(seed % 5), " A,a,α ", pick(), pick(), pick(), String(seed % 100), `One ${seed};Two 😀`]);
      }
      const fields = Object.fromEntries(table[0].slice(1).map(field => [field, field]));
      const preview = await previewJoins(f.root, { version: 1, tables: [{ name: "tasks", key: "key", csv: serializeCSV(table, ","), fields, references: [] }] });
      assert.ok(preview.plan); assert.equal((await applyJoins(f.root, preview.plan, { author: "replay-test" })).applied, 25);
      const before = await evidence(f.root, preview.plan.ids);
      assert.equal((await applyJoins(f.root, preview.plan, { author: "replay-test" })).unchanged, 25);
      assert.deepEqual(await evidence(f.root, preview.plan.ids), before);
      // Lineage has its own stable keys and hashes, and exposes nine native fields.
      const columns = ["title", "body", "type", "status", "priority", "tags", "assignee", "sprint", "release"] as const;
      const lineage = [[...columns], ...table.slice(1).map(row => columns.map(field => row[table[0].indexOf(field)]))];
      const imported = await importLineage(f.root, lineage, { columns }); assert.equal(imported.receipt.imported, 25);
      const ids = imported.manifest.rows.map(row => row.item!); const saved = await evidence(f.root, ids);
      assert.equal((await importLineage(f.root, lineage, { columns })).receipt.replayed, 25);
      assert.deepEqual(await evidence(f.root, ids), saved);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  }
  console.log("native accepted-value seeds=1..500; join sequences=500; lineage sequences=500; unchanged SDK reads=1000");
});

test("edit-session replay canonicalizes every stored field with the SDK, including leading blank body lines and literal sentinels", async () => {
  const f = fixture();
  try {
    const created = await create(buildMutationIntent({ title: "Original" }), { pmRoot: f.root });
    const checkout = await exportEditSession(f.root, [created.item.id]);
    for (const [field, value] of Object.entries({ title: "Café 😀", body: "\n\nEdited body 😀  \n", priority: "0", assignee: "none", sprint: "null", release: "MiXeD" })) {
      checkout.table[1][checkout.table[0].indexOf(field)] = value;
    }
    assert.equal((await applyEditSession(f.root, checkout.session, checkout.table, { author: "replay-test" })).applied, 1);
    const before = await evidence(f.root, [created.item.id]);
    assert.equal((await applyEditSession(f.root, checkout.session, checkout.table, { author: "replay-test" })).unchanged, 1);
    assert.deepEqual(await evidence(f.root, [created.item.id]), before);
    const document = await readUpdateDocument(f.root, created.item.id);
    assert.equal(document.metadata.assignee, "none", "stored snapshots do not interpret command sentinels");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

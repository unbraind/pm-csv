/** Measure negotiation on a read-only public tracker copy, with no git on the feature path. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { listAllComplete, inspectCompleteListResult } from "@unbrained/pm-cli/sdk";
import { serializeCSV, parseCSV, stripBOM } from "../index.ts";
import { describeTable, previewTable, importNegotiatedTable, TableSchemaRefusal } from "../table-schema.ts";

/** Verify permissions and hash all source files, including item history and settings. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  assert.equal(statSync(root).mode & 0o222, 0);
  const entries = readdirSync(root, { recursive: true, withFileTypes: true }).sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)));
  for (const entry of entries) {
    const file = join(entry.parentPath, entry.name);
    assert.equal(entry.isSymbolicLink(), false);
    assert.equal(statSync(file).mode & 0o222, 0);
    hash.update(file.slice(root.length));
    if (entry.isFile()) hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

const input = process.argv[2];
assert.ok(input, "Provide a read-only public tracker copy; never a live tracker.");
const source = resolve(input);
const before = fingerprint(source);
const scratch = mkdtempSync(join(tmpdir(), "csv-schema-validation-"));
const oldPath = process.env.PATH;
const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
try {
  process.env.PATH = "";
  process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
  const corpus = await listAllComplete({ includeBody: true }, { pmRoot: source });
  assert.equal(inspectCompleteListResult(corpus).ok, true);
  const table = [["title", "type", "status", "priority", "body", "id"], ...corpus.items.map(item => [item.title, item.type,
    item.status, item.priority === undefined ? "" : String(item.priority), typeof item.body === "string" ? item.body : "", item.id])];
  const started = performance.now();
  const text = `${serializeCSV(table, ",")}\n`;
  const { schema, receipt } = await describeTable(source, text);
  assert.equal((await previewTable(source, text, schema)).rows, corpus.items.length);
  assert.equal((await importNegotiatedTable(source, text, schema, { dryRun: true })).imported, 0);
  let fixtureCount = 0;
  for (const delimiter of [",", ";", "\t", "|"]) for (const bom of [false, true]) for (const eol of ["\n", "\r\n"] as const) {
    const encoded = `${bom ? "\uFEFF" : ""}${serializeCSV(table, { delimiter, eol })}${eol}`;
    assert.deepEqual(parseCSV(stripBOM(encoded), delimiter), table);
    const described = await describeTable(source, encoded, { delimiter });
    assert.equal((await previewTable(source, encoded, described.schema)).rows, corpus.items.length);
    fixtureCount++;
  }
  let driftRefusals = 0;
  for (const changed of [text.replace("title,", "Summary,"), text.replace("title,type,", "type,title,"), `\uFEFF${text}`]) {
    await assert.rejects(previewTable(source, changed, schema), (error: unknown) => error instanceof TableSchemaRefusal && error.code === "csv_schema_changed");
    driftRefusals++;
  }
  assert.equal(fingerprint(source), before);
  console.log(JSON.stringify({ publicItems: corpus.items.length, rows: receipt.rows, columns: receipt.columns,
    mapped: receipt.mapped, ignored: receipt.ignored, csvBytes: Buffer.byteLength(text), schemaBytes: Buffer.byteLength(JSON.stringify(schema)),
    receiptBytes: Buffer.byteLength(JSON.stringify(receipt)), fixtures: fixtureCount, roundTrippedCells: corpus.items.length * table[0].length * fixtureCount,
    driftRefusals, sourceUnchanged: true, trackerWrites: 0, gitAvailable: false, elapsedMs: Math.round(performance.now() - started) }));
} finally {
  process.env.PATH = oldPath;
  if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
  rmSync(scratch, { recursive: true, force: true });
}

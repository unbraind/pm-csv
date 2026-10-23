import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter as pathDelimiter } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { create, update, listAllComplete } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { serializeCSV, parseCSV, stripBOM } from "../index.ts";
import { describeTable, previewTable, parseTableSchema, importNegotiatedTable, TableSchemaRefusal } from "../table-schema.ts";
import type { TableSchema, TableRefusalCode } from "../table-schema.ts";

/** Real initialized non-git tracker; no SDK doubles. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "csv-schema-"));
  const result = spawnSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "--defaults", "--path", root], {
    encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
  });
  assert.equal(result.status, 0, result.stderr);
  return root;
}

/** Hash every file, including settings, documents and history, to detect preview side effects. */
function snapshot(root: string): string {
  return createHash("sha256").update(JSON.stringify(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => [join(entry.parentPath, entry.name).slice(root.length), readFileSync(join(entry.parentPath, entry.name), "utf8")]).sort())).digest("hex");
}

/** Assert structured refusals expose the code and useful remedy without leaking cell data. */
function refusal(code?: TableRefusalCode) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof TableSchemaRefusal);
    if (code) assert.equal(error.code, code);
    assert.equal(error.context.code, error.code);
    assert.equal(error.exitCode, 2);
    assert.ok(error.remedy.length > 30);
    assert.doesNotMatch(error.message, /SENSITIVE_VALUE/);
    return true;
  };
}

/** Recompute an intentionally approved contract to exercise validation independent of checksum protection. */
function signed(schema: TableSchema): TableSchema {
  const { revision: _old, ...base } = schema;
  return { ...base, revision: createHash("sha256").update(JSON.stringify(base)).digest("hex") };
}

test("saved mapping rejects renamed/reordered/added headers and dialect drift; preview leaves every tracker byte unchanged without git", async () => {
  const root = fixture();
  const savedPath = process.env.PATH;
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    await create({ title: "Existing tracker item" }, { pmRoot: root });
    process.env.PATH = "";
    process.env.GIT_CEILING_DIRECTORIES = dirname(root);
    const text = 'Summary,priority,secret\n"A quoted, title",2,SENSITIVE_VALUE\n';
    const before = snapshot(root);
    const { schema, receipt } = await describeTable(root, text, { autoMap: true });
    assert.equal(schema.columns[0].field, "title");
    assert.equal(schema.columns[2].field, null);
    assert.deepEqual([receipt.rows, receipt.mapped, receipt.ignored], [1, 2, 1]);
    assert.deepEqual(await previewTable(root, text, JSON.parse(JSON.stringify(schema)) as unknown), receipt);
    assert.deepEqual(await importNegotiatedTable(root, text, schema, { dryRun: true }), { ...receipt, imported: 0, updated: 0, skipped: 0 });
    for (const changed of [text.replace("Summary", "Name"), text.replace("Summary,priority", "priority,Summary"), text.replace("secret", "extra"), `\uFEFF${text}`, text.replaceAll("\n", "\r\n")]) {
      await assert.rejects(previewTable(root, changed, schema), refusal("csv_schema_changed"));
      await assert.rejects(importNegotiatedTable(root, changed, schema), refusal("csv_schema_changed"));
    }
    assert.equal(snapshot(root), before);
    assert.doesNotMatch(JSON.stringify({ schema, receipt }), /SENSITIVE_VALUE|quoted, title/);
    assert.ok(JSON.stringify(receipt).length < 200);
  } finally {
    process.env.PATH = savedPath;
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
    rmSync(root, { recursive: true, force: true });
  }
});

test("quoted BOM/delimiter fixtures serialize and negotiate losslessly including embedded line endings", async () => {
  const root = fixture();
  try {
    for (const delimiter of [",", ";", "\t", "|"]) for (const eol of ["\n", "\r\n"] as const) for (const bom of [false, true]) {
      const table = [["title", "body", "priority"], [`Quote " and ${delimiter} café 😀`, "line one\r\nline two\nlast", "2"]];
      const text = `${bom ? "\uFEFF" : ""}${serializeCSV(table, { delimiter, eol })}${eol}`;
      assert.deepEqual(parseCSV(stripBOM(text), delimiter), table);
      const { schema } = await describeTable(root, text, { delimiter });
      assert.deepEqual(schema.dialect, { delimiter, quote: '"', bom, eol: eol === "\n" ? "lf" : "crlf" });
      assert.equal((await previewTable(root, text, schema)).rows, 1);
    }
    const { schema } = await describeTable(root, "title");
    assert.equal(schema.dialect.eol, "none");
    assert.equal((await previewTable(root, "title", schema)).rows, 0);
    for (const delimiter of ["tab", "semicolon", "pipe", "comma"]) {
      const char = ({ tab: "\t", semicolon: ";", pipe: "|", comma: "," })[delimiter]!;
      assert.equal((await describeTable(root, `title${char}priority\nTask${char}2`, { delimiter })).schema.dialect.delimiter, char);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("full-column domains refuse widening and new nulls; text, numeric subsets and declared nulls remain reusable", async () => {
  const root = fixture();
  try {
    const source = "title,integer,decimal,boolean,empty,nullable\nTask,2,2.5,true,,3\nOther,4,3.5,false,,\n";
    const { schema } = await describeTable(root, source);
    assert.deepEqual(schema.columns.map(column => column.domain.kind), ["text", "integer", "decimal", "boolean", "empty", "integer"]);
    for (const changed of [source.replace(",2,", ",2.1,"), source.replace(",2,", ",,"), source.replace("true", "perhaps"), source.replace("true,,", "true,new,"), source.replace("2.5", "nan")]) {
      await assert.rejects(previewTable(root, changed, schema), refusal("csv_domain_changed"));
    }
    assert.equal((await previewTable(root, source.replace("2.5", "2").replace("3.5", "3"), schema)).rows, 2);
    assert.equal((await previewTable(root, source.replace("Task", "Different"), schema)).rows, 2);
    assert.equal((await previewTable(root, source.replace(",3\n", ",\n"), schema)).rows, 2);
    assert.equal((await describeTable(root, "title,extra\nX,+2\nY,-4")).schema.columns[1].domain.kind, "integer");
    assert.equal((await describeTable(root, "title,extra\nX,.5\nY,-4.")).schema.columns[1].domain.kind, "decimal");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed CSV, unsupported mappings and invalid pm values refuse with typed remedies before writes", async () => {
  const root = fixture();
  try {
    const before = snapshot(root);
    const malformed = ["", 'title\n"unclosed', 'ti"tle\nTask', 'title\n"closed"tail', "title\rTask", "title\nX\r\n", "title,title\nX,Y", "title, TITLE \nX,Y", "title,\nX,Y", "title\nX,Y", "title\n\n", "title\n ", `${"a".repeat(129)}\nX`, Array.from({ length: 129 }, (_, i) => `h${i}`).join(","), `title\n${"X".repeat(8 * 1024 * 1024)}`, `title\n${"X\n".repeat(10001)}`];
    for (const text of malformed) await assert.rejects(describeTable(root, text), refusal("csv_table_invalid"));
    for (const delimiter of ['"', "\r", "\n", "\uFEFF", "ab"]) await assert.rejects(describeTable(root, "title\nX", { delimiter }), refusal("csv_table_invalid"));
    const maps: Record<string, string>[] = [{ missing: "title" }, { title: "typo" }, { body: "title" }];
    for (const fieldMap of maps) {
      await assert.rejects(describeTable(root, "title,body\nX,Y", { fieldMap }), refusal("csv_table_invalid"));
    }
    for (const text of ["Summary\nX", "title,priority\nX,9", "title,status\nX,SENSITIVE_VALUE", "title,type\nX,SENSITIVE_VALUE", "title,body\n,Y"]) {
      await assert.rejects(describeTable(root, text), refusal("csv_table_invalid"));
    }
    assert.equal(snapshot(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("schema reader rejects unknown versions, malformed nested fields, ambiguous mappings and tampered revisions", async () => {
  const root = fixture();
  try {
    const { schema } = await describeTable(root, "title,priority\nTask,2");
    const bad: unknown[] = [null, [], false, {}, { ...schema, version: 2 }, { ...schema, revision: 7 }, { ...schema, dialect: null }, { ...schema, target: [] }, { ...schema, columns: [] }, { ...schema, columns: Array.from({ length: 129 }, () => schema.columns[0]) }];
    for (const patch of [{ delimiter: 1 }, { delimiter: "ab" }, { delimiter: '"' }, { quote: "'" }, { bom: "true" }, { eol: "mixed" }]) bad.push({ ...schema, dialect: { ...schema.dialect, ...patch } });
    for (const patch of [{ types: false }, { statuses: null }, { types: [3] }]) bad.push({ ...schema, target: { ...schema.target, ...patch } });
    for (const column of [null, { ...schema.columns[0], name: 1 }, { ...schema.columns[0], name: " " }, { ...schema.columns[0], name: "X".repeat(129) }, { ...schema.columns[0], domain: null }, { ...schema.columns[0], domain: { kind: "date", nullable: false } }, { ...schema.columns[0], domain: { kind: "text", nullable: "no" } }, { ...schema.columns[0], field: "bad" }]) bad.push({ ...schema, columns: [column] });
    bad.push({ ...schema, columns: [schema.columns[0], schema.columns[0]] }, { ...schema, columns: [schema.columns[1]] }, { ...schema, columns: [schema.columns[0], { ...schema.columns[1], field: "title" }] }, { ...schema, revision: "0".repeat(64) });
    for (const value of bad) assert.throws(() => parseTableSchema(value), refusal("csv_schema_invalid"));
    assert.deepEqual(parseTableSchema({ target: schema.target, columns: schema.columns, dialect: schema.dialect, revision: schema.revision, version: 1 }), schema);
    const ignored = signed({ ...schema, columns: [schema.columns[0], { ...schema.columns[1], field: null }] });
    assert.equal(parseTableSchema(ignored).columns[1].field, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SDK target contract drift and newly invalid pm values refuse before mutations", async () => {
  const root = fixture();
  try {
    const { schema } = await describeTable(root, "title,status\nTask,open");
    const altered = signed({ ...schema, target: { ...schema.target, types: ["Different"] } });
    await assert.rejects(previewTable(root, "title,status\nTask,open", altered), refusal("csv_target_changed"));
    await assert.rejects(previewTable(root, "title,status\nTask,SENSITIVE_VALUE", schema), refusal("csv_table_invalid"));
    const { schema: typed } = await describeTable(root, "title,type\nTask,Task");
    await assert.rejects(previewTable(root, "title,type\nTask,SENSITIVE_VALUE", typed), refusal("csv_table_invalid"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("negotiated import uses native create/upsert and ignores excluded canonical-looking fields", async () => {
  const root = fixture();
  const savedPath = process.env.PATH;
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), join(bin, "pm"));
    process.env.PATH = bin;
    const text = "Summary,priority,body\nNative negotiated item,2,Quoted body\n";
    const { schema } = await describeTable(root, text, { fieldMap: { summary: "title" } });
    assert.equal((await importNegotiatedTable(root, text, schema, { keyField: "title" })).imported, 1);
    const again = await importNegotiatedTable(root, text.replace(",2,", ",3,"), schema, { keyField: "title" });
    assert.equal(again.updated, 1);
    const existing = await create({ title: "One" }, { pmRoot: root });
    await update(existing.item.id, { body: "Preserved" }, { pmRoot: root });
    const ignored = signed({ ...schema, columns: schema.columns.map(column => column.name === "priority" ? { ...column, field: null } : column) });
    assert.equal((await importNegotiatedTable(root, text.replace("Native negotiated item", "No priority").replace(",2,", ",4,"), ignored)).imported, 1);
    const files = readdirSync(join(root, "tasks")).filter(name => name.endsWith(".toon"));
    assert.ok(files.some(name => readFileSync(join(root, "tasks", name), "utf8").includes("No priority")));
    const omitted = (await listAllComplete({}, { pmRoot: root })).items.find(item => item.title === "No priority");
    assert.ok(omitted);
    assert.notEqual(omitted.priority, 4, "ignored canonical-looking priority must not reach the mutation core");
    const noType = "title\nRequires type";
    const contract = await describeTable(root, noType);
    // SDK mutation policies remain authoritative, beyond the table contract.
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try { await assert.rejects(importNegotiatedTable(root, noType, contract.schema), refusal("csv_table_import_failed")); }
    finally { process.env.PATH = originalPath; }
  } finally { process.env.PATH = savedPath; rmSync(root, { recursive: true, force: true }); }
});

test("native commands return compact receipts, exclusively save schemas and handle IO/usage failures", async () => {
  const root = fixture();
  const harness = await createExtensionTestHarness(extension, { name: "pm-csv", capabilities: ["commands", "importers", "schema"] });
  const file = join(root, "input.csv");
  const output = join(root, "schema.json");
  const savedPath = process.env.PATH;
  try {
    assert.deepEqual(harness.activation.failed, []);
    writeFileSync(file, '\uFEFFSummary;priority\r\n"Quoted; task";2\r\n');
    const result = await harness.runCommand({ command: "csv schema describe", pmRoot: root, args: [file], options: { delimiter: "semicolon", map: "Summary=title", output } });
    assert.equal((result.result as Record<string, unknown>).saved, true);
    assert.equal((JSON.parse(readFileSync(output, "utf8")) as TableSchema).dialect.bom, true);
    const unsaved = await harness.runCommand({ command: "csv schema describe", pmRoot: root, args: [file], options: { delimiter: ";", "auto-map": true } });
    assert.equal((unsaved.result as Record<string, unknown>).saved, false);
    const before = snapshot(root);
    for (const command of ["csv schema preview", "csv schema import"]) {
      const preview = await harness.runCommand({ command, pmRoot: root, args: [file], options: { schema: output, "dry-run": true } });
      assert.equal((preview.result as Record<string, unknown>).rows, 1);
      assert.ok(JSON.stringify(preview.result).length < 250);
    }
    assert.equal(snapshot(root), before);
    process.env.PATH = `${join(process.cwd(), "node_modules/.bin")}${pathDelimiter}${savedPath}`;
    const imported = await harness.runCommand({ command: "csv schema import", pmRoot: root, args: [file], options: { schema: output } });
    assert.equal((imported.result as Record<string, unknown>).imported, 1);
    await assert.rejects(harness.runCommand({ command: "csv schema describe", pmRoot: root, args: [file], options: { delimiter: ";", "auto-map": true, output } }), refusal("csv_schema_io"));
    for (const options of [{}, { schema: output, key: "unknown" }]) await assert.rejects(harness.runCommand({ command: "csv schema preview", pmRoot: root, args: [file], options }), refusal("csv_schema_invalid"));
    await assert.rejects(harness.runCommand({ command: "csv schema describe", pmRoot: root, args: [file], options: { map: "bad" } }), refusal("csv_table_invalid"));
    for (const args of [[], [join(root, "absent")]]) await assert.rejects(harness.runCommand({ command: "csv schema describe", pmRoot: root, args }), refusal("csv_schema_io"));
    writeFileSync(file, Buffer.from([0xff]));
    await assert.rejects(harness.runCommand({ command: "csv schema describe", pmRoot: root, args: [file] }), refusal("csv_schema_io"));
    writeFileSync(file, "title\nTask");
    await assert.rejects(harness.runCommand({ command: "csv schema preview", pmRoot: root, args: [file], options: { schema: file } }), refusal("csv_schema_io"));
  } finally { process.env.PATH = savedPath; await harness.deactivate(); rmSync(root, { recursive: true, force: true }); }
});

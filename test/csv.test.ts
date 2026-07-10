import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCSV,
  serializeCSV,
  serializeField,
  stripBOM,
  resolveDelimiter,
  parseFieldMap,
  resolveImportFieldMap,
  applyFieldMap,
  normalizeStatus,
  parseTags,
  stringifyTags,
  encodeKeyTagValue,
  decodeKeyTagValue,
  normalizeKeyValue,
  selectExportColumns,
  resolveEncoding,
  validateParsedCSV,
  strictValidationIssues,
  parseImportFilter,
  rowMatchesFilter,
  discoverCustomFields,
  EXPORT_COLUMNS,
  IMPORT_COLUMNS,
  StreamingCSVParser,
  streamCSVFile,
  levenshtein,
  suggestClosest,
  validateFieldMapTargets,
  checkMapSourcesPresent,
} from "../dist/index.js";

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// RFC-4180 parsing
// ---------------------------------------------------------------------------

test("parseCSV: simple rows", () => {
  assert.deepEqual(parseCSV("a,b,c\n1,2,3"), [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("parseCSV: quoted field containing the delimiter", () => {
  assert.deepEqual(parseCSV('title,tags\n"Fix, now","a,b"'), [
    ["title", "tags"],
    ["Fix, now", "a,b"],
  ]);
});

test("parseCSV: escaped quotes inside a quoted field", () => {
  assert.deepEqual(parseCSV('a\n"She said ""hi"""'), [["a"], ['She said "hi"']]);
});

test("parseCSV: embedded newline inside a quoted field", () => {
  const rows = parseCSV('title,body\n"X","line1\nline2"');
  assert.deepEqual(rows, [
    ["title", "body"],
    ["X", "line1\nline2"],
  ]);
});

test("parseCSV: CRLF line endings", () => {
  assert.deepEqual(parseCSV("a,b\r\n1,2\r\n"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("parseCSV: custom (semicolon) delimiter", () => {
  assert.deepEqual(parseCSV("a;b\n1;2", ";"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("parseCSV: TSV (tab) delimiter", () => {
  assert.deepEqual(parseCSV("a\tb\n1\t2", "\t"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("parseCSV: unicode content survives", () => {
  const rows = parseCSV('title\n"日本語 — café 🚀"');
  assert.deepEqual(rows, [["title"], ["日本語 — café 🚀"]]);
});

test("parseCSV: empty trailing field preserved", () => {
  assert.deepEqual(parseCSV("a,b,c\n1,,3"), [
    ["a", "b", "c"],
    ["1", "", "3"],
  ]);
});

test("parseCSV: quoted empty field", () => {
  assert.deepEqual(parseCSV('a,b\n"",x'), [
    ["a", "b"],
    ["", "x"],
  ]);
});

// ---------------------------------------------------------------------------
// BOM handling
// ---------------------------------------------------------------------------

test("stripBOM: removes a leading UTF-8 BOM", () => {
  assert.equal(stripBOM("﻿title"), "title");
});

test("stripBOM: leaves BOM-free text untouched", () => {
  assert.equal(stripBOM("title"), "title");
});

test("parseCSV after stripBOM: first header is clean", () => {
  const rows = parseCSV(stripBOM("﻿title,status\nX,open"));
  assert.equal(rows[0][0], "title");
});

// ---------------------------------------------------------------------------
// Serialization (round-trip + RFC-4180 quoting)
// ---------------------------------------------------------------------------

test("serializeField: plain value unquoted", () => {
  assert.equal(serializeField("hello", ","), "hello");
});

test("serializeField: quotes values with delimiter, quote, or newline", () => {
  assert.equal(serializeField("a,b", ","), '"a,b"');
  assert.equal(serializeField('say "hi"', ","), '"say ""hi"""');
  assert.equal(serializeField("line1\nline2", ","), '"line1\nline2"');
});

test("serializeCSV: legacy string-delimiter signature still works", () => {
  assert.equal(serializeCSV([["a", "b"], ["1", "2"]], ","), "a,b\n1,2");
});

test("serializeCSV: CRLF eol option", () => {
  assert.equal(
    serializeCSV([["a", "b"], ["1", "2"]], { delimiter: ",", eol: "\r\n" }),
    "a,b\r\n1,2",
  );
});

test("round-trip: parse(serialize(x)) === x for nasty values", () => {
  const original = [
    ["title", "tags", "body"],
    ['Fix "navbar", urgent', "a,b,c", "line1\nline2\ttab"],
    ["日本語", "", ""],
  ];
  const text = serializeCSV(original, ",");
  const reparsed = parseCSV(text, ",");
  assert.deepEqual(reparsed, original);
});

test("round-trip: TSV with embedded commas", () => {
  const original = [
    ["title", "body"],
    ["Has, commas", "and; semicolons"],
  ];
  const text = serializeCSV(original, "\t");
  assert.deepEqual(parseCSV(text, "\t"), original);
});

// ---------------------------------------------------------------------------
// Delimiter resolution
// ---------------------------------------------------------------------------

test("resolveDelimiter: aliases and defaults", () => {
  assert.equal(resolveDelimiter(undefined), ",");
  assert.equal(resolveDelimiter(""), ",");
  assert.equal(resolveDelimiter("tab"), "\t");
  assert.equal(resolveDelimiter("\\t"), "\t");
  assert.equal(resolveDelimiter("tsv"), "\t");
  assert.equal(resolveDelimiter("semicolon"), ";");
  assert.equal(resolveDelimiter("pipe"), "|");
  assert.equal(resolveDelimiter(";"), ";");
});

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

test("parseFieldMap: comma-joined and array forms, lowercased", () => {
  assert.deepEqual(parseFieldMap("Summary=title,Owner=tags"), {
    summary: "title",
    owner: "tags",
  });
  assert.deepEqual(parseFieldMap(["A=title", "B=body"]), {
    a: "title",
    b: "body",
  });
  assert.deepEqual(parseFieldMap(undefined), {});
});

test("parseFieldMap: invalid entry throws USAGE", () => {
  assert.throws(() => parseFieldMap("noequalshere"), /Invalid --map/);
  assert.throws(() => parseFieldMap("=title"), /Invalid --map/);
});

test("applyFieldMap: remaps known headers, leaves others", () => {
  assert.deepEqual(applyFieldMap(["summary", "status"], { summary: "title" }), [
    "title",
    "status",
  ]);
});

test("resolveImportFieldMap: --auto-map infers common aliases", () => {
  const resolved = resolveImportFieldMap(
    ["summary", "state", "owner", "priority"],
    {},
    true,
  );
  assert.deepEqual(resolved.fieldMap, {
    summary: "title",
    state: "status",
    owner: "assignee",
  });
  assert.deepEqual(resolved.autoMappings, [
    { from: "summary", to: "title" },
    { from: "state", to: "status" },
    { from: "owner", to: "assignee" },
  ]);
});

test("resolveImportFieldMap: explicit --map wins over --auto-map", () => {
  const resolved = resolveImportFieldMap(
    ["summary", "owner"],
    { summary: "title" },
    true,
  );
  assert.equal(resolved.fieldMap.summary, "title");
  assert.equal(resolved.fieldMap.owner, "assignee");
  assert.deepEqual(resolved.autoMappings, [{ from: "owner", to: "assignee" }]);
});

test("resolveImportFieldMap: ambiguous aliases are left unmapped", () => {
  const resolved = resolveImportFieldMap(
    ["summary", "name", "state"],
    {},
    true,
  );
  // Both "summary" and "name" are title aliases: skip title auto-map.
  assert.equal(resolved.fieldMap.summary, undefined);
  assert.equal(resolved.fieldMap.name, undefined);
  assert.equal(resolved.fieldMap.state, "status");
  assert.deepEqual(resolved.autoMappings, [{ from: "state", to: "status" }]);
});

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

test("normalizeStatus: maps common aliases", () => {
  assert.equal(normalizeStatus("todo"), "open");
  assert.equal(normalizeStatus("WIP"), "in_progress");
  assert.equal(normalizeStatus("Done"), "closed");
  assert.equal(normalizeStatus("on hold"), "blocked");
  assert.equal(normalizeStatus("garbage"), "open");
});

test("parseTags / stringifyTags round-trip", () => {
  assert.deepEqual(parseTags("a, b ,c"), ["a", "b", "c"]);
  assert.deepEqual(parseTags(""), []);
  assert.equal(stringifyTags(["a", "b"]), "a,b");
  assert.equal(stringifyTags([]), "");
  assert.equal(stringifyTags(undefined), "");
});

test("csv-key provenance values are encoded before comma-separated tag transport", () => {
  const value = "Fix navbar, urgent";
  const encoded = encodeKeyTagValue(value);
  assert.equal(encoded, "Fix%20navbar%2C%20urgent");
  assert.equal(decodeKeyTagValue(encoded), value);
  assert.equal(decodeKeyTagValue("legacy,raw"), "legacy,raw");
});

test("normalizeKeyValue: folds case + trims so re-import dedups despite pm tag lowercasing", () => {
  assert.equal(normalizeKeyValue("Fix Login Bug"), "fix login bug");
  assert.equal(normalizeKeyValue("  Spaced  "), "spaced");
  // Same logical key from two casings collapses to one bucket.
  assert.equal(normalizeKeyValue("OAuth"), normalizeKeyValue("oauth"));
});

// ---------------------------------------------------------------------------
// Export column selection
// ---------------------------------------------------------------------------

test("selectExportColumns: default is full set", () => {
  assert.deepEqual(selectExportColumns(undefined), EXPORT_COLUMNS);
  assert.deepEqual(selectExportColumns(""), EXPORT_COLUMNS);
});

test("selectExportColumns: ordered subset", () => {
  assert.deepEqual(selectExportColumns("title,status,id"), ["title", "status", "id"]);
});

test("selectExportColumns: unknown column throws USAGE", () => {
  assert.throws(() => selectExportColumns("title,bogus"), /Unknown export column/);
});

test("selectExportColumns: new relational columns are valid", () => {
  assert.deepEqual(
    selectExportColumns("parent,assignee,sprint,release,blocked_by"),
    ["parent", "assignee", "sprint", "release", "blocked_by"],
  );
});

// ---------------------------------------------------------------------------
// New columns present in the canonical column sets
// ---------------------------------------------------------------------------

test("IMPORT/EXPORT_COLUMNS include the new relational fields", () => {
  for (const col of ["parent", "assignee", "sprint", "release", "blocked_by"]) {
    assert.ok((IMPORT_COLUMNS as readonly string[]).includes(col), `IMPORT missing ${col}`);
    assert.ok((EXPORT_COLUMNS as readonly string[]).includes(col), `EXPORT missing ${col}`);
  }
});

// ---------------------------------------------------------------------------
// Encoding resolution
// ---------------------------------------------------------------------------

test("resolveEncoding: defaults and aliases", () => {
  assert.equal(resolveEncoding(undefined), "utf-8");
  assert.equal(resolveEncoding(""), "utf-8");
  assert.equal(resolveEncoding("UTF-8"), "utf-8");
  assert.equal(resolveEncoding("utf8"), "utf8");
  assert.equal(resolveEncoding("UTF16LE"), "utf16le");
  assert.equal(resolveEncoding("latin1"), "latin1");
});

test("resolveEncoding: unknown encoding throws USAGE", () => {
  assert.throws(() => resolveEncoding("ebcdic"), /Unknown --encoding/);
});

// ---------------------------------------------------------------------------
// CSV validation (pure core)
// ---------------------------------------------------------------------------

test("validateParsedCSV: clean CSV reports ok with zero issues", () => {
  const headers = ["title", "status", "priority"];
  const rows = [
    ["Fix bug", "open", "1"],
    ["Ship it", "in_progress", "2"],
  ];
  const report = validateParsedCSV(headers, rows, {});
  assert.equal(report.ok, true);
  assert.equal(report.rowCount, 2);
  assert.equal(report.hasTitleColumn, true);
  assert.deepEqual(report.duplicateMappedColumns, []);
  assert.equal(report.rowsMissingTitle, 0);
  assert.equal(report.rowsWithUnknownStatus, 0);
  assert.equal(report.rowsWithNonIntegerPriority, 0);
  assert.equal(report.rowsWithOutOfRangePriority, 0);
  assert.deepEqual(report.issues, []);
});

test("validateParsedCSV: missing title column is a structural failure", () => {
  const report = validateParsedCSV(["name", "status"], [["x", "open"]], {});
  assert.equal(report.ok, false);
  assert.equal(report.hasTitleColumn, false);
  assert.ok(report.issues.some((i) => /title/.test(i)));
});

test("validateParsedCSV: --map can satisfy the title requirement", () => {
  const report = validateParsedCSV(["summary", "status"], [["x", "open"]], { summary: "title" });
  assert.equal(report.ok, true);
  assert.equal(report.hasTitleColumn, true);
  assert.deepEqual(report.mappedColumns, ["title", "status"]);
});

test("validateParsedCSV: counts empty titles, unknown status, non-int priority", () => {
  const headers = ["title", "status", "priority"];
  const rows = [
    ["", "open", "1"],            // empty title
    ["Has title", "wat", "2"],    // unknown status
    ["Also", "open", "high"],     // non-int priority
    ["Fine", "done", "3"],        // all good (done is known)
  ];
  const report = validateParsedCSV(headers, rows, {});
  assert.equal(report.ok, true); // structurally fine; these are warnings
  assert.equal(report.rowsMissingTitle, 1);
  assert.equal(report.rowsWithUnknownStatus, 1);
  assert.equal(report.rowsWithNonIntegerPriority, 1);
  assert.equal(report.rowsWithOutOfRangePriority, 0);
  assert.equal(report.issues.length, 3);
});

test("validateParsedCSV: negative integer priority is integer but out of pm range", () => {
  const report = validateParsedCSV(["title", "priority"], [["x", "-1"]], {});
  assert.equal(report.rowsWithNonIntegerPriority, 0);
  assert.equal(report.rowsWithOutOfRangePriority, 1);
  assert.ok(report.issues.some((i) => /outside pm's 0-4 range/.test(i)));
});

test("validateParsedCSV: empty CSV is a structural failure", () => {
  const report = validateParsedCSV([], [], {});
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => /empty/i.test(i)));
});

test("validateParsedCSV: duplicate mapped columns are reported", () => {
  const report = validateParsedCSV(["summary", "name", "status"], [["A", "B", "open"]], {
    summary: "title",
    name: "title",
  });
  assert.equal(report.ok, true, "duplicate mapped columns are data-quality issues, not structural parse failures");
  assert.deepEqual(report.duplicateMappedColumns, ["title"]);
  assert.ok(report.issues.some((i) => /Duplicate mapped column/.test(i)));
});

test("strictValidationIssues promotes warning-class row issues to blocking import issues", () => {
  const report = validateParsedCSV(
    ["title", "status", "priority"],
    [
      ["", "open", "1"],
      ["Known", "mystery", "7"],
      ["Bad priority", "open", "high"],
    ],
    {},
  );
  assert.equal(report.ok, true);
  const issues = strictValidationIssues(report);
  assert.ok(issues.some((i) => /missing title/.test(i)));
  assert.ok(issues.some((i) => /unknown status/.test(i)));
  assert.ok(issues.some((i) => /non-integer priority/.test(i)));
  assert.ok(issues.some((i) => /out-of-range priority/.test(i)));
});

// ---------------------------------------------------------------------------
// Import row-filtering (parseImportFilter + rowMatchesFilter)
// ---------------------------------------------------------------------------

function makeRow(over: Partial<Record<string, unknown>> = {}): any {
  return {
    title: "T",
    status: "open",
    priority: undefined,
    tags: [],
    type: undefined,
    deadline: undefined,
    body: undefined,
    ...over,
  };
}

test("parseImportFilter: no flags returns undefined (no-filter fast path)", () => {
  assert.equal(parseImportFilter(undefined, undefined, undefined), undefined);
  assert.equal(parseImportFilter("", "  ", ""), undefined);
});

test("parseImportFilter: status is normalized like a CSV status cell", () => {
  // 'done' normalizes to 'closed' — same alias vocabulary as the importer.
  assert.deepEqual(parseImportFilter("done", undefined, undefined), { status: "closed", type: undefined, priority: undefined });
  assert.deepEqual(parseImportFilter("in progress", undefined, undefined), { status: "in_progress", type: undefined, priority: undefined });
});

test("parseImportFilter: type is lower-cased; priority parsed as int", () => {
  assert.deepEqual(parseImportFilter(undefined, "Feature", "1"), { status: undefined, type: "feature", priority: 1 });
});

test("parseImportFilter: non-integer priority is a usage error", () => {
  assert.throws(() => parseImportFilter(undefined, undefined, "high"), /Invalid --priority/);
});

test("rowMatchesFilter: undefined filter matches every row", () => {
  assert.equal(rowMatchesFilter(makeRow(), undefined), true);
});

test("rowMatchesFilter: status criterion skips non-matching rows", () => {
  const filter = parseImportFilter("open", undefined, undefined);
  assert.equal(rowMatchesFilter(makeRow({ status: "open" }), filter), true);
  assert.equal(rowMatchesFilter(makeRow({ status: "closed" }), filter), false);
});

test("rowMatchesFilter: type is matched case-insensitively", () => {
  const filter = parseImportFilter(undefined, "Feature", undefined);
  assert.equal(rowMatchesFilter(makeRow({ type: "feature" }), filter), true);
  assert.equal(rowMatchesFilter(makeRow({ type: "FEATURE" }), filter), true);
  assert.equal(rowMatchesFilter(makeRow({ type: "Task" }), filter), false);
  assert.equal(rowMatchesFilter(makeRow({ type: undefined }), filter), false);
});

test("rowMatchesFilter: priority criterion requires an exact integer match", () => {
  const filter = parseImportFilter(undefined, undefined, "2");
  assert.equal(rowMatchesFilter(makeRow({ priority: 2 }), filter), true);
  assert.equal(rowMatchesFilter(makeRow({ priority: 3 }), filter), false);
  assert.equal(rowMatchesFilter(makeRow({ priority: undefined }), filter), false);
});

test("rowMatchesFilter: combined criteria are ANDed together", () => {
  const filter = parseImportFilter("open", "Feature", "1");
  assert.equal(rowMatchesFilter(makeRow({ status: "open", type: "feature", priority: 1 }), filter), true);
  // matches type+priority but wrong status → skipped
  assert.equal(rowMatchesFilter(makeRow({ status: "closed", type: "feature", priority: 1 }), filter), false);
});

// ---------------------------------------------------------------------------
// Custom-field discovery on export (discoverCustomFields)
// ---------------------------------------------------------------------------

function makeWorkspace(setup: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "pm-csv-test-"));
  setup(root);
  return root;
}

test("discoverCustomFields: no workspace settings → empty list (never throws)", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-csv-test-"));
  try {
    assert.deepEqual(discoverCustomFields(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverCustomFields: reads file-backed schema/fields.json", () => {
  const root = makeWorkspace((r) => {
    writeFileSync(join(r, "settings.json"), JSON.stringify({ schema: { files: { fields: "schema/fields.json" }, fields: [] } }));
    mkdirSync(join(r, "schema"));
    writeFileSync(
      join(r, "schema", "fields.json"),
      JSON.stringify({
        fields: [
          { key: "story_points", metadata_key: "story_points", type: "number" },
          { key: "team", metadata_key: "team", type: "string" },
        ],
      }),
    );
  });
  try {
    const found = discoverCustomFields(root);
    assert.deepEqual(found, [
      { key: "story_points", metadataKey: "story_points" },
      { key: "team", metadataKey: "team" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverCustomFields: built-in columns and csv_source are excluded", () => {
  const root = makeWorkspace((r) => {
    writeFileSync(
      join(r, "settings.json"),
      JSON.stringify({
        schema: {
          files: {},
          fields: [
            { key: "title" },        // built-in → excluded
            { key: "csv_source" },   // provenance column → excluded
            { key: "epic_link", metadata_key: "epic_link" },
          ],
        },
      }),
    );
  });
  try {
    assert.deepEqual(discoverCustomFields(root), [{ key: "epic_link", metadataKey: "epic_link" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverCustomFields: falls back to metadata key, then key, for the stored property", () => {
  const root = makeWorkspace((r) => {
    writeFileSync(
      join(r, "settings.json"),
      JSON.stringify({
        schema: {
          files: {},
          fields: [
            { key: "points" }, // no metadata_key → property is the key itself
            { key: "sev", front_matter_key: "severity" }, // legacy front_matter_key honored
          ],
        },
      }),
    );
  });
  try {
    assert.deepEqual(discoverCustomFields(root), [
      { key: "points", metadataKey: "points" },
      { key: "sev", metadataKey: "severity" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// selectExportColumns: discovered custom fields are selectable via --columns
// ---------------------------------------------------------------------------

test("selectExportColumns: extraValid lets a custom field be selected", () => {
  assert.deepEqual(selectExportColumns("title,story_points", ["story_points"]), ["title", "story_points"]);
});

test("selectExportColumns: unknown column still rejected with custom fields present", () => {
  assert.throws(() => selectExportColumns("title,nope", ["story_points"]), /Unknown export column/);
});

// ---------------------------------------------------------------------------
// Streaming CSV parser (StreamingCSVParser / streamCSVFile)
// ---------------------------------------------------------------------------

test("StreamingCSVParser: matches parseCSV for simple rows", () => {
  const rows: string[][] = [];
  const parser = new StreamingCSVParser(",", (r) => rows.push(r));
  parser.push("a,b,c\n1,2,3");
  parser.end();
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("StreamingCSVParser: handles quoted fields with embedded delimiters and newlines", () => {
  const rows: string[][] = [];
  const parser = new StreamingCSVParser(",", (r) => rows.push(r));
  parser.push('title,body\n"Fix, now","line1\nline2"');
  parser.end();
  assert.deepEqual(rows, [
    ["title", "body"],
    ["Fix, now", "line1\nline2"],
  ]);
});

test("StreamingCSVParser: handles quoted field split across chunk boundary", () => {
  const rows: string[][] = [];
  const parser = new StreamingCSVParser(",", (r) => rows.push(r));
  // The quoted field is split mid-way through the chunk.
  parser.push('title,body\n"A","line1\n');
  parser.push('line2"');
  parser.end();
  assert.deepEqual(rows, [
    ["title", "body"],
    ["A", "line1\nline2"],
  ]);
});

test("StreamingCSVParser: handles escaped quotes split across chunks", () => {
  const rows: string[][] = [];
  const parser = new StreamingCSVParser(",", (r) => rows.push(r));
  // The escaped-quote pair "" is split across the chunk boundary.
  parser.push('a\n"She said ""');
  parser.push('hi"""');
  parser.end();
  assert.deepEqual(rows, [
    ["a"],
    ['She said "hi"'],
  ]);
});

test("StreamingCSVParser: handles an escaped quote pair split exactly across chunks", () => {
  const rows: string[][] = [];
  const parser = new StreamingCSVParser(",", (r) => rows.push(r));
  parser.push('a\n"She said "');
  parser.push('"hi"""');
  parser.end();
  assert.deepEqual(rows, [["a"], ['She said "hi"']]);
});

test("StreamingCSVParser: custom delimiter (semicolon)", () => {
  const rows: string[][] = [];
  const parser = new StreamingCSVParser(";", (r) => rows.push(r));
  parser.push("a;b\n1;2");
  parser.end();
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("StreamingCSVParser: CRLF line endings", () => {
  const rows: string[][] = [];
  const parser = new StreamingCSVParser(",", (r) => rows.push(r));
  parser.push("a,b\r\n1,2\r\n");
  parser.end();
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("StreamingCSVParser: handles CRLF split exactly across chunks", () => {
  const rows: string[][] = [];
  const parser = new StreamingCSVParser(",", (r) => rows.push(r));
  parser.push("a,b\r");
  parser.push("\n1,2\r");
  parser.push("\n");
  parser.end();
  assert.deepEqual(rows, [["a", "b"], ["1", "2"]]);
});

test("StreamingCSVParser: empty input produces no rows", () => {
  const rows: string[][] = [];
  const parser = new StreamingCSVParser(",", (r) => rows.push(r));
  parser.push("");
  parser.end();
  assert.deepEqual(rows, []);
});

test("streamCSVFile: reads a file and emits rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-csv-stream-"));
  const filePath = join(root, "data.csv");
  writeFileSync(filePath, "title,status\nTask 1,open\nTask 2,closed\n");
  const rows: string[][] = [];
  try {
    await streamCSVFile(filePath, ",", "utf-8", (r) => rows.push(r));
    assert.deepEqual(rows, [
      ["title", "status"],
      ["Task 1", "open"],
      ["Task 2", "closed"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("streamCSVFile: strips BOM from the first chunk", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-csv-stream-"));
  const filePath = join(root, "bom.csv");
  writeFileSync(filePath, "\uFEFFtitle,status\nX,open\n");
  const rows: string[][] = [];
  try {
    await streamCSVFile(filePath, ",", "utf-8", (r) => rows.push(r));
    assert.equal(rows[0][0], "title");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("streamCSVFile: rejects on a non-existent file", async () => {
  await assert.rejects(
    () => streamCSVFile("/nonexistent/path/file.csv", ",", "utf-8", () => {}),
  );
});

// ---------------------------------------------------------------------------
// Field mapping validation (levenshtein, suggestClosest, validateFieldMapTargets, checkMapSourcesPresent)
// ---------------------------------------------------------------------------

test("levenshtein: identical strings have distance 0", () => {
  assert.equal(levenshtein("title", "title"), 0);
});

test("levenshtein: known edit distances", () => {
  assert.equal(levenshtein("title", "titel"), 2); // swap l/e = 2 edits
  assert.equal(levenshtein("", "abc"), 3);
  assert.equal(levenshtein("abc", ""), 3);
});

test("suggestClosest: finds the nearest valid match", () => {
  assert.equal(suggestClosest("titel", ["title", "status", "priority"]), "title");
  assert.equal(suggestClosest("stat", ["title", "status", "priority"]), "status");
});

test("suggestClosest: returns undefined when nothing is close", () => {
  assert.equal(suggestClosest("completelyunrelated", ["title", "status"]), undefined);
});

test("validateFieldMapTargets: valid targets produce no warnings", () => {
  assert.deepEqual(validateFieldMapTargets({ summary: "title", owner: "tags" }), []);
});

test("validateFieldMapTargets: unknown target warns with suggestion", () => {
  const warnings = validateFieldMapTargets({ summary: "titel" });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("'titel'"), "warning should mention the bad target");
  assert.ok(warnings[0].includes("Did you mean 'title'?"), "warning should suggest 'title'");
  assert.ok(warnings[0].includes("Valid fields:"), "warning should list valid fields");
});

test("validateFieldMapTargets: multiple bad targets each produce a warning", () => {
  const warnings = validateFieldMapTargets({ a: "titel", b: "stat" });
  assert.equal(warnings.length, 2);
});

test("checkMapSourcesPresent: present sources produce no warnings", () => {
  assert.deepEqual(checkMapSourcesPresent(["summary", "status"], { summary: "title" }), []);
});

test("checkMapSourcesPresent: missing source warns with suggestion", () => {
  const warnings = checkMapSourcesPresent(["summary", "status"], { summry: "title" });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("'summry'"), "warning should mention the missing source");
  assert.ok(warnings[0].includes("Did you mean 'summary'?"), "warning should suggest the closest header");
  assert.ok(warnings[0].includes("Found:"), "warning should list found headers");
});

test("checkMapSourcesPresent: empty headers still warn without suggestion", () => {
  const warnings = checkMapSourcesPresent([], { foo: "title" });
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes("Did you mean"));
});

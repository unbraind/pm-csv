import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCSV,
  serializeCSV,
  serializeField,
  stripBOM,
  resolveDelimiter,
  parseFieldMap,
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
  EXPORT_COLUMNS,
  IMPORT_COLUMNS,
} from "../dist/index.js";

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
  assert.equal(report.rowsMissingTitle, 0);
  assert.equal(report.rowsWithUnknownStatus, 0);
  assert.equal(report.rowsWithNonIntegerPriority, 0);
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
  assert.equal(report.issues.length, 3);
});

test("validateParsedCSV: negative integer priority is accepted", () => {
  const report = validateParsedCSV(["title", "priority"], [["x", "-1"]], {});
  assert.equal(report.rowsWithNonIntegerPriority, 0);
});

test("validateParsedCSV: empty CSV is a structural failure", () => {
  const report = validateParsedCSV([], [], {});
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => /empty/i.test(i)));
});

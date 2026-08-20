import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, {
  atomicTransactionId,
  assertListAllComplete,
  buildCsvExport,
  compensateCreate,
  describePmNullStatus,
  discoverCustomFields,
  errorMessage,
  importCSV,
  itemStatus,
  loadAppliedByTransaction,
  loadKeyIndex,
  parseFieldMap,
  resolveDelimiter,
  streamCSVFile,
  strictValidationIssues,
  validateCSV,
  validateParsedCSV,
  type PmSpawn,
} from "../index.ts";

/** Create an isolated real tracker used only by the calling test. */
function freshTracker(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-csv-edge-"));
  const initialized = spawnSync("pm", ["init", "--defaults", "--path", root], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  return root;
}

/** Build a successful synthetic pm subprocess receipt around one JSON envelope. */
function successfulEnvelope(envelope: unknown): PmSpawn {
  return () => ({
    status: 0,
    stdout: JSON.stringify(envelope),
    stderr: "",
    pid: 1,
    output: [],
  }) as unknown as SpawnSyncReturns<string>;
}

test("edge helper contracts cover alternate encodings, null receipts, and empty strict reports", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-csv-stream-edge-"));
  try {
    const file = join(root, "latin1.csv");
    writeFileSync(file, `title,body\nCaf\xe9,${"x".repeat(80_000)}\n`, "latin1");
    const rows: string[][] = [];
    await streamCSVFile(file, ",", "latin1", (row) => rows.push(row));
    assert.equal(rows.length, 2);
    assert.equal(rows[1][0], "Café");

    assert.equal(resolveDelimiter("comma"), ",");
    assert.equal(errorMessage("raw failure"), "raw failure");
    assert.deepEqual(parseFieldMap(", title=title, ,"), { title: "title" });
    assert.throws(() => assertListAllComplete(null), /completeness\.status=\(missing\)/u);
    assert.doesNotThrow(() => assertListAllComplete({
      items: [],
      completeness: { status: "complete" },
    }));
    assert.deepEqual(strictValidationIssues({
      ok: true,
      rowCount: 0,
      detectedColumns: ["title"],
      mappedColumns: ["title"],
      hasTitleColumn: true,
      duplicateMappedColumns: [],
      rowsMissingTitle: 0,
      rowsWithUnknownStatus: 0,
      rowsWithNonIntegerPriority: 0,
      rowsWithOutOfRangePriority: 0,
      autoMappings: [],
      fieldMapWarnings: [],
      issues: [],
    }), []);
    const missingCells = validateParsedCSV(["title", "status", "priority"], [[]], {});
    assert.equal(missingCells.rowsMissingTitle, 1);
    assert.match(strictValidationIssues(validateParsedCSV([], [], {}))[0], /CSV is empty/u);
    assert.match(strictValidationIssues(validateParsedCSV(
      ["summary", "name"],
      [["One", "Two"]],
      { summary: "title", name: "title" },
    ))[0], /duplicate mapped columns/u);

    const noCode = Object.assign(new Error("spawn failed"), { code: undefined });
    assert.match(describePmNullStatus({
      status: null,
      signal: null,
      error: noCode,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [],
    }, "list-all"), /spawn failed; this is a spawn or system error/u);
    assert.match(describePmNullStatus({
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [],
    }, "list-all"), /signal <unknown>/u);
    const enobufs = Object.assign(new Error("too much output"), { code: "ENOBUFS" });
    assert.match(describePmNullStatus({
      status: null,
      signal: null,
      error: enobufs,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [],
    }, "list-all"), /ENOBUFS/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct import and reader seams cover default options and fallback receipt shapes", async () => {
  const root = freshTracker();
  try {
    const complete = {
      count: 0,
      total: 0,
      truncated: false,
      has_more: false,
      completeness: { status: "complete" },
    };
    assert.equal(loadKeyIndex("unused", successfulEnvelope(complete)).size, 0);
    assert.equal(loadAppliedByTransaction("unused", "csv-import-none", successfulEnvelope(complete)).byRowIndex.size, 0);

    const untagged = { ...complete, count: 1, total: 1, items: [{ id: "pm-untagged" }] };
    assert.equal(loadKeyIndex("unused", successfulEnvelope(untagged)).size, 0);
    assert.equal(loadAppliedByTransaction("unused", "csv-import-none", successfulEnvelope(untagged)).byRowIndex.size, 0);
    assert.equal(itemStatus("unused", "pm-fallback", successfulEnvelope({ status: "open" })), "open");

    const empty = join(root, "empty-default.csv");
    writeFileSync(empty, "", "utf8");
    assert.equal((await importCSV(root, empty, { delimiter: ",", dryRun: true, fieldMap: {} })).imported, 0);
    assert.equal(validateCSV(empty, { delimiter: ",", fieldMap: {} }).ok, false);

    const headerless = join(root, "headerless-default.csv");
    writeFileSync(headerless, "Direct,Task,open\n", "utf8");
    assert.equal((await importCSV(root, headerless, {
      delimiter: ",",
      dryRun: true,
      fieldMap: {},
      skipHeaders: true,
    })).imported, 1);

    const latin1 = join(root, "latin1-default.csv");
    writeFileSync(latin1, "title\nCaf\xe9\n", "latin1");
    assert.equal((await importCSV(root, latin1, {
      delimiter: ",",
      dryRun: true,
      fieldMap: {},
      encoding: "latin1",
    })).previews[0].title, "Café");

    const streamed = join(root, "stream-default.csv");
    writeFileSync(streamed, "title\n\nStreamed\n", "utf8");
    assert.equal((await importCSV(root, streamed, {
      delimiter: ",",
      dryRun: true,
      fieldMap: {},
      keyField: "title",
      stream: true,
    })).imported, 1);
    const headerlessStream = join(root, "headerless-stream-keyed.csv");
    writeFileSync(headerlessStream, "Stream key,Task,open\n", "utf8");
    assert.equal((await importCSV(root, headerlessStream, {
      delimiter: ",",
      dryRun: true,
      fieldMap: {},
      keyField: "title",
      skipHeaders: true,
      stream: true,
    })).imported, 1);

    const resumed = join(root, "resumed.csv");
    writeFileSync(resumed, "title\nResumed\n", "utf8");
    const transactionId = atomicTransactionId(resumed);
    const created = spawnSync(
      "pm",
      ["--path", root, "create", "--title", "Resumed", "--tags", `csv-tx:${transactionId},csv-txrow:${transactionId}#0`, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const resumedId = (JSON.parse(created.stdout) as { id: string }).id;
    const resumedResult = await importCSV(root, resumed, {
      delimiter: ",",
      dryRun: false,
      fieldMap: {},
      atomic: true,
      commitTransaction: async ({ steps }) => {
        assert.equal((await steps[0].inspect()).state, "applied");
        await steps[0].compensate();
        return { transactionId, status: "committed", recovered: true, results: {} };
      },
    });
    assert.equal(resumedResult.imported, 0);
    assert.equal(itemStatus(root, resumedId), "closed");

    const alreadyClosed = spawnSync("pm", ["--path", root, "create", "--title", "Already closed", "--json"], { encoding: "utf8" });
    assert.equal(alreadyClosed.status, 0, alreadyClosed.stderr || alreadyClosed.stdout);
    const alreadyClosedId = (JSON.parse(alreadyClosed.stdout) as { id: string }).id;
    const closed = spawnSync("pm", ["--path", root, "close", alreadyClosedId, "--validate-close", "off", "--reason", "edge test"], { encoding: "utf8" });
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    compensateCreate(root, alreadyClosedId);
    assert.equal(itemStatus(root, alreadyClosedId), "closed");

    writeFileSync(join(root, "settings.json"), "{}", "utf8");
    assert.deepEqual(discoverCustomFields(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("export handles filters, provenance, internal tags, missing arrays, and remapped custom fields", () => {
  const envelope = {
    items: [
      {
        id: "pm-one",
        title: "One",
        status: "open",
        type: "Task",
        tags: ["visible", "csv-key:key", "csv-source:Source%20One", "csv-tx:batch", "csv-txrow:batch#0", 7],
        custom_meta: "custom value",
        nullable: null,
      },
      { id: "pm-two", title: "Two", status: "open", type: "Task" },
      { id: "pm-three", title: "Three", status: "closed", type: "Feature" },
    ],
    count: 3,
    total: 3,
    truncated: false,
    has_more: false,
    completeness: { status: "complete" },
  };
  const rendered = buildCsvExport("unused", {
    statusFilter: "open",
    typeFilter: "Task",
    delimiter: ",",
    columns: ["id", "tags", "csv_source", "custom", "nullable", "missing"],
    columnSource: { custom: "custom_meta" },
  }, successfulEnvelope(envelope));
  assert.equal(rendered.count, 2);
  assert.match(rendered.csvText, /visible,Source One,custom value,,/u);
  assert.doesNotMatch(rendered.csvText, /csv-key|csv-source|csv-tx/u);

  const noItems = buildCsvExport("unused", {
    delimiter: ",",
    columns: ["id"],
  }, successfulEnvelope({
    count: 0,
    total: 0,
    truncated: false,
    has_more: false,
    completeness: { status: "complete" },
  }));
  assert.equal(noItems.count, 0);

  const failed: PmSpawn = () => ({
    status: 1,
    stdout: "",
    stderr: "",
    pid: 1,
    output: [],
  }) as unknown as SpawnSyncReturns<string>;
  assert.throws(() => buildCsvExport("unused", { delimiter: ",", columns: ["id"] }, failed), /pm list-all failed/u);
});

test("command paths exercise rich create/update, headerless streaming, strict success, and generic file failures", async () => {
  const root = freshTracker();
  const harness = await createExtensionTestHarness(extension, {
    name: "pm-csv",
    capabilities: ["commands", "importers", "schema"],
  });
  try {
    const parent = spawnSync("pm", ["--path", root, "create", "--title", "Parent", "--json"], { encoding: "utf8" });
    const blocker = spawnSync("pm", ["--path", root, "create", "--title", "Blocker", "--json"], { encoding: "utf8" });
    assert.equal(parent.status, 0, parent.stderr || parent.stdout);
    assert.equal(blocker.status, 0, blocker.stderr || blocker.stdout);
    const parentId = (JSON.parse(parent.stdout) as { id: string }).id;
    const blockerId = (JSON.parse(blocker.stdout) as { id: string }).id;

    const rich = join(root, "rich.csv");
    writeFileSync(
      rich,
      "title,status,priority,tags,type,deadline,body,parent,assignee,sprint,release,blocked_by\n"
        + `Rich,open,2,visible,Task,2026-09-01,Body,${parentId},codex,sprint-1,release-1,${blockerId}\n`,
      "utf8",
    );
    const created = await harness.runCommand({
      command: "csv import",
      args: [rich],
      options: { key: "title", source: "edge-suite" },
      pmRoot: root,
    });
    assert.equal(created.handled, true);

    writeFileSync(
      rich,
      "title,status,priority,tags,type,deadline,body,parent,assignee,sprint,release,blocked_by\n"
        + `Rich,in_progress,1,updated,Task,2026-09-02,Updated,${parentId},codex,sprint-2,release-2,${blockerId}\n`,
      "utf8",
    );
    const updated = await harness.runCommand({
      command: "csv import",
      args: [rich],
      options: { key: "title", source: "edge-suite" },
      pmRoot: root,
    });
    assert.equal(updated.handled, true);
    const atomicUpdated = await harness.runCommand({
      command: "csv import",
      args: [rich],
      options: { key: "title", source: "edge-suite", atomic: true },
      pmRoot: root,
    });
    assert.equal(atomicUpdated.handled, true);

    const headerless = join(root, "headerless-latin1.csv");
    writeFileSync(headerless, "Caf\xe9,Task,open\n", "latin1");
    const streamed = await harness.runCommand({
      command: "csv import",
      args: [headerless],
      options: { dryRun: true, stream: true, skipHeaders: true, encoding: "latin1" },
      pmRoot: root,
    });
    assert.equal(streamed.handled, true);

    const warnings = join(root, "warnings.csv");
    writeFileSync(warnings, "title\nWarn\n", "utf8");
    const warned = await harness.runCommand({
      command: "csv import",
      args: [warnings],
      options: { dryRun: true, map: "missing=unknown" },
      pmRoot: root,
    });
    assert.equal(warned.handled, true);

    const strict = await harness.runImporter({
      importer: "csv-import",
      pmRoot: root,
      options: { file: warnings, strict: true },
    });
    assert.equal(strict.handled, true);
    const filteredImporter = await harness.runImporter({
      importer: "csv-import",
      pmRoot: root,
      options: { file: warnings, type: "Feature" },
    });
    assert.equal(filteredImporter.handled, true);

    const closedSource = join(root, "closed-source.csv");
    writeFileSync(closedSource, "title,status\nClosed source,closed\n", "utf8");
    const closedImport = await harness.runCommand({
      command: "csv import",
      args: [closedSource],
      options: { source: "edge-suite" },
      pmRoot: root,
    });
    assert.equal(closedImport.handled, true);

    mkdirSync(join(root, "schema"), { recursive: true });
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      schema: { fields: "invalid", files: { fields: "schema/fields.json" } },
    }), "utf8");
    writeFileSync(join(root, "schema", "fields.json"), JSON.stringify({
      fields: [{ key: "custom", metadata_key: "custom_meta" }, { key: "title" }],
    }), "utf8");
    assert.deepEqual(discoverCustomFields(root), [{ key: "custom", metadataKey: "custom_meta" }]);
    const exported = await harness.runCommand({
      command: "csv export",
      options: { allFields: true, columns: "title,custom" },
      pmRoot: root,
    });
    assert.equal(exported.handled, true);
    const discoveredExport = await harness.runCommand({
      command: "csv export",
      options: { allFields: true },
      pmRoot: root,
    });
    assert.equal(discoveredExport.handled, true);

    const invalid = join(root, "invalid.csv");
    writeFileSync(invalid, "unknown\nvalue\n", "utf8");
    await assert.rejects(harness.runCommand({
      command: "csv validate",
      args: [invalid],
      global: { json: true },
      pmRoot: root,
    }));
    const emptyValidation = join(root, "empty-validation.csv");
    writeFileSync(emptyValidation, "", "utf8");
    await assert.rejects(harness.runCommand({ command: "csv validate", args: [emptyValidation], pmRoot: root }));
    const warningValidation = await harness.runCommand({
      command: "csv validate",
      args: [warnings],
      options: { map: "missing=unknown" },
      pmRoot: root,
    });
    assert.equal(warningValidation.handled, true);
    await assert.rejects(harness.runCommand({ command: "csv import", args: [root], pmRoot: root }), /Failed to import/u);
    await assert.rejects(harness.runCommand({ command: "csv validate", args: [root], pmRoot: root }), /Failed to validate/u);

    const incompatible = await harness.runImporter({
      importer: "csv-import",
      pmRoot: root,
      options: { file: warnings, stream: true, atomic: true },
    });
    assert.equal(incompatible.handled, true);
  } finally {
    await harness.deactivate();
    rmSync(root, { recursive: true, force: true });
  }
});

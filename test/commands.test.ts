import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { CommandHandlerResult } from "@unbrained/pm-cli/sdk/authoring";

import extension, { CommandError } from "../index.ts";

/** Create an isolated real pm tracker for command-level behavior tests. */
function freshTracker(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-csv-commands-"));
  const initialized = spawnSync("pm", ["init", "--defaults", "--path", root], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  return root;
}

/** Activate pm-csv through the public host test harness. */
async function commandHarness() {
  return createExtensionTestHarness(extension, {
    name: "pm-csv",
    capabilities: ["commands", "importers", "schema"],
  });
}

/** Assert and return the record carried by a successfully handled command. */
function handledRecord(result: CommandHandlerResult): Record<string, unknown> {
  assert.equal(result.handled, true, result.errorMessage ?? "command was not handled");
  assert.ok(typeof result.result === "object" && result.result !== null && !Array.isArray(result.result));
  return result.result as Record<string, unknown>;
}

test("csv validate reports valid auto-mapped input and rejects structural input", async () => {
  const root = freshTracker();
  const harness = await commandHarness();
  try {
    const valid = join(root, "valid.csv");
    writeFileSync(valid, "Summary,Status,Priority\nOne,Open,2\n", "utf8");
    const result = handledRecord(await harness.runCommand({
      command: "csv validate",
      args: [valid],
      options: { autoMap: true },
      pmRoot: root,
    }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.autoMappings, [{ from: "summary", to: "title" }]);

    const invalid = join(root, "invalid.csv");
    writeFileSync(invalid, "Unknown\nvalue\n", "utf8");
    await assert.rejects(
      harness.runCommand({ command: "csv validate", args: [invalid], pmRoot: root }),
      (error: unknown) => error instanceof CommandError && error.exitCode === 2,
    );
    await assert.rejects(
      harness.runCommand({ command: "csv validate", pmRoot: root }),
      (error: unknown) => error instanceof CommandError && error.exitCode === 2,
    );
    await assert.rejects(
      harness.runCommand({ command: "csv validate", args: [join(root, "missing.csv")], pmRoot: root }),
      (error: unknown) => error instanceof CommandError && error.exitCode === 3,
    );
  } finally {
    await harness.deactivate();
    rmSync(root, { recursive: true, force: true });
  }
});

test("csv import previews streaming auto-mapped input and refuses strict invalid data", async () => {
  const root = freshTracker();
  const harness = await commandHarness();
  try {
    const valid = join(root, "valid.csv");
    writeFileSync(valid, "Summary,Status\nOne,Open\n", "utf8");
    const result = handledRecord(await harness.runCommand({
      command: "csv import",
      args: [valid],
      options: { autoMap: true, dryRun: true, stream: true },
      pmRoot: root,
      global: { author: "harness:codex" },
    }));
    assert.equal(result.dryRun, true);
    assert.equal(result.wouldCreate, 1);
    assert.deepEqual(result.autoMapped, { summary: "title" });

    const invalid = join(root, "invalid.csv");
    writeFileSync(invalid, "title,status\nOne,impossible\n", "utf8");
    await assert.rejects(
      harness.runCommand({
        command: "csv import",
        args: [invalid],
        options: { strict: true },
        pmRoot: root,
      }),
      (error: unknown) => error instanceof CommandError && error.exitCode === 2,
    );
    await assert.rejects(
      harness.runCommand({ command: "csv import", pmRoot: root }),
      (error: unknown) => error instanceof CommandError && error.exitCode === 2,
    );
    await assert.rejects(
      harness.runCommand({ command: "csv import", args: [join(root, "missing.csv")], pmRoot: root }),
      (error: unknown) => error instanceof CommandError && error.exitCode === 3,
    );
  } finally {
    await harness.deactivate();
    rmSync(root, { recursive: true, force: true });
  }
});

test("csv import edge paths keep previews truthful and validate headers before writes", async () => {
  const root = freshTracker();
  const harness = await commandHarness();
  try {
    const existing = spawnSync(
      "pm",
      ["--path", root, "create", "--title", "Existing", "--tags", "csv-key:existing", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(existing.status, 0, existing.stderr || existing.stdout);

    const keyed = join(root, "keyed.csv");
    writeFileSync(keyed, "title\nExisting\n", "utf8");
    const preview = handledRecord(await harness.runCommand({
      command: "csv import",
      args: [keyed],
      options: { dryRun: true, key: "title" },
      pmRoot: root,
    }));
    assert.equal(preview.wouldUpdate, 1, "dry-run must consult existing key provenance");
    assert.equal(preview.wouldCreate, 0);
    const atomicPreview = handledRecord(await harness.runCommand({
      command: "csv import",
      args: [keyed],
      options: { dryRun: true, atomic: true, key: "title" },
      pmRoot: root,
    }));
    assert.equal(atomicPreview.wouldUpdate, 1, "atomic dry-run must consult existing key provenance");
    assert.equal(atomicPreview.wouldCreate, 0);

    const headerless = join(root, "headerless.csv");
    writeFileSync(headerless, "Headerless,Task,open\n", "utf8");
    const positional = handledRecord(await harness.runCommand({
      command: "csv import",
      args: [headerless],
      options: { dryRun: true, skipHeaders: true, atomic: true },
      pmRoot: root,
    }));
    assert.equal(positional.wouldCreate, 1);

    const filtered = join(root, "filtered.csv");
    writeFileSync(filtered, "title,type\n,Feature\nWrong type,Task\n", "utf8");
    const filterResult = handledRecord(await harness.runCommand({
      command: "csv import",
      args: [filtered],
      options: { dryRun: true, stream: true, type: "Feature" },
      pmRoot: root,
    }));
    assert.equal(filterResult.wouldSkip, 2);
    assert.equal(filterResult.filtered, 1);

    const empty = join(root, "empty.csv");
    writeFileSync(empty, "", "utf8");
    const emptyResult = handledRecord(await harness.runCommand({
      command: "csv import",
      args: [empty],
      options: { atomic: true },
      pmRoot: root,
    }));
    assert.equal(emptyResult.imported, 0);

    const atomicFiltered = join(root, "atomic-filtered-headerless.csv");
    writeFileSync(
      atomicFiltered,
      ",Feature,open\nFiltered,Task,open\nDuplicate,Feature,open\nDuplicate,Feature,open\n",
      "utf8",
    );
    const atomicResult = handledRecord(await harness.runCommand({
      command: "csv import",
      args: [atomicFiltered],
      options: { atomic: true, skipHeaders: true, key: "title", type: "Feature" },
      pmRoot: root,
    }));
    assert.equal(atomicResult.imported, 1);
    assert.equal(atomicResult.skipped, 3);
    assert.equal(atomicResult.filtered, 1);

    const missingTitle = join(root, "missing-title.csv");
    writeFileSync(missingTitle, "status\nopen\n", "utf8");
    await assert.rejects(
      harness.runCommand({ command: "csv import", args: [missingTitle], pmRoot: root }),
      /missing required 'title' column/u,
    );
    await assert.rejects(
      harness.runCommand({
        command: "csv import",
        args: [keyed],
        options: { key: "external_id" },
        pmRoot: root,
      }),
      /--key column 'external_id' not found/u,
    );
  } finally {
    await harness.deactivate();
    rmSync(root, { recursive: true, force: true });
  }
});

test("csv export handles empty, stdout, file, header-negation, and Excel paths", async () => {
  const root = freshTracker();
  const harness = await commandHarness();
  try {
    const empty = handledRecord(await harness.runCommand({ command: "csv export", pmRoot: root }));
    assert.equal(empty.exported, 0);

    const created = spawnSync(
      "pm",
      ["--path", root, "create", "--title", "Exported item", "--body", "line one", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(created.status, 0, created.stderr || created.stdout);

    const stdout = handledRecord(await harness.runCommand({
      command: "csv export",
      options: { columns: "title,body", header: false },
      pmRoot: root,
    }));
    assert.equal(stdout.exported, 1);
    assert.equal(stdout.csv, "Exported item,line one");

    const output = join(root, "items.csv");
    const file = handledRecord(await harness.runCommand({
      command: "csv export",
      options: { output, columns: "title", excel: true, allFields: true },
      pmRoot: root,
    }));
    assert.equal(file.file, output);
    assert.match(readFileSync(output, "utf8"), /^\uFEFFtitle(?:,|\r\n)/u);
    assert.ok(readFileSync(output).subarray(-2).equals(Buffer.from("\r\n")));
  } finally {
    await harness.deactivate();
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered importer and exporter execute through host-owned capability dispatch", async () => {
  const root = freshTracker();
  const harness = await commandHarness();
  try {
    const skipped = await harness.runImporter({ importer: "csv-import", pmRoot: root });
    assert.equal(skipped.handled, true);

    const input = join(root, "import.csv");
    writeFileSync(input, "Summary,Status\nImported,Open\n", "utf8");
    const imported = await harness.runImporter({
      importer: "csv-import",
      options: { file: input, autoMap: true },
      pmRoot: root,
      global: { author: "harness:codex" },
    });
    assert.equal(imported.handled, true, imported.errorMessage ?? "importer was not handled");

    const stdout = await harness.runExporter({
      exporter: "csv-export",
      options: { columns: "title", noHeader: true },
      pmRoot: root,
    });
    assert.equal(stdout.handled, true, stdout.errorMessage ?? "exporter was not handled");
    assert.deepEqual(stdout.result, { exported: 1, csv: "Imported" });

    const output = join(root, "export.csv");
    const file = await harness.runExporter({
      exporter: "csv-export",
      options: { output, columns: "title", crlf: true },
      pmRoot: root,
    });
    assert.equal(file.handled, true, file.errorMessage ?? "exporter was not handled");
    assert.match(readFileSync(output, "utf8"), /^title\r\nImported\r\n$/u);

    const failed = await harness.runImporter({
      importer: "csv-import",
      options: { file: join(root, "missing.csv") },
      pmRoot: root,
    });
    assert.equal(failed.handled, true);
  } finally {
    await harness.deactivate();
    rmSync(root, { recursive: true, force: true });
  }
});

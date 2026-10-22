import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { getHistoryPath, update, create, readSettings, normalizeItemId } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { parseCSV, serializeCSV } from "../index.ts";
import { importLineage, writeLineageBundle, lineageDigest, LineageRefusal } from "../lineage.ts";
import type { LineageField, LineageManifest } from "../lineage.ts";
import { readUpdateDocument } from "../atomic-update.ts";

/** Real native tracker outside Git, with discovery explicitly bounded. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "csv-lineage-"));
  const initialized = spawnSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "--defaults", "--path", root], {
    encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  return root;
}

/** Assert the SDK refusal carries actionable structured context. */
function refused(error: unknown): boolean {
  assert.ok(error instanceof LineageRefusal);
  assert.equal(error.exitCode, 2);
  assert.equal(error.context.code, error.code);
  assert.ok(error.remedy.length > 20);
  return true;
}

test("cell lineage excludes disallowed values and corrected rejects replay without touching successful rows or history, without git", async () => {
  const root = fixture();
  const savedPath = process.env.PATH;
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    process.env.PATH = "";
    process.env.GIT_CEILING_DIRECTORIES = dirname(root);
    const table = [["Summary", "priority", "body", "secret"], ["Accepted", "2", "Line one\nquoted, \"café\"", "NEVER_EXPORT"], ["", "9", "Fix me", "NEVER_EXPORT"]];
    const options = { columns: ["title", "priority", "body"] as LineageField[], fieldMap: { Summary: "title" as const }, author: "lineage-test" };
    const initial = await importLineage(root, table, options);
    assert.deepEqual([initial.receipt.imported, initial.receipt.rejected], [1, 1]);
    const manifest = initial.manifest;
    assert.equal(manifest.mapping[0].header, "Summary");
    assert.equal(manifest.mapping[0].column, 1);
    assert.equal(manifest.rows[0].row, 2);
    assert.equal(manifest.rows[1].code, "invalid_row");
    assert.equal(manifest.rows[0].cells[0].sourceDigest, lineageDigest("Accepted"));
    assert.equal(manifest.rows[0].cells[0].valueDigest, lineageDigest("Accepted"));
    const { digest, ...base } = manifest;
    assert.equal(digest, lineageDigest(base));
    assert.equal(manifest.rejectedDigest, lineageDigest(initial.rejected));
    assert.doesNotMatch(JSON.stringify(initial), /NEVER_EXPORT|secret/);
    assert.deepEqual(initial.rejected[0], ["_csv_key", "title", "priority", "body"]);
    const id = manifest.rows[0].item!;
    const before = readFileSync(getHistoryPath(root, id), "utf8");
    const retry = parseCSV(serializeCSV(initial.rejected, ","));
    retry[1][1] = "Corrected";
    retry[1][2] = "1";
    const fixed = await importLineage(root, retry, { columns: options.columns });
    assert.equal(fixed.receipt.imported, 1);
    assert.equal(fixed.receipt.rejected, 0);
    assert.equal(fixed.manifest.rows[0].key, manifest.rows[1].key);
    const again = await importLineage(root, retry, { columns: options.columns });
    assert.equal(again.receipt.replayed, 1);
    assert.equal(again.receipt.imported, 0);
    const reordered = retry.map(row => [row[0], row[3], row[2], row[1]]);
    const reorderedReplay = await importLineage(root, reordered, { columns: options.columns });
    assert.equal(reorderedReplay.receipt.replayed, 1);
    assert.notEqual(reorderedReplay.manifest.mappingRevision, again.manifest.mappingRevision);
    assert.equal(readFileSync(getHistoryPath(root, id), "utf8"), before);
    const replay = await importLineage(root, table, options);
    assert.equal(replay.receipt.replayed, 1);
    assert.equal(readFileSync(getHistoryPath(root, id), "utf8"), before);
    assert.equal((await readUpdateDocument(root, id)).metadata.priority, 2);
    assert.equal((await importLineage(root, [["title"], ["Default author"]], { columns: ["title"] })).receipt.imported, 1);
  } finally {
    process.env.PATH = savedPath;
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid schemas and retry identities refuse before writes; native SDK validation rejects individual rows without leaking values", async () => {
  const root = fixture();
  try {
    const bad: [string[][], LineageField[], Record<string, LineageField>][] = [
      [[], ["title"], {}], [[[]], ["title"], {}], [[["title"], ...Array.from({ length: 1001 }, () => ["X"])], ["title"], {}],
      [[["title"]], [], {}], [[["title"]], ["title", "title"], {}], [[["title"]], ["title", "unknown" as LineageField], {}],
      [[["title", "title"]], ["title"], {}], [[["title"]], ["title"], { absent: "title" }],
      [[["title"]], ["title"], { title: "body" }], [[["body"]], ["title"], {}],
      [[["title", "Summary"]], ["title"], { Summary: "title" }],
      [[["title", "_csv_key"], ["X", "bad"]], ["title"], {}],
      [[["title", "_csv_key"], ["X", "a".repeat(64)], ["Y", "a".repeat(64)]], ["title"], {}],
    ];
    for (const [table, columns, fieldMap] of bad) await assert.rejects(importLineage(root, table, { columns, fieldMap }), refused);
    const rejected = await importLineage(root, [["title", "type", "priority"], ["Rejected secret", "NOT_A_TYPE", "2"], ["Missing", "", ""], ["Priority", "", "-1"], ["Short row"]], { columns: ["title", "type", "priority"] });
    assert.equal(rejected.receipt.rejected, 3);
    assert.equal(rejected.manifest.rows[0].code, "create_refused");
    assert.doesNotMatch(JSON.stringify(rejected.manifest), /Rejected secret|NOT_A_TYPE/);
    const table = [["title", "body"], ["Original", ""]];
    const imported = await importLineage(root, table, { columns: ["title", "body"] });
    await update(imported.manifest.rows[0].item!, { tags: "removed-marker" }, { pmRoot: root });
    const conflict = await importLineage(root, table, { columns: ["title", "body"] });
    assert.equal(conflict.manifest.rows[0].code, "identity_conflict");
    assert.equal(conflict.receipt.rejected, 1);
    const rich = await importLineage(root, [["title", "assignee", "sprint", "release", "status", "tags", "type"], ["Rich", "", "", "", "open", "one,two", "Task"]], { columns: ["title", "assignee", "sprint", "release", "status", "tags", "type"] });
    assert.equal(rich.receipt.imported, 1);
    assert.equal(rich.manifest.rows[0].cells.find(cell => cell.field === "assignee")!.valueDigest, lineageDigest(null));
    const empty = await importLineage(root, [["title"]], { columns: ["title"] });
    assert.equal(empty.receipt.rows, 0);
    // Existing unrelated ID cannot be adopted merely because it matches a row key.
    const key = "b".repeat(64);
    const settings = await readSettings(root);
    await create({ title: "Unrelated", id: normalizeItemId(`csv-${key}`, settings.id_prefix) }, { pmRoot: root });
    assert.equal((await importLineage(root, [["title", "_csv_key"], ["Other", key]], { columns: ["title"] })).manifest.rows[0].code, "identity_conflict");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("concurrent imports share one native create and recover the racing writer without duplicate items", async () => {
  const root = fixture();
  try {
    const table = [["title"], ["Racing"]];
    const results = await Promise.all([importLineage(root, table, { columns: ["title"] }), importLineage(root, table, { columns: ["title"] })]);
    assert.equal(results.reduce((sum, result) => sum + result.receipt.imported, 0), 1);
    assert.equal(results.reduce((sum, result) => sum + result.receipt.replayed, 0), 1);
    assert.equal(results[0].manifest.rows[0].item, results[1].manifest.rows[0].item);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bundle command writes private checksummed artifacts and returns a bounded JSON/TOON-ready receipt with typed IO remedies", async () => {
  const root = fixture();
  const harness = await createExtensionTestHarness(extension, { name: "pm-csv", capabilities: ["commands", "importers", "schema"] });
  const file = join(root, "input.csv");
  writeFileSync(file, "title,priority,secret\nGood,1,NEVER_EXPORT\n,9,NEVER_EXPORT\n");
  try {
    for (const options of [{}, { output: join(root, "missing-columns") }, { columns: "title" }]) {
      await assert.rejects(harness.runCommand({ command: "csv bundle", pmRoot: root, args: [file], options }), refused);
    }
    await assert.rejects(harness.runCommand({ command: "csv bundle", pmRoot: root, args: [], options: { output: "ignored", columns: "title" } }), refused);
    await assert.rejects(harness.runCommand({ command: "csv bundle", pmRoot: root, args: [join(root, "absent")], options: { output: join(root, "absent-out"), columns: "title" } }), refused);
    await assert.rejects(harness.runCommand({ command: "csv bundle", pmRoot: root, args: [file], options: { output: root, columns: "title" } }), refused);
    const output = join(root, "bundle");
    const result = await harness.runCommand({ command: "csv bundle", pmRoot: root, args: [file], options: { output, columns: "title,priority" } });
    assert.deepEqual([(result.result as Record<string, unknown>).imported, (result.result as Record<string, unknown>).rejected], [1, 1]);
    assert.ok(JSON.stringify(result.result).length < 200);
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")) as LineageManifest;
    assert.equal(manifest.rows.length, 2);
    const checksums = JSON.parse(readFileSync(join(output, "checksums.json"), "utf8")) as Record<string, string>;
    for (const name of ["manifest.json", "rejected.csv"]) assert.equal(createHash("sha256").update(readFileSync(join(output, name))).digest("hex"), checksums[name]);
    assert.doesNotMatch(readFileSync(join(output, "rejected.csv"), "utf8"), /secret|NEVER_EXPORT|Good/);
    // A publication failure is recoverable; a new output directory replays stable identities.
    const blocked = join(root, "blocked");
    mkdirSync(blocked);
    mkdirSync(join(blocked, "manifest.json"));
    const recovered = await importLineage(root, parseCSV(readFileSync(file, "utf8")), { columns: ["title", "priority"] });
    assert.throws(() => writeLineageBundle(blocked, recovered), refused);
    const mappedFile = join(root, "mapped.csv");
    writeFileSync(mappedFile, "Summary\nMapped task\n");
    const mapped = await harness.runCommand({ command: "csv bundle", pmRoot: root, args: [mappedFile], options: { output: join(root, "mapped"), columns: "title", map: "Summary=title" }, global: { author: "lineage-test" } });
    assert.equal((mapped.result as Record<string, unknown>).imported, 1);
    for (const map of ["invalid", "unknown=title"]) {
      await assert.rejects(harness.runCommand({ command: "csv bundle", pmRoot: root, args: [mappedFile], options: { output: join(root, `invalid-${map}`), columns: "title", map } }), refused);
    }
    writeFileSync(mappedFile, "");
    await assert.rejects(harness.runCommand({ command: "csv bundle", pmRoot: root, args: [mappedFile], options: { output: join(root, "empty-mapping"), columns: "title", map: "Summary=title" } }), refused);

  } finally { rmSync(root, { recursive: true, force: true }); }
});

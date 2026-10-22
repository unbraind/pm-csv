/** Validate lineage using an immutable public tracker copy and a disposable non-git target. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getHistoryPath, init, inspectCompleteListResult, listAllComplete } from "@unbrained/pm-cli/sdk";
import { importLineage, lineageDigest, writeLineageBundle } from "../lineage.ts";
import { parseCSV, serializeCSV } from "../index.ts";

/** Hash the explicit source tree and assert it has been made read-only before use. */
function snapshot(path: string): string {
  assert.equal(statSync(path).mode & 0o222, 0, "Source copy must be read-only");
  return lineageDigest(readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).map(entry => {
    assert.equal(entry.isSymbolicLink(), false, "Source copy must not contain symlinks");
    const file = join(path, entry.name);
    if (entry.isDirectory()) return [entry.name, snapshot(file)];
    assert.equal(statSync(file).mode & 0o222, 0, "Source files must be read-only");
    return [entry.name, createHash("sha256").update(readFileSync(file)).digest("hex")];
  }));
}

const source = process.argv[2];
assert.ok(source, "Provide the tracker root of a read-only public copy; this script never reads a live tracker.");
const before = snapshot(resolve(source));
const root = mkdtempSync(join(tmpdir(), "csv-lineage-validation-"));
const previousPath = process.env.PATH;
const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
try {
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  const corpus = await listAllComplete({}, { pmRoot: resolve(source) });
  assert.equal(inspectCompleteListResult(corpus).ok, true);
  assert.ok(corpus.items.length >= 24, "Public fixture must have at least 24 items");
  const table = [["title", "priority", "excluded"], ...corpus.items.slice(0, 24).map(item => [item.title, String(item.priority ?? 2), "EXCLUDED_SENTINEL"])];
  for (let index = 6; index < table.length; index += 6) table[index][1] = "9";
  const target = join(root, "target");
  await init("validation-", { defaults: true, agentGuidance: "skip" }, { pmRoot: target });
  process.env.PATH = "";
  const started = performance.now();
  const first = await importLineage(target, table, { columns: ["title", "priority"], author: "csv-validation" });
  assert.equal(first.receipt.imported, 20);
  assert.equal(first.receipt.rejected, 4);
  const output = join(root, "bundle");
  mkdirSync(output);
  writeLineageBundle(output, first);
  const sums = JSON.parse(readFileSync(join(output, "checksums.json"), "utf8")) as Record<string, string>;
  for (const name of ["manifest.json", "rejected.csv"]) assert.equal(createHash("sha256").update(readFileSync(join(output, name))).digest("hex"), sums[name]);
  const saved = first.manifest.rows.filter(row => row.item).map(row => [row.item!, readFileSync(getHistoryPath(target, row.item!), "utf8")]);
  assert.doesNotMatch(JSON.stringify(first), /EXCLUDED_SENTINEL|excluded/);
  const corrected = parseCSV(serializeCSV(first.rejected, ","));
  for (const row of corrected.slice(1)) row[2] = "2";
  const retry = await importLineage(target, corrected, { columns: ["title", "priority"], author: "csv-validation" });
  const replay = await importLineage(target, corrected, { columns: ["title", "priority"], author: "csv-validation" });
  assert.equal(retry.receipt.imported, 4);
  assert.equal(replay.receipt.replayed, 4);
  for (const [id, history] of saved) assert.equal(readFileSync(getHistoryPath(target, id), "utf8"), history);
  assert.equal(snapshot(source), before);
  console.log(JSON.stringify({ totalPublicItems: corpus.items.length, selectedRows: 24, initialImported: 20, initialRejected: 4,
    correctedImported: 4, replayed: 4, successfulHistoriesUnchanged: saved.length, sourceUnchanged: true, excludedColumns: 1,
    fileChecksumsVerified: 2, lineageCells: first.manifest.rows.reduce((count, row) => count + row.cells.length, 0),
    receiptBytes: Buffer.byteLength(JSON.stringify(first.receipt)), elapsedMs: Math.round(performance.now() - started) }));
} finally {
  process.env.PATH = previousPath;
  if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  // Only the disposable target is removed; source permissions and contents stay untouched.
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
}

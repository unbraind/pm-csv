/** Measure join negotiation against an immutable public tracker copy with no Git executable. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { listAllComplete, inspectCompleteListResult } from "@unbrained/pm-cli/sdk";
import { serializeCSV } from "../index.ts";
import { previewJoins } from "../join-plans.ts";
import type { JoinInput } from "../join-plans.ts";

/** Verify immutable permissions and hash the complete source tree before and after inspection. */
function fingerprint(root: string): string {
  const hash = createHash("sha256");
  assert.equal(statSync(root).mode & 0o222, 0);
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true }).sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))) {
    const path = join(e.parentPath, e.name);
    assert.equal(e.isSymbolicLink(), false);
    assert.equal(statSync(path).mode & 0o222, 0);
    hash.update(path.slice(root.length));
    if (e.isFile()) hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

assert.ok(process.argv[2], "Provide a read-only copy of a public tracker.");
const root = resolve(process.argv[2]);
const before = fingerprint(root);
const oldPath = process.env.PATH;
try {
  process.env.PATH = "";
  const started = performance.now();
  const corpus = await listAllComplete({ includeBody: true }, { pmRoot: root });
  assert.equal(inspectCompleteListResult(corpus).ok, true);
  const items = [...corpus.items].sort((a, b) => a.id.localeCompare(b.id));
  const group = new Map(items.map((item, index) => [item.id, index % 3]));
  let nativeParents = 0, nativeDependencies = 0;
  const tables = Array.from({ length: 3 }, (_, g): JoinInput["tables"][number] => {
    const selected = items.filter(i => group.get(i.id) === g);
    const data = [["key", "title", "type", "status", "priority", "reason", ...Array.from({ length: 6 }, (_, i) => `ref${i}`)]];
    for (const item of selected) {
      const refs = Array<string>(6).fill("");
      if (item.parent && group.has(item.parent)) { refs[group.get(item.parent)!] = item.parent; nativeParents++; }
      const dependency = item.dependencies?.find(e => e.kind === "blocked_by" && group.has(e.id));
      if (dependency) { refs[3 + group.get(dependency.id)!] = dependency.id; nativeDependencies++; }
      data.push([item.id, item.title, item.type, item.status, String(item.priority ?? 2), String(item.close_reason ?? "Imported public tracker item"), ...refs]);
    }
    return { name: `table${g}`, key: "key", csv: serializeCSV(data, ","), fields: { title: "title", type: "type", status: "status", priority: "priority", closeReason: "reason" },
      references: Array.from({ length: 6 }, (_, i) => ({ column: `ref${i}`, table: `table${i % 3}`, kind: i < 3 ? "parent" : "blocked_by" })) };
  });
  // Each row has at most one parent, selected by target table; the input protocol allows only one parent declaration.
  // Use dependency edges for this public join-resolution measurement so all six sparse columns remain explicit.
  for (const table of tables) for (const ref of table.references) ref.kind = "blocked_by";
  const input: JoinInput = { version: 1, tables };
  const result = await previewJoins(root, input);
  assert.equal(result.receipt.ok, true);
  assert.ok(result.plan);
  assert.equal(result.receipt.rows, items.length);
  assert.equal(result.receipt.references, nativeParents + nativeDependencies);
  const duplicate = structuredClone(input);
  const first = items.find(i => group.get(i.id) === 0)!;
  duplicate.tables[0].csv += `\n${serializeCSV([[first.id, "Duplicate", "Task", "open", "2", "Reason", "", "", "", "", "", ""]], ",")}`;
  const denied = await previewJoins(root, duplicate);
  assert.equal(denied.receipt.ok, false);
  assert.equal(fingerprint(root), before);
  console.log(JSON.stringify({ publicItems: items.length, tables: 3, rows: result.receipt.rows,
    references: result.receipt.references, nativeParents, nativeDependencies,
    csvBytes: tables.reduce((n, t) => n + Buffer.byteLength(t.csv), 0),
    receiptBytes: Buffer.byteLength(JSON.stringify(result.receipt)), planBytes: Buffer.byteLength(JSON.stringify(result.plan)),
    duplicateCoordinates: denied.receipt.issues.filter(i => i.code === "duplicate_key").length,
    trackerWrites: 0, sourceUnchanged: true, gitAvailable: false, elapsedMs: Math.round(performance.now() - started) }));
} finally { process.env.PATH = oldPath; }

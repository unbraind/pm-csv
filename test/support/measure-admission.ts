import "./isolated-environment.ts";
import { listAllComplete, certifyCompleteListResult } from "@unbrained/pm-cli/sdk";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, delimiter } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { admitCSV } from "../../admission.ts";
import { buildCsvExport, EXPORT_COLUMNS } from "../../index.ts";

const [root, file] = process.argv.slice(2);
process.env.PATH = resolve("node_modules/.bin") + delimiter + process.env.PATH;
/** Fingerprint every copied public tracker byte before and after the observational read. */
function fingerprint(): string {
  const records = readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => [join(e.parentPath, e.name).slice(root.length), createHash("sha256").update(readFileSync(join(e.parentPath, e.name))).digest("hex")]).sort();
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}
const before = fingerprint();
const items = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot: root }));
const exported = buildCsvExport(root, { delimiter: ",", columns: EXPORT_COLUMNS });
writeFileSync(file, exported.csvText);
const started = performance.now();
const receipt = await admitCSV(root, file);
const elapsedMs = Math.round(performance.now() - started);
if (fingerprint() !== before) throw new Error("Copied public tracker changed during observational validation.");
console.log(JSON.stringify({ trackerItems: items.items.length, exportedRows: exported.count, csvBytes: receipt.sourceBytes,
  scannedRows: receipt.rows, invalidRows: receipt.invalidRows, maxFieldCodeUnits: Math.max(...receipt.fieldWidths),
  mutationWork: receipt.mutationWork, admitted: receipt.admitted, elapsedMs, heapUsed: process.memoryUsage().heapUsed, trackerUnchanged: true }));

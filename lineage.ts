import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { create, locateItem, normalizeItemId, PmCliError, readSettings } from "@unbrained/pm-cli/sdk";
import { buildMutationIntent, matchesMutationScope } from "./mutation-intent.ts";
import { serializeCSV } from "./index.ts";
import { readUpdateDocument } from "./atomic-update.ts";

/** Deliberately bounded import/diagnostic field surface; other columns never leave the input. */
export const LINEAGE_FIELDS = ["title", "body", "type", "status", "priority", "tags", "assignee", "sprint", "release"] as const;
/** Canonical destination field allowed in a lineage bundle. */
export type LineageField = typeof LINEAGE_FIELDS[number];
/** Stable actionable refusals never contain source values or filesystem paths. */
export class LineageRefusal extends PmCliError {
  /** Stable machine-readable category. */
  readonly code: "csv_lineage_invalid" | "csv_bundle_io";
  /** Action required before retry. */
  readonly remedy: string;
  constructor(code: "csv_lineage_invalid" | "csv_bundle_io", remedy: string) {
    super(`${code}: ${remedy}`, 2, { code, required: remedy, nextSteps: [remedy] });
    this.code = code;
    this.remedy = remedy;
  }
}
/** Caller explicitly authorizes the fields allowed in both import and diagnostics. */
export interface LineageOptions {
  columns: readonly LineageField[];
  fieldMap?: Readonly<Record<string, LineageField>>;
  author?: string;
}
/** Value hashes bind source cells to persisted destination values without disclosing either. */
export interface CellLineage {
  column: number;
  field: LineageField;
  sourceDigest: string;
  valueDigest: string;
}
/** Logical CSV record numbers include the header; embedded newlines do not increment them. */
export interface RowLineage {
  row: number;
  key: string;
  outcome: "imported" | "replayed" | "rejected";
  item?: string;
  code?: "invalid_row" | "create_refused" | "identity_conflict";
  cells: CellLineage[];
}
/** Portable, content-addressed manifest. No input filename, raw values or excluded headers. */
export interface LineageManifest {
  version: 1;
  sourceDigest: string;
  mappingRevision: string;
  mapping: { column: number; field: LineageField; header: string }[];
  remedies: Record<NonNullable<RowLineage["code"]>, string>;
  rows: RowLineage[];
  rejectedDigest: string;
  digest: string;
}
/** SDK result separates the bounded command receipt from potentially large artifacts. */
export interface LineageBundle {
  manifest: LineageManifest;
  rejected: string[][];
  receipt: { rows: number; imported: number; replayed: number; rejected: number; manifest: string };
}
/** Versioned SHA-256 over JSON values; artifacts specify this canonicalization. */
export function lineageDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Refuse an invalid table or disclosure policy before any mutation occurs. */
function planMapping(table: readonly string[][], options: LineageOptions): LineageManifest["mapping"] {
  const headers = table[0];
  const fields = options.columns;
  if (!headers?.length || table.length > 1001 || !fields.includes("title") || new Set(fields).size !== fields.length
      || fields.some(field => !LINEAGE_FIELDS.includes(field)) || new Set(headers).size !== headers.length) {
    throw new LineageRefusal("csv_lineage_invalid", "Provide a header and at most 1000 rows; select distinct supported --columns including title and remove duplicate headers.");
  }
  const fieldMap = options.fieldMap ?? {};
  if (Object.entries(fieldMap).some(([header, field]) => !headers.includes(header) || !fields.includes(field))) {
    throw new LineageRefusal("csv_lineage_invalid", "Map only existing source headers to explicitly allowed columns.");
  }
  const mapping = headers.flatMap((header, index) => {
    const field = Object.hasOwn(fieldMap, header) ? fieldMap[header] : header;
    return fields.includes(field as LineageField) ? [{ column: index + 1, field: field as LineageField, header }] : [];
  });
  if (mapping.length !== fields.length || new Set(mapping.map(cell => cell.field)).size !== fields.length) {
    throw new LineageRefusal("csv_lineage_invalid", "Supply exactly one source column for every allowed field; resolve missing or ambiguous mappings.");
  }
  return mapping;
}
/** Recover a committed native create by its stable key, including a crash before artifact export. */
async function existingRow(pmRoot: string, id: string, marker: string, intent: Parameters<typeof create>[0]): Promise<"replayed" | "identity_conflict" | undefined> {
  if (!await locateItem(pmRoot, id)) return undefined;
  const document = await readUpdateDocument(pmRoot, id);
  return document.metadata.tags?.includes(marker) && matchesMutationScope(document, intent!, await readSettings(pmRoot)) ? "replayed" : "identity_conflict";
}
/** Import bounded rows with native SDK validation/history/locking and stable explicit IDs.
 * Rejected artifacts contain only allowed columns plus a stable retry key. Replaying
 * corrected rejects cannot apply successful source rows because those rows are absent.
 */
export async function importLineage(pmRoot: string, table: string[][], options: LineageOptions): Promise<LineageBundle> {
  const mapping = planMapping(table, options);
  const sourceDigest = lineageDigest(table);
  const mappingRevision = lineageDigest([1, mapping]);
  const keyColumn = table[0].indexOf("_csv_key");
  const keys = table.slice(1).map((row, index) => keyColumn < 0 ? lineageDigest([sourceDigest, index + 2]) : row[keyColumn]);
  if (keys.some(key => !/^[a-f0-9]{64}$/.test(key)) || new Set(keys).size !== keys.length) {
    throw new LineageRefusal("csv_lineage_invalid", "Keep distinct unchanged _csv_key values in the rejected CSV; use the original artifact if keys were lost.");
  }
  const settings = await readSettings(pmRoot);
  const rows: RowLineage[] = [];
  const rejected = [["_csv_key", ...mapping.map(cell => cell.field)]];
  for (const [index, row] of table.slice(1).entries()) {
    const key = keys[index];
    const values = Object.fromEntries([...mapping].sort((left, right) => left.field.localeCompare(right.field)).map(cell => [cell.field, (row[cell.column - 1] ?? "").trim()]));
    const marker = `csv-lineage:${lineageDigest([key, values])}`;
    const id = normalizeItemId(`csv-${key}`, settings.id_prefix);
    const intent = buildMutationIntent({ ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "")), id,
      tags: [values.tags, marker].filter(Boolean).join(",") });
    const record: RowLineage = { row: index + 2, key, outcome: "rejected", cells: [] };
    rows.push(record);
    if (row.length !== table[0].length || !values.title || (values.priority && !/^[0-4]$/.test(values.priority))) {
      record.code = "invalid_row";
    } else {
      let outcome = await existingRow(pmRoot, id, marker, intent);
      if (!outcome) {
        try {
          await create(intent, { pmRoot, author: options.author ?? "pm-csv" });
          record.outcome = "imported";
        } catch {
          // A racing writer may have won the same native create; inspect durable state.
          outcome = await existingRow(pmRoot, id, marker, intent);
          record.code = outcome ? undefined : "create_refused";
        }
      }
      if (outcome === "identity_conflict") record.code = outcome;
      if (outcome === "replayed") record.outcome = outcome;
      if (record.outcome !== "rejected") {
        record.item = id;
        const document = await readUpdateDocument(pmRoot, id);
        record.cells = mapping.map(cell => ({ column: cell.column, field: cell.field,
          sourceDigest: lineageDigest(row[cell.column - 1]),
          valueDigest: lineageDigest(cell.field === "body" ? document.body : document.metadata[cell.field] ?? null),
        }));
      }
    }
    if (record.outcome === "rejected") rejected.push([key, ...mapping.map(cell => row[cell.column - 1] ?? "")]);
  }
  const base = { version: 1 as const, sourceDigest, mappingRevision, mapping, rows, remedies: {
    invalid_row: "Correct the title, priority (0-4), or row width in rejected.csv, then retry that file.",
    create_refused: "Check the tracker schema, required type fields, terminal-status reason, permissions and pm health; correct rejected.csv and retry.",
    identity_conflict: "This key already belongs to different imported values. Restore the unchanged rejected artifact or use pm update for intentional changes.",
  }, rejectedDigest: lineageDigest(rejected) };
  const manifest = { ...base, digest: lineageDigest(base) };
  return { manifest, rejected, receipt: { rows: rows.length,
    imported: rows.filter(row => row.outcome === "imported").length,
    replayed: rows.filter(row => row.outcome === "replayed").length,
    rejected: rejected.length - 1, manifest: manifest.digest,
  } };
}

/** Publish only new artifacts; exact-byte checksums complement parsed-content digests. */
export function writeLineageBundle(output: string, bundle: LineageBundle): void {
  const rejectedCsv = serializeCSV(bundle.rejected, ",") + "\n";
  try {
    const manifest = JSON.stringify(bundle.manifest);
    const checksums = {
      "rejected.csv": createHash("sha256").update(rejectedCsv).digest("hex"),
      "manifest.json": createHash("sha256").update(manifest).digest("hex"),
    };
    writeFileSync(join(output, "rejected.csv"), rejectedCsv, { flag: "wx", mode: 0o600 });
    writeFileSync(join(output, "manifest.json"), manifest, { flag: "wx", mode: 0o600 });
    writeFileSync(join(output, "checksums.json"), JSON.stringify(checksums), { flag: "wx", mode: 0o600 });
  } catch {
    throw new LineageRefusal("csv_bundle_io", "Keep partial artifacts; rerun the unchanged input into a new directory to recover committed rows by stable identity.");
  }
}

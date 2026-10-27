import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { getWorkspaceContracts, PmCliError } from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { IMPORT_COLUMNS, parseCSV, stripBOM, resolveDelimiter, parseFieldMap, resolveImportFieldMap,
  validateFieldMapTargets, checkMapSourcesPresent, validateParsedCSV, strictValidationIssues,
  normalizeStatus, importParsedCSV, readBoolOption } from "./index.ts";

/** Fields supported by the existing CSV import core; other columns are explicitly ignored. */
export type TableField = typeof IMPORT_COLUMNS[number];
/** Stable machine-readable refusal categories. Messages never echo source values or paths. */
export type TableRefusalCode = "csv_table_invalid" | "csv_schema_invalid" | "csv_schema_changed" |
  "csv_domain_changed" | "csv_target_changed" | "csv_schema_io" | "csv_table_import_failed";
/** Expected SDK/CLI refusal with an actionable remedy and semantic usage exit code. */
export class TableSchemaRefusal extends PmCliError {
  /** Stable category for automated refusal handling. */
  readonly code: TableRefusalCode;
  /** Concrete recovery action required before retrying. */
  readonly remedy: string;
  constructor(code: TableRefusalCode, remedy: string) {
    super(`${code}: ${remedy}`, 2, { code, required: remedy, nextSteps: [remedy] });
    this.code = code;
    this.remedy = remedy;
  }
}
/** Lexical domains describe all observed nonempty cells, without storing cell values. */
export interface TableDomain {
  kind: "empty" | "integer" | "decimal" | "boolean" | "text";
  nullable: boolean;
}
/** Version 1 contract. The revision binds dialect, ordered exact headers, domains, mappings and target enums. */
export interface TableSchema {
  version: 1;
  revision: string;
  dialect: { delimiter: string; quote: '"'; bom: boolean; eol: "lf" | "crlf" | "none" };
  columns: { name: string; domain: TableDomain; field: TableField | null }[];
  target: { types: string[]; statuses: string[] };
}
/** Proposal controls reuse existing import alias/mapping vocabulary; UTF-8 is required. */
export interface DescribeTableOptions {
  delimiter?: string;
  fieldMap?: Record<string, string>;
  autoMap?: boolean;
}
/** Compact receipt contains counts and an immutable mapping identity, never rows or cell values. */
export interface TableReceipt {
  version: 1;
  revision: string;
  rows: number;
  columns: number;
  mapped: number;
  ignored: number;
}
/** Full reusable artifact is separate from the bounded agent receipt. */
export interface TableDescription {
  schema: TableSchema;
  receipt: TableReceipt;
}

/** Reject malformed quoting before using the existing parser; inspect only record separators outside quotes. */
export function readTable(text: string, delimiter: string): { table: string[][]; dialect: TableSchema["dialect"] } {
  if (Buffer.byteLength(text) > 8 * 1024 * 1024 || delimiter.length !== 1 || /["\r\n\uFEFF]/.test(delimiter)) {
    throw new TableSchemaRefusal("csv_table_invalid", "Use at most 8 MiB of UTF-8 CSV and a single delimiter other than quotes or newlines.");
  }
  const source = stripBOM(text);
  let state: "start" | "plain" | "quoted" | "after" = "start";
  const endings = new Set<"lf" | "crlf">();
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (state === "quoted") {
      if (char === '"') {
        if (source[index + 1] === '"') index++;
        else state = "after";
      }
      continue;
    }
    if (char === delimiter) state = "start";
    else if (char === "\n" || char === "\r") {
      if (char === "\r") {
        if (source[++index] !== "\n") throw new TableSchemaRefusal("csv_table_invalid", "Use LF or CRLF record separators; bare CR is unsupported.");
        endings.add("crlf");
      } else endings.add("lf");
      state = "start";
    } else if (char === '"' && state === "start") state = "quoted";
    else if (char === '"' || state === "after") {
      throw new TableSchemaRefusal("csv_table_invalid", "Quote complete fields and double embedded quotes; remove characters after closing quotes.");
    } else state = "plain";
  }
  if (state === "quoted" || endings.size > 1) throw new TableSchemaRefusal("csv_table_invalid", "Close every quoted field and use one consistent record separator.");
  const table = parseCSV(source, delimiter);
  const headers = table[0];
  if (!headers?.length || headers.length > 128 || table.length > 10001 ||
      headers.some(header => !header.trim() || header.length > 128) ||
      new Set(headers.map(header => header.trim().toLowerCase())).size !== headers.length ||
      table.some(row => row.length !== headers.length || row.every(cell => !cell.trim()))) {
    throw new TableSchemaRefusal("csv_table_invalid", "Provide 1-128 distinct nonempty headers, at most 10000 data rows, matching row widths and no empty records.");
  }
  return { table, dialect: { delimiter, quote: '"', bom: text.startsWith("\uFEFF"), eol: [...endings][0] ?? "none" } };
}

/** Infer a conservative lexical domain over the complete column, never a sample. */
function inferDomain(values: string[]): TableDomain {
  const nonempty = values.map(value => value.trim()).filter(Boolean);
  const kind = nonempty.length === 0 ? "empty" : nonempty.every(value => /^[+-]?\d+$/.test(value)) ? "integer"
    : nonempty.every(value => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) ? "decimal"
    : nonempty.every(value => /^(true|false)$/i.test(value)) ? "boolean" : "text";
  return { kind, nullable: nonempty.length < values.length };
}

/** Canonical SHA-256 contract identity. Key ordering is reconstructed by the schema reader. */
function revision(base: Omit<TableSchema, "revision">): string {
  return createHash("sha256").update(JSON.stringify(base)).digest("hex");
}

/** Read native target enums without activating extensions or invoking git. */
async function targetContract(pmRoot: string): Promise<TableSchema["target"]> {
  const contracts = await getWorkspaceContracts(pmRoot, { noExtensions: true });
  return { types: contracts.types.sort(), statuses: contracts.statuses.sort() };
}

/** Project only explicitly mapped columns; ignored canonical-looking headers cannot acquire meaning. */
function mappedTable(table: string[][], columns: TableSchema["columns"]): string[][] {
  const selected = columns.map((column, index) => ({ ...column, index })).filter(column => column.field !== null);
  return [selected.map(column => column.field!), ...table.slice(1).map(row => selected.map(column => row[column.index]))];
}

/** Reuse strict import checks, then check mapped type/status destinations against the SDK contract. */
function validateMapping(table: string[][], columns: TableSchema["columns"], target: TableSchema["target"]): void {
  const projected = mappedTable(table, columns);
  const report = validateParsedCSV(projected[0], projected.slice(1), {});
  if (strictValidationIssues(report).length || table.slice(1).some(row => columns.some((column, index) => {
    const value = row[index].trim();
    return value !== "" && ((column.field === "type" && !target.types.includes(value)) ||
      (column.field === "status" && !target.statuses.includes(normalizeStatus(value))));
  }))) throw new TableSchemaRefusal("csv_table_invalid", "Correct missing titles, unsupported types/statuses, priorities outside 0-4 or ambiguous pm mappings, then describe again.");
}

/** Produce bounded summary counts without returning table contents. */
function receipt(schema: TableSchema, rows: number): TableReceipt {
  const mapped = schema.columns.filter(column => column.field !== null).length;
  return { version: 1, revision: schema.revision, rows, columns: schema.columns.length, mapped, ignored: schema.columns.length - mapped };
}

/** Describe and propose a reusable schema without writing tracker state or artifacts. */
export async function describeTable(pmRoot: string, text: string, options: DescribeTableOptions = {}): Promise<TableDescription> {
  const delimiter = resolveDelimiter(options.delimiter);
  const { table, dialect } = readTable(text, delimiter);
  const headers = table[0].map(header => header.trim().toLowerCase());
  const explicit = options.fieldMap ?? {};
  if (validateFieldMapTargets(explicit).length || checkMapSourcesPresent(headers, explicit).length) {
    throw new TableSchemaRefusal("csv_table_invalid", "Map existing normalized source headers to supported CSV import fields.");
  }
  const { fieldMap } = resolveImportFieldMap(headers, explicit, options.autoMap ?? false);
  const columns = table[0].map((name, index) => {
    const field = Object.hasOwn(fieldMap, headers[index]) ? fieldMap[headers[index]] : headers[index];
    return { name, domain: inferDomain(table.slice(1).map(row => row[index])), field: IMPORT_COLUMNS.includes(field as TableField) ? field as TableField : null };
  });
  const target = await targetContract(pmRoot);
  validateMapping(table, columns, target);
  const base = { version: 1 as const, dialect, columns, target };
  const schema = { ...base, revision: revision(base) };
  return { schema, receipt: receipt(schema, table.length - 1) };
}

/** Narrow an unknown JSON artifact before accessing nested properties. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate artifact version, bounds, mapping shape and canonical identity. Unknown versions fail closed. */
export function parseTableSchema(value: unknown): TableSchema {
  const invalid = new TableSchemaRefusal("csv_schema_invalid", "Use an unchanged version 1 schema produced by csv schema describe; create a new artifact for intentional changes.");
  if (!record(value) || value.version !== 1 || typeof value.revision !== "string" || !record(value.dialect) ||
      !record(value.target) || !Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 128) throw invalid;
  const { dialect, target } = value;
  if (typeof dialect.delimiter !== "string" || dialect.delimiter.length !== 1 || /["\r\n\uFEFF]/.test(dialect.delimiter) ||
      dialect.quote !== '"' || typeof dialect.bom !== "boolean" || !["lf", "crlf", "none"].includes(String(dialect.eol)) ||
      !Array.isArray(target.types) || !Array.isArray(target.statuses) ||
      [...target.types, ...target.statuses].some(entry => typeof entry !== "string")) throw invalid;
  const columns = value.columns.map((column: unknown): TableSchema["columns"][number] => {
    if (!record(column) || typeof column.name !== "string" || !column.name.trim() || column.name.length > 128 ||
        !record(column.domain) || !["empty", "integer", "decimal", "boolean", "text"].includes(String(column.domain.kind)) ||
        typeof column.domain.nullable !== "boolean" || (column.field !== null && !IMPORT_COLUMNS.includes(column.field as TableField))) throw invalid;
    return { name: column.name, domain: { kind: column.domain.kind as TableDomain["kind"], nullable: column.domain.nullable }, field: column.field as TableField | null };
  });
  const fields = columns.flatMap(column => column.field === null ? [] : [column.field]);
  if (new Set(columns.map(column => column.name.trim().toLowerCase())).size !== columns.length ||
      new Set(fields).size !== fields.length || !fields.includes("title")) throw invalid;
  const base = { version: 1 as const, dialect: { delimiter: dialect.delimiter, quote: '"' as const, bom: dialect.bom, eol: dialect.eol as TableSchema["dialect"]["eol"] },
    columns, target: { types: [...target.types] as string[], statuses: [...target.statuses] as string[] } };
  if (revision(base) !== value.revision) throw invalid;
  return { ...base, revision: value.revision };
}

/** Enforce a saved mapping against the full new table before any tracker mutation. */
export async function previewTable(pmRoot: string, text: string, saved: unknown): Promise<TableReceipt> {
  const schema = parseTableSchema(saved);
  const { table, dialect } = readTable(text, schema.dialect.delimiter);
  if (JSON.stringify(dialect) !== JSON.stringify(schema.dialect) || JSON.stringify(table[0]) !== JSON.stringify(schema.columns.map(column => column.name))) {
    throw new TableSchemaRefusal("csv_schema_changed", "Review changed headers, order or dialect; run csv schema describe into a new artifact and explicitly approve its mappings.");
  }
  for (const [index, column] of schema.columns.entries()) {
    const next = inferDomain(table.slice(1).map(row => row[index]));
    if ((!column.domain.nullable && next.nullable) || (next.kind !== "empty" && column.domain.kind !== "text" && next.kind !== column.domain.kind &&
        !(column.domain.kind === "decimal" && next.kind === "integer"))) {
      throw new TableSchemaRefusal("csv_domain_changed", "Review changed value domains or new empty cells; describe the revised table into a new schema before importing.");
    }
  }
  if (JSON.stringify(await targetContract(pmRoot)) !== JSON.stringify(schema.target)) {
    throw new TableSchemaRefusal("csv_target_changed", "Review tracker type/status changes and describe a new table schema against the current tracker.");
  }
  validateMapping(table, schema.columns, schema.target);
  return receipt(schema, table.length - 1);
}

/** Negotiate a captured UTF-8 table then use the existing import mutation/upsert core.
 * Preview never runs mutation hooks. Import retains legacy partial-write semantics on row failures.
 */
export async function importNegotiatedTable(pmRoot: string, text: string, saved: unknown, options: { dryRun?: boolean; keyField?: TableField } = {}): Promise<TableReceipt & { imported: number; updated: number; skipped: number }> {
  const schema = parseTableSchema(saved);
  const { dryRun, keyField } = options;
  const summary = await previewTable(pmRoot, text, schema);
  if (dryRun) return { ...summary, imported: 0, updated: 0, skipped: 0 };
  const { table } = readTable(text, schema.dialect.delimiter);
  const result = importParsedCSV(pmRoot, mappedTable(table, schema.columns), { delimiter: schema.dialect.delimiter, fieldMap: {}, dryRun: false, keyField });
  if (result.errors.length) throw new TableSchemaRefusal("csv_table_import_failed", `Inspect tracker state and import policies before retrying: imported=${result.imported}, updated=${result.updated}, skipped=${result.skipped}, errors=${result.errors.length}. Use csv import --atomic when rollback is required.`);
  return { ...summary, imported: result.imported, updated: result.updated, skipped: result.skipped };
}

/** Read UTF-8 input and optional JSON contract without leaking IO paths in refusals. */
function readInputs(file: string | undefined, schemaFile?: string): { text: string; saved?: unknown } {
  try {
    if (!file) throw new Error("missing input");
    const bytes = readFileSync(file);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { text, saved: schemaFile === undefined ? undefined : JSON.parse(readFileSync(schemaFile, "utf8")) as unknown };
  } catch { throw new TableSchemaRefusal("csv_schema_io", "Provide readable UTF-8 CSV and, for preview/import, a readable versioned JSON schema."); }
}

/** Register native host-rendered TOON/JSON commands; full artifacts are written only on explicit request. */
export function registerTableSchemaCommands(api: ExtensionApi): void {
  api.registerCommand({
    name: "csv schema describe", description: "Describe a bounded UTF-8 table and propose a versioned pm mapping without tracker writes.",
    arguments: [{ name: "file", required: true, description: "UTF-8 CSV input" }],
    flags: [
      { long: "--delimiter", value_name: "char", description: "Delimiter or comma|semicolon|tab|pipe (default comma)" },
      { long: "--map", value_name: "mapping", description: "Normalized Source=field pairs" },
      { long: "--auto-map", description: "Propose existing unambiguous import aliases" },
      { long: "--output", value_name: "file", description: "Exclusively create reusable JSON schema; never overwrite" },
    ],
    async run(ctx) {
      const { text } = readInputs(ctx.args[0]);
      let fieldMap: Record<string, string>;
      try { fieldMap = parseFieldMap(ctx.options["map"] as string | undefined); }
      catch { throw new TableSchemaRefusal("csv_table_invalid", "Use --map Source=title,Rank=priority with supported import fields."); }
      const described = await describeTable(ctx.pm_root, text, { delimiter: ctx.options["delimiter"] as string | undefined, fieldMap, autoMap: readBoolOption(ctx.options, "auto-map", "autoMap") });
      const output = ctx.options["output"] as string | undefined;
      if (output) {
        try { writeFileSync(output, `${JSON.stringify(described.schema, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
        catch { throw new TableSchemaRefusal("csv_schema_io", "Choose a new writable schema filename; existing artifacts are preserved."); }
      }
      return { ...described.receipt, saved: Boolean(output) };
    },
  });
  for (const action of ["preview", "import"] as const) api.registerCommand({
    name: `csv schema ${action}`, description: `${action === "preview" ? "Check" : "Import"} a table using an unchanged saved schema; refuse drift before writes.`,
    arguments: [{ name: "file", required: true, description: "UTF-8 table matching the saved dialect" }],
    flags: [
      { long: "--schema", value_name: "file", description: "Required version 1 JSON schema" },
      { long: "--dry-run", description: "Read-only negotiation; no item or history writes" },
      { long: "--key", value_name: "field", description: "Existing import upsert key (import only)" },
    ],
    async run(ctx) {
      const schemaFile = ctx.options["schema"] as string | undefined;
      const keyField = ctx.options["key"] as TableField | undefined;
      if (!schemaFile || (keyField !== undefined && !IMPORT_COLUMNS.includes(keyField))) {
        throw new TableSchemaRefusal("csv_schema_invalid", "Provide --schema saved.json and, optionally, a supported import field for --key.");
      }
      const { text, saved } = readInputs(ctx.args[0], schemaFile);
      return { ...await importNegotiatedTable(ctx.pm_root, text, saved, { dryRun: action === "preview" || readBoolOption(ctx.options, "dry-run", "dryRun"), keyField }) };
    },
  });
}

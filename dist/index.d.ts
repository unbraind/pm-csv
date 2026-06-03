type ItemStatus = "open" | "in_progress" | "blocked" | "closed" | "canceled" | "draft";
interface PmItem {
    id: string;
    title: string;
    body?: string;
    status: ItemStatus;
    priority?: number;
    type?: string;
    tags?: string[];
    created_at?: string;
    updated_at?: string;
    deadline?: string;
    parent?: string;
    assignee?: string;
    sprint?: string;
    release?: string;
    blocked_by?: string;
    /** Derived on export from the csv-source: provenance tag (not a stored field). */
    csv_source?: string;
}
declare const IMPORT_COLUMNS: readonly ["title", "type", "status", "priority", "tags", "deadline", "body", "parent", "assignee", "sprint", "release", "blocked_by"];
declare const EXPORT_COLUMNS: Array<keyof PmItem>;
/** Supported file encodings for `--encoding` on import. */
declare const SUPPORTED_ENCODINGS: readonly ["utf-8", "utf8", "utf16le", "latin1"];
type SupportedEncoding = (typeof SUPPORTED_ENCODINGS)[number];
/**
 * Parse a full CSV string into rows of string arrays.
 * Handles:
 *  - Quoted fields (double-quotes), including embedded newlines inside quotes
 *  - Escaped quotes ("" inside a quoted field → single ")
 *  - Custom delimiter
 *  - CRLF and LF line endings
 */
declare function parseCSV(text: string, delimiter?: string): string[][];
/**
 * Strip a leading UTF-8 BOM (U+FEFF) if present. Files exported by Excel and
 * many Windows tools start with a BOM; without removing it the first header
 * name silently becomes "﻿title" and the required-column check fails.
 */
declare function stripBOM(text: string): string;
/**
 * Serialize a single field value for CSV output.
 * Wraps in double-quotes when the value contains the delimiter, quotes, or newlines.
 */
declare function serializeField(value: string, delimiter: string): string;
interface SerializeOptions {
    delimiter: string;
    /** Line terminator. RFC-4180 mandates CRLF; we default to LF for unix-friendliness. */
    eol?: "\n" | "\r\n";
}
/**
 * Serialize a full array of rows into a CSV string.
 */
declare function serializeCSV(rows: string[][], delimiterOrOpts: string | SerializeOptions): string;
/**
 * Resolve a user-supplied delimiter, accepting friendly aliases so TSV is easy:
 *   --delimiter tab   --delimiter "\t"   --delimiter ";"
 * A literal backslash-t is interpreted as a tab.
 */
declare function resolveDelimiter(raw: string | undefined): string;
/**
 * Normalize a dedup key value for stable matching. pm lower-cases tags on
 * storage, so a `csv-key:` tag written from "Fix Bug" comes back as
 * "fix bug"; we therefore fold the key to lower-case on BOTH write and lookup
 * so re-imports match (and thus update) instead of duplicating.
 */
declare function normalizeKeyValue(value: string): string;
declare function encodeKeyTagValue(value: string): string;
declare function decodeKeyTagValue(value: string): string;
/**
 * Parse a `--map csvHeader=field` spec (repeatable / comma-joined) into a
 * lookup from a normalized CSV header name to the canonical pm field name.
 * Example: `--map "Summary=title,Owner=tags"`.
 */
declare function parseFieldMap(spec: string | string[] | undefined): Record<string, string>;
/**
 * Apply a field map to a list of header names, producing the effective
 * (canonical) header used for column lookup.
 */
declare function applyFieldMap(headers: string[], fieldMap: Record<string, string>): string[];
/**
 * Map an arbitrary status string (from the CSV) to a valid SDK status.
 * Falls back to "open".
 */
declare function normalizeStatus(raw: string): ItemStatus;
/**
 * Parse a comma-separated tags string into an array, stripping whitespace.
 */
declare function parseTags(raw: string): string[];
/**
 * Stringify a tags array back to a semicolon-free comma-separated string
 * (safe to embed in a single CSV field).
 */
declare function stringifyTags(tags: string[] | undefined): string;
/**
 * Validate and normalize a user-supplied `--encoding` value to a Node-supported
 * BufferEncoding. Accepts utf-8/utf8, utf16le, latin1. Throws USAGE otherwise.
 */
declare function resolveEncoding(raw: string | undefined): SupportedEncoding;
/**
 * Row-level import filter. Mirrors the `csv export` filter semantics exactly:
 *   - `status` matches the row's *normalized* SDK status (so `done` matches
 *     `--status closed`, just like export filters on the stored status).
 *   - `type` matches the row's raw `type` value case-insensitively.
 *   - `priority` matches the row's parsed integer priority.
 * Any unset criterion is a wildcard. Rows that fail are skipped (not imported)
 * and counted in the result's `skipped` total.
 */
interface ImportRowFilter {
    status?: ItemStatus;
    type?: string;
    priority?: number;
}
interface ParsedRow {
    title: string;
    status: ItemStatus;
    priority?: number;
    tags: string[];
    type?: string;
    deadline?: string;
    body?: string;
    parent?: string;
    assignee?: string;
    sprint?: string;
    release?: string;
    blocked_by?: string;
}
/**
 * Parse the `--status`/`--type`/`--priority` import filter flags into a
 * normalized {@link ImportRowFilter}. Mirrors export filter semantics:
 *   - status is normalized through {@link normalizeStatus} so the same alias
 *     vocabulary as a CSV `status` cell applies (e.g. `--status done` matches
 *     rows whose status normalizes to `closed`).
 *   - priority must be an integer; a non-integer is a USAGE error.
 *   - type is matched case-insensitively (lower-cased here and at compare time).
 * Returns `undefined` when no filter flag is set (the common no-filter path).
 */
declare function parseImportFilter(statusRaw: string | undefined, typeRaw: string | undefined, priorityRaw: string | undefined): ImportRowFilter | undefined;
/**
 * Pure predicate: does a parsed row satisfy every set filter criterion?
 * Unset criteria are wildcards. Exposed for unit testing.
 */
declare function rowMatchesFilter(row: ParsedRow, filter: ImportRowFilter | undefined): boolean;
interface CsvValidateReport {
    ok: boolean;
    rowCount: number;
    detectedColumns: string[];
    mappedColumns: string[];
    hasTitleColumn: boolean;
    rowsMissingTitle: number;
    rowsWithUnknownStatus: number;
    rowsWithNonIntegerPriority: number;
    issues: string[];
}
/**
 * Core validation logic over already-parsed headers + rows. Pure and
 * side-effect-free so it can be unit tested directly.
 */
declare function validateParsedCSV(rawHeaders: string[], dataRows: string[][], fieldMap: Record<string, string>): CsvValidateReport;
/**
 * A custom (workspace-registered) item field discovered from the runtime
 * schema. `key` is the human-facing column name; `metadataKey` is the property
 * name the value is stored under on the item JSON (usually identical).
 */
interface DiscoveredField {
    key: string;
    metadataKey: string;
}
/**
 * Discover custom item fields registered in the workspace runtime schema and
 * return those that are NOT already covered by the built-in export columns
 * (or the provenance `csv_source` column).
 *
 * This is the standalone-extension-safe equivalent of the SDK's
 * `resolveRuntimeFieldRegistry(settings.schema)`: a standalone-installed
 * extension only loads its own `dist/`, so `@unbrained/pm-cli` is not
 * resolvable at runtime and the SDK function cannot be imported. We instead
 * read the very same inputs that function consumes — the workspace
 * `settings.json` `schema.fields` plus the file it points at
 * (`schema.files.fields`, default `schema/fields.json`) — and merge them by
 * field key. The shape matches the SDK `RuntimeFieldDefinition` type.
 *
 * Never throws: any read/parse problem yields an empty list so export still
 * works on hosts without a runtime field schema.
 */
declare function discoverCustomFields(pmRoot: string): DiscoveredField[];
declare function selectExportColumns(spec: string | undefined, extraValid?: ReadonlyArray<string>): string[];
declare const _default: {
    name: string;
    version: string;
    activate(api: import("@unbrained/pm-cli/sdk").ExtensionApi): void;
};
export default _default;
export { parseCSV, serializeCSV, serializeField, stripBOM, resolveDelimiter, parseFieldMap, applyFieldMap, normalizeStatus, parseTags, stringifyTags, encodeKeyTagValue, decodeKeyTagValue, normalizeKeyValue, selectExportColumns, resolveEncoding, validateParsedCSV, parseImportFilter, rowMatchesFilter, discoverCustomFields, EXPORT_COLUMNS, IMPORT_COLUMNS, };
export type { ParsedRow, ImportRowFilter, DiscoveredField };
//# sourceMappingURL=index.d.ts.map
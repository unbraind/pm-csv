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
declare function selectExportColumns(spec: string | undefined): Array<keyof PmItem>;
declare const _default: {
    name: string;
    version: string;
    activate(api: import("@unbrained/pm-cli/sdk").ExtensionApi): void;
};
export default _default;
export { parseCSV, serializeCSV, serializeField, stripBOM, resolveDelimiter, parseFieldMap, applyFieldMap, normalizeStatus, parseTags, stringifyTags, encodeKeyTagValue, decodeKeyTagValue, normalizeKeyValue, selectExportColumns, resolveEncoding, validateParsedCSV, EXPORT_COLUMNS, IMPORT_COLUMNS, };
//# sourceMappingURL=index.d.ts.map
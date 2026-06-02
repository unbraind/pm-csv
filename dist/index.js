import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const defineExtension = ((extension) => extension);
// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------
// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property
// (see @unbrained/pm-cli runCommandHandler). A plain `Error` makes the runtime
// fall through to its "unhandled" path, which RE-INVOKES the command handler a
// second time and exits with a generic code. We mirror the SDK's EXIT_CODE
// contract here rather than importing it: standalone-installed extensions load
// only their own `dist/`, so `@unbrained/pm-cli` is not resolvable at runtime.
const EXIT_CODE = {
    GENERIC_FAILURE: 1,
    USAGE: 2,
    NOT_FOUND: 3,
};
class CommandError extends Error {
    exitCode;
    constructor(message, exitCode = EXIT_CODE.GENERIC_FAILURE) {
        super(message);
        this.name = "CommandError";
        this.exitCode = exitCode;
    }
}
// Columns accepted on import (order independent — driven by header row).
// The relational/planning fields (parent, assignee, sprint, release,
// blocked_by) all map to real `pm create`/`pm update` flags verified against
// the installed CLI (--parent, --assignee, --sprint, --release, --blocked-by).
const IMPORT_COLUMNS = [
    "title",
    "type",
    "status",
    "priority",
    "tags",
    "deadline",
    "body",
    "parent",
    "assignee",
    "sprint",
    "release",
    "blocked_by",
];
// Columns written on export (fixed order)
const EXPORT_COLUMNS = [
    "id",
    "title",
    "type",
    "status",
    "priority",
    "tags",
    "deadline",
    "body",
    "parent",
    "assignee",
    "sprint",
    "release",
    "blocked_by",
    "csv_source",
    "created_at",
    "updated_at",
];
/** Recognized status values for the `csv validate` report. */
const KNOWN_STATUSES = new Set([
    "open", "todo", "new",
    "in_progress", "wip", "in progress", "doing",
    "blocked", "on_hold", "on hold",
    "closed", "done", "complete", "completed",
    "canceled", "cancelled",
    "draft",
]);
/** Supported file encodings for `--encoding` on import. */
const SUPPORTED_ENCODINGS = ["utf-8", "utf8", "utf16le", "latin1"];
// ---------------------------------------------------------------------------
// CSV parser — no external dependencies
// ---------------------------------------------------------------------------
/**
 * Parse a full CSV string into rows of string arrays.
 * Handles:
 *  - Quoted fields (double-quotes), including embedded newlines inside quotes
 *  - Escaped quotes ("" inside a quoted field → single ")
 *  - Custom delimiter
 *  - CRLF and LF line endings
 */
function parseCSV(text, delimiter = ",") {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                // Peek ahead: "" means escaped quote
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                // Closing quote
                inQuotes = false;
                i++;
                continue;
            }
            // Any other character (including newlines) inside quotes
            field += ch;
            i++;
            continue;
        }
        // Not in quotes
        if (ch === '"') {
            inQuotes = true;
            i++;
            continue;
        }
        if (ch === delimiter) {
            row.push(field);
            field = "";
            i++;
            continue;
        }
        if (ch === "\r" && text[i + 1] === "\n") {
            row.push(field);
            field = "";
            rows.push(row);
            row = [];
            i += 2;
            continue;
        }
        if (ch === "\n") {
            row.push(field);
            field = "";
            rows.push(row);
            row = [];
            i++;
            continue;
        }
        field += ch;
        i++;
    }
    // Flush last field / row
    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}
/**
 * Strip a leading UTF-8 BOM (U+FEFF) if present. Files exported by Excel and
 * many Windows tools start with a BOM; without removing it the first header
 * name silently becomes "﻿title" and the required-column check fails.
 */
function stripBOM(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
/**
 * Serialize a single field value for CSV output.
 * Wraps in double-quotes when the value contains the delimiter, quotes, or newlines.
 */
function serializeField(value, delimiter) {
    const needsQuoting = value.includes(delimiter) ||
        value.includes('"') ||
        value.includes("\n") ||
        value.includes("\r");
    if (!needsQuoting)
        return value;
    // Escape embedded double-quotes by doubling them
    return `"${value.replace(/"/g, '""')}"`;
}
/**
 * Serialize a full array of rows into a CSV string.
 */
function serializeCSV(rows, delimiterOrOpts) {
    const opts = typeof delimiterOrOpts === "string"
        ? { delimiter: delimiterOrOpts }
        : delimiterOrOpts;
    const eol = opts.eol ?? "\n";
    return rows
        .map((row) => row.map((f) => serializeField(f, opts.delimiter)).join(opts.delimiter))
        .join(eol);
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Read a boolean option honoring both the kebab-case long flag and the
 * camelCase key the runtime normalizes it to (e.g. `--dry-run` -> `dryRun`).
 * Without this, `ctx.options["dry-run"]` is silently `undefined`.
 */
function readBoolOption(options, ...keys) {
    for (const key of keys) {
        if (options[key] !== undefined)
            return Boolean(options[key]);
    }
    return false;
}
/**
 * Resolve a user-supplied delimiter, accepting friendly aliases so TSV is easy:
 *   --delimiter tab   --delimiter "\t"   --delimiter ";"
 * A literal backslash-t is interpreted as a tab.
 */
function resolveDelimiter(raw) {
    if (raw === undefined || raw === "")
        return ",";
    const lower = raw.toLowerCase();
    if (lower === "tab" || lower === "\\t" || lower === "tsv")
        return "\t";
    if (lower === "comma")
        return ",";
    if (lower === "semicolon")
        return ";";
    if (lower === "pipe")
        return "|";
    return raw;
}
/**
 * Provenance tag prefix used for idempotent upsert. When the importer is told
 * to key on a column, the created item is tagged `csv-key:<value>` so a later
 * re-import can find and update the same item instead of duplicating it.
 */
const KEY_TAG_PREFIX = "csv-key:";
// Provenance tag prefix written when `--source <label>` is given. The CLI's
// registerItemFields registers the `csv_source` schema field but (as of
// pm 2026.5.31) does not expose a `pm create --csv_source` setter, so we
// persist the label as a queryable tag. Stripped from exports like csv-key.
const SOURCE_TAG_PREFIX = "csv-source:";
const PM_LIST_MAX_BUFFER = 16 * 1024 * 1024;
/**
 * Normalize a dedup key value for stable matching. pm lower-cases tags on
 * storage, so a `csv-key:` tag written from "Fix Bug" comes back as
 * "fix bug"; we therefore fold the key to lower-case on BOTH write and lookup
 * so re-imports match (and thus update) instead of duplicating.
 */
function normalizeKeyValue(value) {
    return value.trim().toLowerCase();
}
function encodeKeyTagValue(value) {
    return encodeURIComponent(value);
}
function decodeKeyTagValue(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
/**
 * Parse a `--map csvHeader=field` spec (repeatable / comma-joined) into a
 * lookup from a normalized CSV header name to the canonical pm field name.
 * Example: `--map "Summary=title,Owner=tags"`.
 */
function parseFieldMap(spec) {
    const map = {};
    if (spec === undefined)
        return map;
    const parts = (Array.isArray(spec) ? spec : [spec]).flatMap((s) => s.split(","));
    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed)
            continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) {
            throw new CommandError(`Invalid --map entry "${trimmed}"; expected csvHeader=field`, EXIT_CODE.USAGE);
        }
        const from = trimmed.slice(0, eq).trim().toLowerCase();
        const to = trimmed.slice(eq + 1).trim().toLowerCase();
        if (!from || !to) {
            throw new CommandError(`Invalid --map entry "${trimmed}"; expected csvHeader=field`, EXIT_CODE.USAGE);
        }
        map[from] = to;
    }
    return map;
}
/**
 * Apply a field map to a list of header names, producing the effective
 * (canonical) header used for column lookup.
 */
function applyFieldMap(headers, fieldMap) {
    return headers.map((h) => fieldMap[h] ?? h);
}
/**
 * Map an arbitrary status string (from the CSV) to a valid SDK status.
 * Falls back to "open".
 */
function normalizeStatus(raw) {
    const s = raw.trim().toLowerCase();
    const map = {
        open: "open",
        todo: "open",
        new: "open",
        in_progress: "in_progress",
        wip: "in_progress",
        "in progress": "in_progress",
        doing: "in_progress",
        blocked: "blocked",
        on_hold: "blocked",
        "on hold": "blocked",
        closed: "closed",
        done: "closed",
        complete: "closed",
        completed: "closed",
        canceled: "canceled",
        cancelled: "canceled",
        draft: "draft",
    };
    return map[s] ?? "open";
}
/**
 * Parse a comma-separated tags string into an array, stripping whitespace.
 */
function parseTags(raw) {
    if (!raw.trim())
        return [];
    return raw.split(",").map((t) => t.trim()).filter(Boolean);
}
/**
 * Stringify a tags array back to a semicolon-free comma-separated string
 * (safe to embed in a single CSV field).
 */
function stringifyTags(tags) {
    if (!tags || tags.length === 0)
        return "";
    return tags.join(",");
}
/**
 * Validate and normalize a user-supplied `--encoding` value to a Node-supported
 * BufferEncoding. Accepts utf-8/utf8, utf16le, latin1. Throws USAGE otherwise.
 */
function resolveEncoding(raw) {
    if (raw === undefined || raw === "")
        return "utf-8";
    const lower = raw.trim().toLowerCase();
    if (SUPPORTED_ENCODINGS.includes(lower)) {
        return lower;
    }
    throw new CommandError(`Unknown --encoding '${raw}'. Supported: ${SUPPORTED_ENCODINGS.join(", ")}`, EXIT_CODE.USAGE);
}
/**
 * Read rows from a CSV file, returning header and data rows separately.
 * Skips fully-empty rows. Decodes with the given encoding (default utf-8).
 */
function readCSVFile(filePath, delimiter, encoding = "utf-8") {
    // Node's BufferEncoding spells utf-8 as "utf8"; normalize.
    const bufEnc = encoding === "utf-8" ? "utf8" : encoding;
    const text = stripBOM(readFileSync(filePath, bufEnc));
    const rows = parseCSV(text, delimiter).filter((r) => r.some((f) => f.trim() !== ""));
    if (rows.length === 0) {
        return { headers: [], dataRows: [] };
    }
    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const dataRows = rows.slice(1);
    return { headers, dataRows };
}
/**
 * Build the canonical field accessor for a header row + data row.
 */
function rowFields(headers, row) {
    const col = (name) => headers.indexOf(name);
    const get = (name) => {
        const idx = col(name);
        return idx >= 0 ? (row[idx] ?? "").trim() : "";
    };
    const rawStatus = get("status");
    const rawPriority = get("priority");
    const priority = rawPriority ? parseInt(rawPriority, 10) : undefined;
    return {
        get,
        parsed: {
            title: get("title"),
            status: rawStatus ? normalizeStatus(rawStatus) : "open",
            priority: priority !== undefined && !isNaN(priority) ? priority : undefined,
            tags: parseTags(get("tags")),
            type: get("type") || undefined,
            // pm has no milestone/due_date fields; map deadline (accept legacy header).
            deadline: get("deadline") || get("due_date") || undefined,
            body: get("body") || undefined,
            parent: get("parent") || undefined,
            assignee: get("assignee") || undefined,
            sprint: get("sprint") || undefined,
            release: get("release") || undefined,
            // Accept both blocked_by and a friendlier blocked-by header.
            blocked_by: get("blocked_by") || get("blocked-by") || undefined,
        },
    };
}
/**
 * List existing items once and build a lookup from csv-key provenance value to
 * item id, for idempotent upsert.
 */
function loadKeyIndex(pmRoot) {
    const index = new Map();
    const result = spawnSync("pm", ["--path", pmRoot, "list-all", "--json"], { encoding: "utf-8", maxBuffer: PM_LIST_MAX_BUFFER });
    if (result.error)
        throw new CommandError(`pm list-all failed: ${result.error.message}`);
    if (result.status !== 0) {
        throw new CommandError(result.stderr?.trim() || "pm list-all failed");
    }
    let items = [];
    try {
        items = JSON.parse(result.stdout).items ?? [];
    }
    catch {
        return index;
    }
    for (const item of items) {
        for (const tag of item.tags ?? []) {
            if (tag.startsWith(KEY_TAG_PREFIX)) {
                index.set(normalizeKeyValue(decodeKeyTagValue(tag.slice(KEY_TAG_PREFIX.length))), item.id);
            }
        }
    }
    return index;
}
function importCSV(pmRoot, filePath, opts) {
    const { headers: rawHeaders, dataRows } = readCSVFile(filePath, opts.delimiter, opts.encoding ?? "utf-8");
    const result = { imported: 0, updated: 0, skipped: 0, errors: [], previews: [] };
    if (rawHeaders.length === 0)
        return result;
    const headers = applyFieldMap(rawHeaders, opts.fieldMap);
    if (!headers.includes("title")) {
        throw new CommandError(`CSV is missing required 'title' column (after --map). Found: ${headers.join(", ")}`, EXIT_CODE.USAGE);
    }
    if (opts.keyField && !headers.includes(opts.keyField)) {
        throw new CommandError(`--key column '${opts.keyField}' not found in CSV. Found: ${headers.join(", ")}`, EXIT_CODE.USAGE);
    }
    // Pre-load the dedup index only when upserting (one extra pm call, not per-row).
    const keyIndex = opts.keyField && !opts.dryRun ? loadKeyIndex(pmRoot) : new Map();
    for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
        const row = dataRows[rowIndex];
        const lineNo = rowIndex + 2; // 1-based + header row
        const { get, parsed } = rowFields(headers, row);
        if (!parsed.title) {
            const msg = `Row ${lineNo}: skipping — 'title' is empty`;
            console.error(msg);
            result.skipped++;
            continue;
        }
        const keyValue = opts.keyField ? get(opts.keyField) : "";
        const existingId = keyValue ? keyIndex.get(normalizeKeyValue(keyValue)) : undefined;
        if (opts.dryRun) {
            result.previews.push({
                action: existingId ? "update" : "create",
                ...parsed,
                ...(opts.keyField ? { key: keyValue } : {}),
                ...(opts.source ? { csv_source: opts.source } : {}),
            });
            if (existingId)
                result.updated++;
            else
                result.imported++;
            continue;
        }
        try {
            if (existingId) {
                upsertUpdate(pmRoot, existingId, parsed, opts.source);
                result.updated++;
            }
            else {
                const newId = upsertCreate(pmRoot, parsed, opts.keyField ? keyValue : undefined, opts.source);
                if (opts.keyField && keyValue && newId)
                    keyIndex.set(normalizeKeyValue(keyValue), newId);
                result.imported++;
            }
        }
        catch (err) {
            const msg = `Row ${lineNo}: ${existingId ? "update" : "create"} failed — ${err instanceof Error ? err.message : String(err)}`;
            console.error(msg);
            result.errors.push(msg);
            result.skipped++;
        }
    }
    return result;
}
/**
 * Append the relational/planning field flags shared by create and update.
 * Flag names verified against the installed `pm create`/`pm update` contracts:
 * --parent, --assignee, --sprint, --release, --blocked-by.
 */
function appendRelationalArgs(args, p) {
    if (p.parent)
        args.push("--parent", p.parent);
    if (p.assignee)
        args.push("--assignee", p.assignee);
    if (p.sprint)
        args.push("--sprint", p.sprint);
    if (p.release)
        args.push("--release", p.release);
    if (p.blocked_by)
        args.push("--blocked-by", p.blocked_by);
}
/** Create a new item, optionally carrying a csv-key provenance tag. Returns the new id. */
function upsertCreate(pmRoot, p, keyValue, source) {
    const tags = [...p.tags];
    // Encode the lower-cased key so the stored tag matches the lookup index
    // regardless of pm's tag case-folding (see normalizeKeyValue).
    if (keyValue)
        tags.push(`${KEY_TAG_PREFIX}${encodeKeyTagValue(normalizeKeyValue(keyValue))}`);
    // Provenance for the schema-registered csv_source field, persisted as a tag
    // since the CLI exposes no scalar setter for extension-registered fields.
    if (source)
        tags.push(`${SOURCE_TAG_PREFIX}${encodeKeyTagValue(source)}`);
    const args = ["--path", pmRoot, "create", "--title", p.title, "--status", p.status, "--json"];
    if (p.body)
        args.push("--body", p.body);
    if (p.priority !== undefined)
        args.push("--priority", String(p.priority));
    if (p.type)
        args.push("--type", p.type);
    if (p.deadline)
        args.push("--deadline", p.deadline);
    appendRelationalArgs(args, p);
    if (tags.length > 0)
        args.push("--tags", tags.join(","));
    const r = spawnSync("pm", args, { encoding: "utf-8" });
    if (r.status !== 0)
        throw new Error(r.stderr?.trim() || "pm create failed");
    try {
        const parsed = JSON.parse(r.stdout);
        return parsed.id ?? parsed.item?.id ?? "";
    }
    catch {
        return "";
    }
}
/** Update an existing item in place (status via update; close handled separately). */
function upsertUpdate(pmRoot, id, p, source) {
    const args = ["--path", pmRoot, "update", id, "--title", p.title];
    if (p.body !== undefined)
        args.push("--body", p.body);
    if (p.priority !== undefined)
        args.push("--priority", String(p.priority));
    if (p.type)
        args.push("--type", p.type);
    if (p.deadline)
        args.push("--deadline", p.deadline);
    appendRelationalArgs(args, p);
    // Preserve the csv-key tag (additive) and refresh the user tags.
    const addTags = [...p.tags];
    if (source)
        addTags.push(`${SOURCE_TAG_PREFIX}${encodeKeyTagValue(source)}`);
    if (addTags.length > 0)
        args.push("--add-tags", addTags.join(","));
    // `update` cannot set a closed status; only set non-closed statuses here.
    if (p.status !== "closed" && p.status !== "canceled")
        args.push("--status", p.status);
    const r = spawnSync("pm", args, { encoding: "utf-8" });
    if (r.status !== 0)
        throw new Error(r.stderr?.trim() || "pm update failed");
    // Apply terminal statuses through the dedicated close command.
    if (p.status === "closed" || p.status === "canceled") {
        const reason = p.status === "canceled" ? "canceled" : "completed";
        const cr = spawnSync("pm", ["--path", pmRoot, "close", id, "--reason", reason], { encoding: "utf-8" });
        if (cr.status !== 0)
            throw new Error(cr.stderr?.trim() || "pm close failed");
    }
}
/**
 * Parse a CSV and report data-quality issues without writing anything.
 * Pure function over file contents — exposed for unit testing via the
 * lower-level {@link validateParsedCSV} helper below.
 */
function validateCSV(filePath, opts) {
    const { headers: rawHeaders, dataRows } = readCSVFile(filePath, opts.delimiter, opts.encoding ?? "utf-8");
    return validateParsedCSV(rawHeaders, dataRows, opts.fieldMap);
}
/**
 * Core validation logic over already-parsed headers + rows. Pure and
 * side-effect-free so it can be unit tested directly.
 */
function validateParsedCSV(rawHeaders, dataRows, fieldMap) {
    const mappedColumns = applyFieldMap(rawHeaders, fieldMap);
    const hasTitleColumn = mappedColumns.includes("title");
    const issues = [];
    let rowsMissingTitle = 0;
    let rowsWithUnknownStatus = 0;
    let rowsWithNonIntegerPriority = 0;
    const titleIdx = mappedColumns.indexOf("title");
    const statusIdx = mappedColumns.indexOf("status");
    const priorityIdx = mappedColumns.indexOf("priority");
    for (const row of dataRows) {
        if (hasTitleColumn) {
            const title = (row[titleIdx] ?? "").trim();
            if (!title)
                rowsMissingTitle++;
        }
        if (statusIdx >= 0) {
            const status = (row[statusIdx] ?? "").trim().toLowerCase();
            if (status && !KNOWN_STATUSES.has(status))
                rowsWithUnknownStatus++;
        }
        if (priorityIdx >= 0) {
            const priority = (row[priorityIdx] ?? "").trim();
            if (priority && !/^-?\d+$/.test(priority))
                rowsWithNonIntegerPriority++;
        }
    }
    if (rawHeaders.length === 0) {
        issues.push("CSV is empty (no header row).");
    }
    if (!hasTitleColumn) {
        issues.push(`Missing required 'title' column (after --map). Detected: ${mappedColumns.join(", ") || "(none)"}`);
    }
    if (rowsMissingTitle > 0) {
        issues.push(`${rowsMissingTitle} row(s) have an empty title and would be skipped.`);
    }
    if (rowsWithUnknownStatus > 0) {
        issues.push(`${rowsWithUnknownStatus} row(s) have an unrecognized status (would fall back to 'open').`);
    }
    if (rowsWithNonIntegerPriority > 0) {
        issues.push(`${rowsWithNonIntegerPriority} row(s) have a non-integer priority (would be ignored).`);
    }
    // Only a missing title column (or empty file) is a structural problem.
    const ok = hasTitleColumn && rawHeaders.length > 0;
    return {
        ok,
        rowCount: dataRows.length,
        detectedColumns: rawHeaders,
        mappedColumns,
        hasTitleColumn,
        rowsMissingTitle,
        rowsWithUnknownStatus,
        rowsWithNonIntegerPriority,
        issues,
    };
}
// Parse a `--columns id,title,status` spec into a validated, ordered subset of
// the export columns. Unknown column names throw a USAGE error; an empty/absent
// spec falls back to the full default column set.
function selectExportColumns(spec) {
    if (!spec || !spec.trim())
        return EXPORT_COLUMNS;
    const requested = spec.split(",").map((s) => s.trim()).filter(Boolean);
    const valid = new Set(EXPORT_COLUMNS);
    const unknown = requested.filter((c) => !valid.has(c));
    if (unknown.length > 0) {
        throw new CommandError(`Unknown export column(s): ${unknown.join(", ")}. Valid: ${EXPORT_COLUMNS.join(", ")}`, EXIT_CODE.USAGE);
    }
    return requested;
}
function buildCsvExport(pmRoot, opts) {
    const result = spawnSync("pm", ["--path", pmRoot, "list-all", "--json", "--include-body"], { encoding: "utf-8" });
    if (result.status !== 0) {
        throw new CommandError(result.stderr || "pm list-all failed");
    }
    let items = JSON.parse(result.stdout).items ?? [];
    if (opts.statusFilter)
        items = items.filter((i) => i.status === opts.statusFilter);
    if (opts.typeFilter)
        items = items.filter((i) => i.type === opts.typeFilter);
    // Surface provenance: derive csv_source from the internal csv-source: tag.
    for (const item of items) {
        const sourceTag = (item.tags ?? []).find((t) => t.startsWith(SOURCE_TAG_PREFIX));
        if (sourceTag)
            item.csv_source = decodeKeyTagValue(sourceTag.slice(SOURCE_TAG_PREFIX.length));
    }
    const dataRows = items.map((item) => opts.columns.map((col) => {
        const val = item[col];
        if (val === undefined || val === null)
            return "";
        if (Array.isArray(val)) {
            // Strip internal provenance tags (csv-key / csv-source) so a round-trip
            // export stays clean.
            const visible = val.filter((t) => typeof t === "string" &&
                !t.startsWith(KEY_TAG_PREFIX) &&
                !t.startsWith(SOURCE_TAG_PREFIX));
            return stringifyTags(visible);
        }
        return String(val);
    }));
    const allRows = opts.noHeader ? dataRows : [opts.columns.map(String), ...dataRows];
    // --excel implies CRLF (and a UTF-8 BOM prefix, added below).
    const eol = opts.crlf || opts.excel ? "\r\n" : "\n";
    let csvText = serializeCSV(allRows, { delimiter: opts.delimiter, eol });
    if (opts.excel)
        csvText = "﻿" + csvText;
    return {
        csvText,
        count: items.length,
    };
}
export default defineExtension({
    name: "pm-csv",
    version: "2026.6.2",
    activate(api) {
        // -----------------------------------------------------------------------
        // Schema: register an optional `csv_source` provenance field so imported
        // items can record where they came from (set via `pm csv import --source`).
        // Guarded: only call when the running SDK exposes registerItemFields, so
        // older hosts that lack the schema capability degrade to a no-op (and the
        // manifest still declares "schema" because we genuinely implement it).
        //
        // NOTE: pm 2026.5.31 accepts the field into the schema registry but exposes
        // no `pm create --csv_source` setter for extension-registered scalar fields,
        // so the importer persists the provenance label as a `csv-source:` tag
        // (stripped from exports and surfaced back via the csv_source export column).
        // -----------------------------------------------------------------------
        if (typeof api.registerItemFields === "function") {
            try {
                api.registerItemFields([
                    { name: "csv_source", type: "string", optional: true },
                ]);
            }
            catch (err) {
                // Never let a schema-registration hiccup break command registration.
                console.error(`pm-csv: csv_source field not registered — ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        // -----------------------------------------------------------------------
        // Command: pm csv import <file>
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "csv import",
            description: "Import pm items from a CSV file with full RFC-4180 parsing (quoted fields, " +
                "embedded newlines, escaped quotes, BOM, CRLF). Expected columns: title, type, " +
                "status, priority, tags, deadline, body, parent, assignee, sprint, release, " +
                "blocked_by. Only 'title' is required. Use --map to remap arbitrary headers, " +
                "--key for idempotent re-import (upsert), --encoding for non-UTF-8 files, and " +
                "--source to record import provenance in the csv_source field.",
            intent: "import items from a CSV file into pm",
            examples: [
                "pm csv import tasks.csv",
                "pm csv import backlog.csv --delimiter ';'",
                "pm csv import data.tsv --delimiter tab",
                "pm csv import jira.csv --map 'Summary=title,Owner=tags'",
                "pm csv import items.csv --key title   # idempotent re-import (no duplicates)",
                "pm csv import legacy.csv --encoding latin1",
                "pm csv import sprint12.csv --source 'jira-export-2026-06'",
                "pm csv import items.csv --dry-run",
            ],
            flags: [
                { long: "--delimiter", value_name: "char", description: "Field delimiter, or alias tab|comma|semicolon|pipe (default: ,)" },
                { long: "--map", value_name: "col=field", description: "Remap a CSV header to a pm field (repeatable, comma-joined). e.g. --map 'Summary=title'" },
                { long: "--key", value_name: "field", description: "Dedup key column: re-import updates the matching item instead of creating a duplicate" },
                { long: "--encoding", value_name: "enc", description: "Source file encoding: utf-8 (default) | utf16le | latin1" },
                { long: "--source", value_name: "label", description: "Record an import-provenance label in the csv_source field of created/updated items" },
                { long: "--dry-run", description: "Preview without writing" },
            ],
            async run(ctx) {
                const filePath = ctx.args[0];
                if (!filePath) {
                    throw new CommandError("Usage: pm csv import <file> [--delimiter <char>] [--map col=field] [--key field] [--encoding enc] [--source label] [--dry-run]", EXIT_CODE.USAGE);
                }
                const delimiter = resolveDelimiter(ctx.options["delimiter"]);
                const dryRun = readBoolOption(ctx.options, "dry-run", "dryRun");
                const fieldMap = parseFieldMap(ctx.options["map"]);
                const keyField = (ctx.options["key"] ?? "").trim().toLowerCase() || undefined;
                const encoding = resolveEncoding(ctx.options["encoding"]);
                const source = (ctx.options["source"] ?? "").trim() || undefined;
                const absolutePath = resolve(filePath);
                console.error(`Reading CSV from: ${absolutePath}`);
                let res;
                try {
                    res = importCSV(ctx.pm_root, absolutePath, { delimiter, dryRun, fieldMap, keyField, encoding, source });
                }
                catch (err) {
                    if (err instanceof CommandError)
                        throw err;
                    const msg = err instanceof Error ? err.message : String(err);
                    const exitCode = /ENOENT|no such file/i.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
                    throw new CommandError(`Failed to import: ${msg}`, exitCode);
                }
                if (dryRun) {
                    console.error(`[dry-run] Would create ${res.imported}, update ${res.updated}, skip ${res.skipped}.`);
                    return {
                        dryRun: true,
                        wouldCreate: res.imported,
                        wouldUpdate: res.updated,
                        wouldSkip: res.skipped,
                        previews: res.previews,
                    };
                }
                console.error(`Imported ${res.imported}, updated ${res.updated}, skipped ${res.skipped}.`);
                return { imported: res.imported, updated: res.updated, skipped: res.skipped, errors: res.errors };
            },
        });
        // -----------------------------------------------------------------------
        // Command: pm csv validate <file>
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "csv validate",
            description: "Validate a CSV without importing it. Reports row count, detected/mapped " +
                "columns, rows missing a title, rows with unrecognized status, rows with a " +
                "non-integer priority, and whether the required 'title' column is present " +
                "(after --map). Exits non-zero on structural problems (missing title column). " +
                "Honors --delimiter, --map, --encoding; supports --json.",
            intent: "validate a CSV file without importing",
            examples: [
                "pm csv validate tasks.csv",
                "pm csv validate jira.csv --map 'Summary=title'",
                "pm csv validate data.tsv --delimiter tab --json",
            ],
            flags: [
                { long: "--delimiter", value_name: "char", description: "Field delimiter, or alias tab|comma|semicolon|pipe (default: ,)" },
                { long: "--map", value_name: "col=field", description: "Remap a CSV header to a pm field (repeatable, comma-joined) before validating" },
                { long: "--encoding", value_name: "enc", description: "Source file encoding: utf-8 (default) | utf16le | latin1" },
                { long: "--json", description: "Emit the report as JSON" },
            ],
            async run(ctx) {
                const filePath = ctx.args[0];
                if (!filePath) {
                    throw new CommandError("Usage: pm csv validate <file> [--delimiter <char>] [--map col=field] [--encoding enc] [--json]", EXIT_CODE.USAGE);
                }
                const delimiter = resolveDelimiter(ctx.options["delimiter"]);
                const fieldMap = parseFieldMap(ctx.options["map"]);
                const encoding = resolveEncoding(ctx.options["encoding"]);
                const asJson = readBoolOption(ctx.options, "json");
                const absolutePath = resolve(filePath);
                let report;
                try {
                    report = validateCSV(absolutePath, { delimiter, fieldMap, encoding });
                }
                catch (err) {
                    if (err instanceof CommandError)
                        throw err;
                    const msg = err instanceof Error ? err.message : String(err);
                    const exitCode = /ENOENT|no such file/i.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
                    throw new CommandError(`Failed to validate: ${msg}`, exitCode);
                }
                // Human-readable summary on stderr (so --json stdout stays clean).
                console.error(`Rows: ${report.rowCount}`);
                console.error(`Detected columns: ${report.detectedColumns.join(", ") || "(none)"}`);
                console.error(`Mapped columns:   ${report.mappedColumns.join(", ") || "(none)"}`);
                console.error(`Has 'title' column: ${report.hasTitleColumn ? "yes" : "no"}`);
                console.error(`Rows missing title: ${report.rowsMissingTitle}`);
                console.error(`Rows w/ unknown status: ${report.rowsWithUnknownStatus}`);
                console.error(`Rows w/ non-integer priority: ${report.rowsWithNonIntegerPriority}`);
                for (const issue of report.issues)
                    console.error(`  - ${issue}`);
                console.error(report.ok ? "Validation OK." : "Validation FAILED (structural problems).");
                // Structural problems (no title column / empty) → non-zero exit.
                if (!report.ok) {
                    if (asJson) {
                        // Surface the structured report even on failure before throwing.
                        console.error(JSON.stringify(report, null, 2));
                    }
                    throw new CommandError("CSV is missing the required 'title' column (after --map).", EXIT_CODE.USAGE);
                }
                return report;
            },
        });
        // -----------------------------------------------------------------------
        // Command: pm csv export [--output <file>]
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "csv export",
            description: "Export pm items to a CSV file (or print to stdout if --output is not given). " +
                `Columns: ${EXPORT_COLUMNS.join(", ")}.`,
            intent: "export pm items to a CSV file",
            examples: [
                "pm csv export",
                "pm csv export --output items.csv",
                "pm csv export --output backlog.csv --delimiter ';'",
                "pm csv export --status open --output todos.csv",
                "pm csv export --type Feature --output features.csv",
                "pm csv export --excel --output for-excel.csv",
            ],
            flags: [
                { long: "--output", value_name: "file", description: "Output file path (default: print to stdout)" },
                { long: "--delimiter", value_name: "char", description: "Field delimiter, or alias tab|comma|semicolon|pipe (default: ,)" },
                { long: "--status", value_name: "filter", description: "Filter by status: open | in_progress | blocked | closed | canceled | draft" },
                { long: "--type", value_name: "type", description: "Filter by item type" },
                { long: "--columns", value_name: "list", description: `Comma-separated columns to export, in order (default: all). Valid: ${EXPORT_COLUMNS.join(", ")}` },
                { long: "--no-header", description: "Omit the CSV header row" },
                { long: "--crlf", description: "Use CRLF line endings (RFC-4180 / Excel)" },
                { long: "--excel", description: "Excel-friendly output: CRLF line endings + a UTF-8 BOM prefix" },
            ],
            async run(ctx) {
                const delimiter = resolveDelimiter(ctx.options["delimiter"]);
                const outputPath = ctx.options["output"];
                const columns = selectExportColumns(ctx.options["columns"]);
                const noHeader = readBoolOption(ctx.options, "no-header", "noHeader");
                const crlf = readBoolOption(ctx.options, "crlf");
                const excel = readBoolOption(ctx.options, "excel");
                console.error("Fetching pm items…");
                const { csvText, count } = buildCsvExport(ctx.pm_root, {
                    statusFilter: ctx.options["status"],
                    typeFilter: ctx.options["type"],
                    delimiter,
                    columns,
                    noHeader,
                    crlf,
                    excel,
                });
                if (count === 0) {
                    console.error("No items found.");
                    return { exported: 0 };
                }
                if (outputPath) {
                    const absolutePath = resolve(outputPath);
                    writeFileSync(absolutePath, csvText + "\n", "utf-8");
                    console.error(`Exported ${count} item(s) to: ${absolutePath}`);
                    return { exported: count, file: absolutePath };
                }
                // Print to stdout — return as data so the CLI host renders it
                console.error(`Exported ${count} item(s).`);
                return { exported: count, csv: csvText };
            },
        });
        // -----------------------------------------------------------------------
        // Exporter: csv-export  (native export pipeline — `pm csv-export export`)
        // Mirrors the importer so CSV is a first-class import/export pair.
        // -----------------------------------------------------------------------
        api.registerExporter("csv-export", async (ctx) => {
            const delimiter = resolveDelimiter(ctx.options["delimiter"]);
            const outputPath = ctx.options["output"];
            const columns = selectExportColumns(ctx.options["columns"]);
            const noHeader = readBoolOption(ctx.options, "no-header", "noHeader");
            const crlf = readBoolOption(ctx.options, "crlf");
            const excel = readBoolOption(ctx.options, "excel");
            const { csvText, count } = buildCsvExport(ctx.pm_root, {
                statusFilter: ctx.options["status"],
                typeFilter: ctx.options["type"],
                delimiter,
                columns,
                noHeader,
                crlf,
                excel,
            });
            if (outputPath) {
                const absolutePath = resolve(outputPath);
                writeFileSync(absolutePath, csvText + "\n", "utf-8");
                console.error(`csv-export: wrote ${count} item(s) to ${absolutePath}`);
                return { exported: count, file: absolutePath };
            }
            console.log(csvText);
            return { exported: count, csv: csvText };
        });
        // -----------------------------------------------------------------------
        // Importer: csv-import  (programmatic / config-driven)
        // -----------------------------------------------------------------------
        api.registerImporter("csv-import", async (ctx) => {
            const filePath = ctx.options["file"];
            if (!filePath) {
                console.error("csv-import: no 'file' provided in options — skipping.");
                return;
            }
            const delimiter = resolveDelimiter(ctx.options["delimiter"]);
            const fieldMap = parseFieldMap(ctx.options["map"]);
            const keyField = (ctx.options["key"] ?? "").trim().toLowerCase() || undefined;
            const encoding = resolveEncoding(ctx.options["encoding"]);
            const source = (ctx.options["source"] ?? "").trim() || undefined;
            const absolutePath = resolve(filePath);
            console.error(`csv-import: reading ${absolutePath}`);
            let res;
            try {
                res = importCSV(ctx.pm_root, absolutePath, { delimiter, dryRun: false, fieldMap, keyField, encoding, source });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`csv-import: failed — ${msg}`);
                return;
            }
            console.error(`csv-import: done — imported ${res.imported}, updated ${res.updated}, skipped ${res.skipped}.`);
        });
    },
});
// ---------------------------------------------------------------------------
// Named exports — pure helpers exposed for unit testing (no side effects).
// ---------------------------------------------------------------------------
export { parseCSV, serializeCSV, serializeField, stripBOM, resolveDelimiter, parseFieldMap, applyFieldMap, normalizeStatus, parseTags, stringifyTags, encodeKeyTagValue, decodeKeyTagValue, normalizeKeyValue, selectExportColumns, resolveEncoding, validateParsedCSV, EXPORT_COLUMNS, IMPORT_COLUMNS, };
//# sourceMappingURL=index.js.map
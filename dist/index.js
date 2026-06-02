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
// Columns accepted on import (order independent — driven by header row)
const IMPORT_COLUMNS = [
    "title",
    "type",
    "status",
    "priority",
    "tags",
    "deadline",
    "body",
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
    "created_at",
    "updated_at",
];
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
const PM_LIST_MAX_BUFFER = 16 * 1024 * 1024;
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
 * Read rows from a CSV file, returning header and data rows separately.
 * Skips fully-empty rows.
 */
function readCSVFile(filePath, delimiter) {
    const text = stripBOM(readFileSync(filePath, "utf-8"));
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
                index.set(decodeKeyTagValue(tag.slice(KEY_TAG_PREFIX.length)), item.id);
            }
        }
    }
    return index;
}
function importCSV(pmRoot, filePath, opts) {
    const { headers: rawHeaders, dataRows } = readCSVFile(filePath, opts.delimiter);
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
        const existingId = keyValue ? keyIndex.get(keyValue) : undefined;
        if (opts.dryRun) {
            result.previews.push({
                action: existingId ? "update" : "create",
                ...parsed,
                ...(opts.keyField ? { key: keyValue } : {}),
            });
            if (existingId)
                result.updated++;
            else
                result.imported++;
            continue;
        }
        try {
            if (existingId) {
                upsertUpdate(pmRoot, existingId, parsed);
                result.updated++;
            }
            else {
                const newId = upsertCreate(pmRoot, parsed, opts.keyField ? keyValue : undefined);
                if (opts.keyField && keyValue && newId)
                    keyIndex.set(keyValue, newId);
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
/** Create a new item, optionally carrying a csv-key provenance tag. Returns the new id. */
function upsertCreate(pmRoot, p, keyValue) {
    const tags = [...p.tags];
    if (keyValue)
        tags.push(`${KEY_TAG_PREFIX}${encodeKeyTagValue(keyValue)}`);
    const args = ["--path", pmRoot, "create", "--title", p.title, "--status", p.status, "--json"];
    if (p.body)
        args.push("--body", p.body);
    if (p.priority !== undefined)
        args.push("--priority", String(p.priority));
    if (p.type)
        args.push("--type", p.type);
    if (p.deadline)
        args.push("--deadline", p.deadline);
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
function upsertUpdate(pmRoot, id, p) {
    const args = ["--path", pmRoot, "update", id, "--title", p.title];
    if (p.body !== undefined)
        args.push("--body", p.body);
    if (p.priority !== undefined)
        args.push("--priority", String(p.priority));
    if (p.type)
        args.push("--type", p.type);
    if (p.deadline)
        args.push("--deadline", p.deadline);
    // Preserve the csv-key tag (additive) and refresh the user tags.
    if (p.tags.length > 0)
        args.push("--add-tags", p.tags.join(","));
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
    const dataRows = items.map((item) => opts.columns.map((col) => {
        const val = item[col];
        if (val === undefined || val === null)
            return "";
        if (Array.isArray(val)) {
            // Strip internal csv-key provenance tags so a round-trip export stays clean.
            const visible = val.filter((t) => typeof t === "string" && !t.startsWith(KEY_TAG_PREFIX));
            return stringifyTags(visible);
        }
        return String(val);
    }));
    const allRows = opts.noHeader ? dataRows : [opts.columns.map(String), ...dataRows];
    const eol = opts.crlf ? "\r\n" : "\n";
    return {
        csvText: serializeCSV(allRows, { delimiter: opts.delimiter, eol }),
        count: items.length,
    };
}
export default defineExtension({
    name: "pm-csv",
    version: "2026.6.2",
    activate(api) {
        // -----------------------------------------------------------------------
        // Command: pm csv import <file>
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "csv import",
            description: "Import pm items from a CSV file with full RFC-4180 parsing (quoted fields, " +
                "embedded newlines, escaped quotes, BOM, CRLF). Expected columns: title, type, " +
                "status, priority, tags, deadline, body. Only 'title' is required. Use --map to " +
                "remap arbitrary headers and --key for idempotent re-import (upsert).",
            intent: "import items from a CSV file into pm",
            examples: [
                "pm csv import tasks.csv",
                "pm csv import backlog.csv --delimiter ';'",
                "pm csv import data.tsv --delimiter tab",
                "pm csv import jira.csv --map 'Summary=title,Owner=tags'",
                "pm csv import items.csv --key title   # idempotent re-import (no duplicates)",
                "pm csv import items.csv --dry-run",
            ],
            flags: [
                { long: "--delimiter", value_name: "char", description: "Field delimiter, or alias tab|comma|semicolon|pipe (default: ,)" },
                { long: "--map", value_name: "col=field", description: "Remap a CSV header to a pm field (repeatable, comma-joined). e.g. --map 'Summary=title'" },
                { long: "--key", value_name: "field", description: "Dedup key column: re-import updates the matching item instead of creating a duplicate" },
                { long: "--dry-run", description: "Preview without writing" },
            ],
            async run(ctx) {
                const filePath = ctx.args[0];
                if (!filePath) {
                    throw new CommandError("Usage: pm csv import <file> [--delimiter <char>] [--map col=field] [--key field] [--dry-run]", EXIT_CODE.USAGE);
                }
                const delimiter = resolveDelimiter(ctx.options["delimiter"]);
                const dryRun = readBoolOption(ctx.options, "dry-run", "dryRun");
                const fieldMap = parseFieldMap(ctx.options["map"]);
                const keyField = (ctx.options["key"] ?? "").trim().toLowerCase() || undefined;
                const absolutePath = resolve(filePath);
                console.error(`Reading CSV from: ${absolutePath}`);
                let res;
                try {
                    res = importCSV(ctx.pm_root, absolutePath, { delimiter, dryRun, fieldMap, keyField });
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
            ],
            flags: [
                { long: "--output", value_name: "file", description: "Output file path (default: print to stdout)" },
                { long: "--delimiter", value_name: "char", description: "Field delimiter, or alias tab|comma|semicolon|pipe (default: ,)" },
                { long: "--status", value_name: "filter", description: "Filter by status: open | in_progress | blocked | closed | canceled | draft" },
                { long: "--type", value_name: "type", description: "Filter by item type" },
                { long: "--columns", value_name: "list", description: `Comma-separated columns to export, in order (default: all). Valid: ${EXPORT_COLUMNS.join(", ")}` },
                { long: "--no-header", description: "Omit the CSV header row" },
                { long: "--crlf", description: "Use CRLF line endings (RFC-4180 / Excel)" },
            ],
            async run(ctx) {
                const delimiter = resolveDelimiter(ctx.options["delimiter"]);
                const outputPath = ctx.options["output"];
                const columns = selectExportColumns(ctx.options["columns"]);
                const noHeader = readBoolOption(ctx.options, "no-header", "noHeader");
                const crlf = readBoolOption(ctx.options, "crlf");
                console.error("Fetching pm items…");
                const { csvText, count } = buildCsvExport(ctx.pm_root, {
                    statusFilter: ctx.options["status"],
                    typeFilter: ctx.options["type"],
                    delimiter,
                    columns,
                    noHeader,
                    crlf,
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
            const { csvText, count } = buildCsvExport(ctx.pm_root, {
                statusFilter: ctx.options["status"],
                typeFilter: ctx.options["type"],
                delimiter,
                columns,
                noHeader,
                crlf,
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
            const absolutePath = resolve(filePath);
            console.error(`csv-import: reading ${absolutePath}`);
            let res;
            try {
                res = importCSV(ctx.pm_root, absolutePath, { delimiter, dryRun: false, fieldMap, keyField });
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
export { parseCSV, serializeCSV, serializeField, stripBOM, resolveDelimiter, parseFieldMap, applyFieldMap, normalizeStatus, parseTags, stringifyTags, encodeKeyTagValue, decodeKeyTagValue, selectExportColumns, EXPORT_COLUMNS, };
//# sourceMappingURL=index.js.map
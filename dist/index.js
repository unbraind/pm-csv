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
function serializeCSV(rows, delimiter) {
    return rows
        .map((row) => row.map((f) => serializeField(f, delimiter)).join(delimiter))
        .join("\n");
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
    const text = readFileSync(filePath, "utf-8");
    const rows = parseCSV(text, delimiter).filter((r) => r.some((f) => f.trim() !== ""));
    if (rows.length === 0) {
        return { headers: [], dataRows: [] };
    }
    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const dataRows = rows.slice(1);
    return { headers, dataRows };
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
    const headerRow = opts.columns.map(String);
    const dataRows = items.map((item) => opts.columns.map((col) => {
        const val = item[col];
        if (val === undefined || val === null)
            return "";
        if (Array.isArray(val))
            return stringifyTags(val);
        return String(val);
    }));
    return { csvText: serializeCSV([headerRow, ...dataRows], opts.delimiter), count: items.length };
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
            description: "Import pm items from a CSV file. " +
                "Expected columns: title, type, status, priority, tags, milestone, due_date, body. " +
                "Only 'title' is required; all other columns are optional.",
            intent: "import items from a CSV file into pm",
            examples: [
                "pm csv import tasks.csv",
                "pm csv import backlog.csv --delimiter ';'",
                "pm csv import items.csv --dry-run",
            ],
            flags: [
                { long: "--delimiter", value_name: "char", description: "CSV field delimiter (default: ,)" },
                { long: "--dry-run", description: "Preview without writing" },
            ],
            async run(ctx) {
                const filePath = ctx.args[0];
                if (!filePath) {
                    throw new CommandError("Usage: pm csv import <file> [--delimiter <char>] [--dry-run]", EXIT_CODE.USAGE);
                }
                const delimiter = ctx.options["delimiter"] ?? ",";
                const dryRun = readBoolOption(ctx.options, "dry-run", "dryRun");
                const absolutePath = resolve(filePath);
                console.error(`Reading CSV from: ${absolutePath}`);
                let headers;
                let dataRows;
                try {
                    ({ headers, dataRows } = readCSVFile(absolutePath, delimiter));
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    const exitCode = /ENOENT|no such file/i.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
                    throw new CommandError(`Failed to read file: ${msg}`, exitCode);
                }
                if (headers.length === 0) {
                    console.error("CSV file is empty or has no headers.");
                    return { imported: 0, skipped: 0 };
                }
                // Validate that at minimum 'title' is present
                if (!headers.includes("title")) {
                    throw new CommandError(`CSV is missing required 'title' column. Found: ${headers.join(", ")}`);
                }
                // Index columns
                const col = (name) => headers.indexOf(name);
                let imported = 0;
                let skipped = 0;
                const previews = [];
                for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
                    const row = dataRows[rowIndex];
                    const get = (name) => {
                        const idx = col(name);
                        return idx >= 0 ? (row[idx] ?? "").trim() : "";
                    };
                    const title = get("title");
                    if (!title) {
                        console.error(`Row ${rowIndex + 2}: skipping — 'title' is empty`);
                        skipped++;
                        continue;
                    }
                    const rawStatus = get("status");
                    const status = rawStatus ? normalizeStatus(rawStatus) : "open";
                    const rawPriority = get("priority");
                    const priority = rawPriority ? parseInt(rawPriority, 10) : undefined;
                    const tags = parseTags(get("tags"));
                    const type = get("type") || undefined;
                    // pm has no milestone/due_date fields on `create`; the deadline column
                    // (accept legacy "due_date" header too) maps to `--deadline`.
                    const deadline = get("deadline") || get("due_date") || undefined;
                    const body = get("body") || undefined;
                    if (dryRun) {
                        previews.push({ title, type, status, priority, tags, deadline, body });
                        imported++;
                        continue;
                    }
                    try {
                        const spawnArgs = [
                            "--path", ctx.pm_root,
                            "create",
                            "--title", title,
                            "--status", status,
                        ];
                        if (body)
                            spawnArgs.push("--body", body);
                        if (priority !== undefined && !isNaN(priority))
                            spawnArgs.push("--priority", String(priority));
                        if (type)
                            spawnArgs.push("--type", type);
                        if (deadline)
                            spawnArgs.push("--deadline", deadline);
                        if (tags.length > 0)
                            spawnArgs.push("--tags", tags.join(","));
                        const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
                        if (result.status !== 0) {
                            throw new Error(result.stderr || "pm create failed");
                        }
                        imported++;
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        console.error(`Row ${rowIndex + 2}: create failed — ${msg}`);
                        skipped++;
                    }
                }
                if (dryRun) {
                    console.error(`[dry-run] Would import ${imported} item(s), skip ${skipped} item(s).`);
                    return { dryRun: true, wouldImport: imported, wouldSkip: skipped, previews };
                }
                console.error(`Imported ${imported} item(s), skipped ${skipped} item(s).`);
                return { imported, skipped };
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
                { long: "--delimiter", value_name: "char", description: "CSV field delimiter (default: ,)" },
                { long: "--status", value_name: "filter", description: "Filter by status: open | in_progress | blocked | closed | canceled | draft" },
                { long: "--type", value_name: "type", description: "Filter by item type" },
                { long: "--columns", value_name: "list", description: `Comma-separated columns to export, in order (default: all). Valid: ${EXPORT_COLUMNS.join(", ")}` },
            ],
            async run(ctx) {
                const delimiter = ctx.options["delimiter"] ?? ",";
                const outputPath = ctx.options["output"];
                const columns = selectExportColumns(ctx.options["columns"]);
                console.error("Fetching pm items…");
                const { csvText, count } = buildCsvExport(ctx.pm_root, {
                    statusFilter: ctx.options["status"],
                    typeFilter: ctx.options["type"],
                    delimiter,
                    columns,
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
            const delimiter = ctx.options["delimiter"] ?? ",";
            const outputPath = ctx.options["output"];
            const columns = selectExportColumns(ctx.options["columns"]);
            const { csvText, count } = buildCsvExport(ctx.pm_root, {
                statusFilter: ctx.options["status"],
                typeFilter: ctx.options["type"],
                delimiter,
                columns,
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
            const delimiter = ctx.options["delimiter"] ?? ",";
            const absolutePath = resolve(filePath);
            console.error(`csv-import: reading ${absolutePath}`);
            let headers;
            let dataRows;
            try {
                ({ headers, dataRows } = readCSVFile(absolutePath, delimiter));
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`csv-import: failed to read file — ${msg}`);
                return;
            }
            if (!headers.includes("title")) {
                console.error("csv-import: CSV is missing required 'title' column — skipping.");
                return;
            }
            const col = (name) => headers.indexOf(name);
            let imported = 0;
            let skipped = 0;
            for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
                const row = dataRows[rowIndex];
                const get = (name) => {
                    const idx = col(name);
                    return idx >= 0 ? (row[idx] ?? "").trim() : "";
                };
                const title = get("title");
                if (!title) {
                    skipped++;
                    continue;
                }
                const rawStatus = get("status");
                const status = rawStatus ? normalizeStatus(rawStatus) : "open";
                const rawPriority = get("priority");
                const priority = rawPriority ? parseInt(rawPriority, 10) : undefined;
                const tags = parseTags(get("tags"));
                const type = get("type") || undefined;
                const deadline = get("deadline") || get("due_date") || undefined;
                const body = get("body") || undefined;
                try {
                    const spawnArgs = [
                        "--path", ctx.pm_root,
                        "create",
                        "--title", title,
                        "--status", status,
                    ];
                    if (body)
                        spawnArgs.push("--body", body);
                    if (priority !== undefined && !isNaN(priority))
                        spawnArgs.push("--priority", String(priority));
                    if (type)
                        spawnArgs.push("--type", type);
                    if (deadline)
                        spawnArgs.push("--deadline", deadline);
                    if (tags.length > 0)
                        spawnArgs.push("--tags", tags.join(","));
                    const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
                    if (result.status !== 0) {
                        throw new Error(result.stderr || "pm create failed");
                    }
                    imported++;
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`csv-import: row ${rowIndex + 2} create failed — ${msg}`);
                    skipped++;
                }
            }
            console.error(`csv-import: done — imported ${imported}, skipped ${skipped}.`);
        });
    },
});
//# sourceMappingURL=index.js.map
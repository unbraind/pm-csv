function defineExtension(m){return m}
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
// Columns accepted on import (order independent — driven by header row)
const IMPORT_COLUMNS = [
    "title",
    "type",
    "status",
    "priority",
    "tags",
    "milestone",
    "due_date",
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
    "milestone",
    "due_date",
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
 * Map an arbitrary status string (from the CSV) to a valid SDK status.
 * Falls back to "todo".
 */
function normalizeStatus(raw) {
    const s = raw.trim().toLowerCase();
    const map = {
        todo: "todo",
        open: "todo",
        new: "todo",
        done: "done",
        closed: "done",
        complete: "done",
        completed: "done",
        wip: "wip",
        in_progress: "wip",
        "in progress": "wip",
        doing: "wip",
        blocked: "blocked",
        on_hold: "blocked",
        "on hold": "blocked",
    };
    return map[s] ?? "todo";
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
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default defineExtension({
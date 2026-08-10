import type { ExtensionApi, ExtensionModule } from "@unbrained/pm-cli/sdk/authoring";
import { readFileSync, writeFileSync, createReadStream } from "node:fs";
import { resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";

import type {
  WorkspaceTransactionStep,
  WorkspaceTransactionCommitResult,
  WorkspaceTransactionStepInspection,
  WorkspaceTransactionJsonValue,
} from "@unbrained/pm-cli/sdk";


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
} as const;

class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
] as const;

// Columns written on export (fixed order)
const EXPORT_COLUMNS: Array<keyof PmItem> = [
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
const KNOWN_STATUSES: ReadonlySet<string> = new Set<string>([
  "open", "todo", "new",
  "in_progress", "wip", "in progress", "doing",
  "blocked", "on_hold", "on hold",
  "closed", "done", "complete", "completed",
  "canceled", "cancelled",
  "draft",
]);

/** Supported file encodings for `--encoding` on import. */
const SUPPORTED_ENCODINGS = ["utf-8", "utf8", "utf16le", "latin1"] as const;
type SupportedEncoding = (typeof SUPPORTED_ENCODINGS)[number];

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
function parseCSV(text: string, delimiter: string = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
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
function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Serialize a single field value for CSV output.
 * Wraps in double-quotes when the value contains the delimiter, quotes, or newlines.
 */
function serializeField(value: string, delimiter: string): string {
  const needsQuoting =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r");

  if (!needsQuoting) return value;

  // Escape embedded double-quotes by doubling them
  return `"${value.replace(/"/g, '""')}"`;
}

interface SerializeOptions {
  delimiter: string;
  /** Line terminator. RFC-4180 mandates CRLF; we default to LF for unix-friendliness. */
  eol?: "\n" | "\r\n";
}

/**
 * Serialize a full array of rows into a CSV string.
 */
function serializeCSV(
  rows: string[][],
  delimiterOrOpts: string | SerializeOptions,
): string {
  const opts: SerializeOptions =
    typeof delimiterOrOpts === "string"
      ? { delimiter: delimiterOrOpts }
      : delimiterOrOpts;
  const eol = opts.eol ?? "\n";
  return rows
    .map((row) => row.map((f) => serializeField(f, opts.delimiter)).join(opts.delimiter))
    .join(eol);
}

// ---------------------------------------------------------------------------
// Streaming CSV parser — for large files that should not be held in memory.
// Same RFC-4180 state machine as parseCSV, but fed incrementally so quoted
// fields spanning chunk boundaries are handled correctly.
// ---------------------------------------------------------------------------

/**
 * Incremental CSV state machine. Feed text via {@link push} and call
 * {@link end} when the input is exhausted. Each complete row is emitted to the
 * `onRow` callback exactly as in {@link parseCSV}.
 */
class StreamingCSVParser {
  private delimiter: string;
  private onRow: (row: string[]) => void;
  private field = "";
  private row: string[] = [];
  private inQuotes = false;
  private pendingBoundaryChar = "";

  constructor(delimiter: string, onRow: (row: string[]) => void) {
    this.delimiter = delimiter;
    this.onRow = onRow;
  }

  push(text: string): void {
    text = this.pendingBoundaryChar + text;
    this.pendingBoundaryChar = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (this.inQuotes) {
        if (ch === '"') {
          if (i + 1 === text.length) {
            this.pendingBoundaryChar = ch;
            return;
          }
          if (text[i + 1] === '"') {
            this.field += '"';
            i += 2;
            continue;
          }
          this.inQuotes = false;
          i++;
          continue;
        }
        this.field += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        this.inQuotes = true;
        i++;
        continue;
      }
      if (ch === this.delimiter) {
        this.row.push(this.field);
        this.field = "";
        i++;
        continue;
      }
      if (ch === "\r" && text[i + 1] === "\n") {
        this.row.push(this.field);
        this.field = "";
        this.onRow(this.row);
        this.row = [];
        i += 2;
        continue;
      }
      if (ch === "\r" && i + 1 === text.length) {
        this.pendingBoundaryChar = ch;
        return;
      }
      if (ch === "\n") {
        this.row.push(this.field);
        this.field = "";
        this.onRow(this.row);
        this.row = [];
        i++;
        continue;
      }
      this.field += ch;
      i++;
    }
  }

  end(): void {
    if (this.pendingBoundaryChar === '"' && this.inQuotes) {
      this.inQuotes = false;
    } else if (this.pendingBoundaryChar !== "") {
      this.field += this.pendingBoundaryChar;
    }
    this.pendingBoundaryChar = "";
    if (this.field !== "" || this.row.length > 0) {
      this.row.push(this.field);
      this.onRow(this.row);
      this.field = "";
      this.row = [];
    }
  }
}

/**
 * Stream a CSV file from disk, emitting each parsed row to `onRow`. Uses a
 * readable stream so the file is never fully loaded into memory. The BOM is
 * stripped from the first chunk. If `onRow` throws, the stream is destroyed and
 * the returned promise rejects with that error.
 */
function streamCSVFile(
  filePath: string,
  delimiter: string,
  encoding: SupportedEncoding,
  onRow: (row: string[]) => void,
): Promise<void> {
  const bufEnc: BufferEncoding = encoding === "utf-8" ? "utf8" : (encoding as BufferEncoding);

  return new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: bufEnc });
    const parser = new StreamingCSVParser(delimiter, onRow);
    let bomChecked = false;
    let stopped = false;

    const fail = (err: unknown) => {
      if (stopped) return;
      stopped = true;
      stream.destroy();
      reject(err);
    };

    stream.on("data", (chunk: Buffer | string) => {
      if (stopped) return;
      let text = typeof chunk === "string" ? chunk : chunk.toString(bufEnc);
      if (!bomChecked) {
        text = stripBOM(text);
        bomChecked = true;
      }
      try {
        parser.push(text);
      } catch (err) {
        fail(err);
      }
    });
    stream.on("end", () => {
      if (stopped) return;
      try {
        parser.end();
      } catch (err) {
        fail(err);
        return;
      }
      resolve();
    });
    stream.on("error", fail);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a boolean option honoring both the kebab-case long flag and the
 * camelCase key the runtime normalizes it to (e.g. `--dry-run` -> `dryRun`).
 * Without this, `ctx.options["dry-run"]` is silently `undefined`.
 */
function readBoolOption(options: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    if (options[key] !== undefined) return Boolean(options[key]);
  }
  return false;
}

/**
 * Whether the CSV header row should be omitted. The host parses `--no-header`
 * as the negation of the registered positive `--header` flag (setting
 * `header=false`); the literal `no-header`/`noHeader` keys are accepted as a
 * fallback for the exporter-capability path. Precedence: an explicit
 * `header=false` (i.e. `--no-header`) always wins. Shared by the `csv export`
 * command and the `csv-export` exporter so the two paths can't drift.
 */
function readNoHeaderOption(options: Record<string, unknown>): boolean {
  return options["header"] === false || readBoolOption(options, "no-header", "noHeader");
}

/**
 * Resolve a user-supplied delimiter, accepting friendly aliases so TSV is easy:
 *   --delimiter tab   --delimiter "\t"   --delimiter ";"
 * A literal backslash-t is interpreted as a tab.
 */
function resolveDelimiter(raw: string | undefined): string {
  if (raw === undefined || raw === "") return ",";
  const lower = raw.toLowerCase();
  if (lower === "tab" || lower === "\\t" || lower === "tsv") return "\t";
  if (lower === "comma") return ",";
  if (lower === "semicolon") return ";";
  if (lower === "pipe") return "|";
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
// Ownership tag prefix stamped by the `--atomic` import path. Every item
// created/updated inside one atomic transaction is tagged with BOTH:
//   - a batch-level marker `csv-tx:<transactionId>` (useful for scanning), and
//   - a per-row marker `csv-txrow:<transactionId>#<rowIndex>` (source of truth).
// The per-row marker makes resume/compensation per-row-precise, so a CSV with
// duplicate titles or duplicate keys cannot trick inspect() into skipping the
// wrong row or compensating the wrong item. Like the other csv- prefixes both
// are stripped from exports and never surface in the user-facing tags column.
// pm lower-cases tags on storage; transactionId is `csv-import-<hex>` (already
// lower-case) and rowIndex is numeric, so the marker round-trips unchanged.
const TX_TAG_PREFIX = "csv-tx:";
const TX_ROW_TAG_PREFIX = "csv-txrow:";
const TX_ROW_TAG_SEPARATOR = "#";
/** Read-buffer cap for `pm` output, in bytes. 16 MiB by default; override with the
 * `PM_LIST_MAX_BUFFER` env var. Resolved per call so the override takes effect
 * without an import-order dependency. Invalid or non-positive values fall back to
 * the default rather than silently disabling the guard. */
function pmListMaxBuffer(): number {
  // Number(), not parseInt(): parseInt("16MiB") silently yields 16, which would
  // impose a 16-BYTE cap and break every ordinary read while appearing to honor
  // the documented invalid-value fallback. Number() rejects the whole string.
  const raw = Number(process.env.PM_LIST_MAX_BUFFER);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 16 * 1024 * 1024;
}

/**
 * Describe why a `spawnSync` result has `status: null`, wording the message for
 * the REAL cause so the operator is sent down the right path.
 *
 * Node reports `status: null` whenever the child was terminated before it could
 * produce a usable exit code, and three distinct causes produce it (verified
 * against `SpawnSyncReturns` in `@types/node` and confirmed empirically):
 *
 *  - A captured-output overrun. Node sets `result.error` with `code ===
 *    "ENOBUFS"` and terminates the child with the kill signal. The captured
 *    output is truncated and unusable, and the fix IS to narrow the query or
 *    raise `PM_LIST_MAX_BUFFER`.
 *  - A spawn or system error (the binary could not be launched, a timeout,
 *    …). `result.error` is set with a code OTHER than `ENOBUFS`. This is NOT a
 *    buffer problem, and telling the operator to raise `PM_LIST_MAX_BUFFER`
 *    sends them down the wrong path.
 *  - An external signal termination (an OOM reaper, a manual kill, …).
 *    `result.error` is unset and `result.signal` carries the signal. Also NOT a
 *    buffer problem — note the kill signal from a buffer overrun (`SIGTERM`) is
 *    the SAME signal an external `SIGTERM` produces, so the signal alone cannot
 *    tell the two apart; only `error.code === "ENOBUFS"` can.
 *
 * Exposed so the write paths ({@link upsertCreate}) can reuse the same wording
 * when they recover an id from an overrun receipt before throwing, and so the
 * three causes can be regression-tested directly with synthetic results.
 */
export function describePmNullStatus(result: SpawnSyncReturns<string>, label: string): string {
  const err = result.error as NodeJS.ErrnoException | undefined;
  const code = err?.code;
  if (err !== undefined && code === "ENOBUFS") {
    return `pm ${label} overran its ${pmListMaxBuffer()}-byte stdout buffer (Node reported error code ENOBUFS${result.signal ? ` and terminated the child with ${result.signal}` : ""}); the captured output is truncated and unusable — narrow the query (--status/--type) or raise the PM_LIST_MAX_BUFFER env var`;
  }
  if (err !== undefined) {
    return `pm ${label} could not run to completion: ${err.message}${code !== undefined ? ` (code ${code})` : ""}; this is a spawn or system error, NOT a stdout buffer overrun, so raising the PM_LIST_MAX_BUFFER env var will not help`;
  }
  return `pm ${label} was terminated by signal ${result.signal ?? "<unknown>"} before producing a usable exit code; this is NOT a stdout buffer overrun (no ENOBUFS error was reported), so raising the PM_LIST_MAX_BUFFER env var will not help — investigate what sent the signal`;
}

/**
 * Turn a `status: null` pm subprocess result into a hard, named error instead of
 * the wrong answer `spawnSync` otherwise leaves behind.
 *
 * When a child is terminated before exiting, `spawnSync` reports `status: null`
 * and a guard that only branches on `status !== 0` then reads `null !== 0` as
 * truthy and routes the result onto its failure branch — "the item does not
 * exist", "nothing was applied yet", or a generic "pm failed" — so a too-large
 * project (or a killed child) is silently mis-imported instead of reported.
 * This collapses that case into one explicit error, worded for the real cause by
 * {@link describePmNullStatus}, at every call site that captures pm output and
 * must not degrade.
 *
 * The best-effort rollback sites in {@link compensateCreate} intentionally do
 * NOT call this on their own subprocesses: compensation is contractually
 * tolerant of a failed subprocess, and a named throw there would abort a sweep
 * that exists to leave the tracker consistent despite partial failure.
 */
function assertPmOutputFit(result: SpawnSyncReturns<string>, label: string): void {
  if (result.status !== null) return;
  throw new CommandError(
    `${describePmNullStatus(result, label)}. The result is unusable, so it must never be treated as an empty or absent value.`,
  );
}

/**
 * Normalize a dedup key value for stable matching. pm lower-cases tags on
 * storage, so a `csv-key:` tag written from "Fix Bug" comes back as
 * "fix bug"; we therefore fold the key to lower-case on BOTH write and lookup
 * so re-imports match (and thus update) instead of duplicating.
 */
function normalizeKeyValue(value: string): string {
  return value.trim().toLowerCase();
}

function encodeKeyTagValue(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Percent-decode a value taken from an internal tag, tolerating bad input.
 *
 * Tag payloads are percent-encoded when written, but a hand-edited or
 * externally-created item can carry a malformed escape, which makes
 * `decodeURIComponent` throw. Rather than abort an export over one damaged tag,
 * the raw value is returned unchanged — so the caller may receive a still-encoded
 * string, and the return is not guaranteed to be decoded.
 *
 * @param value - Percent-encoded tag payload.
 * @returns The decoded value, or `value` itself when it cannot be decoded.
 */
function decodeKeyTagValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse a `--map csvHeader=field` spec (repeatable / comma-joined) into a
 * lookup from a normalized CSV header name to the canonical pm field name.
 * Example: `--map "Summary=title,Owner=tags"`.
 */
function parseFieldMap(spec: string | string[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (spec === undefined) return map;
  const parts = (Array.isArray(spec) ? spec : [spec]).flatMap((s) => s.split(","));
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      throw new CommandError(
        `Invalid --map entry "${trimmed}"; expected csvHeader=field`,
        EXIT_CODE.USAGE,
      );
    }
    const from = trimmed.slice(0, eq).trim().toLowerCase();
    const to = trimmed.slice(eq + 1).trim().toLowerCase();
    if (!from || !to) {
      throw new CommandError(
        `Invalid --map entry "${trimmed}"; expected csvHeader=field`,
        EXIT_CODE.USAGE,
      );
    }
    map[from] = to;
  }
  return map;
}

/**
 * Apply a field map to a list of header names, producing the effective
 * (canonical) header used for column lookup.
 */
function applyFieldMap(headers: string[], fieldMap: Record<string, string>): string[] {
  return headers.map((h) => fieldMap[h] ?? h);
}

/**
 * Compute a simple Levenshtein edit distance between two lowercase strings.
 * Used only for "did you mean …?" suggestions, so a naive O(m*n) DP is fine.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/**
 * Suggest the closest match from `valid` for an unknown `input` string, or
 * undefined when nothing is close enough (distance > 3 and > half the input
 * length). Exposed for unit testing.
 */
function suggestClosest(input: string, valid: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  const normalizedInput = input.toLowerCase();
  for (const candidate of valid) {
    const dist = levenshtein(normalizedInput, candidate.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  if (best === undefined) return undefined;
  return bestDist <= 3 || bestDist <= Math.floor(input.length / 2) ? best : undefined;
}

/**
 * Validate that every `--map` target is a known pm import field. Returns a
 * list of helpful warning strings (empty when all targets are valid). Each
 * warning includes a "did you mean" suggestion when one is close.
 */
function validateFieldMapTargets(fieldMap: Record<string, string>): string[] {
  const warnings: string[] = [];
  const valid = IMPORT_COLUMNS as readonly string[];
  for (const [from, to] of Object.entries(fieldMap)) {
    if (!valid.includes(to)) {
      const suggestion = suggestClosest(to, valid);
      const hint = suggestion ? ` Did you mean '${suggestion}'?` : "";
      warnings.push(
        `--map target '${to}' (from '${from}') is not a known pm field.${hint} Valid fields: ${valid.join(", ")}`,
      );
    }
  }
  return warnings;
}

/**
 * Detect `--map` source headers that are not present in the CSV file. Returns a
 * list of warning strings with a suggestion for the closest actual header.
 */
function checkMapSourcesPresent(headers: string[], fieldMap: Record<string, string>): string[] {
  const warnings: string[] = [];
  for (const from of Object.keys(fieldMap)) {
    if (!headers.includes(from)) {
      const suggestion = suggestClosest(from, headers);
      const hint = suggestion ? ` Did you mean '${suggestion}'?` : "";
      warnings.push(
        `--map source '${from}' not found in CSV headers.${hint} Found: ${headers.join(", ") || "(none)"}`,
      );
    }
  }
  return warnings;
}

interface AutoFieldMapping {
  from: string;
  to: string;
}

interface FieldMapResolution {
  fieldMap: Record<string, string>;
  autoMappings: AutoFieldMapping[];
}

/**
 * Alias vocabulary used by `--auto-map` for import/validate. Mappings are
 * intentionally conservative: a target field is auto-mapped only when exactly
 * one alias candidate is present and the target is not already claimed by a
 * canonical header or explicit `--map`.
 */
const AUTO_MAP_ALIASES: Record<string, readonly string[]> = {
  title: ["summary", "name", "subject", "issue", "issue_title", "item", "task"],
  status: ["state", "workflow_state", "workflow status"],
  priority: ["rank", "prio", "importance"],
  tags: ["labels", "label", "tag"],
  deadline: ["due", "due_date", "due-date", "target_date", "target-date"],
  body: ["description", "details", "notes"],
  parent: ["parent_id", "parent-id", "epic", "epic_id", "epic-id"],
  assignee: ["owner", "assigned_to", "assigned-to", "assigned"],
  sprint: ["iteration", "sprint_name", "sprint-name"],
  release: ["milestone", "version", "fix_version", "fix-version", "fixversion"],
  blocked_by: ["blocked-by", "depends_on", "depends-on", "dependency", "blocker", "blocked_by_id"],
};

/**
 * Resolve the effective header map for import/validate.
 *
 * Explicit `--map` entries always win. `--auto-map` only adds non-conflicting
 * alias mappings and never overrides an already-claimed canonical field.
 */
function resolveImportFieldMap(
  headers: string[],
  explicitMap: Record<string, string>,
  autoMap: boolean,
): FieldMapResolution {
  const fieldMap: Record<string, string> = { ...explicitMap };
  if (!autoMap || headers.length === 0) return { fieldMap, autoMappings: [] };

  const headerCounts = new Map<string, number>();
  for (const header of headers) {
    headerCounts.set(header, (headerCounts.get(header) ?? 0) + 1);
  }

  const mappedHeaders = new Set<string>(Object.keys(fieldMap));
  const claimedTargets = new Set<string>(headers);
  for (const to of Object.values(fieldMap)) claimedTargets.add(to);

  const autoMappings: AutoFieldMapping[] = [];
  for (const [target, aliases] of Object.entries(AUTO_MAP_ALIASES)) {
    if (claimedTargets.has(target)) continue;
    const candidates = aliases.filter(
      (alias) => (headerCounts.get(alias) ?? 0) === 1 && !mappedHeaders.has(alias),
    );
    // Multiple candidates (e.g. both summary and name) is ambiguous: skip.
    if (candidates.length !== 1) continue;

    const from = candidates[0];
    fieldMap[from] = target;
    mappedHeaders.add(from);
    claimedTargets.add(target);
    autoMappings.push({ from, to: target });
  }

  return { fieldMap, autoMappings };
}

function formatAutoMappings(mappings: AutoFieldMapping[]): string {
  return mappings.map((m) => `${m.from}->${m.to}`).join(", ");
}

function autoMappingsToRecord(mappings: AutoFieldMapping[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const m of mappings) record[m.from] = m.to;
  return record;
}

/**
 * Map an arbitrary status string (from the CSV) to a valid SDK status.
 * Falls back to "open".
 */
function normalizeStatus(raw: string): ItemStatus {
  const s = raw.trim().toLowerCase();
  const map: Record<string, ItemStatus> = {
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
function parseTags(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

/**
 * Stringify a tags array back to a semicolon-free comma-separated string
 * (safe to embed in a single CSV field).
 */
function stringifyTags(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return "";
  return tags.join(",");
}

/**
 * Validate and normalize a user-supplied `--encoding` value to a Node-supported
 * BufferEncoding. Accepts utf-8/utf8, utf16le, latin1. Throws USAGE otherwise.
 */
function resolveEncoding(raw: string | undefined): SupportedEncoding {
  if (raw === undefined || raw === "") return "utf-8";
  const lower = raw.trim().toLowerCase();
  if ((SUPPORTED_ENCODINGS as readonly string[]).includes(lower)) {
    return lower as SupportedEncoding;
  }
  throw new CommandError(
    `Unknown --encoding '${raw}'. Supported: ${SUPPORTED_ENCODINGS.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

/**
 * Read rows from a CSV file, returning header and data rows separately.
 * Skips fully-empty rows. Decodes with the given encoding (default utf-8).
 */
function readCSVFile(
  filePath: string,
  delimiter: string,
  encoding: SupportedEncoding = "utf-8",
  skipHeaders = false,
): { headers: string[]; dataRows: string[][] } {
  // Node's BufferEncoding spells utf-8 as "utf8"; normalize.
  const bufEnc: BufferEncoding = encoding === "utf-8" ? "utf8" : (encoding as BufferEncoding);
  const text = stripBOM(readFileSync(filePath, bufEnc));
  const rows = parseCSV(text, delimiter).filter((r) =>
    r.some((f) => f.trim() !== "")
  );

  if (rows.length === 0) {
    return { headers: [], dataRows: [] };
  }

  if (skipHeaders) {
    // No header row in the file: map columns positionally to the canonical
    // import order. Every row (including the first) is a data row.
    return { headers: [...IMPORT_COLUMNS], dataRows: rows };
  }

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const dataRows = rows.slice(1);
  return { headers, dataRows };
}

// ---------------------------------------------------------------------------
// Shared import core — used by `csv import` and the csv-import importer so both
// share one code path (mapping, coercion, idempotent upsert, counts).
// ---------------------------------------------------------------------------

interface CsvImportOptions {
  delimiter: string;
  dryRun: boolean;
  fieldMap: Record<string, string>;
  /** Auto-map well-known third-party headers (summary->title, owner->assignee, ...). */
  autoMap?: boolean;
  /** Canonical pm field whose value is the dedup key (e.g. "title" or "id"). */
  keyField?: string;
  /** File text encoding to decode the source with (default utf-8). */
  encoding?: SupportedEncoding;
  /** Optional provenance label recorded on imported items via the csv_source field. */
  source?: string;
  /** Row-level filter: only rows matching every set criterion are imported. */
  filter?: ImportRowFilter;
  /** The CSV file has no header row; map columns positionally to IMPORT_COLUMNS. */
  skipHeaders?: boolean;
  /** Stream the file row-by-row instead of loading it fully into memory. */
  stream?: boolean;
  /**
   * Import all creates atomically under one workspace writer-locked,
   * crash-recoverable transaction (pm-cli >= 2026.7.19
   * `commitWorkspaceTransaction`). On failure every applied create is
   * compensated (closed) and the tracker is left with no committed items from
   * this import; an interrupted run resumes from the durable journal.
   * Incompatible with `--stream` (an unbounded stream cannot be one transaction).
   */
  atomic?: boolean;
  /**
   * Bound commit coordinator for the atomic path. Bound by the command path
   * from the host-injected `ctx.sdk` (runtime-safe); the importer path resolves
   * it via a dynamic `import("@unbrained/pm-cli/sdk")`. When `atomic` is set but
   * this is absent, the atomic path dynamically imports the SDK itself.
   */
  commitTransaction?: (options: {
    transactionId: string;
    author: string;
    steps: readonly WorkspaceTransactionStep[];
    lockTtlSeconds?: number;
    lockWaitMs?: number;
  }) => Promise<WorkspaceTransactionCommitResult>;
  /** Author attributed to the atomic transaction journal (defaults to `pm-csv`). */
  atomicAuthor?: string;
}

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

interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  /** Subset of `skipped` attributable to a row not matching the import filter. */
  filtered: number;
  /** Auto-applied alias mappings when `--auto-map` is enabled. */
  autoMappings: AutoFieldMapping[];
  errors: string[];
  previews: Record<string, unknown>[];
  /** Helpful warnings about unknown --map targets or missing source headers. */
  fieldMapWarnings: string[];
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
 * Build the canonical field accessor for a header row + data row.
 */
function rowFields(
  headers: string[],
  row: string[],
): { get: (name: string) => string; parsed: ParsedRow } {
  const col = (name: string): number => headers.indexOf(name);
  const get = (name: string): string => {
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
 * Parse the `--status`/`--type`/`--priority` import filter flags into a
 * normalized {@link ImportRowFilter}. Mirrors export filter semantics:
 *   - status is normalized through {@link normalizeStatus} so the same alias
 *     vocabulary as a CSV `status` cell applies (e.g. `--status done` matches
 *     rows whose status normalizes to `closed`).
 *   - priority must be an integer; a non-integer is a USAGE error.
 *   - type is matched case-insensitively (lower-cased here and at compare time).
 * Returns `undefined` when no filter flag is set (the common no-filter path).
 */
function parseImportFilter(
  statusRaw: string | undefined,
  typeRaw: string | undefined,
  priorityRaw: string | undefined,
): ImportRowFilter | undefined {
  const status = statusRaw && statusRaw.trim() ? normalizeStatus(statusRaw) : undefined;
  const type = typeRaw && typeRaw.trim() ? typeRaw.trim().toLowerCase() : undefined;
  let priority: number | undefined;
  if (priorityRaw !== undefined && priorityRaw.trim() !== "") {
    const n = Number(priorityRaw.trim());
    if (!Number.isInteger(n)) {
      throw new CommandError(
        `Invalid --priority filter '${priorityRaw}'; expected an integer.`,
        EXIT_CODE.USAGE,
      );
    }
    priority = n;
  }
  if (status === undefined && type === undefined && priority === undefined) {
    return undefined;
  }
  return { status, type, priority };
}

/**
 * Pure predicate: does a parsed row satisfy every set filter criterion?
 * Unset criteria are wildcards. Exposed for unit testing.
 */
function rowMatchesFilter(row: ParsedRow, filter: ImportRowFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.status !== undefined && row.status !== filter.status) return false;
  if (filter.type !== undefined && (row.type ?? "").toLowerCase() !== filter.type) return false;
  if (filter.priority !== undefined && row.priority !== filter.priority) return false;
  return true;
}

/**
 * List existing items once and build a lookup from csv-key provenance value to
 * item id, for idempotent upsert.
 */
function loadKeyIndex(pmRoot: string): Map<string, string> {
  const index = new Map<string, string>();
  const result = spawnSync(
    "pm",
    ["--path", pmRoot, "list-all", "--json"],
    { encoding: "utf-8", maxBuffer: pmListMaxBuffer() },
  );
  if (result.error) throw new CommandError(`pm list-all failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new CommandError(result.stderr?.trim() || "pm list-all failed");
  }
  let items: PmItem[] = [];
  try {
    items = JSON.parse(result.stdout).items ?? [];
  } catch {
    return index;
  }
  for (const item of items) {
    for (const tag of item.tags ?? []) {
      if (tag.startsWith(KEY_TAG_PREFIX)) {
        index.set(
          normalizeKeyValue(decodeKeyTagValue(tag.slice(KEY_TAG_PREFIX.length))),
          item.id,
        );
      }
    }
  }
  return index;
}

/**
 * Process a single data row against the resolved headers, updating the shared
 * {@link ImportResult} in place. Extracted so the in-memory and streaming
 * import paths share one code path for filtering, dry-run preview, and upsert.
 */
function processImportRow(
  pmRoot: string,
  headers: string[],
  row: string[],
  lineNo: number,
  opts: CsvImportOptions,
  keyIndex: Map<string, string>,
  result: ImportResult,
): void {
  const { get, parsed } = rowFields(headers, row);

  if (!parsed.title) {
    const msg = `Row ${lineNo}: skipping — 'title' is empty`;
    console.error(msg);
    result.skipped++;
    return;
  }

  // Row-level filter (mirrors export filter semantics): skip non-matching
  // rows BEFORE any create/update so they never become pm items.
  if (!rowMatchesFilter(parsed, opts.filter)) {
    result.skipped++;
    result.filtered++;
    return;
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
    if (existingId) result.updated++;
    else result.imported++;
    return;
  }

  try {
    if (existingId) {
      upsertUpdate(pmRoot, existingId, parsed, opts.source);
      result.updated++;
    } else {
      const newId = upsertCreate(pmRoot, parsed, opts.keyField ? keyValue : undefined, opts.source);
      if (opts.keyField && keyValue && newId) keyIndex.set(normalizeKeyValue(keyValue), newId);
      result.imported++;
    }
  } catch (err: unknown) {
    const msg = `Row ${lineNo}: ${existingId ? "update" : "create"} failed — ${
      err instanceof Error ? err.message : String(err)
    }`;
    console.error(msg);
    result.errors.push(msg);
    result.skipped++;
  }
}

/**
 * Validate the resolved header map, throwing a helpful error when the required
 * `title` column or the `--key` column is missing. Shared by both import paths.
 */
function assertImportHeaders(headers: string[], opts: CsvImportOptions): void {
  if (!headers.includes("title")) {
    throw new CommandError(
      `CSV is missing required 'title' column (after --map). Found: ${headers.join(", ") || "(none)"}`,
      EXIT_CODE.USAGE,
    );
  }
  if (opts.keyField && !headers.includes(opts.keyField)) {
    throw new CommandError(
      `--key column '${opts.keyField}' not found in CSV. Found: ${headers.join(", ") || "(none)"}`,
      EXIT_CODE.USAGE,
    );
  }
}

/**
 * Compute and log field-mapping validation warnings, returning them for the
 * caller to store in the {@link ImportResult}. Shared by both import paths.
 */
function computeFieldMapWarnings(
  rawHeaders: string[],
  fieldMap: Record<string, string>,
): string[] {
  const warnings = [
    ...validateFieldMapTargets(fieldMap),
    ...checkMapSourcesPresent(rawHeaders, fieldMap),
  ];
  for (const w of warnings) console.error(`Warning: ${w}`);
  return warnings;
}

/**
 * Import CSV rows into a pm tracker as items.
 *
 * Rejects rather than throws when `--atomic` is combined with `--stream`: the
 * two are genuinely incompatible, because an all-or-nothing commit needs the
 * whole row set in hand and a stream is unbounded. Returning a rejected promise
 * keeps the failure on the same channel as the rest of the async path.
 *
 * @param pmRoot - Tracker root passed through to the pm CLI.
 * @param filePath - CSV file to read.
 * @param opts - Import behaviour, including the atomic and stream modes.
 * @returns The import outcome; rejects with a {@link CommandError} on a usage
 *          conflict or an unreadable file.
 */
function importCSV(pmRoot: string, filePath: string, opts: CsvImportOptions): Promise<ImportResult> {
  if (opts.atomic && opts.stream) {
    return Promise.reject(
      new CommandError(
        "--atomic cannot be combined with --stream: an unbounded stream cannot be committed as one all-or-nothing transaction.",
        EXIT_CODE.USAGE,
      ),
    );
  }
  if (opts.atomic) return importCSVAtomic(pmRoot, filePath, opts);
  if (opts.stream) return importCSVStreaming(pmRoot, filePath, opts);
  return Promise.resolve(importCSVInMemory(pmRoot, filePath, opts));
}

/**
 * In-memory import: reads the full file, resolves the header map, and processes
 * every data row. Used when `--stream` is not set (the default).
 */
function importCSVInMemory(pmRoot: string, filePath: string, opts: CsvImportOptions): ImportResult {
  const { headers: rawHeaders, dataRows } = readCSVFile(
    filePath,
    opts.delimiter,
    opts.encoding ?? "utf-8",
    opts.skipHeaders ?? false,
  );
  const result: ImportResult = {
    imported: 0,
    updated: 0,
    skipped: 0,
    filtered: 0,
    autoMappings: [],
    errors: [],
    previews: [],
    fieldMapWarnings: [],
  };

  if (rawHeaders.length === 0) return result;

  result.fieldMapWarnings = computeFieldMapWarnings(rawHeaders, opts.fieldMap);

  const mapResolution = resolveImportFieldMap(rawHeaders, opts.fieldMap, opts.autoMap ?? false);
  const headers = applyFieldMap(rawHeaders, mapResolution.fieldMap);
  result.autoMappings = mapResolution.autoMappings;

  assertImportHeaders(headers, opts);

  // Pre-load the dedup index only when upserting (one extra pm call, not per-row).
  const keyIndex = opts.keyField && !opts.dryRun ? loadKeyIndex(pmRoot) : new Map<string, string>();

  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
    const lineNo = opts.skipHeaders ? rowIndex + 1 : rowIndex + 2;
    processImportRow(pmRoot, headers, dataRows[rowIndex], lineNo, opts, keyIndex, result);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Atomic import (pm-cli >= 2026.7.19 commitWorkspaceTransaction)
// ---------------------------------------------------------------------------

/**
 * SHA-1 fingerprint of the exact parsed content being imported (raw headers +
 * every data row). Folded into the transaction id so editing a file in place
 * changes the id (see deriveTransactionId).
 */
function fingerprintContent(rawHeaders: string[], dataRows: string[][]): string {
  return createHash("sha1")
    .update(JSON.stringify({ headers: rawHeaders, rows: dataRows }))
    .digest("hex");
}

/**
 * Derive a stable, resumable transaction id from the absolute import file path
 * AND a fingerprint of the exact rows being imported:
 * `csv-import-<sha1(absPath + separator + contentFingerprint)>` (12 hex chars).
 *
 * The content fingerprint is essential. Resume matching keys on `rowIndex`, so
 * an id derived from the path ALONE would let a later import of *different*
 * content at the same path reuse the old `csv-txrow:#<n>` markers — `inspect()`
 * would treat the new rows as already applied and silently skip them, reporting
 * a successful import that changed nothing. Folding the content into the id
 * means: the SAME file re-run after a crash keeps the same id (resumes from the
 * journal, no duplicates), while editing the file in place yields a NEW id (a
 * fresh import that applies the new contents) — never a stale skip.
 */
function deriveTransactionId(absoluteFilePath: string, contentFingerprint: string): string {
  const hash = createHash("sha1")
    .update(absoluteFilePath)
    .update("\x1f")  // unit-separator between path and content
    .update(contentFingerprint)
    .digest("hex")
    .slice(0, 12);
  return `csv-import-${hash}`;
}

/**
 * Public helper: the atomic transaction id that `pm csv import <file> --atomic`
 * derives for the given file and options (reads and parses the file exactly as
 * the importer does). Exposed so callers/tests can correlate items to their
 * originating atomic import without re-implementing the derivation.
 */
export function atomicTransactionId(
  filePath: string,
  opts: { delimiter?: string; encoding?: SupportedEncoding; skipHeaders?: boolean } = {},
): string {
  const { headers: rawHeaders, dataRows } = readCSVFile(
    filePath,
    resolveDelimiter(opts.delimiter),
    opts.encoding ?? "utf-8",
    opts.skipHeaders ?? false,
  );
  return deriveTransactionId(resolve(filePath), fingerprintContent(rawHeaders, dataRows));
}

/**
 * Load every item stamped with this transaction's per-row ownership marker
 * (`csv-txrow:<transactionId>#<rowIndex>`) and build a single lookup the step
 * `inspect()` uses to detect rows already applied by a prior (interrupted) run:
 *   - byRowIndex: rowIndex -> item id
 *
 * The per-row marker is the source of truth for resume/compensation: it makes
 * matching per-row-precise, so a CSV with duplicate titles or duplicate keys
 * can never trick inspect() into skipping the wrong row. The batch-level
 * `csv-tx:<transactionId>` marker is also stamped (handy for scanning) but is
 * NOT used for matching. Only items carrying a per-row marker for THIS
 * transaction are included, so pre-existing items this transaction never
 * touched are never mistaken for already-applied steps.
 *
 * Presence of the row marker — NOT item status — is the applied signal. A row
 * whose CSV `status` is `closed`/`canceled` is legitimately imported as a
 * closed item (upsertCreate/upsertUpdate apply the row's status, routing
 * terminal transitions through `pm close --reason`), so it must
 * still be recognized on resume and never re-imported. Conversely a rolled-back
 * create must NOT be recognized: `compensateCreate()` therefore STRIPS the
 * `csv-tx`/`csv-txrow` markers before closing the item, so a compensated
 * tombstone carries no marker and a post-rollback retry re-imports its row.
 * (This is why matching by marker-presence is correct for both a
 * legitimately-closed applied row and a rolled-back one; see compensateCreate.)
 */
function loadAppliedByTransaction(
  pmRoot: string,
  transactionId: string,
): { byRowIndex: Map<number, string> } {
  const byRowIndex = new Map<number, string>();
  const rowMarkerPrefix = `${TX_ROW_TAG_PREFIX}${transactionId}${TX_ROW_TAG_SEPARATOR}`;
  const r = spawnSync("pm", ["--path", pmRoot, "list-all", "--json"], {
    encoding: "utf-8",
    maxBuffer: pmListMaxBuffer(),
  });
  // A stdout overrun kills the child with `status: null` and an empty stderr;
  // the previous guard (`r.error || r.status !== 0`) then returned an EMPTY map,
  // so inspect() concluded "nothing was applied" and a resumed atomic import
  // silently re-imported every already-applied row — wrong data, not a crash.
  // Route that overrun through {@link assertPmOutputFit} as a hard, named error
  // instead. A genuine non-zero exit (not a buffer condition) still falls through
  // to the best-effort empty map, preserving the resume scan's tolerance.
  assertPmOutputFit(r, "list-all");
  if (r.status !== 0) return { byRowIndex };
  let items: PmItem[] = [];
  try {
    items = JSON.parse(r.stdout).items ?? [];
  } catch {
    return { byRowIndex };
  }
  for (const item of items) {
    for (const tag of item.tags ?? []) {
      if (!tag.startsWith(rowMarkerPrefix)) continue;
      const rowIndexStr = tag.slice(rowMarkerPrefix.length);
      const rowIndex = Number.parseInt(rowIndexStr, 10);
      if (Number.isInteger(rowIndex)) byRowIndex.set(rowIndex, item.id);
    }
  }
  return { byRowIndex };
}

/**
 * Return the current status of an item id, or `undefined` when the item no
 * longer exists. Used by the compensation guard so `pm close` is only invoked
 * on items that still exist and are not already closed (closing a closed item
 * is a pm error).
 *
 * Tier-2 read: this single-item lookup stays a `pm get` subprocess (the SDK's
 * status lives on item metadata, not the located document, and converting it
 * would push `async` through the whole sync import graph). It now caps stdout
 * at {@link pmListMaxBuffer} and routes a buffer overrun through
 * {@link assertPmOutputFit} as a hard, named error. Previously an overrun left
 * `status: null`, which `status !== 0` mapped onto `undefined` — i.e. a
 * too-large item was silently reported as "does not exist", and the
 * compensation guard then skipped a close it should have run. A genuine
 * non-zero exit (item truly absent, or a failed lookup such as the
 * `fake-get-fail` regression) still returns `undefined` unchanged.
 */
function itemStatus(pmRoot: string, id: string): ItemStatus | undefined {
  const r = spawnSync("pm", ["--path", pmRoot, "get", id, "--json"], {
    encoding: "utf-8",
    maxBuffer: pmListMaxBuffer(),
  });
  assertPmOutputFit(r, "get");
  if (r.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(r.stdout);
    return (parsed.item?.status ?? parsed.status) as ItemStatus | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Idempotently undo one row's create. First STRIPS this transaction's ownership
 * markers (`markers`) from the item, then closes it via `pm close` (NOT delete,
 * to avoid the known history-resurrection issue) when it is still open.
 *
 * Stripping the markers is what makes marker-presence a correct "applied"
 * signal: a rolled-back row no longer carries a marker, so a post-rollback
 * retry re-imports it, while a *successfully* imported row (even one whose CSV
 * status is `closed`/`canceled`) keeps its marker and is resumed idempotently.
 * The strip runs whether the item is open or already closed (a closed-status
 * create being rolled back must also lose its marker); the close only runs for
 * a still-open item. Every step tolerates a missing item / absent tag, so a
 * repeated compensation (e.g. after a crash mid-compensation) is a safe no-op.
 *
 * The status lookup itself is also tolerated: if `itemStatus` throws (a stdout
 * overrun or a signal kill on the `pm get`), the throw is caught and this row's
 * compensation becomes a no-op rather than aborting the sweep. The hard error is
 * kept on the import READ path ({@link loadAppliedByTransaction}, and the
 * verification `itemStatus` in {@link upsertCreate}), where a wrong answer is
 * the real danger; here the danger is aborting a best-effort rollback mid-sweep
 * and leaving every later applied create un-compensated.
 */
function compensateCreate(
  pmRoot: string,
  id: string,
  markers: readonly string[] = [],
  reason: string = "atomic csv import rolled back",
): void {
  // itemStatus throws on a stdout overrun / signal kill; compensation is a
  // best-effort sweep, so an overrun in the status lookup itself is a no-op for
  // THIS row (the operator can reconcile by id) and must never abort the sweep
  // over the remaining applied creates. (itemStatus's only throw is the
  // CommandError from assertPmOutputFit; a bare catch is therefore equivalent to
  // catching CommandError and avoids an unreachable rethrow branch.)
  let status: ItemStatus | undefined;
  try {
    status = itemStatus(pmRoot, id);
  } catch {
    return; // status lookup overran/killed: no-op for this row, sweep continues
  }
  if (status === undefined) return; // item no longer exists
  if (markers.length > 0) {
    // Best-effort: remove the tx markers so this row is no longer "applied".
    spawnSync(
      "pm",
      ["--path", pmRoot, "update", id, "--remove-tags", markers.join(",")],
      { encoding: "utf-8", maxBuffer: pmListMaxBuffer() },
    );
  }
  if (status === "closed") return; // terminal already; markers stripped above
  // Compensation is an internal rollback, not a user closure: it must reliably
  // undo the create regardless of closure-validation governance, so it bypasses
  // `--validate-close` (off). `require_close_reason` still applies and is
  // satisfied by `reason`. Without this a strict tracker would block the
  // rollback and leave the orphan open — the very leak compensation exists to
  // prevent. Used by both the atomic transaction path (rollback) and the
  // non-atomic `upsertCreate` close-failure path.
  const r = spawnSync(
    "pm",
    ["--path", pmRoot, "close", id, "--reason", reason, "--validate-close", "off"],
    { encoding: "utf-8", maxBuffer: pmListMaxBuffer() },
  );
  if (r.status !== 0 && r.status !== 4) {
    // Exit 4 is "already closed" / invalid state — treat as already compensated.
    console.error(`atomic import: compensation close failed for ${id}: ${r.stderr?.trim() || r.stdout?.trim()}`);
  }
}

/**
 * Atomic in-memory import: every row that would CREATE an item becomes one
 * {@link WorkspaceTransactionStep} committed under a single workspace
 * writer-locked, crash-recoverable transaction. On success the same
 * {@link ImportResult} as the non-atomic path is returned (counts derived from
 * the committed step results). On failure every applied create is compensated
 * (closed) so no committed items remain, and a clear error is thrown. An
 * interrupted run resumes from the durable journal (inspect() skips already
 * applied rows).
 */
async function importCSVAtomic(
  pmRoot: string,
  filePath: string,
  opts: CsvImportOptions,
): Promise<ImportResult> {
  const { headers: rawHeaders, dataRows } = readCSVFile(
    filePath,
    opts.delimiter,
    opts.encoding ?? "utf-8",
    opts.skipHeaders ?? false,
  );
  const result: ImportResult = {
    imported: 0,
    updated: 0,
    skipped: 0,
    filtered: 0,
    autoMappings: [],
    errors: [],
    previews: [],
    fieldMapWarnings: [],
  };

  if (rawHeaders.length === 0) return result;

  result.fieldMapWarnings = computeFieldMapWarnings(rawHeaders, opts.fieldMap);
  const mapResolution = resolveImportFieldMap(rawHeaders, opts.fieldMap, opts.autoMap ?? false);
  const headers = applyFieldMap(rawHeaders, mapResolution.fieldMap);
  result.autoMappings = mapResolution.autoMappings;
  assertImportHeaders(headers, opts);

  // A dry-run atomic import just previews like the non-atomic path (no
  // transaction is committed, nothing is written).
  if (opts.dryRun) {
    const keyIndex = new Map<string, string>();
    for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
      const lineNo = opts.skipHeaders ? rowIndex + 1 : rowIndex + 2;
      processImportRow(pmRoot, headers, dataRows[rowIndex], lineNo, opts, keyIndex, result);
    }
    return result;
  }

  // Fingerprint the exact parsed content (raw headers + all data rows) so that
  // editing the file in place yields a fresh transaction id instead of reusing
  // stale per-row markers from a previous import of different content.
  const transactionId = deriveTransactionId(
    resolve(filePath),
    fingerprintContent(rawHeaders, dataRows),
  );
  const author = opts.atomicAuthor ?? "pm-csv";
  const ownershipTag = `${TX_TAG_PREFIX}${transactionId}`;
  // Per-row ownership marker source of truth: `csv-txrow:<transactionId>#<rowIndex>`.
  const rowTagFor = (rowIndex: number): string =>
    `${TX_ROW_TAG_PREFIX}${transactionId}${TX_ROW_TAG_SEPARATOR}${rowIndex}`;

  // Detect rows a prior interrupted run already applied (resumability) plus
  // the dedup index for --key upsert decisions, both from one fresh scan.
  const applied = loadAppliedByTransaction(pmRoot, transactionId);
  const keyIndex = opts.keyField ? loadKeyIndex(pmRoot) : new Map<string, string>();
  // In-batch duplicate-KEY guard: keys already claimed by an earlier planned
  // CREATE in THIS run (the keyIndex is not updated during planning, so
  // without this guard two rows sharing a not-yet-existing key would both
  // plan as create and produce duplicate items). A later row repeating a
  // claimed key is skipped with a clear per-row warning (see README).
  const claimedKeys = new Map<string, number>();

  interface PlannedRow {
    rowIndex: number;
    lineNo: number;
    parsed: ParsedRow;
    keyValue: string;
    existingId: string | undefined;
    isUpdate: boolean;
  }
  const planned: PlannedRow[] = [];

  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
    const lineNo = opts.skipHeaders ? rowIndex + 1 : rowIndex + 2;
    const row = dataRows[rowIndex];
    // Compute the field accessor once and reuse for both `parsed` and the
    // --key value (previously rowFields() was called twice per row).
    const { get, parsed } = rowFields(headers, row);

    if (!parsed.title) {
      console.error(`Row ${lineNo}: skipping — 'title' is empty`);
      result.skipped++;
      continue;
    }
    if (!rowMatchesFilter(parsed, opts.filter)) {
      result.skipped++;
      result.filtered++;
      continue;
    }
    const keyValue = opts.keyField ? (get(opts.keyField) ?? "") : "";
    const normalizedKey = keyValue ? normalizeKeyValue(keyValue) : "";
    // In-batch duplicate-key guard: an earlier planned CREATE in this run
    // already claimed this key. The first item does not exist yet at apply
    // time, so rather than fold a dependent update (the transaction primitive
    // treats steps as independent) we skip the duplicate with a clear warning.
    if (normalizedKey && claimedKeys.has(normalizedKey)) {
      const firstRow = claimedKeys.get(normalizedKey)!;
      console.error(
        `Row ${lineNo}: skipping — key '${keyValue}' duplicates row ${
          opts.skipHeaders ? firstRow + 1 : firstRow + 2
        } which is already planned as a create in this --atomic import`,
      );
      result.skipped++;
      continue;
    }
    const existingId = normalizedKey ? keyIndex.get(normalizedKey) : undefined;
    if (normalizedKey && !existingId) claimedKeys.set(normalizedKey, rowIndex);
    planned.push({ rowIndex, lineNo, parsed, keyValue, existingId, isUpdate: Boolean(existingId) });
  }

  // Build one transaction step per row to be written (create or update).
  //   - create: apply() shells out to the same `pm create` as the non-atomic
  //     path (parity) plus the csv-tx batch marker AND the per-row marker;
  //     compensate() closes the created id.
  //   - update (--key match): apply() updates the pre-existing item and stamps
  //     both markers; compensate() is a no-op (an arbitrary update cannot be
  //     safely reverted without capturing prior state, and the spec scopes
  //     all-or-nothing compensation to creates).
  //
  // Resume/compensation matching is per-row-precise via the per-row marker
  // (csv-txrow:<transactionId>#<rowIndex>), so duplicate titles or duplicate
  // keys in the CSV cannot trick inspect() into skipping the wrong row or
  // compensate() into closing the wrong item. Each step keeps a closure-local
  // `appliedId` set by apply() so the coordinator's compensation pass (which
  // re-runs inspect() to decide whether a step needs compensating) sees
  // `state: "applied"` for items created during THIS run — not just for items
  // left over from a prior interrupted run (which the pre-run `applied` lookup
  // already detects).
  const steps: WorkspaceTransactionStep[] = planned.map((row) => {
    const stepId = `csv-import-row-${row.rowIndex}`;
    const rowTag = rowTagFor(row.rowIndex);
    // Set by apply() in this run; undefined before that or on a fresh resume.
    let appliedId: string | undefined;
    const inspect = async (): Promise<WorkspaceTransactionStepInspection> => {
      // A step applied earlier in THIS run (apply() captured the id).
      if (appliedId) return { state: "applied", result: appliedId };
      // A prior interrupted run already applied this row: an item carries this
      // transaction's per-row marker for THIS rowIndex. Per-row-precise, so
      // duplicate titles/keys cannot match the wrong row.
      const id = applied.byRowIndex.get(row.rowIndex);
      if (id) return { state: "applied", result: id };
      return { state: "pending" };
    };
    const apply = async (): Promise<WorkspaceTransactionJsonValue | undefined> => {
      const ownershipTags = [ownershipTag, rowTag];
      if (row.isUpdate) {
        upsertUpdate(pmRoot, row.existingId!, row.parsed, opts.source, ownershipTags);
        appliedId = row.existingId!;
        return row.existingId!;
      }
      const newId = upsertCreate(
        pmRoot,
        row.parsed,
        opts.keyField ? row.keyValue : undefined,
        opts.source,
        ownershipTags,
      );
      if (!newId) throw new Error(`pm create returned no id for row ${row.lineNo}`);
      appliedId = newId;
      return newId;
    };
    const prepareCompensation = async (): Promise<WorkspaceTransactionJsonValue | undefined> => undefined;
    const compensate = async (): Promise<void> => {
      // Only creates are compensated (closed); updates to pre-existing items
      // are intentionally left in place (documented limitation).
      if (row.isUpdate) return;
      // Prefer the id captured by apply() in this run; fall back to the
      // pre-run per-row lookup (resume-compensation of a prior run's applied step).
      const id = appliedId ?? applied.byRowIndex.get(row.rowIndex);
      // Strip both markers so the rolled-back row is no longer recognized as
      // applied on a retry (marker-presence — not status — is the applied signal).
      if (typeof id === "string" && id) compensateCreate(pmRoot, id, [rowTag, ownershipTag]);
    };
    return { id: stepId, inspect, apply, prepareCompensation, compensate };
  });

  const commitTransaction =
    opts.commitTransaction ??
    (await resolveCommitWorkspaceTransaction(pmRoot));

  let committed: WorkspaceTransactionCommitResult;
  try {
    committed = await commitTransaction({ transactionId, author, steps });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Every applied create has been compensated by the coordinator; no
    // committed items from this import remain in the tracker.
    throw new CommandError(
      `Atomic CSV import failed and was rolled back — every applied create was compensated (closed); the tracker has no committed items from this import. Transaction id: ${transactionId}. Underlying error: ${msg}`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }

  // Tally the ImportResult from the committed step results. Each committed
  // result is the created/updated item id. Only rows that were NOT already
  // applied at the start of this run (i.e. newly committed by this attempt)
  // count toward imported/updated — resumed rows from a prior interrupted run
  // are already in the tracker and must not be double-counted.
  for (const row of planned) {
    const stepId = `csv-import-row-${row.rowIndex}`;
    const res = committed.results[stepId];
    if (res === undefined) continue;
    const alreadyApplied = applied.byRowIndex.has(row.rowIndex);
    if (alreadyApplied) continue;
    if (row.isUpdate) result.updated++;
    else result.imported++;
  }
  return result;
}

/**
 * Cached SDK commit coordinator. Resolved once per process via a dynamic
 * `import("@unbrained/pm-cli/sdk")` so repeated --atomic calls don't re-import.
 * `null` means a previous attempt failed and the failure is not retried within
 * this process (each CLI invocation is a fresh process, so this is safe).
 */
let cachedCommitWorkspaceTransaction:
  | ((options: {
      pmRoot: string;
      transactionId: string;
      author: string;
      steps: readonly WorkspaceTransactionStep[];
      lockTtlSeconds?: number;
      lockWaitMs?: number;
    }) => Promise<WorkspaceTransactionCommitResult>)
  | null
  | undefined;

/**
 * Dynamically resolve the SDK commit coordinator bound to a tracker root, for
 * the importer path (which has no host-injected `ctx.sdk`). Falls back to a
 * dynamic `import("@unbrained/pm-cli/sdk")` so a standalone-installed extension
 * still works when the SDK package is resolvable. The resolved function is
 * cached at module scope so repeated --atomic calls don't re-import. If the
 * import fails or `commitWorkspaceTransaction` is not exported, a clear,
 * actionable CommandError is thrown.
 */
async function resolveCommitWorkspaceTransaction(
  pmRoot: string,
): Promise<(opts: {
  transactionId: string;
  author: string;
  steps: readonly WorkspaceTransactionStep[];
  lockTtlSeconds?: number;
  lockWaitMs?: number;
}) => Promise<WorkspaceTransactionCommitResult>> {
  if (cachedCommitWorkspaceTransaction === null) {
    throw new CommandError(
      "--atomic requires @unbrained/pm-cli>=2026.7.19 with the commitWorkspaceTransaction SDK primitive, but it could not be resolved (a prior attempt in this process failed). Ensure @unbrained/pm-cli is installed and up to date.",
      EXIT_CODE.USAGE,
    );
  }
  if (cachedCommitWorkspaceTransaction) {
    const cached = cachedCommitWorkspaceTransaction;
    return (opts) => cached({ pmRoot, ...opts });
  }
  let mod: typeof import("@unbrained/pm-cli/sdk");
  try {
    mod = await import("@unbrained/pm-cli/sdk");
  } catch (err: unknown) {
    cachedCommitWorkspaceTransaction = null;
    const msg = err instanceof Error ? err.message : String(err);
    throw new CommandError(
      `--atomic requires @unbrained/pm-cli>=2026.7.19 with the commitWorkspaceTransaction SDK primitive, but the SDK could not be imported: ${msg}. Install or upgrade @unbrained/pm-cli.`,
      EXIT_CODE.USAGE,
    );
  }
  const commit = mod.commitWorkspaceTransaction;
  if (typeof commit !== "function") {
    cachedCommitWorkspaceTransaction = null;
    throw new CommandError(
      "--atomic requires @unbrained/pm-cli>=2026.7.19 with the commitWorkspaceTransaction SDK primitive, but the installed SDK does not export it as a function. Upgrade @unbrained/pm-cli to >=2026.7.19.",
      EXIT_CODE.USAGE,
    );
  }
  cachedCommitWorkspaceTransaction = commit;
  return (opts) => commit({ pmRoot, ...opts });
}

/**
 * Streaming import: reads the file via a readable stream so large CSV files
 * are never fully loaded into memory. The header row (or positional
 * {@link IMPORT_COLUMNS} when `--skip-headers` is set) is resolved from the
 * first row, then every subsequent row is processed and upserted immediately.
 */
async function importCSVStreaming(pmRoot: string, filePath: string, opts: CsvImportOptions): Promise<ImportResult> {
  const result: ImportResult = {
    imported: 0,
    updated: 0,
    skipped: 0,
    filtered: 0,
    autoMappings: [],
    errors: [],
    previews: [],
    fieldMapWarnings: [],
  };

  let headers: string[] = [];
  let headerResolved = opts.skipHeaders ?? false;
  let logicalRowIndex = 0;

  if (headerResolved) {
    // --skip-headers: no header row in the file; use positional column order.
    headers = [...IMPORT_COLUMNS];
    result.fieldMapWarnings = computeFieldMapWarnings(headers, opts.fieldMap);
    const mapResolution = resolveImportFieldMap(headers, opts.fieldMap, opts.autoMap ?? false);
    headers = applyFieldMap(headers, mapResolution.fieldMap);
    result.autoMappings = mapResolution.autoMappings;
    assertImportHeaders(headers, opts);
  }

  // Load only after the input header has been validated so malformed input
  // reports its CSV error before any workspace lookup is attempted.
  let keyIndex = new Map<string, string>();
  if (headerResolved && opts.keyField && !opts.dryRun) keyIndex = loadKeyIndex(pmRoot);

  await streamCSVFile(filePath, opts.delimiter, opts.encoding ?? "utf-8", (row: string[]) => {
    logicalRowIndex++;
    // Skip fully-empty rows (mirrors the in-memory filter).
    if (!row.some((f) => f.trim() !== "")) return;

    if (!headerResolved) {
      headers = row.map((h) => h.trim().toLowerCase());
      result.fieldMapWarnings = computeFieldMapWarnings(headers, opts.fieldMap);
      const mapResolution = resolveImportFieldMap(headers, opts.fieldMap, opts.autoMap ?? false);
      headers = applyFieldMap(headers, mapResolution.fieldMap);
      result.autoMappings = mapResolution.autoMappings;
      assertImportHeaders(headers, opts);
      headerResolved = true;
      if (opts.keyField && !opts.dryRun) keyIndex = loadKeyIndex(pmRoot);
      return;
    }

    const lineNo = logicalRowIndex;
    processImportRow(pmRoot, headers, row, lineNo, opts, keyIndex, result);
  });

  return result;
}

/**
 * Append the relational/planning field flags shared by create and update.
 * Flag names verified against the installed `pm create`/`pm update` contracts:
 * --parent, --assignee, --sprint, --release, --blocked-by.
 */
function appendRelationalArgs(args: string[], p: ParsedRow): void {
  if (p.parent) args.push("--parent", p.parent);
  if (p.assignee) args.push("--assignee", p.assignee);
  if (p.sprint) args.push("--sprint", p.sprint);
  if (p.release) args.push("--release", p.release);
  if (p.blocked_by) args.push("--blocked-by", p.blocked_by);
}

/**
 * Build the `pm close --reason` text for an imported row whose CSV status is
 * terminal (`closed`/`canceled`). Since pm-cli 2026.8.3 the CLI enforces
 * governance.require_close_reason on every `closed` transition, and the CSV
 * source carries no close-reason/resolution field (see {@link IMPORT_COLUMNS}),
 * so the reason states the import provenance factually instead of inventing an
 * outcome (e.g. "completed") that the source never recorded.
 */
function importCloseReason(status: "closed" | "canceled", source?: string): string {
  const origin = source ? ` from ${source}` : "";
  return `Imported${origin} (source status: ${status})`;
}

/**
 * Create a new item, optionally carrying a csv-key provenance tag. Returns the
 * new id (empty string when `pm create` did not report one AND the row is not
 * terminal-closed — see below).
 *
 * A terminal `closed` status cannot be set at create time: `pm create --status
 * closed` is rejected with close_reason_required (governance.require_close_reason
 * is enforced since pm-cli 2026.8.3 and create has no --reason flag). Such rows
 * are created as `open` and immediately transitioned through `pm close --reason`
 * with the factual import provenance ({@link importCloseReason}). `canceled` is
 * not gated by that policy and is still set directly at create time.
 *
 * GUARANTEE (and its limits): the create-then-close sequence for a `closed` row
 * is NOT atomic — the item is already persisted as `open` when the close runs.
 * Two failure modes are handled so a failed row is never left as a silent,
 * undiscoverable orphan that a retry without `--key-field` would duplicate:
 *
 *   1. `pm create` succeeded but no id could be recovered (unparseable / id-less
 *      JSON). The close cannot be applied and the orphan cannot be compensated
 *      without its id, so this is a HARD FAILURE: an error is thrown (the row is
 *      reported as failed, never as a silent success), naming the title so the
 *      operator can find and reconcile the open orphan manually. The created
 *      open item is left behind in this one unrecoverable case.
 *   2. `pm close` failed after the item was persisted as open. The orphan is
 *      compensated (closed) via {@link compensateCreate} with `--validate-close
 *      off`, so a failed row is all-or-nothing and a retry re-imports it. If
 *      compensation also fails, the thrown error carries the created id and
 *      states the item was left open, so the partial state is actionable and a
 *      retry can reconcile it.
 *
 * For a `closed` row, an empty id is therefore a hard error, not a silent
 * return; the empty-string return only happens for non-closed rows whose
 * `pm create` reported no id.
 */
function upsertCreate(
  pmRoot: string,
  p: ParsedRow,
  keyValue?: string,
  source?: string,
  extraTags?: string[],
): string {
  const tags = [...p.tags];
  // Encode the lower-cased key so the stored tag matches the lookup index
  // regardless of pm's tag case-folding (see normalizeKeyValue).
  if (keyValue) tags.push(`${KEY_TAG_PREFIX}${encodeKeyTagValue(normalizeKeyValue(keyValue))}`);
  // Provenance for the schema-registered csv_source field, persisted as a tag
  // since the CLI exposes no scalar setter for extension-registered fields.
  if (source) tags.push(`${SOURCE_TAG_PREFIX}${encodeKeyTagValue(source)}`);
  // Atomic-import ownership marker (csv-tx:<transactionId>) stamped on every
  // item created inside a transaction so inspect()/compensate() can find it.
  if (extraTags && extraTags.length > 0) tags.push(...extraTags);

  // See the function docstring: terminal `closed` is applied via pm close
  // after the create, never via `pm create --status closed`.
  const createStatus = p.status === "closed" ? "open" : p.status;
  const args = ["--path", pmRoot, "create", "--title", p.title, "--status", createStatus, "--json"];
  if (p.body) args.push("--body", p.body);
  if (p.priority !== undefined) args.push("--priority", String(p.priority));
  if (p.type) args.push("--type", p.type);
  if (p.deadline) args.push("--deadline", p.deadline);
  appendRelationalArgs(args, p);
  if (tags.length > 0) args.push("--tags", tags.join(","));

  const r = spawnSync("pm", args, { encoding: "utf-8", maxBuffer: pmListMaxBuffer() });
  // Parse the id BEFORE any status check. `pm create` is a WRITE: by the time
  // spawnSync returns it may have ALREADY persisted the item, even if its
  // receipt then overran the buffer (status null). Asserting before the parse
  // would throw with the id still unread, stranding an orphan compensation
  // cannot identify. Node retains the FULL captured stdout for outputs under
  // one read chunk, and `pm create --json`'s flat receipt is always far under
  // that, so the id is recoverable here even when the buffer overran.
  // `pm create --json` emits a FLAT receipt — {id, status, changed_field_count}
  // — with no `item` wrapper (mutations return a flat receipt; only queries
  // such as `pm read`/`pm list` wrap, see upstream pm-cli#888). No `item`
  // fallback is kept: it would be dead code no real CLI can exercise, and the
  // sibling pm-github package shipped a silent production bug from trusting
  // exactly that wrapper — every closed import landed open because the id
  // never parsed.
  let id = "";
  try {
    const parsed = JSON.parse(r.stdout);
    id = typeof parsed?.id === "string" ? parsed.id : "";
  } catch {
    id = "";
  }
  if (r.status === null) {
    // The receipt overran the buffer (or the child was killed). The create may
    // have persisted an item, so a write that may have taken effect is never
    // abandoned un-identified: if the id was recovered, attempt to close the
    // orphan DIRECTLY (compensation's own status lookup would overrun under the
    // same cap and no-op, so the close is issued here) and INSPECT its result so
    // the thrown error reports the recovery close's ACTUAL outcome, never an
    // assumed one. The close is attempted exactly once — under a capped buffer
    // it fails identically every time, so retrying in a loop would only turn a
    // fast, actionable error into a slow one. Without the id, throw naming the
    // title for manual reconcile.
    //
    // GUARANTEE: the extension cannot make `pm create` atomic — it is a single
    // subprocess with no transaction the caller can join, so a window always
    // exists where the item is persisted and the caller does not yet know it.
    // What is guaranteed is that the window is always REPORTED WITH THE ID: the
    // recovery close's outcome is inspected and the thrown error names the id
    // and the real resulting state (closed, or still-open with the close's
    // failure cause), so the operator never stops looking for an open orphan.
    if (id) {
      const rc = spawnSync(
        "pm",
        ["--path", pmRoot, "close", id, "--validate-close", "off", "--reason", "csv import create overran its receipt buffer; closing the orphaned created item"],
        { encoding: "utf-8", maxBuffer: pmListMaxBuffer() },
      );
      const createCause = describePmNullStatus(r, "create");
      if (rc.status === 0) {
        throw new CommandError(
          `${createCause}. The create for row (title '${p.title}', id ${id}) may have persisted; the orphaned item ${id} was closed — retry the import.`,
        );
      }
      // The recovery close failed or returned no usable status: do NOT claim it
      // succeeded. Report the orphan as still open and carry the close's own
      // failure cause (an overrun/kill via describePmNullStatus for a null
      // status; the close's stderr for a non-zero exit) so the operator can
      // close the item manually by id.
      const closeCause =
        rc.status === null
          ? describePmNullStatus(rc, "close")
          : (rc.stderr?.trim() || "pm close failed");
      throw new CommandError(
        `${createCause}. The create for row (title '${p.title}', id ${id}) may have persisted; the recovery close failed (${closeCause}), so the orphaned item ${id} is still open and must be closed manually — retry the import.`,
      );
    }
    throw new CommandError(
      `${describePmNullStatus(r, "create")}. The create for row (title '${p.title}') produced no recoverable id, so any persisted item cannot be identified or rolled back — reconcile manually and retry.`,
    );
  }
  if (r.status !== 0) throw new Error(r.stderr?.trim() || "pm create failed");
  if (p.status === "closed") {
    // (1) No id recovered: the close cannot be applied and the orphan cannot be
    // compensated without its id. Hard failure — never a silent success — so
    // the row is reported as failed, not imported. The created open orphan is
    // unrecoverable from here; the error names the title for manual reconcile.
    if (!id) {
      throw new Error(
        `pm create succeeded for closed row (title '${p.title}') but returned no id, so the terminal 'closed' status cannot be applied and the created open item cannot be compensated; it is left as an unrecoverable open orphan — reconcile manually`,
      );
    }
    const cr = spawnSync(
      "pm",
      ["--path", pmRoot, "close", id, "--reason", importCloseReason("closed", source)],
      { encoding: "utf-8", maxBuffer: pmListMaxBuffer() },
    );
    // Deliberately NO assertPmOutputFit(cr, "close") here: a null close status
    // (receipt overrun or a signal kill) must route INTO the compensation branch
    // below rather than bypass it. The close may have persisted before its
    // receipt overran; the branch compensates and verifies the outcome either
    // way, and the id is already known so nothing is stranded.
    if (cr.status !== 0) {
      // (2) The close failed but the item is already persisted as open.
      // Compensate (close) the orphan so a failed row is all-or-nothing and a
      // retry without --key-field cannot duplicate an undiscoverable open item.
      // Compensation bypasses closure-validation governance (it is a rollback,
      // not a user closure) so a strict tracker cannot block the cleanup.
      compensateCreate(
        pmRoot,
        id,
        [],
        "csv import row failed; closing orphan created item",
      );
      const closeErr = cr.stderr?.trim() || cr.stdout?.trim() || "pm close failed";
      // Only a status of exactly `closed` is evidence that compensation worked.
      // `itemStatus` returns undefined when the lookup itself fails — non-zero
      // exit, malformed JSON, or an absent status field — and an unknown status
      // is NOT evidence of success. Treating it as such would report a possibly
      // still-open orphan as compensated, and a retry without --key-field would
      // then duplicate it: exactly the leak this branch exists to prevent.
      const compensatedStatus = itemStatus(pmRoot, id);
      if (compensatedStatus !== "closed") {
        const state =
          compensatedStatus === undefined
            ? "could not be verified (the status lookup failed): the item may have been left OPEN"
            : `also failed: the item was created and left OPEN (status '${compensatedStatus}')`;
        throw new Error(
          `pm close failed for closed row (title '${p.title}', id ${id}) and compensation ${state} — retry or reconcile by id. ${closeErr}`,
        );
      }
      throw new Error(
        `pm close failed for closed row (title '${p.title}', id ${id}); the created open item was compensated (verified closed) so the failed row is all-or-nothing. ${closeErr}`,
      );
    }
  }
  return id;
}

/**
 * Update an existing item in place. Non-terminal statuses go through
 * `pm update --status`; a terminal closed/canceled status is applied afterwards
 * through `pm close --reason` with the factual import provenance
 * ({@link importCloseReason}) — never an invented outcome — because
 * governance.require_close_reason forbids reason-free terminal transitions.
 *
 * GUARANTEE (and its limits): `pm update` and the terminal `pm close` are each
 * a single non-atomic subprocess, so either may have already taken effect when
 * its receipt then overruns the buffer or the child is killed (status null),
 * and a non-zero exit is likewise not proof nothing was written. The guarantee
 * here is that NO MUTATION IS LEFT UN-IDENTIFIED: every update/close failure
 * carries the item id and states explicitly that the mutation may already have
 * been applied, so the operator can verify and reconcile by id. The guarantee
 * is NOT that no mutation is left behind — an update has no inverse without the
 * prior field values, which this extension does not capture, so a failed update
 * is reported loudly by id rather than compensated with a second unreviewed
 * write on top of a failed one (see the deferred capture-prior-values feature).
 */
function upsertUpdate(
  pmRoot: string,
  id: string,
  p: ParsedRow,
  source?: string,
  extraTags?: string[],
): void {
  const args = ["--path", pmRoot, "update", id, "--title", p.title];
  if (p.body !== undefined) args.push("--body", p.body);
  if (p.priority !== undefined) args.push("--priority", String(p.priority));
  if (p.type) args.push("--type", p.type);
  if (p.deadline) args.push("--deadline", p.deadline);
  appendRelationalArgs(args, p);
  // Preserve the csv-key tag (additive) and refresh the user tags.
  const addTags = [...p.tags];
  if (source) addTags.push(`${SOURCE_TAG_PREFIX}${encodeKeyTagValue(source)}`);
  if (extraTags && extraTags.length > 0) addTags.push(...extraTags);
  if (addTags.length > 0) args.push("--add-tags", addTags.join(","));
  // `update` cannot set a closed status; only set non-closed statuses here.
  if (p.status !== "closed" && p.status !== "canceled") args.push("--status", p.status);

  const r = spawnSync("pm", args, { encoding: "utf-8", maxBuffer: pmListMaxBuffer() });
  // `pm update` is a WRITE: a null status (receipt overrun or a signal kill)
  // means the mutation may already have been applied to the item, so the
  // failure must carry the item id and state that explicitly — matching the
  // create path. The guarantee is that no mutation is left un-IDENTIFIED, NOT
  // that no mutation is left behind: an update has no inverse without the prior
  // field values, which this extension does not capture, so a failed update is
  // reported loudly by id rather than papered over with a second unreviewed
  // write on top of a failed one.
  if (r.status === null) {
    throw new CommandError(
      `${describePmNullStatus(r, "update")}. The update for item ${id} may already have been applied — verify the item by id before retrying.`,
    );
  }
  if (r.status !== 0) {
    const updateErr = r.stderr?.trim() || "pm update failed";
    throw new Error(
      `pm update failed for item ${id} (${updateErr}); the mutation may already have been applied — verify the item by id before retrying.`,
    );
  }

  // Apply terminal statuses through the dedicated close command. The preceding
  // update has already been applied, so a failure here is reported with the id
  // and the explicit caveat that the terminal transition may already have taken
  // effect too — the close, like the update, is a single non-atomic subprocess.
  if (p.status === "closed" || p.status === "canceled") {
    const cr = spawnSync("pm", ["--path", pmRoot, "close", id, "--reason", importCloseReason(p.status, source)], { encoding: "utf-8", maxBuffer: pmListMaxBuffer() });
    if (cr.status === null) {
      throw new CommandError(
        `${describePmNullStatus(cr, "close")}. The update for item ${id} was applied, but the terminal ${p.status} close may already have been applied too — verify the item by id before retrying.`,
      );
    }
    if (cr.status !== 0) {
      const closeErr = cr.stderr?.trim() || "pm close failed";
      throw new Error(
        `pm close failed for item ${id} (${closeErr}); the update was applied and the terminal ${p.status} close may already have been applied — verify the item by id before retrying.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Shared validate core — parses a CSV and reports structural/data issues
// WITHOUT importing. Used by the `csv validate` command.
// ---------------------------------------------------------------------------

interface CsvValidateOptions {
  delimiter: string;
  fieldMap: Record<string, string>;
  encoding?: SupportedEncoding;
  autoMap?: boolean;
  /** The CSV file has no header row; map columns positionally to IMPORT_COLUMNS. */
  skipHeaders?: boolean;
}

interface CsvValidateReport {
  ok: boolean;
  rowCount: number;
  detectedColumns: string[];
  mappedColumns: string[];
  hasTitleColumn: boolean;
  duplicateMappedColumns: string[];
  rowsMissingTitle: number;
  rowsWithUnknownStatus: number;
  rowsWithNonIntegerPriority: number;
  rowsWithOutOfRangePriority: number;
  autoMappings: AutoFieldMapping[];
  /** Helpful warnings about unknown --map targets or missing source headers. */
  fieldMapWarnings: string[];
  issues: string[];
}

/**
 * Parse a CSV and report data-quality issues without writing anything.
 * Pure function over file contents — exposed for unit testing via the
 * lower-level {@link validateParsedCSV} helper below.
 */
function validateCSV(filePath: string, opts: CsvValidateOptions): CsvValidateReport {
  const { headers: rawHeaders, dataRows } = readCSVFile(
    filePath,
    opts.delimiter,
    opts.encoding ?? "utf-8",
    opts.skipHeaders ?? false,
  );
  const mapResolution = resolveImportFieldMap(rawHeaders, opts.fieldMap, opts.autoMap ?? false);
  const report = validateParsedCSV(rawHeaders, dataRows, mapResolution.fieldMap);
  report.autoMappings = mapResolution.autoMappings;
  report.fieldMapWarnings = [
    ...validateFieldMapTargets(opts.fieldMap),
    ...checkMapSourcesPresent(rawHeaders, opts.fieldMap),
  ];
  return report;
}

/**
 * Core validation logic over already-parsed headers + rows. Pure and
 * side-effect-free so it can be unit tested directly.
 */
function validateParsedCSV(
  rawHeaders: string[],
  dataRows: string[][],
  fieldMap: Record<string, string>,
): CsvValidateReport {
  const mappedColumns = applyFieldMap(rawHeaders, fieldMap);
  const hasTitleColumn = mappedColumns.includes("title");
  const issues: string[] = [];

  let rowsMissingTitle = 0;
  let rowsWithUnknownStatus = 0;
  let rowsWithNonIntegerPriority = 0;
  let rowsWithOutOfRangePriority = 0;
  const seenColumns = new Set<string>();
  const duplicateMappedColumns: string[] = [];
  for (const col of mappedColumns) {
    if (seenColumns.has(col) && !duplicateMappedColumns.includes(col)) duplicateMappedColumns.push(col);
    seenColumns.add(col);
  }

  const titleIdx = mappedColumns.indexOf("title");
  const statusIdx = mappedColumns.indexOf("status");
  const priorityIdx = mappedColumns.indexOf("priority");

  for (const row of dataRows) {
    if (hasTitleColumn) {
      const title = (row[titleIdx] ?? "").trim();
      if (!title) rowsMissingTitle++;
    }
    if (statusIdx >= 0) {
      const status = (row[statusIdx] ?? "").trim().toLowerCase();
      if (status && !KNOWN_STATUSES.has(status)) rowsWithUnknownStatus++;
    }
    if (priorityIdx >= 0) {
      const priority = (row[priorityIdx] ?? "").trim();
      if (priority && !/^-?\d+$/.test(priority)) {
        rowsWithNonIntegerPriority++;
      } else if (priority) {
        const n = Number(priority);
        if (n < 0 || n > 4) rowsWithOutOfRangePriority++;
      }
    }
  }

  if (rawHeaders.length === 0) {
    issues.push("CSV is empty (no header row).");
  }
  if (!hasTitleColumn) {
    issues.push(
      `Missing required 'title' column (after --map). Detected: ${mappedColumns.join(", ") || "(none)"}`,
    );
  }
  if (duplicateMappedColumns.length > 0) {
    issues.push(`Duplicate mapped column(s): ${duplicateMappedColumns.join(", ")}. Use --map/--columns so each pm field appears once.`);
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
  if (rowsWithOutOfRangePriority > 0) {
    issues.push(`${rowsWithOutOfRangePriority} row(s) have a priority outside pm's 0-4 range (pm may reject them).`);
  }

  // Only a missing title column (or empty file) is a structural problem.
  const ok = hasTitleColumn && rawHeaders.length > 0;

  return {
    ok,
    rowCount: dataRows.length,
    detectedColumns: rawHeaders,
    mappedColumns,
    hasTitleColumn,
    duplicateMappedColumns,
    rowsMissingTitle,
    rowsWithUnknownStatus,
    rowsWithNonIntegerPriority,
    rowsWithOutOfRangePriority,
    autoMappings: [],
    fieldMapWarnings: [],
    issues,
  };
}

/**
 * Flatten a validation report into the issues strict mode refuses to import on.
 *
 * Strict mode treats several conditions as blocking that a normal import merely
 * counts: duplicate mapped columns, and rows missing a title or carrying an
 * unknown status or a non-integer / out-of-range priority. Each becomes one
 * human-readable line, with counts rather than row numbers.
 *
 * @param report - Report produced by validating the CSV.
 * @returns One string per blocking condition; empty when strict mode would let
 *          the import proceed.
 */
function strictValidationIssues(report: CsvValidateReport): string[] {
  const issues: string[] = [];
  if (!report.ok) issues.push(...report.issues);
  if (report.duplicateMappedColumns.length > 0) issues.push(`duplicate mapped columns: ${report.duplicateMappedColumns.join(", ")}`);
  if (report.rowsMissingTitle > 0) issues.push(`${report.rowsMissingTitle} row(s) missing title`);
  if (report.rowsWithUnknownStatus > 0) issues.push(`${report.rowsWithUnknownStatus} row(s) with unknown status`);
  if (report.rowsWithNonIntegerPriority > 0) issues.push(`${report.rowsWithNonIntegerPriority} row(s) with non-integer priority`);
  if (report.rowsWithOutOfRangePriority > 0) issues.push(`${report.rowsWithOutOfRangePriority} row(s) with out-of-range priority`);
  return [...new Set(issues)];
}

/**
 * Validate a CSV and abort the import before anything is written.
 *
 * The ordering is the point: this runs to completion before the first item is
 * created, so a strict import either creates every row or none. Failing halfway
 * would leave a tracker holding part of a file the caller believed was rejected.
 *
 * @param filePath - CSV file to validate.
 * @param opts - Validation options, including the column mapping.
 * @returns The validation report, when strict mode finds nothing blocking.
 * @throws CommandError listing every blocking issue, exiting with the usage code.
 */
function assertStrictImportReady(filePath: string, opts: CsvValidateOptions): CsvValidateReport {
  const report = validateCSV(filePath, opts);
  const strictIssues = strictValidationIssues(report);
  if (strictIssues.length > 0) {
    throw new CommandError(
      `CSV strict validation failed; import aborted before any items were created:\n` +
        strictIssues.map((issue) => `  - ${issue}`).join("\n"),
      EXIT_CODE.USAGE,
    );
  }
  return report;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared export core (used by the `csv export` command and the csv-export
// exporter) — keeps a single code path for filtering, column selection and
// serialization.
// ---------------------------------------------------------------------------

interface CsvExportOptions {
  statusFilter?: string;
  typeFilter?: string;
  delimiter: string;
  /**
   * Ordered columns to emit. Built-in columns are keys of {@link PmItem};
   * discovered custom fields (see {@link discoverCustomFields}) are arbitrary
   * string keys read straight off the item JSON, hence the widened type.
   */
  columns: string[];
  /**
   * Optional column-header → item-property remap, used when a discovered custom
   * field's display key differs from the metadata key its value is stored under.
   * Columns absent from the map are read by their own name.
   */
  columnSource?: Record<string, string>;
  /** Omit the header row. */
  noHeader?: boolean;
  /** Use CRLF line endings (RFC-4180 / Excel-friendly). */
  crlf?: boolean;
  /** Excel-friendly output: forces CRLF and prepends a UTF-8 BOM. */
  excel?: boolean;
}

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
function discoverCustomFields(pmRoot: string): DiscoveredField[] {
  const builtin = new Set<string>(EXPORT_COLUMNS as string[]);
  const byKey = new Map<string, DiscoveredField>();

  const collect = (fields: unknown): void => {
    if (!Array.isArray(fields)) return;
    for (const raw of fields) {
      if (!raw || typeof raw !== "object") continue;
      const def = raw as { key?: unknown; metadata_key?: unknown; front_matter_key?: unknown };
      const key = typeof def.key === "string" ? def.key.trim() : "";
      if (!key || builtin.has(key)) continue;
      const metadataKey =
        (typeof def.metadata_key === "string" && def.metadata_key.trim()) ||
        (typeof def.front_matter_key === "string" && def.front_matter_key.trim()) ||
        key;
      if (!byKey.has(key)) byKey.set(key, { key, metadataKey });
    }
  };

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(resolve(pmRoot, "settings.json"), "utf-8"));
  } catch {
    return [];
  }
  const schema = (settings["schema"] ?? {}) as Record<string, unknown>;

  // Inline fields declared directly in settings.json.
  collect(schema["fields"]);

  // File-backed fields (schema.files.fields, default schema/fields.json) — the
  // path the CLI scaffolds and the SDK loader reads.
  const files = (schema["files"] ?? {}) as Record<string, unknown>;
  const fieldsPath =
    typeof files["fields"] === "string" && files["fields"].trim()
      ? (files["fields"] as string)
      : "schema/fields.json";
  try {
    const fileJson = JSON.parse(readFileSync(resolve(pmRoot, fieldsPath), "utf-8"));
    collect(fileJson?.fields);
  } catch {
    // No file / unreadable / unparsable — inline fields (if any) still apply.
  }

  return [...byKey.values()];
}

// Parse a `--columns id,title,status` spec into a validated, ordered subset of
// the export columns. Unknown column names throw a USAGE error; an empty/absent
// spec falls back to the full default column set. `extraValid` lets discovered
// custom-field keys be selected explicitly via --columns alongside --all-fields.
/**
 * Resolve a `--columns` spec into the ordered export column list.
 *
 * An absent or blank spec selects the full built-in set; otherwise the caller's
 * order is preserved exactly, since column order is what the spec is for.
 * Unknown names fail loudly rather than being dropped, because silently
 * omitting a requested column produces a CSV that looks complete and is not.
 *
 * @param spec - Comma-separated column names; blank or absent selects the default set.
 * @param extraValid - Additional accepted names, used for discovered custom fields.
 * @returns The requested columns in the order given, or a copy of the default set.
 * @throws CommandError naming every unrecognised column and listing the valid ones.
 */
function selectExportColumns(
  spec: string | undefined,
  extraValid: ReadonlyArray<string> = [],
): string[] {
  if (!spec || !spec.trim()) return [...EXPORT_COLUMNS];
  const requested = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const valid = new Set<string>([...(EXPORT_COLUMNS as string[]), ...extraValid]);
  const unknown = requested.filter((c) => !valid.has(c));
  if (unknown.length > 0) {
    const validList = [...EXPORT_COLUMNS, ...extraValid].join(", ");
    throw new CommandError(
      `Unknown export column(s): ${unknown.join(", ")}. Valid: ${validList}`,
      EXIT_CODE.USAGE,
    );
  }
  return requested;
}

/**
 * Resolve the effective export column list (and the column→property remap for
 * custom fields) shared by `csv export` and the `csv-export` exporter.
 *
 * - With no `--columns` and no discovery, returns the default built-in set.
 * - With `discover` set, appends every discovered custom field key not already
 *   present (default column set otherwise unchanged — strictly additive).
 * - With `--columns`, the explicit, ordered selection wins; discovered custom
 *   field keys become selectable names too.
 */
function resolveExportColumns(
  pmRoot: string,
  columnsSpec: string | undefined,
  discover: boolean,
): { columns: string[]; columnSource: Record<string, string> } {
  const discovered = discover ? discoverCustomFields(pmRoot) : [];
  const columnSource: Record<string, string> = {};
  for (const f of discovered) {
    if (f.key !== f.metadataKey) columnSource[f.key] = f.metadataKey;
  }

  if (columnsSpec && columnsSpec.trim()) {
    const columns = selectExportColumns(columnsSpec, discovered.map((f) => f.key));
    return { columns, columnSource };
  }

  const columns = [...EXPORT_COLUMNS] as string[];
  for (const f of discovered) {
    if (!columns.includes(f.key)) columns.push(f.key);
  }
  return { columns, columnSource };
}

/**
 * Read every item from a tracker and render the CSV export body.
 *
 * Shells out to `pm list-all --json --include-body` with an explicit
 * `maxBuffer`, because a stdout overrun kills the child with a null status and
 * an EMPTY stderr — which would otherwise surface as an unexplained
 * "pm list-all failed" rather than as the size problem it is.
 *
 * Status and type filters are applied after the read, not pushed into the
 * query. Each item's `csv_source` is then derived from its internal source tag
 * via {@link decodeKeyTagValue}, so a re-export carries the provenance of the
 * file the row originally came from.
 *
 * @param pmRoot - Tracker root to export.
 * @param opts - Column selection, per-column property remap, and status/type filters.
 * @returns The rendered CSV text, the exported row count, and the line ending used.
 * @throws CommandError when the pm read fails, naming the buffer overrun explicitly.
 */
function buildCsvExport(pmRoot: string, opts: CsvExportOptions): { csvText: string; count: number; eol: "\n" | "\r\n" } {
  const result = spawnSync(
    "pm",
    ["--path", pmRoot, "list-all", "--json", "--include-body"],
    { encoding: "utf-8", maxBuffer: pmListMaxBuffer() },
  );
  // A stdout overrun kills the child with status null and EMPTY stderr, so name
  // the real cause instead of reporting an unexplained "pm list-all failed".
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new CommandError(
      code === "ENOBUFS"
        ? `pm list-all output exceeded the ${pmListMaxBuffer()} byte read buffer; narrow the export (--status/--type) or raise the PM_LIST_MAX_BUFFER env var.`
        : `pm list-all failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new CommandError(result.stderr || "pm list-all failed");
  }

  let items: PmItem[] = JSON.parse(result.stdout).items ?? [];
  if (opts.statusFilter) items = items.filter((i) => i.status === opts.statusFilter);
  if (opts.typeFilter) items = items.filter((i) => i.type === opts.typeFilter);

  // Surface provenance: derive csv_source from the internal csv-source: tag.
  for (const item of items) {
    const sourceTag = (item.tags ?? []).find((t) => t.startsWith(SOURCE_TAG_PREFIX));
    if (sourceTag) item.csv_source = decodeKeyTagValue(sourceTag.slice(SOURCE_TAG_PREFIX.length));
  }

  const dataRows = items.map((item) =>
    opts.columns.map((col) => {
      const prop = opts.columnSource?.[col] ?? col;
      const val = (item as unknown as Record<string, unknown>)[prop];
      if (val === undefined || val === null) return "";
      if (Array.isArray(val)) {
        // Strip internal provenance tags (csv-key / csv-source) so a round-trip
        // export stays clean.
        const visible = (val as unknown[]).filter(
          (t) =>
            typeof t === "string" &&
            !t.startsWith(KEY_TAG_PREFIX) &&
            !t.startsWith(SOURCE_TAG_PREFIX) &&
            !t.startsWith(TX_TAG_PREFIX) &&
            !t.startsWith(TX_ROW_TAG_PREFIX),
        ) as string[];
        return stringifyTags(visible);
      }
      return String(val);
    }),
  );

  const allRows = opts.noHeader ? dataRows : [opts.columns.map(String), ...dataRows];
  // --excel implies CRLF (and a UTF-8 BOM prefix, added below).
  const eol: "\n" | "\r\n" = opts.crlf || opts.excel ? "\r\n" : "\n";
  let csvText = serializeCSV(allRows, { delimiter: opts.delimiter, eol });
  if (opts.excel) csvText = "﻿" + csvText;
  return {
    csvText,
    count: items.length,
    eol,
  };
}

/**
 * Local stand-in for the SDK's `defineExtension` identity helper.
 *
 * Declared here rather than imported so this package keeps a type-only
 * dependency on `@unbrained/pm-cli` and adds no runtime module edge. The
 * generic constraint is the SDK's own, so the extension object is contract-
 * checked against {@link ExtensionModule} exactly as the imported helper would.
 */
const defineExtension = <TModule extends ExtensionModule>(module: TModule): TModule => module;

export default defineExtension({
  name: "pm-csv",
  version: "2026.8.10",

  activate(api: ExtensionApi) {
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
      } catch (err: unknown) {
        // Never let a schema-registration hiccup break command registration.
        console.error(
          `pm-csv: csv_source field not registered — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // -----------------------------------------------------------------------
    // Command: pm csv import <file>
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "csv import",
      description:
        "Import pm items from a CSV file with full RFC-4180 parsing (quoted fields, " +
        "embedded newlines, escaped quotes, BOM, CRLF). Expected columns: title, type, " +
        "status, priority, tags, deadline, body, parent, assignee, sprint, release, " +
        "blocked_by. Only 'title' is required. Use --map to remap arbitrary headers, " +
        "--auto-map to infer common aliases (e.g. summary->title), " +
        "--key for idempotent re-import (upsert), --encoding for non-UTF-8 files, " +
        "--source to record import provenance in the csv_source field, and " +
        "--status/--type/--priority to import only matching rows (others are skipped). " +
        "Use --strict to fail before writing when row-level data issues are present.",
      intent: "import items from a CSV file into pm",
      examples: [
        "pm csv import tasks.csv",
        "pm csv import backlog.csv --delimiter ';'",
        "pm csv import data.tsv --delimiter tab",
        "pm csv import jira.csv --auto-map",
        "pm csv import jira.csv --map 'Summary=title,Owner=tags'",
        "pm csv import items.csv --key title   # idempotent re-import (no duplicates)",
        "pm csv import legacy.csv --encoding latin1",
        "pm csv import sprint12.csv --source 'jira-export-2026-06'",
        "pm csv import tasks.csv --status open          # import only open rows",
        "pm csv import tasks.csv --type Feature --priority 1",
        "pm csv import tasks.csv --strict",
        "pm csv import items.csv --dry-run",
        "pm csv import headerless.csv --skip-headers   # no header row, positional columns",
        "pm csv import big.csv --stream   # stream large files without loading into memory",
        "pm csv import tasks.csv --atomic # all-or-nothing import (pm-cli >= 2026.7.19)",
      ],
      flags: [
        { long: "--delimiter", value_name: "char", description: "Field delimiter, or alias tab|comma|semicolon|pipe (default: ,)" },
        { long: "--map", value_name: "col=field", description: "Remap a CSV header to a pm field (repeatable, comma-joined). e.g. --map 'Summary=title'" },
        { long: "--auto-map", description: "Auto-map common third-party headers (e.g. summary->title, owner->assignee) when unambiguous" },
        { long: "--key", value_name: "field", description: "Dedup key column: re-import updates the matching item instead of creating a duplicate" },
        { long: "--encoding", value_name: "enc", description: "Source file encoding: utf-8 (default) | utf16le | latin1" },
        { long: "--source", value_name: "label", description: "Record an import-provenance label in the csv_source field of created/updated items" },
        { long: "--status", value_name: "filter", description: "Import only rows whose (normalized) status matches: open | in_progress | blocked | closed | canceled | draft" },
        { long: "--type", value_name: "type", description: "Import only rows whose type matches (case-insensitive)" },
        { long: "--priority", value_name: "n", description: "Import only rows whose integer priority equals this value" },
        { long: "--strict", description: "Abort before writing if validation finds missing titles, unknown statuses, bad priorities, or duplicate mapped columns" },
        { long: "--dry-run", description: "Preview without writing" },
        { long: "--skip-headers", description: "The CSV file has no header row; map columns positionally to the standard import order (title, type, status, priority, tags, deadline, body, parent, assignee, sprint, release, blocked_by)" },
        { long: "--stream", description: "Stream the file row-by-row instead of loading it fully into memory (recommended for large CSV files)" },
        { long: "--atomic", description: "Import all creates atomically under one workspace writer-locked, crash-recoverable transaction (pm-cli >= 2026.7.19). On failure every applied create is compensated (closed); interrupted runs resume. Incompatible with --stream" },
      ],
      async run(ctx) {
        const filePath = ctx.args[0] as string | undefined;
        if (!filePath) {
          throw new CommandError(
            "Usage: pm csv import <file> [--delimiter <char>] [--map col=field] [--auto-map] [--key field] [--encoding enc] [--source label] [--status s] [--type t] [--priority n] [--dry-run]",
            EXIT_CODE.USAGE,
          );
        }

        const delimiter = resolveDelimiter(ctx.options["delimiter"] as string | undefined);
        const dryRun = readBoolOption(ctx.options, "dry-run", "dryRun");
        const fieldMap = parseFieldMap(ctx.options["map"] as string | string[] | undefined);
        const autoMap = readBoolOption(ctx.options, "auto-map", "autoMap");
        const keyField = ((ctx.options["key"] as string | undefined) ?? "").trim().toLowerCase() || undefined;
        const encoding = resolveEncoding(ctx.options["encoding"] as string | undefined);
        const source = ((ctx.options["source"] as string | undefined) ?? "").trim() || undefined;
        const strict = readBoolOption(ctx.options, "strict");
        const skipHeaders = readBoolOption(ctx.options, "skip-headers", "skipHeaders");
        const stream = readBoolOption(ctx.options, "stream");
        const atomic = readBoolOption(ctx.options, "atomic");
        const filter = parseImportFilter(
          ctx.options["status"] as string | undefined,
          ctx.options["type"] as string | undefined,
          ctx.options["priority"] as string | undefined,
        );
        const absolutePath = resolve(filePath);

        console.error(`Reading CSV from: ${absolutePath}${stream ? " (streaming)" : ""}${atomic ? " (atomic)" : ""}`);

        let res: ImportResult;
        try {
          if (strict) assertStrictImportReady(absolutePath, { delimiter, fieldMap, encoding, autoMap, skipHeaders });
          res = await importCSV(
            ctx.pm_root,
            absolutePath,
            {
              delimiter,
              dryRun,
              fieldMap,
              autoMap,
              keyField,
              encoding,
              source,
              filter,
              skipHeaders,
              stream,
              atomic,
              // Prefer the host-injected SDK coordinator (bound to the
              // tracker root) so a standalone-installed extension never relies
              // on package resolution; the atomic path falls back to a dynamic
              // import when ctx.sdk is absent.
              commitTransaction: ctx.sdk?.commitWorkspaceTransaction,
              atomicAuthor: (ctx.global?.author as string | undefined) ?? undefined,
            },
          );
        } catch (err: unknown) {
          if (err instanceof CommandError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          const exitCode = /ENOENT|no such file/i.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
          throw new CommandError(`Failed to import: ${msg}`, exitCode);
        }

        const filterNote = res.filtered > 0 ? ` (${res.filtered} filtered out)` : "";
        const autoMapped = autoMappingsToRecord(res.autoMappings);
        if (res.autoMappings.length > 0) {
          console.error(`Auto-mapped columns: ${formatAutoMappings(res.autoMappings)}.`);
        }

        if (dryRun) {
          console.error(
            `[dry-run] Would create ${res.imported}, update ${res.updated}, skip ${res.skipped}${filterNote}.`,
          );
          return {
            dryRun: true,
            wouldCreate: res.imported,
            wouldUpdate: res.updated,
            wouldSkip: res.skipped,
            filtered: res.filtered,
            previews: res.previews,
            autoMapped,
            fieldMapWarnings: res.fieldMapWarnings,
          };
        }

        console.error(
          `Imported ${res.imported}, updated ${res.updated}, skipped ${res.skipped}${filterNote}.`,
        );
        return {
          imported: res.imported,
          updated: res.updated,
          skipped: res.skipped,
          filtered: res.filtered,
          errors: res.errors,
          autoMapped,
          fieldMapWarnings: res.fieldMapWarnings,
        };
      },
    });

    // -----------------------------------------------------------------------
    // Command: pm csv validate <file>
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "csv validate",
      description:
        "Validate a CSV without importing it. Reports row count, detected/mapped " +
        "columns, rows missing a title, rows with unrecognized status, rows with a " +
        "non-integer priority, and whether the required 'title' column is present " +
        "(after --map). Exits non-zero on structural problems (missing title column). " +
        "Honors --delimiter, --map, --auto-map, --encoding; supports --json.",
      intent: "validate a CSV file without importing",
      examples: [
        "pm csv validate tasks.csv",
        "pm csv validate jira.csv --map 'Summary=title'",
        "pm csv validate jira.csv --auto-map",
        "pm csv validate data.tsv --delimiter tab --json",
        "pm csv validate headerless.csv --skip-headers",
      ],
      flags: [
        { long: "--delimiter", value_name: "char", description: "Field delimiter, or alias tab|comma|semicolon|pipe (default: ,)" },
        { long: "--map", value_name: "col=field", description: "Remap a CSV header to a pm field (repeatable, comma-joined) before validating" },
        { long: "--auto-map", description: "Auto-map common third-party headers (e.g. summary->title) when unambiguous" },
        { long: "--encoding", value_name: "enc", description: "Source file encoding: utf-8 (default) | utf16le | latin1" },
        { long: "--skip-headers", description: "The CSV file has no header row; map columns positionally to the standard import order" },
      ],
      async run(ctx) {
        const filePath = ctx.args[0] as string | undefined;
        if (!filePath) {
          throw new CommandError(
            "Usage: pm csv validate <file> [--delimiter <char>] [--map col=field] [--auto-map] [--encoding enc] [--json]",
            EXIT_CODE.USAGE,
          );
        }

        const delimiter = resolveDelimiter(ctx.options["delimiter"] as string | undefined);
        const fieldMap = parseFieldMap(ctx.options["map"] as string | string[] | undefined);
        const autoMap = readBoolOption(ctx.options, "auto-map", "autoMap");
        const encoding = resolveEncoding(ctx.options["encoding"] as string | undefined);
        const skipHeaders = readBoolOption(ctx.options, "skip-headers", "skipHeaders");
        // `--json` is a host-owned global flag: extensions must not redeclare it
        // (the host rejects the registration) and must read it from ctx.global.
        const asJson = ctx.global?.json === true;
        const absolutePath = resolve(filePath);

        let report: CsvValidateReport;
        try {
          report = validateCSV(absolutePath, { delimiter, fieldMap, autoMap, encoding, skipHeaders });
        } catch (err: unknown) {
          if (err instanceof CommandError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          const exitCode = /ENOENT|no such file/i.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
          throw new CommandError(`Failed to validate: ${msg}`, exitCode);
        }

        // Human-readable summary on stderr (so --json stdout stays clean).
        console.error(`Rows: ${report.rowCount}`);
        console.error(`Detected columns: ${report.detectedColumns.join(", ") || "(none)"}`);
        console.error(`Mapped columns:   ${report.mappedColumns.join(", ") || "(none)"}`);
        if (report.autoMappings.length > 0) {
          console.error(`Auto-mapped columns: ${formatAutoMappings(report.autoMappings)}.`);
        }
        console.error(`Has 'title' column: ${report.hasTitleColumn ? "yes" : "no"}`);
        console.error(`Rows missing title: ${report.rowsMissingTitle}`);
        console.error(`Rows w/ unknown status: ${report.rowsWithUnknownStatus}`);
        console.error(`Rows w/ non-integer priority: ${report.rowsWithNonIntegerPriority}`);
        console.error(`Rows w/ out-of-range priority: ${report.rowsWithOutOfRangePriority}`);
        console.error(`Duplicate mapped columns: ${report.duplicateMappedColumns.join(", ") || "(none)"}`);
        for (const issue of report.issues) console.error(`  - ${issue}`);
        for (const w of report.fieldMapWarnings) console.error(`  Warning: ${w}`);
        console.error(report.ok ? "Validation OK." : "Validation FAILED (structural problems).");

        // Structural problems (no title column / empty) → non-zero exit.
        if (!report.ok) {
          if (asJson) {
            // Surface the structured report even on failure before throwing.
            console.error(JSON.stringify(report, null, 2));
          }
          throw new CommandError(
            "CSV is missing the required 'title' column (after --map).",
            EXIT_CODE.USAGE,
          );
        }

        return report as unknown as Record<string, unknown>;
      },
    });

    // -----------------------------------------------------------------------
    // Command: pm csv export [--output <file>]
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "csv export",
      description:
        "Export pm items to a CSV file (or print to stdout if --output is not given). " +
        `Columns: ${EXPORT_COLUMNS.join(", ")}.`,
      intent: "export pm items to a CSV file",
      examples: [
        "pm csv export",
        "pm csv export --output items.csv",
        "pm csv export --output backlog.csv --delimiter ';'",
        "pm csv export --status open --output todos.csv",
        "pm csv export --type Feature --output features.csv",
        "pm csv export --all-fields --output full.csv   # include custom workspace fields",
        "pm csv export --excel --output for-excel.csv",
      ],
      flags: [
        { long: "--output", value_name: "file", description: "Output file path (default: print to stdout)" },
        { long: "--delimiter", value_name: "char", description: "Field delimiter, or alias tab|comma|semicolon|pipe (default: ,)" },
        { long: "--status", value_name: "filter", description: "Filter by status: open | in_progress | blocked | closed | canceled | draft" },
        { long: "--type", value_name: "type", description: "Filter by item type" },
        { long: "--columns", value_name: "list", description: `Comma-separated columns to export, in order (default: all). Valid: ${EXPORT_COLUMNS.join(", ")} (plus any discovered custom fields)` },
        { long: "--all-fields", description: "Discover custom item fields registered in the workspace schema and append them as columns" },
        { long: "--discover-fields", description: "Alias for --all-fields" },
        { long: "--header", description: "Include the CSV header row (default: on). Pass --no-header to omit it." },
        { long: "--crlf", description: "Use CRLF line endings (RFC-4180 / Excel)" },
        { long: "--excel", description: "Excel-friendly output: CRLF line endings + a UTF-8 BOM prefix" },
      ],
      async run(ctx) {
        const delimiter = resolveDelimiter(ctx.options["delimiter"] as string | undefined);
        const outputPath = ctx.options["output"] as string | undefined;
        const discover = readBoolOption(ctx.options, "all-fields", "allFields", "discover-fields", "discoverFields");
        const { columns, columnSource } = resolveExportColumns(
          ctx.pm_root,
          ctx.options["columns"] as string | undefined,
          discover,
        );
        const noHeader = readNoHeaderOption(ctx.options);
        const crlf = readBoolOption(ctx.options, "crlf");
        const excel = readBoolOption(ctx.options, "excel");

        console.error("Fetching pm items…");
        const { csvText, count, eol } = buildCsvExport(ctx.pm_root, {
          statusFilter: ctx.options["status"] as string | undefined,
          typeFilter: ctx.options["type"] as string | undefined,
          delimiter,
          columns,
          columnSource,
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
          // Terminate the final record with the SAME EOL used between records
          // so `--crlf`/`--excel` output is uniformly CRLF (no lone trailing LF).
          writeFileSync(absolutePath, csvText + eol, "utf-8");
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
      const delimiter = resolveDelimiter(ctx.options["delimiter"] as string | undefined);
      const outputPath = ctx.options["output"] as string | undefined;
      const discover = readBoolOption(ctx.options, "all-fields", "allFields", "discover-fields", "discoverFields");
      const { columns, columnSource } = resolveExportColumns(
        ctx.pm_root,
        ctx.options["columns"] as string | undefined,
        discover,
      );
      const noHeader = readNoHeaderOption(ctx.options);
      const crlf = readBoolOption(ctx.options, "crlf");
      const excel = readBoolOption(ctx.options, "excel");

      const { csvText, count, eol } = buildCsvExport(ctx.pm_root, {
        statusFilter: ctx.options["status"] as string | undefined,
        typeFilter: ctx.options["type"] as string | undefined,
        delimiter,
        columns,
        columnSource,
        noHeader,
        crlf,
        excel,
      });

      if (outputPath) {
        const absolutePath = resolve(outputPath);
        // Match the inter-record EOL on the trailing terminator (no lone LF in --crlf/--excel).
        writeFileSync(absolutePath, csvText + eol, "utf-8");
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
      const filePath = ctx.options["file"] as string | undefined;
      if (!filePath) {
        console.error("csv-import: no 'file' provided in options — skipping.");
        return;
      }

      const delimiter = resolveDelimiter(ctx.options["delimiter"] as string | undefined);
      const fieldMap = parseFieldMap(ctx.options["map"] as string | string[] | undefined);
      const autoMap = readBoolOption(ctx.options, "auto-map", "autoMap");
      const keyField = ((ctx.options["key"] as string | undefined) ?? "").trim().toLowerCase() || undefined;
      const encoding = resolveEncoding(ctx.options["encoding"] as string | undefined);
      const source = ((ctx.options["source"] as string | undefined) ?? "").trim() || undefined;
      const strict = readBoolOption(ctx.options, "strict");
      const skipHeaders = readBoolOption(ctx.options, "skip-headers", "skipHeaders");
      const stream = readBoolOption(ctx.options, "stream");
      const atomic = readBoolOption(ctx.options, "atomic");
      const filter = parseImportFilter(
        ctx.options["status"] as string | undefined,
        ctx.options["type"] as string | undefined,
        ctx.options["priority"] as string | undefined,
      );
      const absolutePath = resolve(filePath);

      console.error(`csv-import: reading ${absolutePath}${stream ? " (streaming)" : ""}${atomic ? " (atomic)" : ""}`);

      let res: ImportResult;
      try {
        if (strict) assertStrictImportReady(absolutePath, { delimiter, fieldMap, encoding, autoMap, skipHeaders });
        res = await importCSV(
          ctx.pm_root,
          absolutePath,
          {
            delimiter,
            dryRun: false,
            fieldMap,
            autoMap,
            keyField,
            encoding,
            source,
            filter,
            skipHeaders,
            stream,
            atomic,
            atomicAuthor: (ctx.global?.author as string | undefined) ?? undefined,
          },
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`csv-import: failed — ${msg}`);
        return;
      }

      const filterNote = res.filtered > 0 ? ` (${res.filtered} filtered out)` : "";
      if (res.autoMappings.length > 0) {
        console.error(`csv-import: auto-mapped columns ${formatAutoMappings(res.autoMappings)}.`);
      }
      console.error(
        `csv-import: done — imported ${res.imported}, updated ${res.updated}, skipped ${res.skipped}${filterNote}.`,
      );
    });
  },
});

// ---------------------------------------------------------------------------
// Named exports — pure helpers exposed for unit testing (no side effects).
// ---------------------------------------------------------------------------
export {
  parseCSV,
  serializeCSV,
  serializeField,
  stripBOM,
  resolveDelimiter,
  parseFieldMap,
  resolveImportFieldMap,
  applyFieldMap,
  normalizeStatus,
  parseTags,
  stringifyTags,
  encodeKeyTagValue,
  decodeKeyTagValue,
  normalizeKeyValue,
  selectExportColumns,
  resolveEncoding,
  validateParsedCSV,
  strictValidationIssues,
  parseImportFilter,
  rowMatchesFilter,
  discoverCustomFields,
  EXPORT_COLUMNS,
  IMPORT_COLUMNS,
  StreamingCSVParser,
  streamCSVFile,
  levenshtein,
  suggestClosest,
  validateFieldMapTargets,
  checkMapSourcesPresent,
};
// ---------------------------------------------------------------------------
// Internal store helpers exposed for regression testing against oversized pm
// roots. Unlike the pure helpers above, these READ or WRITE the given pm root
// (they are not side-effect free) and are exported ONLY so the buffer-overrun
// and compensation regressions can drive them directly under a capped
// PM_LIST_MAX_BUFFER, independent of the write-bearing `csv import` command
// path. `describePmNullStatus` is a pure classifier exposed so the three
// null-status causes (buffer / spawn-error / signal) can be asserted directly
// with synthetic results.
// ---------------------------------------------------------------------------
export { loadAppliedByTransaction, itemStatus, compensateCreate };
// `describePmNullStatus` is exported at its declaration above.
export type { ParsedRow, ImportRowFilter, DiscoveredField, AutoFieldMapping };

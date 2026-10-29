import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { openSync, closeSync, readSync, fstatSync, constants } from "node:fs";
import { resolveItemTypeRegistry, resolveRuntimeStatusRegistry, normalizeStatusInput, getHistoryPath, readHistoryEntries, verifyHistoryEntries, locateItem, readLocatedItem, PmCliError } from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import type { PmSettings } from "@unbrained/pm-cli/sdk";
import type { ImportRowFilter } from "./index.ts";
import { readPinnedSettings, verifySettings, withSettings } from "./settings-snapshot.ts";
import { mutationMessageBase } from "./mutation-intent.ts";
import { StreamingCSVParser, IMPORT_COLUMNS, resolveDelimiter, resolveEncoding, stripBOM, parseFieldMap,
  resolveImportFieldMap, applyFieldMap, validateFieldMapTargets, checkMapSourcesPresent, validateParsedCSV, strictValidationIssues, readBoolOption } from "./index.ts";

/** Hard allocation and materialization ceilings; callers can only lower them. Units are UTF-16 code units unless named bytes. */
export const ADMISSION_LIMITS: Readonly<Record<"maxFieldCodeUnits" | "maxRecordCodeUnits" | "maxColumns" | "maxAtomicBytes" | "maxAtomicRows" | "maxSourceBytes", number>> = Object.freeze({ maxFieldCodeUnits: 65536, maxRecordCodeUnits: 262144, maxColumns: 128,
  maxAtomicBytes: 8 * 1024 * 1024, maxAtomicRows: 1000, maxSourceBytes: 1024 ** 4 });
/** One strict SDK/CLI boundary; initial scans never authorize apply. */
export interface AdmissionOptions {
  mode?: "initial" | "full";
  initialRows?: number;
  delimiter?: string;
  encoding?: "utf-8" | "utf8" | "utf16le" | "latin1";
  skipHeaders?: boolean;
  fieldMap?: Record<string, string>;
  autoMap?: boolean;
  filter?: ImportRowFilter;
  maxFieldCodeUnits?: number;
  maxRecordCodeUnits?: number;
  maxColumns?: number;
  maxAtomicBytes?: number;
  maxAtomicRows?: number;
  maxSourceBytes?: number;
}
/** Compact source-free receipt. Mutation work is a row-operation upper bound, never an exact create/update count or heap prediction. */
export interface AdmissionReceipt {
  version: 1;
  mode: "initial" | "full";
  ok: boolean;
  complete: boolean;
  admitted: boolean;
  digest?: string;
  rows: { value: number; kind: "exact" | "lower_bound" };
  invalidRows: number;
  issues: { row: number; code: "row_width" | "row_invalid" }[];
  fieldWidths: number[];
  mutationWork: { value: number; kind: "upper_bound" };
  sourceBytes: number;
  limits: typeof ADMISSION_LIMITS;
  remedy?: string;
}
/** Stable refusal families; no source cells, source paths or low-level IO text is exposed. */
export type AdmissionRefusalCode = "csv_admission_options" | "csv_admission_io" | "csv_admission_limit" |
  "csv_admission_invalid" | "csv_admission_incomplete" | "csv_admission_source_changed" | "csv_admission_settings_changed" | "csv_admission_target_changed" | "csv_admission_sdk";
/** Expected semantic failure with a concrete retry action. */
export class AdmissionRefusal extends PmCliError {
  /** Stable category for an automated retry decision. */
  readonly code: AdmissionRefusalCode;
  /** Concrete repair action, excluding source content. */
  readonly remedy: string;
  constructor(code: AdmissionRefusalCode, remedy: string) {
    super(`${code}: ${remedy}`, 2, { code, required: remedy, nextSteps: [remedy] });
    this.code = code;
    this.remedy = remedy;
  }
}
/** Keep admission and its native application in one settings-refusal family. */
export function admissionSettingsChanged(): AdmissionRefusal {
  return new AdmissionRefusal("csv_admission_settings_changed", "Tracker settings changed; scan again against current schemas and status roles.");
}
/** Preserve typed admission remedies when native transaction compensation aggregates failures. */
export function findAdmissionFailure(error: unknown, seen = new Set<unknown>()): AdmissionRefusal | undefined {
  if (seen.has(error)) return undefined;
  seen.add(error);
  if (error instanceof AdmissionRefusal) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const refusal = findAdmissionFailure(nested, seen);
      if (refusal) return refusal;
    }
  }
  return error instanceof Error && error.cause !== undefined ? findAdmissionFailure(error.cause, seen) : undefined;
}
/** Older hosts keep read-only admission; applying needs the native semantic preview capability. */
export function requireAdmissionCapability<T extends (...args: never[]) => unknown>(value: T | undefined): T {
  if (typeof value !== "function") throw new AdmissionRefusal("csv_admission_sdk", "Upgrade the pm host to one exposing semantic mutation preview and transaction-key derivation (the development SDK is supported); csv admit remains available without applying.");
  return value;
}
/** Preserve a concrete host/storage remedy when an older SDK previews installed dependency links. */
export function admissionPreviewFailure(error: unknown): AdmissionRefusal {
  const storage = typeof error === "object" && error !== null && "code" in error && error.code === "transaction_preview_non_regular_file";
  const refusal = new AdmissionRefusal(storage ? "csv_admission_sdk" : "csv_admission_invalid", storage
    ? "Native preview refused linked or special tracker storage. Use pm 2026.10.28 or newer for installed dependency links; inspect authoritative tracker links or special files without following them, then retry. No mutations were attempted."
    : "Native SDK validation refused the bounded plan before application. Correct native fields, references or governance policies, then review the import again.");
  refusal.cause = error;
  return refusal;
}
/** Validate options once before IO, including finite integer domains and bounded own-key mappings. */
export function parseAdmissionOptions(value: AdmissionOptions): Required<AdmissionOptions> {
  const keys = ["mode", "initialRows", "delimiter", "encoding", "skipHeaders", "fieldMap", "autoMap", "filter", ...Object.keys(ADMISSION_LIMITS)];
  const invalid = new AdmissionRefusal("csv_admission_options", "Use full or initial mode, supported encoding/mappings, booleans and positive safe integer limits no larger than ADMISSION_LIMITS.");
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key))) throw invalid;
  if ((value.mode !== undefined && !["initial", "full"].includes(value.mode)) ||
      [value.skipHeaders, value.autoMap].some(flag => flag !== undefined && typeof flag !== "boolean") ||
      (value.delimiter !== undefined && typeof value.delimiter !== "string") ||
      (value.encoding !== undefined && typeof value.encoding !== "string")) throw invalid;
  const fieldMap = value.fieldMap === undefined ? {} : value.fieldMap;
  if (!fieldMap || typeof fieldMap !== "object" || Array.isArray(fieldMap) || ![Object.prototype, null].includes(Object.getPrototypeOf(fieldMap)) ||
      Reflect.ownKeys(fieldMap).length > 128 || Reflect.ownKeys(fieldMap).some(key => typeof key !== "string") ||
      Object.entries(fieldMap).some(([key, field]) => !key.trim() || key.length > 128 || typeof field !== "string" || !IMPORT_COLUMNS.includes(field as typeof IMPORT_COLUMNS[number]))) throw invalid;
  const filter = value.filter === undefined ? {} : value.filter;
  if (!filter || typeof filter !== "object" || Array.isArray(filter) || ![Object.prototype, null].includes(Object.getPrototypeOf(filter)) ||
      Reflect.ownKeys(filter).some(key => typeof key !== "string" || !["status", "type", "priority"].includes(key)) ||
      [filter.status, filter.type].some(v => v !== undefined && (typeof v !== "string" || !v.trim() || v.length > 128)) ||
      (filter.priority !== undefined && (!Number.isSafeInteger(filter.priority) || filter.priority < 0 || filter.priority > 4))) throw invalid;
  const limits = { ...ADMISSION_LIMITS };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const n = value[key] === undefined ? limits[key] : value[key];
    if (!Number.isSafeInteger(n) || n < 1 || n > ADMISSION_LIMITS[key]) throw invalid;
    limits[key] = n;
  }
  const initialRows = value.initialRows === undefined ? 1000 : value.initialRows;
  if (!Number.isSafeInteger(initialRows) || initialRows < 1 || initialRows > 1000000) throw invalid;
  let delimiter: string, encoding: Required<AdmissionOptions>["encoding"];
  try { delimiter = resolveDelimiter(value.delimiter); encoding = resolveEncoding(value.encoding); }
  catch { throw invalid; }
  if (delimiter.length !== 1 || /["\r\n\uFEFF]/.test(delimiter)) throw invalid;
  return { ...limits, mode: value.mode ?? "full", initialRows, delimiter, encoding,
    skipHeaders: value.skipHeaders ?? false, autoMap: value.autoMap ?? false, fieldMap: { ...fieldMap }, filter: { ...filter } };
}
/** Normalize a selected status through the same native registry as row writes, preserving source-based type filtering. */
export function normalizeAdmissionFilter(filter: ImportRowFilter, settings: PmSettings): ImportRowFilter | undefined {
  const status = filter.status === undefined ? undefined : normalizeStatusInput(filter.status, resolveRuntimeStatusRegistry(settings.schema));
  if (filter.status !== undefined && status === undefined) throw new AdmissionRefusal("csv_admission_options", "Select a configured native status for the import filter, then scan again.");
  const type = filter.type?.trim().toLowerCase();
  if (status === undefined && type === undefined && filter.priority === undefined) return undefined;
  return { status, type, priority: filter.priority };
}
/** Refuse unusable resource reports before an atomic caller allocates a row plan. */
export function assertCSVAdmission(receipt: AdmissionReceipt): void {
  if (receipt.mode === "initial" || !receipt.complete) throw new AdmissionRefusal("csv_admission_incomplete", "Run a full scan; an initial scan never authorizes atomic import.");
  if (!receipt.ok) throw new AdmissionRefusal("csv_admission_invalid", "Repair the reported row coordinates and run full admission again; no mutations were attempted.");
  if (!receipt.admitted) throw new AdmissionRefusal("csv_admission_limit", "Split the source into explicitly reviewed imports within the reported atomic row/byte budgets, or lower the requested work; admission did not apply anything.");
}
/** Capture bounded bytes for the existing atomic parser, refusing source drift before materialization or writes. */
export function readAdmittedSource(file: string, digest: string, maxBytes = ADMISSION_LIMITS.maxAtomicBytes): Buffer {
  const budget = parseAdmissionOptions({ maxAtomicBytes: maxBytes }).maxAtomicBytes;
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch { throw new AdmissionRefusal("csv_admission_io", "The admitted file is no longer readable; restore a readable regular source and scan again."); }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    if (!fstatSync(fd).isFile()) throw new AdmissionRefusal("csv_admission_io", "Use a regular file for admitted materialization; the source changed type after scanning.");
    for (;;) {
      const chunk = Buffer.alloc(16384), length = readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      total += length;
      if (total > budget) throw new AdmissionRefusal("csv_admission_limit", "Source grew beyond the atomic byte budget; stabilize it and scan again.");
      chunks.push(chunk.subarray(0, length));
    }
  } finally { closeSync(fd); }
  const bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new AdmissionRefusal("csv_admission_source_changed", "Source bytes changed after admission; review and scan the new source before retrying.");
  return bytes;
}
/** Bind a mutation step to verified native state plus append-only history, preventing ABA replay. */
export async function admissionTargetRevision(pmRoot: string, id: string, expected?: string, appliedMarker?: string): Promise<string> {
  const settings = await readPinnedSettings(pmRoot);
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder);
  const history = await readHistoryEntries(getHistoryPath(pmRoot, id), id);
  if (!located) {
    if (expected === "absent" && history.length === 0) return "absent";
    throw new AdmissionRefusal("csv_admission_target_changed", "A target is missing or has retained history; reconcile its SDK state before retrying the original plan.");
  }
  const document = (await readLocatedItem(located, { schema: settings.schema })).document;
  const revision = createHash("sha256").update(JSON.stringify([document, history])).digest("hex");
  const owned = appliedMarker !== undefined && ["create", "apply", "close"].some(phase => mutationMessageBase(history.at(-1)?.message) === `${appliedMarker}:${phase}`);
  if (!verifyHistoryEntries(history, document).ok || (expected !== undefined && revision !== expected && !owned)) {
    throw new AdmissionRefusal("csv_admission_target_changed", "A target revision changed after planning or a prior import. Reconcile current SDK state and preview a fresh import; no frozen target plan was replayed.");
  }
  return revision;
}
/** Check every emitted count and width before returning success, also useful to consumers validating receipts. */
export function assertAdmissionNumbers(receipt: AdmissionReceipt): void {
  const counts = [receipt.rows.value, receipt.invalidRows, receipt.sourceBytes, receipt.mutationWork.value,
    ...receipt.fieldWidths, ...receipt.issues.map(issue => issue.row), ...Object.values(receipt.limits)];
  if (counts.some(n => !Number.isSafeInteger(n) || n < 0) || receipt.sourceBytes > ADMISSION_LIMITS.maxSourceBytes ||
      (Object.keys(ADMISSION_LIMITS) as (keyof typeof ADMISSION_LIMITS)[]).some(key => receipt.limits[key] < 1 || receipt.limits[key] > ADMISSION_LIMITS[key]) ||
      receipt.mutationWork.value > receipt.sourceBytes || receipt.issues.some(issue => issue.row < 1 || issue.row > receipt.sourceBytes) ||
      receipt.rows.value > receipt.sourceBytes || receipt.invalidRows > receipt.rows.value || receipt.fieldWidths.length > receipt.limits.maxColumns ||
      receipt.fieldWidths.some(n => n > receipt.limits.maxFieldCodeUnits) || receipt.issues.length > 8) {
    throw new AdmissionRefusal("csv_admission_limit", "The source exceeded the finite receipt domain; reduce the resource limits and rescan.");
  }
}
/** Stream one open regular-file descriptor, keeping a single bounded record and aggregate counters. */
async function scan(pmRoot: string, file: string, opts: Required<AdmissionOptions>, diagnostics: AdmissionDiagnostics): Promise<AdmissionReceipt> {
  const settings = await readPinnedSettings(pmRoot);
  normalizeAdmissionFilter(opts.filter, settings);
  const statuses = resolveRuntimeStatusRegistry(settings.schema), types = resolveItemTypeRegistry(settings);
  const knownStatus = (status: string): boolean => normalizeStatusInput(status, statuses) !== undefined;
  let headers: string[] | undefined, rows = 0, invalidRows = 0, record = 0;
  const widths: number[] = [], issues: AdmissionReceipt["issues"] = [];
  const stop = Symbol("initial_scan_complete");
  /** Resolve through the import's existing mapping path; reject lossy/ambiguous mappings before scanning rows. */
  const setHeaders = (raw: string[]): void => {
    if (raw.some(h => !h.trim() || h.length > 128) || validateFieldMapTargets(opts.fieldMap).length || checkMapSourcesPresent(raw, opts.fieldMap).length) {
      throw new AdmissionRefusal("csv_admission_invalid", "Use distinct nonempty headers up to 128 code units and map existing columns to supported CSV fields.");
    }
    const mapped = resolveImportFieldMap(raw, opts.fieldMap, opts.autoMap);
    headers = applyFieldMap(raw, mapped.fieldMap);
    if (strictValidationIssues(validateParsedCSV(headers, [], {}, knownStatus)).length) {
      throw new AdmissionRefusal("csv_admission_invalid", "Provide a title column with distinct mapped fields; reuse csv schema describe to review mappings.");
    }
    for (const field of raw) widths.push(opts.skipHeaders ? 0 : field.length);
  };
  /** Bound initial observation work even when the prefix consists entirely of blank records. */
  const stopInitial = (): void => {
    if (opts.mode === "initial" && record >= opts.initialRows + (opts.skipHeaders ? 0 : 1)) throw stop;
  };
  if (opts.skipHeaders) setHeaders([...IMPORT_COLUMNS]);
  const parser = new StreamingCSVParser(opts.delimiter, row => {
    record++;
    if (!row.some(cell => cell.trim())) { stopInitial(); return; }
    if (!headers) { setHeaders(row.map(h => h.trim().toLowerCase())); stopInitial(); return; }
    rows++;
    for (let index = 0; index < row.length; index++) widths[index] = Math.max(widths[index] ?? 0, row[index].length);
    const report = validateParsedCSV(headers, [row], {}, knownStatus);
    const type = row[headers.indexOf("type")]?.trim();
    const badWidth = row.length !== headers.length;
    if (badWidth || strictValidationIssues(report).length || (type && !Object.hasOwn(types.alias_to_type, type.toLowerCase()))) {
      invalidRows++;
      if (issues.length < 8) issues.push({ row: record, code: badWidth ? "row_width" : "row_invalid" });
    }
    stopInitial();
  }, opts);
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => { throw new AdmissionRefusal("csv_admission_io", "Provide a readable regular CSV file; no source or target was modified."); });
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(opts.maxSourceBytes)) throw new AdmissionRefusal("csv_admission_limit", "Use a regular file within maxSourceBytes; pipes, devices and oversized inputs are refused.");
    await diagnostics.onBoundary?.("opened");
    const buffer = Buffer.alloc(16384);
    const hash = createHash("sha256");
    const decoder = new TextDecoder(opts.encoding === "utf8" ? "utf-8" : opts.encoding === "utf16le" ? "utf-16le" : opts.encoding === "latin1" ? "windows-1252" : opts.encoding, { fatal: true, ignoreBOM: true });
    let first = true, complete = true, readBytes = 0;
    try {
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        const bytes = buffer.subarray(0, bytesRead);
        readBytes += bytes.length;
        if (readBytes > opts.maxSourceBytes) throw new RangeError("csv_source_limit");
        hash.update(bytes);
        let text = opts.encoding === "latin1" ? bytes.toString("latin1") : decoder.decode(bytes, { stream: true });
        if (first) { text = stripBOM(text); first = false; }
        parser.push(text);
        await diagnostics.onBoundary?.("read");
      }
      parser.push(decoder.decode());
      parser.end();
    } catch (error) {
      if (error === stop) complete = false;
      else if (error instanceof AdmissionRefusal) throw error;
      else throw new AdmissionRefusal(error instanceof RangeError ? "csv_admission_limit" : "csv_admission_invalid",
        "Correct encoding/quoting or reduce field, record and column widths to the declared limits; scan stopped before any mutation.");
    }
    await diagnostics.onBoundary?.("validated");
    const after = await handle.stat({ bigint: true });
    if (["size", "mtimeNs", "ctimeNs"].some(key => before[key as "size" | "mtimeNs" | "ctimeNs"] !== after[key as "size" | "mtimeNs" | "ctimeNs"])) {
      throw new AdmissionRefusal("csv_admission_source_changed", "The open source changed during scanning; stabilize the file and run full admission again.");
    }
    if (!headers && complete) throw new AdmissionRefusal("csv_admission_invalid", "Provide a nonempty CSV with a title header.");
    await verifySettings(pmRoot);
    const sourceBytes = Number(before.size);
    const limits = Object.fromEntries(Object.keys(ADMISSION_LIMITS).map(key => [key, opts[key as keyof typeof ADMISSION_LIMITS]])) as typeof ADMISSION_LIMITS;
    const admitted = opts.mode === "full" && complete && invalidRows === 0 && rows <= opts.maxAtomicRows && sourceBytes <= opts.maxAtomicBytes;
    const receipt: AdmissionReceipt = { version: 1, mode: opts.mode, ok: headers !== undefined && invalidRows === 0, complete, admitted,
      ...(complete ? { digest: hash.digest("hex") } : {}), rows: { value: rows, kind: complete ? "exact" : "lower_bound" },
      invalidRows, issues, fieldWidths: widths, sourceBytes, mutationWork: { value: complete ? rows : sourceBytes, kind: "upper_bound" }, limits,
      ...(!admitted ? { remedy: opts.mode === "initial" || !complete ? "Run a full scan before atomic admission." : invalidRows ? "Repair reported rows and rescan." : "Split into reviewed imports within atomic row/byte limits." } : {}) };
    assertAdmissionNumbers(receipt);
    return receipt;
  } finally { await handle.close(); }
}
/** Read-only admission against one SDK settings revision. Source size never determines retained row count. */
export async function admitCSV(pmRoot: string, file: string, options: AdmissionOptions = {}, diagnostics: AdmissionDiagnostics = {}): Promise<AdmissionReceipt> {
  const opts = parseAdmissionOptions(options);
  return withSettings(pmRoot, admissionSettingsChanged, () => scan(pmRoot, file, opts, diagnostics));
}
/** Trusted observer for deterministic concurrency diagnostics, outside the untrusted options schema. */
export interface AdmissionDiagnostics {
  onBoundary?: (phase: "opened" | "read" | "validated") => void | Promise<void>;
}
/** Register one host-rendered compact TOON/JSON command; no source values or artifacts are emitted. */
export function registerAdmissionCommand(api: ExtensionApi): void {
  api.registerCommand({ name: "csv admit", description: "Stream full or initial CSV validation and report bounded import admission without writes.",
    arguments: [{ name: "file", required: true, description: "Readable regular CSV file" }],
    flags: [
      { long: "--initial-rows", value_name: "count", description: "Initial scan only; positive integer up to 1000000, never authorizes apply" },
      { long: "--delimiter", value_name: "char", description: "Existing CSV delimiter vocabulary" },
      { long: "--encoding", value_name: "encoding", description: "utf-8, utf8, utf16le or latin1" },
      { long: "--map", value_name: "mapping", description: "Existing Source=field mapping" },
      { long: "--auto-map", description: "Reuse existing well-known header aliases" },
      { long: "--skip-headers", description: "Use canonical positional import columns" },
      ...Object.keys(ADMISSION_LIMITS).map(key => ({ long: `--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value_name: "count", description: `Lower ${key} for this scan` })),
    ],
    async run(ctx) {
      const options: Record<string, unknown> = {};
      for (const key of Object.keys(ADMISSION_LIMITS)) {
        const raw = ctx.options[key] ?? ctx.options[key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)];
        if (raw !== undefined) options[key] = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
      }
      const initial = ctx.options["initialRows"] ?? ctx.options["initial-rows"];
      if (initial !== undefined) { options.mode = "initial"; options.initialRows = typeof initial === "string" && /^\d+$/.test(initial) ? Number(initial) : NaN; }
      try { options.fieldMap = parseFieldMap(ctx.options["map"] as string | undefined); }
      catch { throw new AdmissionRefusal("csv_admission_options", "Use Source=title,Rank=priority mappings to existing supported CSV fields."); }
      return { ...await admitCSV(ctx.pm_root, ctx.args[0], { ...options, delimiter: ctx.options["delimiter"] as string | undefined,
        encoding: ctx.options["encoding"] as AdmissionOptions["encoding"], autoMap: readBoolOption(ctx.options, "auto-map", "autoMap"),
        skipHeaders: readBoolOption(ctx.options, "skip-headers", "skipHeaders") }) };
    },
  });
}

import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import * as nativeSdk from "@unbrained/pm-cli/sdk";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import {
  acquireLock, create, commitWorkspaceTransaction, generateItemId, getHistoryPath, locateItem, normalizeItemId,
  PmCliError, readHistoryEntries, readLocatedItem, resolveItemTypeRegistry,
  resolveRuntimeStatusRegistry, verifyHistoryEntries,
  appendHistoryEntry, createHistoryEntry, emptyImportedDocument, removeFileIfExists, nowIso,
  PmClient, runWithActiveExtensions, runActiveOnWriteHooks, runWorkspaceTransactionGc,
} from "@unbrained/pm-cli/sdk";
import type { CommitWorkspaceTransactionOptions, WorkspaceTransactionStep, ItemDocument, PmSettings } from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { assertEditLease } from "./lease-guard.ts";
import { assertCanonicalMutationIds, buildMutationIntent, mutationMessageBase, matchesMutationScope } from "./mutation-intent.ts";
import { readTable } from "./table-schema.ts";
import { captureSettings, inSettingsTransaction, pinCreateDefaults, readPinnedSettings as readSettings, rethrowSettingsChange, settingsChangedIn, settingsDigest, useSettings, verifySettings, withSettings, withSettingsFence } from "./settings-snapshot.ts";
import type { SettingsSnapshot } from "./settings-snapshot.ts";

/** Explicit SDK create-option vocabulary: no implicit header mappings or field coercion. */
const FIELDS = ["title", "body", "type", "status", "priority", "tags", "assignee", "sprint", "release", "estimatedMinutes", "acceptanceCriteria", "closeReason", "completedAt"] as const;
/** Supported scalar create options; SDK owns their normalization and persistence. */
type Field = typeof FIELDS[number];
/** Explicit external-key input; CSV sources are captured inline, never reopened during apply. */
export interface JoinInput {
  version: 1;
  tables: { name: string; key: string; csv: string; fields: Partial<Record<Field, string>>;
    references: { column: string; table: string; kind: "parent" | "blocked_by" }[] }[];
}
/** Cell coordinates are one-based logical CSV records and columns, including the header. */
export interface JoinIssue {
  table: string;
  row: number;
  column: number;
  code: "empty_key" | "duplicate_key" | "unresolved" | "cycle" | "foreign" | "dependency_skipped";
}
/** Saved review binds source bytes, target settings, SDK-generated identities and absent revisions. */
export interface JoinPlan {
  version: 1;
  input: JoinInput;
  sources: string[];
  settings: string;
  ids: string[];
  expected: "absent";
  digest: string;
}
/** Bounded host-rendered receipt; no cell values or source text are returned. */
export interface JoinReceipt {
  ok: boolean;
  remedy?: string;
  tables: number;
  rows: number;
  references: number;
  applied: number;
  unchanged: number;
  skipped: number;
  issueCount: number;
  issues: JoinIssue[];
}
/** Stable expected refusal categories for SDK callers and agent dispatch. */
export type JoinRefusalCode = "csv_join_invalid" | "csv_join_io" | "csv_join_settings_changed" | "csv_join_target_changed" | "csv_join_apply_failed" | "csv_join_reconcile";
/** Diagnostics expose transaction boundaries; compensation lock phases execute inside the item lease. */
export interface JoinApplyOptions {
  author: string;
  onTransition?: CommitWorkspaceTransactionOptions["onTransition"];
  onBoundary?: (phase: "inspected" | "before_dependencies" | "before_create" | "compensating" | "compensation_validated" | "compensation_locked" | "compensation_checked" | "compensation_removed" | "compensation_recorded", id: string) => void | Promise<void>;
}
/** Typed refusal with a stable machine code, semantic exit status and actionable remedy. */
export class JoinRefusal extends PmCliError {
  /** Stable category for callers that must choose a recovery action. */
  readonly code: JoinRefusalCode;
  /** Recovery action that avoids replaying over newer native state. */
  readonly remedy: string;
  /** Original lower-level category, when a boundary wrapped another refusal. */
  readonly sourceCode?: string;
  constructor(code: JoinRefusalCode, remedy: string, sourceCode?: string) {
    super(`${code}: ${remedy}`, 2, { code, required: remedy, nextSteps: [remedy], ...(sourceCode ? { sourceCode, sourceRemedy: remedy } : {}) });
    this.sourceCode = sourceCode;
    this.code = code;
    this.remedy = remedy;
  }
}
/** Preserve the documented refusal family while retaining lower-level categories and remedies. */
function joinRefusal(error: unknown, code: JoinRefusalCode, remedy: string): JoinRefusal {
  if (error instanceof JoinRefusal) return error;
  const sourceCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "unexpected_error";
  const sourceRemedy = typeof error === "object" && error !== null && "remedy" in error && typeof error.remedy === "string" ? error.remedy : remedy;
  const refusal = new JoinRefusal(code, sourceRemedy, sourceCode);
  refusal.cause = error;
  return refusal;
}

/** Hash captured strings as UTF-8 bytes and structured revision data as JSON. */
function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}
/** Bind coordinator identity to reviewed bytes, native targets and their absent revisions. */
export function joinTransactionId(plan: JoinPlan, selected: number[], derive: ((input: string) => string) | null = nativeSdk.deriveMutationTransactionId): string {
  const input = JSON.stringify(["csv-join-v2", plan.digest, plan.expected, selected.map(i => plan.ids[i])]);
  return `csv-join-${derive ? derive(input) : `mutate-${hash(input).slice(0, 24)}`}`;
}

/** Public SDK cache mutation shape, also portable to hosts predating derived indexes. */
interface JoinIndexMutation {
  id: string; idPrefix: string; pmRoot: string; preferredFormat: PmSettings["item_format"] | undefined; typeToFolder: Record<string, string>;
  schema: PmSettings["schema"] | undefined; itemPath: string; document: ItemDocument | null;
}
/** Maintain the host's derived index inside its lease, without inventing older-host cache files. */
export async function mutateJoinIndex(mutation: JoinIndexMutation, run: () => Promise<void>, capabilities: {
  acquireItemMetadataDerivedIndexLock?: (root: string, author: string) => Promise<() => Promise<void>>;
  refreshItemMetadataDerivedIndex?: (mutation: JoinIndexMutation) => Promise<string[]>;
} = nativeSdk): Promise<void> {
  const release = capabilities.acquireItemMetadataDerivedIndexLock
    ? await capabilities.acquireItemMetadataDerivedIndexLock(mutation.pmRoot, "pm-csv") : undefined;
  try {
    try { await run(); }
    finally {
      if (capabilities.refreshItemMetadataDerivedIndex) {
        const located = await locateItem(mutation.pmRoot, mutation.id, mutation.idPrefix, mutation.preferredFormat, mutation.typeToFolder);
        const document = located ? (await readLocatedItem(located, { schema: mutation.schema })).document : null;
        await capabilities.refreshItemMetadataDerivedIndex({ ...mutation, document });
      }
    }
  } finally { await release?.(); }
}
/** Refuse malformed boundary data without disclosing input values. */
function invalid(): never {
  throw new JoinRefusal("csv_join_invalid", "Use a version 1 join input or unchanged preview plan; use dense bounded arrays, exact declared keys and supported scalar mappings.");
}
/** One strict boundary schema shared by SDK and CLI, including artifact validation. */
function boundary(value: unknown, artifact: boolean): JoinInput | JoinPlan {
  /** Check own property keys before reading any nested structure. */
  const object = (v: unknown, keys: string[]): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(v, k))) invalid();
    return v as Record<string, unknown>;
  };
  /** Arrays must be dense, bounded and free of additional enumerable properties. */
  const array = (v: unknown, max: number): unknown[] => {
    if (!Array.isArray(v) || v.length > max || Object.keys(v).length !== v.length || Array.from({ length: v.length }, (_, i) => !Object.hasOwn(v, i)).some(Boolean)) invalid();
    return v;
  };
  /** Bound string allocations before field-specific header and identifier checks. */
  const string = (v: unknown, max: number): string => {
    if (typeof v !== "string" || v.length > max) invalid();
    return v;
  };
  const envelope = artifact ? object(value, ["version", "input", "sources", "settings", "ids", "expected", "digest"]) : undefined;
  const input = object(artifact ? envelope!.input : value, ["version", "tables"]);
  if (input.version !== 1 || (envelope && (envelope.version !== 1 || envelope.expected !== "absent"))) invalid();
  let bytes = 0;
  const tables = array(input.tables, 16).map(v => {
    const t = object(v, ["name", "key", "csv", "fields", "references"]);
    const name = string(t.name, 64), key = string(t.key, 128), csv = string(t.csv, 8 * 1024 * 1024);
    bytes += Buffer.byteLength(csv);
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || !key.trim() || bytes > 8 * 1024 * 1024) invalid();
    if (!t.fields || typeof t.fields !== "object" || Array.isArray(t.fields) || Object.keys(t.fields).length > FIELDS.length) invalid();
    const fields = Object.create(null) as Partial<Record<Field, string>>;
    for (const [field, column] of Object.entries(t.fields)) {
      if (!FIELDS.includes(field as Field)) invalid();
      fields[field as Field] = string(column, 128);
    }
    if (!fields.title) invalid();
    const references = array(t.references, 16).map((v): JoinInput["tables"][number]["references"][number] => {
      const r = object(v, ["column", "table", "kind"]);
      if (r.kind !== "parent" && r.kind !== "blocked_by") invalid();
      return { column: string(r.column, 128), table: string(r.table, 64), kind: r.kind };
    });
    if (references.filter(r => r.kind === "parent").length > 1) invalid();
    return { name, key, csv, fields, references };
  });
  if (!tables.length || new Set(tables.map(t => t.name)).size !== tables.length) invalid();
  const parsed: JoinInput = { version: 1, tables };
  if (!envelope) return parsed;
  const ids = array(envelope.ids, 1000).map(v => string(v, 128));
  const sources = array(envelope.sources, 16).map(v => string(v, 64));
  const settings = string(envelope.settings, 64), digest = string(envelope.digest, 64);
  if (new Set(ids).size !== ids.length || ids.some(id => !/^[a-z0-9][a-z0-9_-]*$/.test(id)) ||
      sources.some(v => !/^[a-f0-9]{64}$/.test(v)) || !/^[a-f0-9]{64}$/.test(settings)) invalid();
  const base = { version: 1 as const, input: parsed, sources, settings, ids, expected: "absent" as const };
  if (digest !== hash(base) || JSON.stringify(sources) !== JSON.stringify(tables.map(t => hash(t.csv)))) invalid();
  return { ...base, digest };
}

interface Row {
  table: string;
  row: number;
  keyColumn: number;
  options: Partial<Record<Field, string>>;
  edges: { target: number; kind: "parent" | "blocked_by"; column: number }[];
}
/** Compile and validate all tables before generating a plan or invoking mutation primitives. */
async function compile(settings: PmSettings, input: JoinInput): Promise<{ rows: Row[]; issues: JoinIssue[]; order: number[] }> {
  const statuses = resolveRuntimeStatusRegistry(settings.schema);
  const types = new Map(Object.entries(resolveItemTypeRegistry(settings).type_to_folder));
  const issues: JoinIssue[] = [], rows: Row[] = [];
  const tables = input.tables.map(t => ({ ...t, data: readTable(t.csv, ",").table, keys: new Map<string, number[]>() }));
  for (const t of tables) {
    const headers = t.data[0];
    if (![t.key, ...Object.values(t.fields), ...t.references.map(r => r.column)].every(c => headers.includes(c)) ||
        t.references.some(r => !tables.some(target => target.name === r.table))) invalid();
    for (const [offset, data] of t.data.slice(1).entries()) {
      const row = offset + 2, keyColumn = headers.indexOf(t.key) + 1;
      const key = data[keyColumn - 1].trim();
      const options = Object.assign(Object.create(null) as Row["options"], Object.fromEntries(Object.entries(t.fields).map(([field, column]) => [field, data[headers.indexOf(column)]])));
      if (!options.title!.trim() || (options.priority !== undefined && !/^[0-4]$/.test(options.priority.trim())) ||
          (options.estimatedMinutes !== undefined && (!options.estimatedMinutes.trim() || !Number.isFinite(Number(options.estimatedMinutes)) || Number(options.estimatedMinutes) < 0 || Number(options.estimatedMinutes) > 1e9)) ||
          (options.status !== undefined && !statuses.by_id.has(options.status.trim())) ||
          (options.type !== undefined && !types.has(options.type.trim())) ||
          (options.status !== undefined && statuses.terminal_statuses.has(options.status.trim()) && !options.closeReason?.trim())) invalid();
      Object.assign(options, pinCreateDefaults(options, settings));
      if (!key) issues.push({ table: t.name, row, column: keyColumn, code: "empty_key" });
      const entries = t.keys.get(key) ?? [];
      entries.push(rows.length);
      t.keys.set(key, entries);
      rows.push({ table: t.name, row, keyColumn, options, edges: [] });
    }
    for (const entries of t.keys.values()) if (entries.length > 1) for (const i of entries) issues.push({ table: t.name, row: rows[i].row, column: rows[i].keyColumn, code: "duplicate_key" });
  }
  if (rows.length > 1000) invalid();
  let index = 0;
  for (const t of tables) for (const data of t.data.slice(1)) {
    const row = rows[index++];
    for (const ref of t.references) {
      const column = t.data[0].indexOf(ref.column) + 1, key = data[column - 1].trim();
      if (!key) continue;
      const targets = tables.find(t => t.name === ref.table)!.keys.get(key);
      if (targets?.length !== 1) issues.push({ table: t.name, row: row.row, column, code: "unresolved" });
      else row.edges.push({ target: targets[0], kind: ref.kind, column });
    }
  }
  const order: number[] = [], visiting = new Set<number>(), done = new Set<number>();
  /** Topologically order all parent/dependency targets; cyclic imports are refused as a whole. */
  function visit(i: number): void {
    if (done.has(i)) return;
    if (visiting.has(i)) {
      const r = rows[i];
      issues.push({ table: r.table, row: r.row, column: r.keyColumn, code: "cycle" });
      return;
    }
    visiting.add(i);
    for (const edge of rows[i].edges) visit(edge.target);
    visiting.delete(i);
    done.add(i);
    order.push(i);
  }
  rows.forEach((_, i) => visit(i));
  return { rows, issues, order };
}

/** Reject nonfinite, fractional, negative or excessive receipt numbers at the output boundary. */
export function assertJoinNumbers(values: readonly number[]): void {
  if (values.some(n => !Number.isSafeInteger(n) || n < 0 || n > 32000)) invalid();
}

/** Check every emitted numeric field, including coordinates, before returning a receipt. */
function receipt(input: JoinInput, rows: Row[], issues: JoinIssue[], applied = 0, unchanged = 0, skipped = 0): JoinReceipt {
  const result = { ok: issues.length === 0, tables: input.tables.length, rows: rows.length, references: rows.reduce((sum, r) => sum + r.edges.length, 0), applied, unchanged, skipped, issueCount: issues.length, issues: issues.slice(0, 20) };
  assertJoinNumbers([result.tables, result.rows, result.references, applied, unchanged, skipped, result.issueCount, ...result.issues.flatMap(i => [i.row, i.column])]);
  return { ...result, ...(issues.length ? { remedy: "Resolve reported key coordinates or reconcile foreign targets and their dependent rows before previewing a new plan." } : {}) };
}

/** Resolve every selected table in a single read-only preview and mint SDK-owned native identities. */
async function previewJoinsInternal(pmRoot: string, input: JoinInput): Promise<{ receipt: JoinReceipt; plan?: JoinPlan }> {
  const settings = await readSettings(pmRoot);
  const { rows, issues } = await compile(settings, input);
  const result = receipt(input, rows, issues);
  if (!result.ok) return { receipt: result };
  const namespace = await generateItemId(pmRoot, settings.id_prefix, { tokenLength: 12 });
  const ids = rows.map((_, i) => normalizeItemId(`${namespace}-${i}`, settings.id_prefix));
  const base = { version: 1 as const, input, sources: input.tables.map(t => hash(t.csv)), settings: hash(settings), ids, expected: "absent" as const };
  await verifySettings(pmRoot);
  return { receipt: result, plan: { ...base, digest: hash(base) } };
}

/** Native create/tombstone revisions belonging exclusively to this reviewed plan. */
type JoinState = "pending" | "applied" | "foreign" | "compensated" | "rollback_pending";

/** Revalidate exact ownership, complete history and scope while the caller owns the item lease. */
async function inspectLocked(pmRoot: string, id: string, marker: string, row: Row, ids: string[], settings: PmSettings): Promise<JoinState> {
  const types = resolveItemTypeRegistry(settings);
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, types.type_to_folder);
  const history = await readHistoryEntries(getHistoryPath(pmRoot, id), id);
  if (!located && history.length === 0) return "pending";
  if (mutationMessageBase(history[0]?.message) !== marker) return "foreign";
  const changed = (): never => { throw new JoinRefusal("csv_join_target_changed", "An owned target or its SDK history changed. Reconcile current state and the transaction journal before retrying this reviewed plan."); };
  if (history.length > 2 || history.some((entry, index) => entry.op !== (index % 2 ? "delete" : "create") ||
    mutationMessageBase(entry.message) !== (index % 2 ? `${marker}:compensate` : marker))) changed();
  const deleted = history.at(-1)!.op === "delete";
  const empty = emptyImportedDocument();
  if (deleted && !verifyHistoryEntries(history, empty).ok) changed();
  if (!located) {
    if (deleted) return "compensated";
    return changed();
  }
  const { document } = await readLocatedItem(located, { schema: settings.schema });
  if (!verifyHistoryEntries(deleted ? history.slice(0, -1) : history, document).ok) changed();
  const parent = row.edges.find(edge => edge.kind === "parent");
  if (!matchesMutationScope(document, { ...row.options, parent: parent ? ids[parent.target] : undefined }, settings,
    row.edges.filter(edge => edge.kind === "blocked_by").map(edge => ({ id: ids[edge.target], kind: edge.kind })))) changed();
  return deleted ? "rollback_pending" : "applied";
}

/** Inspect current SDK state under its item lease, never a frozen journal receipt. */
async function inspect(pmRoot: string, id: string, marker: string, row: Row, ids: string[]): Promise<JoinState> {
  const settings = await readSettings(pmRoot);
  const release = await acquireLock(pmRoot, id, settings.locks.ttl_seconds, "pm-csv", false, false, settings.locks.wait_ms);
  const started = performance.now();
  try {
    const result = await inspectLocked(pmRoot, id, marker, row, ids, settings);
    assertEditLease(performance.now() - started, settings.locks.ttl_seconds);
    return result;
  } finally { await release(); }
}

/**
 * Compensate only this plan's unchanged create. Native delete dry-run enforces
 * policies/hooks; the subsequent item lease revalidates the exact approved SDK
 * revision. Public SDK store/history/index primitives publish an audited tombstone
 * before removal, allowing recovery of a crash between the two durable writes.
 */
async function compensateCreate(pmRoot: string, plan: JoinPlan, i: number, row: Row, options: JoinApplyOptions): Promise<"foreign" | void> {
  const id = plan.ids[i], marker = `csv-join:${plan.digest}:${i}`;
  return runWithActiveExtensions({ path: pmRoot }, async () => {
    const prior = await inspect(pmRoot, id, marker, row, plan.ids);
    if (prior === "foreign") return "foreign";
    if (prior === "pending" || prior === "compensated") return;
    if (prior === "applied") await withSettingsFence(pmRoot, () => PmClient.forActiveExtensionHost({ pmRoot, author: options.author }).delete(id, { dryRun: true, force: true }));
    await options.onBoundary?.("compensation_validated", id);
    return withSettingsFence(pmRoot, async () => {
    const settings = await readSettings(pmRoot);
    const release = await acquireLock(pmRoot, id, settings.locks.ttl_seconds, options.author, false, false, settings.locks.wait_ms);
    const started = performance.now();
    try {
      await options.onBoundary?.("compensation_locked", id);
      await verifySettings(pmRoot);
      const current = await inspectLocked(pmRoot, id, marker, row, plan.ids, settings);
      if (current === "foreign") return "foreign";
      if (current === "pending" || current === "compensated") return;
      await options.onBoundary?.("compensation_checked", id);
      const types = resolveItemTypeRegistry(settings);
      const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, types.type_to_folder);
      if (!located) throw new JoinRefusal("csv_join_target_changed", "Reconcile a missing compensation target before retrying.");
      const { document } = await readLocatedItem(located, { schema: settings.schema });
      const empty = emptyImportedDocument(), historyPath = getHistoryPath(pmRoot, id);
      await mutateJoinIndex({ id, idPrefix: settings.id_prefix, pmRoot, preferredFormat: settings.item_format, typeToFolder: types.type_to_folder,
        schema: settings.schema, itemPath: located.itemPath, document: null }, async () => {
        assertEditLease(performance.now() - started, settings.locks.ttl_seconds);
        if (current === "applied") await appendHistoryEntry(historyPath, createHistoryEntry({ nowIso: nowIso(), author: options.author,
          op: "delete", before: document, after: empty, message: `${marker}:compensate` }));
        await options.onBoundary?.("compensation_recorded", id);
        assertEditLease(performance.now() - started, settings.locks.ttl_seconds);
        await removeFileIfExists(located.itemPath);
        await options.onBoundary?.("compensation_removed", id);
      });
      for (const [path, op] of [[located.itemPath, "delete"], [historyPath, "delete:history"]]) await runActiveOnWriteHooks({ path, scope: "project", op,
        item_id: id, item_type: document.metadata.type, before: document, after: empty, changed_fields: ["deleted"] });
    } finally { await release(); }
    });
  });
}

/** Apply captured source bytes under SDK journal coordination; retries always revalidate every target revision. */
async function applyJoinsInternal(pmRoot: string, plan: JoinPlan, options: JoinApplyOptions): Promise<JoinReceipt> {
  const settings = await readSettings(pmRoot);
  if (settingsDigest(settings) !== plan.settings) throw settingsChanged();
  assertCanonicalMutationIds(plan.ids, settings.id_prefix, () => new JoinRefusal("csv_join_invalid",
    "Use distinct canonical native IDs from an unchanged preview. Prefix, case or whitespace aliases cannot identify separate rows; preview a fresh plan."));
  const { rows, issues, order } = await compile(settings, plan.input);
  if (rows.length !== plan.ids.length || issues.length) invalid();
  const marker = (i: number): string => `csv-join:${plan.digest}:${i}`;
  const states: JoinState[] = [];
  // A refusal must not leave sibling SDK inspections acquiring/releasing leases.
  for (const [i, id] of plan.ids.entries()) states.push(await inspect(pmRoot, id, marker(i), rows[i], plan.ids));
  const skipped = new Set<number>();
  for (const i of order) {
    const row = rows[i];
    const code = states[i] === "foreign" ? "foreign" : row.edges.some(e => skipped.has(e.target)) ? "dependency_skipped" : undefined;
    if (code) {
      skipped.add(i);
      issues.push({ table: row.table, row: row.row, column: row.keyColumn, code });
    }
  }
  const selected = order.filter(i => !skipped.has(i));
  /** Preserve foreign records and propagate skips at every inspected step boundary. */
  const skip = (i: number, code: "foreign" | "dependency_skipped"): "applied" => {
    if (!skipped.has(i)) {
      skipped.add(i);
      issues.push({ table: rows[i].table, row: rows[i].row, column: rows[i].keyColumn, code });
    }
    return "applied";
  };
  let compensating = false;
  let rollbackSettings: SettingsSnapshot | undefined;
  /** Inspect current target and dependency revisions; a peer's identical success is applied. */
  const state = async (i: number, allowRollback = false): Promise<"pending" | "applied"> => {
    if (skipped.has(i)) return "applied";
    const current = await inspect(pmRoot, plan.ids[i], marker(i), rows[i], plan.ids);
    if (current === "foreign") return skip(i, "foreign");
    for (const e of rows[i].edges) {
      if (skipped.has(e.target) || await inspect(pmRoot, plan.ids[e.target], marker(e.target), rows[e.target], plan.ids) === "foreign") return skip(i, "dependency_skipped");
    }
    return current === "compensated" ? "pending" : current === "rollback_pending" ? allowRollback ? "applied" : "pending" : current;
  };
  let applied = 0;
  const steps: WorkspaceTransactionStep[] = selected.map(i => ({
    id: plan.ids[i],
    inspect: async () => {
      const current = await state(i, compensating);
      await options.onBoundary?.("inspected", plan.ids[i]);
      return { state: current, result: plan.ids[i] };
    },
    apply: () => inSettingsTransaction(pmRoot, async () => {
      const revision = await inspect(pmRoot, plan.ids[i], marker(i), rows[i], plan.ids);
      if (revision === "compensated" || revision === "rollback_pending") throw new JoinRefusal("csv_join_reconcile", "This plan was compensated and its native identities retain tombstone history. Finish journal recovery, then preview fresh identities; never resurrect a compensated plan blindly.");
      if (await state(i) === "applied") return plan.ids[i];
      await options.onBoundary?.("before_dependencies", plan.ids[i]);
      for (const e of rows[i].edges) if (await inspect(pmRoot, plan.ids[e.target], marker(e.target), rows[e.target], plan.ids) !== "applied") {
        throw new JoinRefusal("csv_join_target_changed", "A dependency disappeared during apply. Reconcile current targets and preview a fresh plan.");
      }
      const row = rows[i];
      const parent = row.edges.find(e => e.kind === "parent");
      await options.onBoundary?.("before_create", plan.ids[i]);
      try {
        await withSettingsFence(pmRoot, () => create(buildMutationIntent({ ...row.options, id: plan.ids[i], author: options.author, message: marker(i),
          ...(parent ? { parent: plan.ids[parent.target] } : {}),
          dep: row.edges.filter(e => e.kind === "blocked_by").map(e => `kind=blocked_by,id=${plan.ids[e.target]}`),
        }), { pmRoot }));
        applied++;
      } catch (error) {
        if (settingsChangedIn(error)) throw error;
        if (await state(i) !== "applied") throw error;
      }
      return plan.ids[i];
    }),
    compensate: async () => {
      await options.onBoundary?.("compensating", plan.ids[i]);
      if (await inSettingsTransaction(pmRoot, () => useSettings(pmRoot, rollbackSettings!, () => compensateCreate(pmRoot, plan, i, rows[i], options))) === "foreign") skip(i, "foreign");
    },
  }));
  try {
    if (steps.length) {
      // Resume legacy journals under their existing key; never bypass pending compensation after upgrade.
      const legacy = `csv-join-${hash([plan.digest, selected])}`;
      const journals = await runWorkspaceTransactionGc(pmRoot, { dryRun: true, retentionDays: Infinity });
      const transactionId = journals.entries.some(entry => basename(entry.file) === `${legacy}.json`) ? legacy : joinTransactionId(plan, selected);
      await commitWorkspaceTransaction({ pmRoot, transactionId, author: options.author, steps, onTransition: async context => {
        if (context.transition === "compensating") {
          compensating = true;
          rollbackSettings = await captureSettings(pmRoot, settingsChanged);
        }
        if (context.transition === "prepared") compensating = false;
        await options.onTransition?.(context);
        if (!compensating && context.transition !== "committed") await withSettingsFence(pmRoot, async () => {});
      } });
    }
    // The SDK fast-paths committed journals without calling step inspectors. Never trust that frozen receipt.
    for (const i of selected) if (await state(i) === "pending") {
      throw new JoinRefusal("csv_join_target_changed", "A reviewed target is missing after coordination. Read current SDK state, reconcile the journal and preview a fresh plan.");
    }
  } catch (error) {
    rethrowSettingsChange(error, settingsChanged);
    throw joinRefusal(error, "csv_join_apply_failed", "Inspect the SDK transaction journal and current targets before retrying this reviewed plan. Reverse compensation removes only owned unchanged creates and retains SDK tombstones. Inspect pending or blocked cleanup before retry; changed, foreign or policy-blocked targets require reconciliation.");
  }
  await verifySettings(pmRoot);
  return receipt(plan.input, rows, issues, applied, rows.length - applied - skipped.size, skipped.size);
}

/** Resolve selected sources, exposing only JoinRefusal for malformed CSV, SDK and input failures. */
export async function previewJoins(pmRoot: string, value: unknown): Promise<{ receipt: JoinReceipt; plan?: JoinPlan }> {
  pmRoot = resolve(pmRoot);
  try {
    const input = boundary(value, false) as JoinInput;
    return await withSettings(pmRoot, settingsChanged, () => previewJoinsInternal(pmRoot, input));
  }
  catch (error) { throw joinRefusal(error, "csv_join_invalid", "Check the selected sources and initialized tracker, then preview again."); }
}

/** Apply a saved source/revision plan using the same documented JoinRefusal boundary on every path. */
export async function applyJoins(pmRoot: string, value: unknown, options: JoinApplyOptions): Promise<JoinReceipt> {
  pmRoot = resolve(pmRoot);
  try {
    const plan = boundary(value, true) as JoinPlan, captured = { ...options };
    return await withSettings(pmRoot, settingsChanged, () => applyJoinsInternal(pmRoot, plan, captured));
  }
  catch (error) { throw joinRefusal(error, "csv_join_invalid", "Check the reviewed plan and current SDK state before retrying."); }
}

/** Keep settings drift in the join API's documented refusal family. */
function settingsChanged(): JoinRefusal {
  return new JoinRefusal("csv_join_settings_changed", "Settings or schema changed since review. Reconcile any interrupted cleanup, then preview a fresh plan against current settings.");
}

/** Register compact native TOON/JSON commands; full source-bearing plans require an explicit output artifact. */
export function registerJoinCommands(api: ExtensionApi): void {
  for (const action of ["preview", "apply"] as const) api.registerCommand({
    name: `csv join ${action}`, description: `${action === "preview" ? "Resolve external table keys without mutations" : "Apply a reviewed cross-table create plan using SDK transactions"}.`,
    arguments: [{ name: "file", required: true, description: "Version 1 join input or saved plan JSON; saved native IDs must be canonical and distinct under the tracker prefix" }],
    flags: action === "preview" ? [{ long: "--output", value_name: "file", description: "Exclusively create source-bearing plan JSON; never overwrite" }] : [],
    async run(ctx) {
      let value: unknown;
      try {
        if (statSync(ctx.args[0]).size > 32 * 1024 * 1024) throw new JoinRefusal("csv_join_io", "Provide readable UTF-8 join input or saved plan JSON no larger than 32 MiB.");
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(ctx.args[0])));
      }
      catch (error) { throw joinRefusal(error, "csv_join_io", "Provide readable UTF-8 join input or saved plan JSON no larger than 32 MiB."); }
      if (action === "apply") return { ...await applyJoins(ctx.pm_root, value, { author: (ctx.global["author"] as string | undefined) ?? "pm-csv" }) };
      const result = await previewJoins(ctx.pm_root, value);
      const output = ctx.options["output"] as string | undefined;
      if (output && result.plan) {
        try { writeFileSync(output, `${JSON.stringify(result.plan, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
        catch (error) { throw joinRefusal(error, "csv_join_io", "Choose a new writable plan filename; existing review artifacts are preserved."); }
      }
      return { ...result.receipt, saved: Boolean(output && result.plan) };
    },
  });
}

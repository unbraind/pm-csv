import { explicitDocumentMutation } from "./mutation-intent.ts";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  acquireLock, canonicalDocument, commitWorkspaceTransaction, getHistoryPath, mutateItem,
  readHistoryEntries, verifyHistoryEntries,
} from "@unbrained/pm-cli/sdk";
import type { CommitWorkspaceTransactionOptions, ItemDocument, WorkspaceTransactionStep, PmSettings } from "@unbrained/pm-cli/sdk";
import { captureSettings, inSettingsTransaction, readPinnedSettings as readSettings, rethrowSettingsChange, useSettings, verifySettings, withSettings, withSettingsFence } from "./settings-snapshot.ts";
import type { SettingsSnapshot } from "./settings-snapshot.ts";
import { EditRefusal } from "./edit-refusal.ts";
import type { EditConflict } from "./edit-refusal.ts";
import { assertEditLease, guardEditMutation } from "./lease-guard.ts";
export { EditRefusal } from "./edit-refusal.ts";
export type { EditConflict, EditRefusalCode } from "./edit-refusal.ts";
import { captureUpdateCompensation, compensateUpdate, inspectUpdate, readUpdateDocument } from "./atomic-update.ts";

/** Versioned, deliberately scalar spreadsheet patch surface; status is read-only. */
export const EDIT_FIELDS = ["title", "body", "priority", "assignee", "sprint", "release"] as const;
/** Editable cell names accepted by the session protocol. */
export type EditField = typeof EDIT_FIELDS[number];
/** Baseline for one stable item key. Values are exact spreadsheet strings. */
export interface EditSessionRow {
  id: string;
  revision: string;
  itemDigest: string;
  status: string;
  values: Record<EditField, string>;
  digests: Record<EditField, string>;
}
/** Portable immutable baseline; retain this alongside the edited CSV. */
export interface EditSession {
  version: 1;
  id: string;
  rows: EditSessionRow[];
  digest: string;
}
/** Bounded agent receipt for both dry runs and successful application. */
export interface EditReceipt {
  rows: number;
  changed: number;
  unchanged: number;
  concurrent: number;
  applied: number;
  transaction?: string;
}
/** Hash versioned JSON tuples rather than ambiguous concatenated strings. */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Render supported scalar values exactly as the spreadsheet sees them. */
function cells(document: ItemDocument): Record<EditField, string> {
  return Object.fromEntries(EDIT_FIELDS.map(field => [field, String(field === "body" ? document.body : document.metadata[field] ?? "")])) as Record<EditField, string>;
}

/** Read an item and its verified history while holding its native SDK lock. */
async function snapshot(pmRoot: string, id: string): Promise<EditSessionRow> {
  const settings = await readSettings(pmRoot);
  const release = await acquireLock(pmRoot, id, settings.locks.ttl_seconds, "pm-csv", false, false, settings.locks.wait_ms);
  const startedAt = performance.now();
  let row: EditSessionRow;
  try {
    const document = await readUpdateDocument(pmRoot, id);
    row = await documentRow(pmRoot, id, document);
    assertEditLease(performance.now() - startedAt, settings.locks.ttl_seconds);
  } catch (error) {
    if (error instanceof EditRefusal) throw error;
    const refusal = new EditRefusal("csv_session_invalid", "Verify that every exported item still exists and is readable; export a fresh session after resolving missing items.", [{ id, fields: ["item"] }]);
    refusal.cause = error;
    throw refusal;
  } finally {
    await release();
  }
  return row;
}

/** Bind the full item and history revision to the exported scalar baseline. */
async function documentRow(pmRoot: string, id: string, document: ItemDocument): Promise<EditSessionRow> {
  if (document.metadata.id !== id) {
    throw new EditRefusal("csv_session_invalid", "Use complete canonical item IDs from pm list; abbreviated keys cannot identify an edit session.");
  }
  const history = await readHistoryEntries(getHistoryPath(pmRoot, id), id);
  if (!verifyHistoryEntries(history, document).ok) {
    throw new EditRefusal("csv_session_invalid", "Verify item history with pm health before exporting or applying a session.", [{ id, fields: ["history"] }]);
  }
  const values = cells(document);
  return {
    id, revision: digest(history), itemDigest: digest(document), status: document.metadata.status, values,
    digests: Object.fromEntries(EDIT_FIELDS.map(field => [field, digest([field, values[field]])])) as Record<EditField, string>,
  };
}

/** Fixed schema makes altered/missing/duplicate metadata columns fail closed. */
export function editSessionHeader(): string[] {
  return ["_session", "id", "_revision", "_item_digest", "status", ...EDIT_FIELDS.flatMap(field => [field, `_digest_${field}`])];
}

/** Escape formula triggers and literal apostrophes without changing baseline values. */
function toCell(value: string): string {
  return /^[=+\-@\t\r']/.test(value) ? `'${value}` : value;
}

/** Remove only a recognized display escape before comparison and persistence. */
function fromCell(cell: string): string {
  return cell.startsWith("'") && /^[=+\-@\t\r']/.test(cell.slice(1)) ? cell.slice(1) : cell;
}

/** Export explicit stable keys and digests without creating tracker metadata. */
async function exportEditSessionInternal(pmRoot: string, ids: readonly string[]): Promise<{ session: EditSession; table: string[][] }> {
  if (ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))) {
    throw new EditRefusal("csv_session_invalid", "Export at most 1000 distinct canonical item IDs; split larger selections.");
  }
  const rows: EditSessionRow[] = [];
  for (const id of ids) rows.push(await snapshot(pmRoot, id));
  const base = { version: 1 as const, id: randomUUID(), rows };
  const session = { ...base, digest: digest(base) };
  await verifySettings(pmRoot);
  return { session, table: [editSessionHeader(), ...rows.map(row => [
    session.digest, row.id, row.revision, row.itemDigest, row.status,
    ...EDIT_FIELDS.flatMap(field => [toCell(row.values[field]), row.digests[field]]),
  ])] };
}

/** Export one internally consistent settings/schema view across all selected items. */
export async function exportEditSession(pmRoot: string, ids: readonly string[]): Promise<{ session: EditSession; table: string[][] }> {
  pmRoot = resolve(pmRoot);
  const captured = [...ids];
  return withSettings(pmRoot, settingsChanged, () => exportEditSessionInternal(pmRoot, captured));
}

/** Validate an untrusted sidecar structurally as well as by its content digest. */
export function parseEditSession(input: unknown): EditSession {
  try {
    const session = input as EditSession;
    if (session.version !== 1 || typeof session.id !== "string" || !Array.isArray(session.rows) || session.rows.length > 1000
        || new Set(session.rows.map(row => row.id)).size !== session.rows.length
        || session.digest !== digest({ version: session.version, id: session.id, rows: session.rows })) throw new Error();
    for (const row of session.rows) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(row.id) || typeof row.status !== "string"
          || !/^[a-f0-9]{64}$/.test(row.revision) || !/^[a-f0-9]{64}$/.test(row.itemDigest)
          || EDIT_FIELDS.some(field => !Object.hasOwn(row.values, field) || !Object.hasOwn(row.digests, field) || typeof row.values[field] !== "string" || row.digests[field] !== digest([field, row.values[field]]))) throw new Error();
    }
    return structuredClone(session);
  } catch {
    throw new EditRefusal("csv_session_invalid", "Use the unchanged session JSON from csv checkout; export a fresh session if it was lost or edited.");
  }
}

interface EditPlan {
  base: EditSessionRow;
  desired: Record<EditField, string>;
  fields: EditField[];
}

/** Parse all edited rows before reading or writing tracker state. */
function plans(session: EditSession, table: string[][], schema: PmSettings["schema"]): EditPlan[] {
  const header = table[0];
  if (JSON.stringify(header) !== JSON.stringify(editSessionHeader())) {
    throw new EditRefusal("csv_edit_invalid", "Keep the checkout column names and order, including all digest columns.");
  }
  const byId = new Map(session.rows.map(row => [row.id, row]));
  const seen = new Set<string>();
  return table.slice(1).map(row => {
    const base = byId.get(row[1]);
    if (row.length !== header.length || !base || seen.has(row[1]) || row[0] !== session.digest
        || row[2] !== base.revision || row[3] !== base.itemDigest
        || EDIT_FIELDS.some((field, index) => row[6 + index * 2] !== base.digests[field])) {
      throw new EditRefusal("csv_edit_invalid", "Restore item/revision/field digests and unique IDs from the checkout; never paste rows from another session.");
    }
    seen.add(base.id);
    if (row[4] !== base.status) {
      throw new EditRefusal("csv_edit_invalid", "Status is read-only. Use pm close or pm reopen for lifecycle transitions, then export a fresh session.");
    }
    const desired = Object.fromEntries(EDIT_FIELDS.map((field, index) => [field, fromCell(row[5 + index * 2])])) as Record<EditField, string>;
    // Spreadsheet saves may convert embedded newlines in either direction.
    for (const field of EDIT_FIELDS) {
      if (desired[field].replace(/\r\n/g, "\n") === base.values[field].replace(/\r\n/g, "\n")) desired[field] = base.values[field];
    }
    const fields = EDIT_FIELDS.filter(field => desired[field] !== base.values[field]);
    if (!desired.title.trim() || !/^[0-4]$/.test(desired.priority)
        || fields.some(field => field !== "body" && desired[field] !== desired[field].trim())) {
      throw new EditRefusal("csv_edit_invalid", "Provide a nonblank title, priority 0..4, and trim scalar cells; body follows SDK document canonicalization.");
    }
    // Edits write stored documents, not command options: canonicalize with the
    // same SDK contract as mutateItem (literal "none" remains a stored string).
    const normalized = cells(canonicalDocument({ metadata: {
      id: base.id, title: desired.title, description: "", type: "Task", status: base.status,
      priority: Number(desired.priority) as 0 | 1 | 2 | 3 | 4, tags: [], created_at: "", updated_at: "",
      assignee: desired.assignee, sprint: desired.sprint, release: desired.release,
    }, body: desired.body }, { schema }));
    return { base, desired: normalized, fields: EDIT_FIELDS.filter(field => normalized[field] !== base.values[field]) };
  });
}

/** Detect divergence only in edited fields; equal desired values are convergent. */
function conflicts(plan: EditPlan, current: EditSessionRow): EditField[] {
  return plan.fields.filter(field => current.values[field] !== plan.base.values[field] && current.values[field] !== plan.desired[field]);
}

/** Check and apply a field patch under the host item lease; write-time fencing remains a host prerequisite. */
async function applyPlan(pmRoot: string, plan: EditPlan, marker: string, author: string): Promise<boolean> {
  const settings = await readSettings(pmRoot);
  const result = await withSettingsFence(pmRoot, () => mutateItem({ pmRoot, settings, id: plan.base.id, op: "update", author,
    message: `${marker}:apply`, skipNoop: true,
    mutate: explicitDocumentMutation(guardEditMutation(settings.locks.ttl_seconds, async document => {
      const current = await documentRow(pmRoot, plan.base.id, document);
      const divergent = conflicts(plan, current);
      if (divergent.length) throw new EditRefusal("csv_edit_conflict", "Re-export and reconcile the edited fields; no conflicting value was overwritten.", [{ id: plan.base.id, fields: divergent }]);
      const changedFields: string[] = [];
      for (const field of plan.fields) {
        if (current.values[field] === plan.desired[field]) continue;
        const value = plan.desired[field];
        if (field === "body") document.body = value;
        else if (field === "priority") document.metadata.priority = Number(value) as 0 | 1 | 2 | 3 | 4;
        else if (field === "title") document.metadata.title = value;
        else if (value === "") delete document.metadata[field];
        else document.metadata[field] = value;
        changedFields.push(field);
      }
      return { changedFields };
    })),
  }));
  return result.changedFields.length > 0;
}

/** Collect conflict keys across cause/aggregate graphs, visiting shared or cyclic errors once. */
function findConflicts(error: unknown): EditConflict[] {
  const pending = [error];
  const seen = new Set<Error>();
  const found: EditConflict[] = [];
  for (const current of pending) {
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof EditRefusal) found.push(...current.conflicts);
    pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return found;
}

/**
 * Three-way patch using stable item keys, field-level conflict checks and the existing SDK
 * transaction/CSV compensation. Preflight refusals create no transaction or
 * item/history writes. Field checks run under each native item lease; protection
 * after lease expiry needs host write fencing. Prior rows are compensated on
 * ordinary failure, which explicitly requires reconciliation.
 */
async function applyEditSessionInternal(
  pmRoot: string, session: EditSession, table: string[][], options: { author: string; dryRun?: boolean; onTransition?: CommitWorkspaceTransactionOptions["onTransition"] },
): Promise<EditReceipt> {
  const planned = plans(session, table, (await readSettings(pmRoot)).schema);
  const transaction = `csv-edit-${digest([session.digest, table])}`;
  const edited = planned.filter(plan => plan.fields.length > 0);
  const found: EditConflict[] = [];
  let concurrent = 0;
  let pending = 0;
  for (const plan of planned) {
    const current = await snapshot(pmRoot, plan.base.id);
    if (current.revision !== plan.base.revision || current.itemDigest !== plan.base.itemDigest) concurrent++;
    const divergent = conflicts(plan, current);
    const editIndex = edited.indexOf(plan);
    if (editIndex >= 0 && (await inspectUpdate(pmRoot, plan.base.id, `csv-txrow:${transaction}#${editIndex}`, false)).state === "applied") {
      for (const field of plan.fields) if (current.values[field] !== plan.desired[field] && !divergent.includes(field)) divergent.push(field);
    }
    if (divergent.length) found.push({ id: plan.base.id, fields: divergent });
    if (plan.fields.some(field => current.values[field] !== plan.desired[field])) pending++;
  }
  if (found.length) throw new EditRefusal("csv_edit_conflict", "Export a fresh session and reconcile the reported fields before applying; this preflight wrote zero items.", found);
  const receipt: EditReceipt = { rows: planned.length, changed: pending, unchanged: planned.length - pending, concurrent, applied: 0 };
  if (options.dryRun || !pending) { await verifySettings(pmRoot); return receipt; }
  // Bind the journal to the exact selected rows and edits, independent of file path.
  let applied = 0;
  let compensating = false;
  let rollback: SettingsSnapshot | undefined;
  const steps: WorkspaceTransactionStep[] = edited.map((plan, index) => {
    const marker = `csv-txrow:${transaction}#${index}`;
    return {
      id: `${index}-${plan.base.id}`,
      inspect: () => inspectUpdate(pmRoot, plan.base.id, marker, false),
      prepareCompensation: () => inSettingsTransaction(pmRoot, () => withSettingsFence(pmRoot, () => captureUpdateCompensation(pmRoot, plan.base.id, marker, options.author))),
      apply: () => inSettingsTransaction(pmRoot, async () => {
        if (await applyPlan(pmRoot, plan, marker, options.author)) applied++;
        return plan.base.id;
      }),
      compensate: data => inSettingsTransaction(pmRoot, () => useSettings(pmRoot, rollback!, () => withSettingsFence(pmRoot, () => compensateUpdate(pmRoot, plan.base.id, marker, options.author, data)))),
    };
  });
  try {
    await commitWorkspaceTransaction({ pmRoot, transactionId: transaction, author: options.author, steps, onTransition: async event => {
      if (event.transition === "compensating") { compensating = true; rollback = await captureSettings(pmRoot, settingsChanged); }
      if (event.transition === "prepared") compensating = false;
      await options.onTransition?.(event);
      if (!compensating && event.transition !== "committed") await withSettingsFence(pmRoot, async () => {});
    } });
  } catch (error) {
    rethrowSettingsChange(error, settingsChanged);
    const refusal = new EditRefusal("csv_edit_apply_failed", `Inspect and reconcile transaction ${transaction} before retrying. Item fields were checked before persistence; the host must keep its item lease valid through the write. Reverse compensation was attempted and may have refused a concurrent writer.`, findConflicts(error));
    refusal.cause = error;
    throw refusal;
  }
  await verifySettings(pmRoot);
  return { ...receipt, applied, transaction };
}

/** Bind each edit attempt, including comparisons and compensation, to stable settings. */
export async function applyEditSession(
  pmRoot: string, input: unknown, table: string[][], options: { author: string; dryRun?: boolean; onTransition?: CommitWorkspaceTransactionOptions["onTransition"] },
): Promise<EditReceipt> {
  pmRoot = resolve(pmRoot);
  if (!Array.isArray(table) || Array.from(table).some(row => !Array.isArray(row) || Array.from(row).some(cell => typeof cell !== "string"))) {
    throw new EditRefusal("csv_edit_invalid", "Provide a table of CSV string cells, including the checkout header.");
  }
  const session = parseEditSession(input), captured = table.map(row => [...row]), configuration = { ...options };
  return withSettings(pmRoot, settingsChanged, () => applyEditSessionInternal(pmRoot, session, captured, configuration));
}

/** Preserve the edit API refusal taxonomy for changing schema/settings. */
function settingsChanged(): EditRefusal {
  return new EditRefusal("csv_edit_settings_changed", "Settings changed during the edit attempt. Inspect pending compensation and export a fresh session before retrying.");
}

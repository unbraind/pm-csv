import {
  acquireLock, appendHistoryEntry, createHistoryEntry, getHistoryPath, nowIso, parseItemDocument, splitFrontMatter, writeFileAtomic, locateItem, mutateItem, readHistoryEntries,
  readLocatedItem, readSettings, resolveItemTypeRegistry, verifyHistoryEntries,
} from "@unbrained/pm-cli/sdk";
import type { ItemDocument, WorkspaceTransactionStepInspection, WorkspaceTransactionJsonValue } from "@unbrained/pm-cli/sdk";
import { decode, encode } from "@toon-format/toon";
import { createHash } from "node:crypto";

/** Version of CSV prior-document compensation; also bound into every step id. */
export const UPDATE_COMPENSATION_VERSION = 2;

/** Read authoritative item state, including absent fields and every collection. */
export async function readUpdateSnapshot(pmRoot: string, id: string) {
  const settings = await readSettings(pmRoot);
  const registry = resolveItemTypeRegistry(settings);
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, registry.type_to_folder);
  if (!located) throw new Error(`Atomic update item ${id} is missing; reconcile before retrying.`);
  return { ...(await readLocatedItem(located, { schema: settings.schema })), located };
}

/** Read canonical field values without discarding the stored snapshot API. */
export async function readUpdateDocument(pmRoot: string, id: string): Promise<ItemDocument> {
  return (await readUpdateSnapshot(pmRoot, id)).document;
}

/**
 * Inspect update ownership in immutable history as well as legacy row tags.
 * A terminal row interrupted between update and close refuses forward replay;
 * the coordinator then compensates using the already saved original values.
 * Completed restores stay pending even when an older scan still saw tags.
 */
export async function inspectUpdate(
  pmRoot: string, id: string, marker: string, terminal: boolean,
): Promise<WorkspaceTransactionStepInspection> {
  const document = await readUpdateDocument(pmRoot, id);
  const history = await readHistoryEntries(getHistoryPath(pmRoot, id), id);
  const lastOwn = [...history].reverse().find(entry => entry.message === `${marker}:apply`
    || entry.message === `${marker}:close` || entry.message === `${marker}:restore` || entry.message === `${marker}:compensate`);
  if (lastOwn?.message === `${marker}:compensate`) return { state: "pending" };
  const applied = Boolean(lastOwn) || Boolean(document.metadata.tags?.includes(marker));
  if (applied && terminal && lastOwn?.message === `${marker}:apply`
      && document.metadata.status !== "closed" && document.metadata.status !== "canceled") {
    throw new Error(`Atomic update item ${id} has an incomplete terminal transition; compensation required.`);
  }
  return applied ? { state: "applied", result: id } : { state: "pending" };
}

/** Hash journal-safe data for immutable history-boundary comparison. */
function journalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Capture the entire prior document and its verified history boundary under the
 * item lock. The coordinator persists this versioned data before apply starts.
 * A full document includes lifecycle side effects and dependency collections,
 * and JSON preserves absent properties separately from empty strings/lists.
 */
export async function captureUpdateCompensation(
  pmRoot: string, id: string, marker: string, author: string,
): Promise<WorkspaceTransactionJsonValue> {
  const settings = await readSettings(pmRoot);
  const release = await acquireLock(pmRoot, id, settings.locks.ttl_seconds, author, false, false, settings.locks.wait_ms);
  try {
    const { document, raw, located } = await readUpdateSnapshot(pmRoot, id);
    const history = await readHistoryEntries(getHistoryPath(pmRoot, id), id);
    if (!verifyHistoryEntries(history, document).ok) {
      throw new Error(`Atomic update item ${id} has unverified history; reconcile before retrying.`);
    }
    return {
      version: UPDATE_COMPENSATION_VERSION, id, marker,
      prior: JSON.stringify(document), raw, format: located.item_format, historyLength: history.length, historyHash: journalHash(history),
    };
  } finally {
    await release();
  }
}

/** Durable compensation boundaries available to diagnostics and crash tests. */
export type CompensationPhase = "canonical_restored" | "representation_written" | "compensation_recorded";

/**
 * Restore the captured document through an append-only SDK mutation. History
 * verification and writer detection occur INSIDE the item lock, so another
 * agent cannot write between the guard and restoration. Refuse any intervening
 * history outside this batch, including edits to unrelated fields. A durable
 * compensation message makes a crash after restoration safe to replay.
 */
export async function compensateUpdate(
  pmRoot: string, id: string, marker: string, author: string,
  data: WorkspaceTransactionJsonValue | undefined,
  onPhase: (phase: CompensationPhase) => void | Promise<void> = () => {},
): Promise<void> {
  if (!data || typeof data !== "object" || Array.isArray(data)
      || data.version !== UPDATE_COMPENSATION_VERSION || data.id !== id || data.marker !== marker
      || typeof data.raw !== "string" || !["toon", "json_markdown"].includes(String(data.format))
      || typeof data.prior !== "string" || typeof data.historyLength !== "number" || typeof data.historyHash !== "string") {
    throw new Error(`Atomic update item ${id} has missing or incompatible prior values; reconcile before retrying.`);
  }
  const prior = JSON.parse(data.prior) as ItemDocument;
  const historyLength = data.historyLength;
  const historyHash = data.historyHash;
  const batchPrefix = `${marker.slice(0, marker.lastIndexOf("#"))}#`;
  const compensationMessage = `${marker}:compensate`;
  const restoreMessage = `${marker}:restore`;
  let completed = false;
  const settings = await readSettings(pmRoot);
  await mutateItem({
    pmRoot, settings, id, op: "restore", author, message: restoreMessage,
    skipNoop: true,
    async mutate(document) {
      const history = await readHistoryEntries(getHistoryPath(pmRoot, id), id);
      if (!verifyHistoryEntries(history, document).ok
          || journalHash(history.slice(0, historyLength)) !== historyHash
          || !verifyHistoryEntries(history.slice(0, historyLength), prior).ok) {
        throw new Error(`Atomic update item ${id} has changed history or state; refusing compensation.`);
      }
      const subsequent = history.slice(historyLength);
      if (subsequent.some(entry => entry.message === compensationMessage)) {
        completed = true;
        return { changedFields: [] };
      }
      // Reverse-order restores of later rows in this same batch are safe. Any
      // other author's mutation remains a conflict, even if its value is equal.
      if (subsequent.some(entry => !entry.message?.startsWith(batchPrefix)
          || !/^\d+:(apply|close|restore|compensate)$/.test(entry.message.slice(batchPrefix.length)))) {
        throw new Error(`Atomic update item ${id} has a concurrent writer; refusing compensation.`);
      }
      if (subsequent.some(entry => entry.message === restoreMessage)) return { changedFields: [] };
      const changedFields = [...new Set([...Object.keys(document.metadata), ...Object.keys(prior.metadata), "body"])];
      document.metadata = structuredClone(prior.metadata);
      document.body = prior.body;
      return { changedFields };
    },
  });
  if (completed) return;
  await onPhase("canonical_restored");
  // The SDK canonicalizes empty metadata to absent values. Preserve the raw
  // prior representation in a second, guarded, resumable phase. It has exactly
  // the same canonical hash as the SDK restore, so the derived index is valid.
  const release = await acquireLock(pmRoot, id, settings.locks.ttl_seconds, author, false, false, settings.locks.wait_ms);
  try {
    const current = await readUpdateSnapshot(pmRoot, id);
    const history = await readHistoryEntries(getHistoryPath(pmRoot, id), id);
    const contents = priorRepresentation(data.raw, data.format as "toon" | "json_markdown", current.document.metadata.updated_at);
    const represented = parseItemDocument(contents, { format: "toon", schema: settings.schema });
    if (history.at(-1)?.message !== restoreMessage || !verifyHistoryEntries(history, current.document).ok
        || !verifyHistoryEntries(history, represented).ok) {
      throw new Error(`Atomic update item ${id} changed during representation restoration; refusing compensation.`);
    }
    await writeFileAtomic(current.located.itemPath, contents);
    await onPhase("representation_written");
    await appendHistoryEntry(getHistoryPath(pmRoot, id), createHistoryEntry({
      nowIso: nowIso(), author, op: "restore", before: current.document, after: represented, message: compensationMessage,
    }));
    await onPhase("compensation_recorded");
  } finally {
    await release();
  }
}

/**
 * Re-encode original physical fields without canonicalizing empty values. Only
 * the audited mutation timestamp changes. JSON Markdown inputs migrate to the
 * SDK's normal TOON output, preserving metadata values and body content.
 */
export function priorRepresentation(raw: string, format: "toon" | "json_markdown", updatedAt: string): string {
  let record: Record<string, unknown>;
  if (format === "toon") {
    record = decode(raw) as Record<string, unknown>;
  } else {
    const { frontMatter, body } = splitFrontMatter(raw);
    record = { ...JSON.parse(frontMatter) as Record<string, unknown>, body };
  }
  const metadata = Object.hasOwn(record, "front_matter") ? record.front_matter as Record<string, unknown> : record;
  metadata.updated_at = updatedAt;
  return `${encode(record)}\n`;
}

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { acquireLock, readSettings, normalizeStatusInput, resolveItemTypeRegistry, resolveRuntimeStatusRegistry, PmCliError } from "@unbrained/pm-cli/sdk";
import type { PmSettings, create } from "@unbrained/pm-cli/sdk";
import { assertEditLease } from "./lease-guard.ts";

/** One operation's schema/defaults, independent of subsequent SDK settings reads. */
export interface SettingsSnapshot {
  settings: PmSettings;
  digest: string;
  refuse: () => Error;
}
/** Async-local stack keeps nested tracker scopes and lease ownership separate. */
interface Scope { root: string; snapshot: SettingsSnapshot; locked: boolean; coordinated?: boolean; parent?: Scope }
const scopes = new AsyncLocalStorage<Scope>();

/** Match the reviewed settings digest, including hydrated schema and type definitions. */
export function settingsDigest(settings: PmSettings): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}
/** Find only the current tracker's async scope; unrelated trackers retain their own settings. */
function scope(pmRoot: string): Scope | undefined {
  for (let current = scopes.getStore(); current; current = current.parent) if (current.root === resolve(pmRoot)) return current;
}
/** Capture the native settings view once, retaining a public API's refusal family. */
export async function captureSettings(pmRoot: string, refuse: () => Error): Promise<SettingsSnapshot> {
  const settings = structuredClone(await readSettings(pmRoot));
  return { settings, digest: settingsDigest(settings), refuse };
}
/** Scope one snapshot without replacing parent scopes or leaking into concurrent operations. */
export function useSettings<T>(pmRoot: string, snapshot: SettingsSnapshot, run: () => Promise<T>): Promise<T> {
  const inherited = scope(pmRoot);
  return scopes.run({ root: resolve(pmRoot), snapshot, locked: inherited?.locked ?? false, coordinated: inherited?.coordinated, parent: scopes.getStore() }, run);
}
/** Use only inside an SDK transaction step, whose writer lease already owns the batch. */
export function inSettingsTransaction<T>(pmRoot: string, run: () => Promise<T>): Promise<T> {
  const current = scope(pmRoot)!;
  return scopes.run({ ...current, coordinated: true, parent: scopes.getStore() }, run);
}
/** Read pinned settings inside a reviewed operation, using the SDK normally elsewhere. */
export async function readPinnedSettings(pmRoot: string): Promise<PmSettings> {
  return scope(pmRoot)?.snapshot.settings ?? readSettings(pmRoot);
}
/** Normalize a status using an active operation's native registry, without reading ambient defaults. */
export function normalizePinnedStatus(value: string): string | undefined {
  const current = scopes.getStore();
  return current ? normalizeStatusInput(value, resolveRuntimeStatusRegistry(current.snapshot.settings.schema)) : undefined;
}
/** Revalidate live state solely as a guard; never use it to resolve forward values. */
export async function verifySettings(pmRoot: string): Promise<void> {
  const current = scope(pmRoot);
  if (current && settingsDigest(await readSettings(pmRoot)) !== current.snapshot.digest) throw current.snapshot.refuse();
}
/** Preserve typed settings refusals even when the SDK aggregates cleanup failures. */
export function settingsChangedIn(error: unknown): boolean {
  const pending = [error], seen = new Set<Error>();
  for (const current of pending) {
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    if (Object.hasOwn(current, "code")) {
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === "string" && code.endsWith("settings_changed")) return true;
    }
    pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}
/** Preserve an API's own refusal family while retaining nested SDK failure evidence. */
export function rethrowSettingsChange(error: unknown, refuse: () => Error): void {
  if (settingsChangedIn(error)) { const refusal = refuse(); refusal.cause = error; throw refusal; }
}
/** Capture one view for a public operation, reusing an enclosing same-tracker snapshot. */
export async function withSettings<T>(pmRoot: string, refuse: () => Error, run: () => Promise<T>): Promise<T> {
  const current = scope(pmRoot);
  if (current) return useSettings(pmRoot, { ...current.snapshot, refuse }, async () => { await verifySettings(pmRoot); return run(); });
  return useSettings(pmRoot, await captureSettings(pmRoot, refuse), run);
}
/**
 * Check a batch inside its existing SDK transaction writer lease. Standalone
 * batches acquire the SDK singleton settings/schema writer lease. Transactional
 * batches keep their coordinator's crash-recovery lifetime, without an auxiliary
 * longer-lived lock. Values remain pinned; SDK policy and persistence stay native.
 */
export async function withSettingsFence<T>(pmRoot: string, run: () => Promise<T>): Promise<T> {
  const current = scope(pmRoot);
  if (!current) return withSettings(pmRoot, () => new PmCliError("csv_settings_changed: Review current settings before retrying.", 2, { code: "csv_settings_changed" }), () => withSettingsFence(pmRoot, run));
  if (current.coordinated) {
    await verifySettings(pmRoot);
    const result = await run();
    await verifySettings(pmRoot);
    return result;
  }
  if (current.locked) { await verifySettings(pmRoot); return run(); }
  const settings = current.snapshot.settings;
  const release = await acquireLock(pmRoot, "workspace-history", settings.locks.ttl_seconds, "pm-csv", false, false, settings.locks.wait_ms);
  const started = performance.now();
  try {
    return await scopes.run({ ...current, locked: true, parent: scopes.getStore() }, async () => {
      await verifySettings(pmRoot);
      const result = await run();
      assertEditLease(performance.now() - started, settings.locks.ttl_seconds);
      await verifySettings(pmRoot);
      return result;
    });
  } finally { await release(); }
}

/** Resolve create type/status defaults using only the snapshot's native registries. */
export function pinCreateDefaults(options: NonNullable<Parameters<typeof create>[0]>, settings: PmSettings): NonNullable<Parameters<typeof create>[0]> {
  const registry = resolveItemTypeRegistry(settings);
  const aliases = new Map(Object.entries(registry.alias_to_type));
  const types = new Map(Object.entries(registry.by_type));
  const configured = settings.governance.create_default_type;
  const type = options.type ?? (configured && aliases.has(configured.trim().toLowerCase()) ? configured : "Task");
  const definition = types.get(aliases.get(type.trim().toLowerCase()) ?? "");
  const statuses = resolveRuntimeStatusRegistry(settings.schema);
  const status = options.status ?? (definition?.default_status === undefined ? undefined : normalizeStatusInput(definition.default_status, statuses)) ?? statuses.open_status;
  return { ...options, type, status };
}

import type { mutateItem } from "@unbrained/pm-cli/sdk";
import { EditRefusal } from "./edit-refusal.ts";

/** Native SDK callback contract, including its optional warning receipt. */
type ItemMutation = Parameters<typeof mutateItem>[0]["mutate"];

/**
 * Refuse an exhausted callback/read budget before releasing control to the host.
 * Reserve ten percent of the effective TTL, capped at one second, for SDK work
 * after callback return. This deadline is not atomic persistence fencing;
 * arbitrary host delays after this check still require pm-cli issue 1549.
 */
export function assertEditLease(elapsedMs: number, ttlSeconds: number): void {
  const ttlMs = ttlSeconds * 1000;
  const marginMs = Math.min(1000, ttlMs / 10);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || elapsedMs >= ttlMs - marginMs) {
    throw new EditRefusal("csv_lease_expired", "Re-run apply; another writer may have changed the item.");
  }
}

/** Measure every native mutation callback, including no-op compensation returns. */
export function guardEditMutation(ttlSeconds: number, mutate: ItemMutation): ItemMutation {
  return async document => {
    const startedAt = performance.now();
    const effectiveTtlSeconds = ttlSeconds;
    const result = await mutate(document);
    assertEditLease(performance.now() - startedAt, effectiveTtlSeconds);
    return result;
  };
}

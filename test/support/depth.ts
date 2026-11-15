/**
 * Keep full local/release depth by default; quick runs the same deterministic
 * seed prefix at one tenth depth, with at least 25 cases (capped by full count).
 * Callers keep seed generation and per-case assertions identical in both modes.
 */
export function testDepth(full: number): number {
  return process.env.PM_TEST_DEPTH === "quick" ? Math.min(full, Math.max(25, Math.ceil(full / 10))) : full;
}

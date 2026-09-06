import { rmSync } from "node:fs";

/**
 * Removes a directory tree with bounded retries for transient teardown faults.
 *
 * `spawnSync` waits for its direct child, but a proxy child can leave its own
 * writer behind when terminated. The test wrapper therefore captures output
 * until its real writer exits, before exposing bytes to the outer buffer cap.
 * This remover does not establish process termination. A plain
 * `rmSync(root, { recursive: true, force: true })` walks the tree and then
 * `rmdir`s each directory; when the dying child creates a new entry between the
 * walk and the `rmdir`, the removal fails with `ENOTEMPTY`. `force: true` does
 * not cover that — it suppresses `ENOENT` (already gone), not `ENOTEMPTY`
 * (something reappeared).
 *
 * Retrying can accommodate a transient filesystem failure on a loaded runner,
 * but callers must establish writer completion before starting teardown.
 *
 * A retry budget is deliberate: exhausting it rethrows rather than swallowing
 * the error, so a tree held open by something that never exits is reported as
 * the leak it is instead of silently accumulating under the temp directory.
 *
 * @param root - Absolute path of the tree to remove.
 * @param remove - Removal primitive, injected so a test can drive the retry
 *   loop deterministically instead of racing a real process. Defaults to a
 *   recursive, forced `rmSync`.
 * @param attempts - Maximum number of removal attempts, at least one.
 * @param waitMs - Milliseconds to block between attempts, giving the operating
 *   system time to reap the writer. Blocking is correct here: the caller is a
 *   synchronous test teardown, and yielding to the event loop would let another
 *   test start against a tree that still exists.
 * @throws The final removal error when every attempt fails.
 */
export function removeTreeResiliently(
  root: string,
  remove: (target: string) => void = (target) =>
    rmSync(target, { recursive: true, force: true }),
  attempts = 20,
  waitMs = 25,
): void {
  for (let attempt = 1; ; attempt++) {
    try {
      remove(root);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      // Atomics.wait on a private buffer is the only true synchronous sleep in
      // Node: no timer fires, no other test observes a half-removed tree.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

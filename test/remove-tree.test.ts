import assert from "node:assert/strict";
import test from "node:test";

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTreeResiliently } from "./support/remove-tree.ts";

// ---------------------------------------------------------------------------
// The retry loop is driven through the injected remover rather than by racing a
// real dying child. Racing one would make THIS test the flake it exists to fix:
// the observation "a plain rmSync throws ENOTEMPTY" is exactly the timing-
// dependent event that cannot be asserted reliably. Injecting the primitive
// makes every branch — first-attempt success, success after retries, and an
// exhausted budget — deterministic and instant.
// ---------------------------------------------------------------------------

/** An ENOTEMPTY exactly as `rmSync` raises it when an entry reappears mid-walk. */
function enotempty(target: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `ENOTEMPTY: directory not empty, rmdir '${target}'`,
  );
  error.code = "ENOTEMPTY";
  error.errno = -39;
  error.syscall = "rmdir";
  error.path = target;
  return error;
}

test("a tree that removes cleanly is removed on the first attempt", () => {
  const calls: string[] = [];
  removeTreeResiliently("/tmp/example", (target) => {
    calls.push(target);
  });
  assert.deepEqual(calls, ["/tmp/example"], "no retry is attempted when the first removal succeeds");
});

test("a removal that keeps failing with ENOTEMPTY is retried until it wins", () => {
  let attempts = 0;
  // Fails twice, as a dying writer would, then succeeds once it is reaped.
  removeTreeResiliently(
    "/tmp/example",
    (target) => {
      attempts++;
      if (attempts < 3) throw enotempty(target);
    },
    5,
    0,
  );
  assert.equal(attempts, 3, "the removal is retried until the writer is gone");
});

test("a tree still held after the whole budget rethrows rather than leaking silently", () => {
  let attempts = 0;
  assert.throws(
    () =>
      removeTreeResiliently(
        "/tmp/example",
        (target) => {
          attempts++;
          throw enotempty(target);
        },
        4,
        0,
      ),
    /ENOTEMPTY/,
    "an exhausted budget surfaces the real error instead of swallowing it",
  );
  assert.equal(attempts, 4, "the budget is spent exactly, never exceeded");
});

test("the default remover really deletes a populated tree from disk", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-csv-remove-tree-"));
  mkdirSync(join(root, "nested", "deeper"), { recursive: true });
  writeFileSync(join(root, "nested", "deeper", "leaf.txt"), "content");
  removeTreeResiliently(root);
  assert.equal(existsSync(root), false, "the default primitive removes the tree recursively");
});

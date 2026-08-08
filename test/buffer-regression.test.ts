import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { loadAppliedByTransaction, itemStatus } from "../index.ts";

// ---------------------------------------------------------------------------
// Regression tests for the silent pm-shellout buffer-overrun defect.
//
// `spawnSync` captures stdout up to `maxBuffer` (Node's default is 1 MiB). When
// a pm command emits more than that, the child is killed mid-capture and the
// result has `status: null`, an EMPTY `stderr`, and truncated `stdout`. Code
// that branches on `status !== 0` then reads `null !== 0` as truthy and routes
// the overrun onto its failure branch — turning a buffer overflow into a WRONG
// ANSWER ("item does not exist", "nothing applied yet") instead of an error.
//
// The fix is tier-2 at every pm subprocess site: cap stdout at
// `pmListMaxBuffer()` (16 MiB by default) and route a `status: null` overrun
// through `assertPmOutputFit` as a hard, named error, never as an empty or
// absent result. (A truly ceiling-free in-process SDK read is not used here: a
// static `@unbrained/pm-cli` value import regresses this package's documented
// standalone-loadability — `dist/` must load with only its own files — and the
// host-injected `ctx.sdk.client.list` carries its own read-output budget.)
//
// Every test below is mutation-tested: reverting its fix makes it fail.
// ---------------------------------------------------------------------------

/**
 * Create a fresh isolated pm tracker root and return its path.
 *
 * Mirrors the harness in `atomic.test.ts`: a real `pm init` in a temp dir so
 * the reads exercised here hit the same on-disk store the production command
 * does, never the repo's own `.agents`.
 */
function freshTracker(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-csv-buf-"));
  const r = spawnSync("pm", ["init", "--defaults", "--path", root], { encoding: "utf-8" });
  if (r.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`pm init failed: ${r.stderr || r.stdout}`);
  }
  return root;
}

/**
 * Create one item in `pmRoot`, returning its id.
 *
 * `tags` are stamped verbatim so the test can plant the importer's internal
 * `csv-tx:`/`csv-txrow:` ownership markers exactly as a prior interrupted run
 * would have. These creates are tiny, so they use Node's default 1 MiB capture
 * and are unaffected by the `PM_LIST_MAX_BUFFER` cap applied only around a read.
 */
function createItem(pmRoot: string, title: string, tags: readonly string[] = []): string {
  const args = ["--path", pmRoot, "create", "--title", title, "--status", "open", "--json"];
  if (tags.length > 0) args.push("--tags", tags.join(","));
  const r = spawnSync("pm", args, { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`pm create (${title}) failed: ${r.stderr || r.stdout}`);
  const id = JSON.parse(r.stdout).id;
  if (typeof id !== "string" || !id) throw new Error(`pm create (${title}) returned no id`);
  return id;
}

/**
 * Run `body` with `PM_LIST_MAX_BUFFER` temporarily set to `cap`, restoring the
 * prior value (including "unset") on exit.
 *
 * The cap simulates a stdout ceiling far tighter than a realistic tracker, so a
 * handful of items is enough to overrun it — the same overrun a large project
 * hits against Node's 1 MiB default, without committing a multi-megabyte fixture
 * or creating tens of thousands of items.
 */
function withCappedReadBuffer<T>(cap: string, body: () => T): T {
  const prev = process.env.PM_LIST_MAX_BUFFER;
  process.env.PM_LIST_MAX_BUFFER = cap;
  try {
    return body();
  } finally {
    if (prev === undefined) delete process.env.PM_LIST_MAX_BUFFER;
    else process.env.PM_LIST_MAX_BUFFER = prev;
  }
}

// The transaction id and per-row ownership markers the atomic importer stamps.
// Kept literal (rather than derived from a file path) so the assertion is
// independent of `atomicTransactionId`'s derivation.
const TX_ID = "csv-import-buftest00";
const batchTag = `csv-tx:${TX_ID}`;
const rowTag = (i: number) => `csv-txrow:${TX_ID}#${i}`;

test("itemStatus returns the real status for an item whose `pm get` output exceeds Node's 1 MiB default", () => {
  // THE regression: itemStatus had NO maxBuffer, so it sat on Node's 1 MiB
  // default. An item whose `pm get --json` exceeds 1 MiB (a large body) left
  // `status: null`, which `status !== 0` mapped onto `undefined` — i.e. a real,
  // existing item was silently reported as "does not exist", and the
  // compensation guard then skipped a close it should have run. The body is
  // loaded from a file (--body-file) so it is never constrained by ARG_MAX.
  const root = freshTracker();
  const bodyFile = join(root, "big-body.md");
  // ~2 MiB: comfortably past the old 1 MiB ceiling, well under the 16 MiB cap.
  writeFileSync(bodyFile, "x".repeat(2 * 1024 * 1024));
  try {
    const r = spawnSync(
      "pm",
      ["--path", root, "create", "--title", "Oversized item", "--status", "open", "--body-file", bodyFile, "--json"],
      { encoding: "utf-8" },
    );
    assert.equal(r.status, 0, `setup create failed: ${r.stderr}`);
    const id = JSON.parse(r.stdout).id;

    // Default (uncapped) buffer: the raised 16 MiB cap accommodates the 2 MiB
    // body, so the real status comes back instead of a silent `undefined`.
    const status = itemStatus(root, id);
    assert.equal(status, "open", "the real status comes back past the old 1 MiB ceiling, not undefined");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("itemStatus surfaces a buffer overrun as a named error, never a silent 'item missing'", () => {
  const root = freshTracker();
  // A minimal item's `pm get --json` is ~850 B, so a 128-byte cap overruns it.
  const id = createItem(root, "Item whose get output overruns the cap");
  try {
    // Under a 128-byte cap the tier-2 read overruns and must throw a named
    // error — NOT return undefined, which the compensation guard reads as
    // "item does not exist". This is the contract the oversized-body test
    // above relies on at the other end of the scale.
    withCappedReadBuffer("128", () => {
      assert.throws(
        () => itemStatus(root, id),
        /status null|overran the 128-byte read buffer/i,
        "a stdout overrun must surface as a named error, not as undefined (silent 'item missing')",
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("itemStatus still returns undefined for a genuinely absent item (non-zero exit, not a buffer condition)", () => {
  // A non-zero `pm get` exit means the item is genuinely absent or unreadable —
  // that must still map to `undefined`, never to the buffer-overrun error. This
  // is the path the `fake-get-fail` compensation regression in atomic.test.ts
  // relies on, and it must be preserved now that a null status is treated
  // specially.
  const root = freshTracker();
  try {
    const status = itemStatus(root, "pm-doesnotexist0000");
    assert.equal(status, undefined, "a genuinely absent item is undefined, not a thrown error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAppliedByTransaction surfaces a buffer overrun as a named error, never a silent 'nothing applied'", () => {
  const root = freshTracker();
  try {
    // Two rows already applied (stamped with this transaction's per-row markers)
    // plus padding so list-all --json overruns the 128-byte cap below.
    createItem(root, "Applied Row 0", [batchTag, rowTag(0)]);
    createItem(root, "Applied Row 1", [batchTag, rowTag(1)]);
    createItem(root, "Padding one");
    createItem(root, "Padding two");

    // OLD behavior: the overrun left `status: null`, the guard returned an EMPTY
    // map, and a resumed atomic import silently re-imported every already-applied
    // row. The tier-2 fix routes the overrun through assertPmOutputFit as a hard,
    // named error instead.
    withCappedReadBuffer("128", () => {
      assert.throws(
        () => loadAppliedByTransaction(root, TX_ID),
        /status null|overran the 128-byte read buffer/i,
        "a stdout overrun must surface as a named error, not as a silent empty 'applied' map",
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAppliedByTransaction returns the real applied rows under the default (uncapped) buffer", () => {
  // Sanity guard for the non-overrun path: with no PM_LIST_MAX_BUFFER override
  // the resume scan returns the real applied rows. This is the path production
  // takes, and it must keep working now that overruns throw.
  const root = freshTracker();
  try {
    createItem(root, "Applied Row 0", [batchTag, rowTag(0)]);
    createItem(root, "Applied Row 1", [batchTag, rowTag(1)]);

    const { byRowIndex } = loadAppliedByTransaction(root, TX_ID);
    assert.equal(byRowIndex.size, 2, "both applied rows are detected");
    assert.ok(byRowIndex.has(0) && byRowIndex.has(1), "the real row indexes (0 and 1) come back");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

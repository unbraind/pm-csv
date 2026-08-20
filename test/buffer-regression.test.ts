import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  loadAppliedByTransaction,
  itemStatus,
  compensateCreate,
  describePmNullStatus,
  type PmSpawn,
} from "../index.ts";
import type { SpawnSyncReturns } from "node:child_process";

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
        // Worded for the REAL cause: a stdout overrun is reported by Node as
        // error code ENOBUFS, and the message must name the buffer and the fix
        // (narrow / raise PM_LIST_MAX_BUFFER) — never read as a silent 'item
        // missing'.
        /overran its 128-byte stdout buffer.*ENOBUFS.*PM_LIST_MAX_BUFFER/is,
        "a stdout overrun must surface as a named error naming ENOBUFS, not as undefined (silent 'item missing')",
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

test("itemStatus refuses to invent a status from malformed successful output", () => {
  const malformed: PmSpawn = () => ({
    status: 0,
    stdout: "not json",
    stderr: "",
    pid: 1,
    output: [],
  }) as unknown as SpawnSyncReturns<string>;
  assert.equal(itemStatus("unused", "pm-malformed", malformed), undefined);
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
        /overran its 128-byte stdout buffer.*ENOBUFS.*PM_LIST_MAX_BUFFER/is,
        "a stdout overrun must surface as a named error naming ENOBUFS, not as a silent empty 'applied' map",
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

// ---------------------------------------------------------------------------
// Follow-up regressions for the three review findings raised on PR #59.
//
// The original fix traded a silent wrong answer for an aborted rollback: the
// shared guard now throws in places that must not throw. These lock in:
//   (F1) compensation is tolerant of an overrun in its OWN status lookup;
//   (F3) a `status: null` result is worded for its REAL cause — a stdout
//        overrun (ENOBUFS), a spawn/system error (other code), or an external
//        signal kill (no error) — never a blanket "buffer overrun" message.
// The import-path write regressions (F2: an oversized create receipt never
// strands an un-identified orphan; a null close never bypasses compensation)
// live in atomic.test.ts alongside the other close-failure / compensation tests.
// ---------------------------------------------------------------------------

/**
 * Build a synthetic `status: null` `spawnSync` result, for asserting the
 * null-status classifier directly without orchestrating a real killed child.
 *
 * Only the fields {@link describePmNullStatus} reads are meaningful; the rest
 * are dummies that satisfy the `SpawnSyncReturns` shape. Node populates exactly
 * these fields for each cause (verified against `@types/node` and empirically):
 * a buffer overrun sets `error.code === "ENOBUFS"` (and the kill signal); a
 * spawn/system error sets `error` with another code; an external signal kill
 * leaves `error` unset and carries `signal`.
 */
function nullStatusResult(
  over: { error?: Error; signal?: NodeJS.Signals | null },
): SpawnSyncReturns<string> {
  return {
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: over.signal ?? null,
    error: over.error,
  };
}

/** Attach a Node `errno`-style `code` to a plain Error (as Node itself does). */
function withCode(err: Error, code: string | number): Error {
  return Object.assign(err, { code });
}

test("F1: compensation tolerates an overrun in its own status lookup (no-op, sweep not aborted)", () => {
  // compensateCreate calls itemStatus() to decide whether to close. itemStatus
  // now THROWS on a buffer overrun; before the F1 fix that throw propagated out
  // of compensateCreate and aborted the compensation sweep before the best-effort
  // strip/close subprocesses on the rows still pending. The fix catches the
  // overrun and treats THAT row's compensation as a no-op, while the import read
  // path (loadAppliedByTransaction, the verification itemStatus) keeps the hard
  // error.
  const root = freshTracker();
  const id = createItem(root, "Item whose get overruns during compensation", [batchTag, rowTag(0)]);
  try {
    withCappedReadBuffer("1", () => {
      assert.doesNotThrow(
        () => compensateCreate(root, id, [batchTag, rowTag(0)], "test rollback"),
        "an overrun in the compensation status lookup must be a no-op, not an abort that strands the remaining sweep",
      );
    });
    // No-op means no side effect: the item is still open and still carries its
    // markers, because compensation could not determine its state.
    const g = spawnSync("pm", ["--path", root, "get", id, "--json"], { encoding: "utf-8" });
    assert.equal(JSON.parse(g.stdout).item.status, "open", "the item is left untouched (no-op)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F3: a stdout overrun (ENOBUFS) is worded as a buffer overrun naming the fix", () => {
  const msg = describePmNullStatus(
    nullStatusResult({ error: withCode(new Error("spawnSync pm ENOBUFS"), "ENOBUFS"), signal: "SIGTERM" }),
    "get",
  );
  assert.match(msg, /overran its .* stdout buffer/i, "names the overrun and the buffer");
  assert.match(msg, /ENOBUFS/, "names the discriminating Node error code");
  assert.match(msg, /PM_LIST_MAX_BUFFER/, "points the operator at the buffer override");
});

test("F3: an external signal kill (no error) is worded as a signal termination, NOT a buffer overrun", () => {
  // A child terminated by a signal also reports `status: null`. Telling the
  // operator to raise PM_LIST_MAX_BUFFER sends them down the wrong path when the
  // real cause was a kill. The signal alone cannot distinguish this from a
  // buffer-driven SIGTERM, so the discriminator is the ABSENCE of an ENOBUFS
  // error.
  const msg = describePmNullStatus(nullStatusResult({ signal: "SIGKILL" }), "get");
  assert.match(msg, /terminated by signal SIGKILL/i, "names the signal");
  assert.match(msg, /NOT a stdout buffer overrun/i, "explicitly steers the operator away from the buffer");
  assert.doesNotMatch(msg, /error code ENOBUFS/, "no ENOBUFS error code is reported for a pure signal kill (only the buffer case carries it)");
});

test("F3: a spawn/system error (non-ENOBUFS code) is worded as a spawn failure, NOT a buffer overrun", () => {
  // A spawn failure such as the binary not being found (ENOENT) also yields
  // `status: null` with an error, but a code other than ENOBUFS. This is not a
  // buffer problem and must not advertise PM_LIST_MAX_BUFFER.
  const msg = describePmNullStatus(
    nullStatusResult({ error: withCode(new Error("spawn pm ENOENT"), "ENOENT") }),
    "get",
  );
  assert.match(msg, /could not run to completion/i, "names it a spawn/run failure");
  assert.match(msg, /ENOENT/, "surfaces the real error code");
  assert.match(msg, /NOT a stdout buffer overrun/i, "explicitly steers the operator away from the buffer");
});

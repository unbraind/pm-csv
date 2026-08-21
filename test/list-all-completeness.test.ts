import assert from "node:assert/strict";
import test, { after } from "node:test";

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";

import {
  assertListAllComplete,
  buildCsvExport,
  loadAppliedByTransaction,
  loadKeyIndex,
  CommandError,
  type PmSpawn,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Regression tests for the canonical complete-list refusal.
//
// The 2026.8.14 failure mode this file pins: pm's list-all defaulted to a
// truncated answer (10 of 682 items on this host's fixture workspace) and all
// three list-all readers here consumed `.items` without consulting the
// envelope's completeness receipt — a CSV export shipping 10 of 682 rows as
// success, a resume scan seeing none of the applied rows, an upsert key index
// missing keys. Every read must REFUSE an envelope whose receipt says the
// answer was not the whole workspace, naming the tripped signal and the
// count/total figures.
//
// Every refusal below is driven from a REAL envelope (captured from the real
// pm CLI's canonical `list --all` output against a real workspace) with exactly one
// field mutated, injected through the PmSpawn seam — not a hand-written mock
// of the envelope shape.
// ---------------------------------------------------------------------------

/** True when a `pm` CLI is on PATH for envelope capture. */
function hasPmCli(): boolean {
  try {
    return spawnSync("pm", ["--version"], { encoding: "utf-8" }).status === 0;
  } catch {
    return false;
  }
}

/** Captured real canonical complete-list envelope plus the root it came from. */
interface EnvelopeFixture {
  pmRoot: string;
  envelope: Record<string, unknown>;
  stdout: string;
}

let cached: EnvelopeFixture | undefined;

/** Build a real 3-item workspace once and capture the CLI's actual envelope. */
function realEnvelope(): EnvelopeFixture {
  if (cached) return cached;
  const root = mkdtempSync(join(tmpdir(), "csv-envelope-"));
  const pmRoot = join(root, ".agents", "pm");
  mkdirSync(pmRoot, { recursive: true });
  const init = spawnSync("pm", ["--path", pmRoot, "init"], { encoding: "utf-8" });
  assert.strictEqual(init.status, 0, `pm init failed: ${init.stderr}`);
  for (const [i, title] of ["Envelope Alpha", "Envelope Beta", "Envelope Gamma"].entries()) {
    const args = ["--path", pmRoot, "--json", "create", "--title", title, "--type", "Task", "--status", "open"];
    // Stamp the importer's own provenance markers so the happy-path tests also
    // exercise the key-index and resume-scan extraction against real rows.
    if (i === 0) args.push("--tags", "csv-key:src-a.csv,csv-tx:csv-import-deadbeef,csv-txrow:csv-import-deadbeef#0");
    if (i === 1) args.push("--tags", "csv-txrow:csv-import-deadbeef#1");
    const created = spawnSync("pm", args, { encoding: "utf-8" });
    assert.strictEqual(created.status, 0, `pm create failed: ${created.stderr}`);
  }
  // The exact canonical argv every whole-tracker reader must use, so the
  // captured envelope carries every receipt the production paths certify.
  const read = spawnSync(
    "pm",
    [
      "--pm-path",
      pmRoot,
      "list",
      "--all",
      "--json",
      "--include-body",
      "--strict-read",
      "--no-truncate",
      "--output-budget",
      "unbounded",
      "--output-limit",
      "unbounded",
      "--output-include",
      "full",
    ],
    { encoding: "utf-8" },
  );
  assert.strictEqual(read.status, 0, `pm list --all failed: ${read.stderr}`);
  cached = { pmRoot, envelope: JSON.parse(read.stdout) as Record<string, unknown>, stdout: read.stdout };
  // One captured fixture serves every test; tear the workspace down once the
  // whole file has run so nothing leaks into /tmp across local runs.
  after(() => rmSync(root, { recursive: true, force: true }));
  return cached;
}

/** Deep-copy the real envelope, apply one mutation, and return its stdout. */
function mutatedStdout(mutate: (env: Record<string, unknown>) => void): string {
  const env = JSON.parse(JSON.stringify(realEnvelope().envelope)) as Record<string, unknown>;
  mutate(env);
  return JSON.stringify(env);
}

/**
 * Seam answering a canned stdout with a successful child exit.
 *
 * Records every argv it is handed so a test can assert what actually reaches
 * `pm`, not merely what the reader does with the answer.
 */
function seamFor(stdout: string, calls: string[][] = []): PmSpawn {
  return (args, _options) => {
    calls.push([...args]);
    return ({ status: 0, stdout, stderr: "", pid: 1, output: [] }) as unknown as SpawnSyncReturns<string>;
  };
}

const EXPORT_OPTS = {
  delimiter: ",",
  columns: ["id", "title", "status", "type"],
};

test("real list-all envelope baseline is complete with all items", { skip: !hasPmCli() }, () => {
  const fx = realEnvelope();
  assert.strictEqual(fx.envelope.truncated, false);
  assert.strictEqual(fx.envelope.has_more, false);
  assert.strictEqual((fx.envelope.completeness as Record<string, unknown>).status, "complete");
  const omission = fx.envelope.omission_receipt as Record<string, unknown> | undefined;
  assert.strictEqual(omission?.has_omissions, false);
  assert.deepStrictEqual(omission?.omitted_field_groups, []);
  const readOutput = fx.envelope.read_output as Record<string, unknown> | undefined;
  assert.strictEqual(readOutput?.command, "list");
  assert.strictEqual(readOutput?.within_budget, true);
  assert.strictEqual(readOutput?.strings_compacted, false);
  assert.strictEqual(readOutput?.rows_compacted, false);
  assert.strictEqual(readOutput?.result_omitted, false);
  assert.strictEqual(Array.isArray(fx.envelope.items) && fx.envelope.items.length, 3);
  assert.strictEqual(fx.envelope.count, 3);
  assert.strictEqual(fx.envelope.total, 3);
});

test("export refuses an envelope with truncated=true", { skip: !hasPmCli() }, () => {
  const { pmRoot } = realEnvelope();
  assert.throws(
    () => buildCsvExport(pmRoot, EXPORT_OPTS, seamFor(mutatedStdout((env) => { env.truncated = true; }))),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /page_incomplete/u, "message must name the stable SDK finding");
      assert.match(err.message, /count=3 of total=3/u, "message must name the counts");
      return true;
    },
  );
});

test("export refuses an envelope with has_more=true", { skip: !hasPmCli() }, () => {
  const { pmRoot } = realEnvelope();
  assert.throws(
    () => buildCsvExport(pmRoot, EXPORT_OPTS, seamFor(mutatedStdout((env) => { env.has_more = true; }))),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /page_incomplete/u, "message must name the stable SDK finding");
      assert.match(err.message, /count=3 of total=3/u, "message must name the counts");
      return true;
    },
  );
});

test("export refuses an envelope with completeness.status partial", { skip: !hasPmCli() }, () => {
  const { pmRoot } = realEnvelope();
  assert.throws(
    () => buildCsvExport(pmRoot, EXPORT_OPTS, seamFor(mutatedStdout((env) => {
      (env.completeness as Record<string, unknown>).status = "partial";
    }))),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /source_incomplete/u, "message must name the stable SDK finding");
      assert.match(err.message, /count=3 of total=3/u, "message must name the counts");
      return true;
    },
  );
});

test("export refuses an envelope with omission_receipt.has_omissions=true", { skip: !hasPmCli() }, () => {
  const { pmRoot } = realEnvelope();
  assert.throws(
    () => buildCsvExport(pmRoot, EXPORT_OPTS, seamFor(mutatedStdout((env) => {
      (env.omission_receipt as Record<string, unknown>).has_omissions = true;
    }))),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /omission_receipt\.has_omissions=true/, "message must name the tripped signal");
      assert.match(err.message, /count=3 of total=3/u, "message must name the counts");
      return true;
    },
  );
});

test("the upsert key index refuses a truncated envelope instead of missing keys", { skip: !hasPmCli() }, () => {
  const { pmRoot } = realEnvelope();
  // A silently-partial key index turns upsert updates into duplicate creates.
  assert.throws(
    () => loadKeyIndex(pmRoot, seamFor(mutatedStdout((env) => { env.truncated = true; }))),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /page_incomplete/u);
      assert.match(err.message, /count=3 of total=3/u);
      return true;
    },
  );
});

test("the resume scan refuses a truncated envelope instead of seeing nothing applied", { skip: !hasPmCli() }, () => {
  const { pmRoot } = realEnvelope();
  // A silently-partial applied-rows map re-imports already-applied rows on resume.
  assert.throws(
    () => loadAppliedByTransaction(pmRoot, "csv-import-deadbeef", seamFor(mutatedStdout((env) => { env.truncated = true; }))),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /page_incomplete/u);
      assert.match(err.message, /count=3 of total=3/u);
      return true;
    },
  );
});

test("happy path: a complete envelope flows every item through all three readers", { skip: !hasPmCli() }, () => {
  const { pmRoot, stdout } = realEnvelope();
  const seam = seamFor(stdout);

  // Export renders one CSV row per envelope item.
  const exported = buildCsvExport(pmRoot, EXPORT_OPTS, seam);
  assert.strictEqual(exported.count, 3);
  assert.match(exported.csvText, /Envelope Alpha/);
  assert.match(exported.csvText, /Envelope Gamma/);

  // The key index picks up the stamped csv-key provenance tag.
  const keys = loadKeyIndex(pmRoot, seam);
  const tagged = (realEnvelope().envelope.items as Array<{ id?: string; tags?: string[] }>)
    .find((it) => (it.tags ?? []).some((t) => t.startsWith("csv-key:")));
  assert.ok(tagged?.id, "the fixture must contain one csv-key-tagged item");
  assert.strictEqual(keys.get("src-a.csv"), tagged.id);

  // The resume scan sees both stamped per-row markers.
  const applied = loadAppliedByTransaction(pmRoot, "csv-import-deadbeef", seam);
  assert.strictEqual(applied.byRowIndex.size, 2);
  assert.ok(applied.byRowIndex.has(0) && applied.byRowIndex.has(1));
});

test("assertListAllComplete refuses missing and contradictory current receipts", () => {
  const cases: Array<[(env: Record<string, unknown>) => void, RegExp]> = [
    [(env) => { delete env.completeness; }, /source_unchecked/u],
    [(env) => { delete env.omission_receipt; }, /omission_receipt=<missing>/u],
    [(env) => {
      const omission = env.omission_receipt as Record<string, unknown>;
      omission.omitted_field_group_count = 1;
      omission.omitted_field_groups = ["body"];
    }, /omission_receipt\.omitted_field_group_count=1/u],
    [(env) => {
      (env.completeness as Record<string, unknown>).unreadable_item_count = 1;
    }, /completeness\.unreadable_item_count=1/u],
    [(env) => { delete env.read_output; }, /read_output=<missing>/u],
    [(env) => {
      (env.read_output as Record<string, unknown>).rows_compacted = true;
    }, /budget_compaction/u],
    [(env) => {
      delete (env.read_output as Record<string, unknown>).requested_dimensions;
    }, /read_output\.requested_dimensions=<missing>/u],
    [(env) => {
      (env.read_output as Record<string, unknown>).requested_dimensions = ["include"];
    }, /read_output\.requested_dimensions missing amount/u],
    [(env) => { env.output_budget_truncation = { reason: "synthetic" }; }, /output_budget_truncation=<present>/u],
    [(env) => { env.output_budget_exceeded = true; }, /output_budget_exceeded=<present>/u],
    [(env) => {
      const items = env.items as Array<Record<string, unknown>>;
      items.push({ ...items[0] });
      env.count = items.length;
      env.total = items.length;
    }, /duplicate_item_id/u],
    [(env) => {
      (env.items as Array<Record<string, unknown>>)[0].id = " ";
    }, /invalid_item_id/u],
  ];
  for (const [mutate, expected] of cases) {
    assert.throws(
      () => assertListAllComplete(JSON.parse(mutatedStdout(mutate)) as unknown),
      expected,
    );
  }
  assert.throws(() => assertListAllComplete([]), /invalid_envelope/u);
});

test("export classifies an unparseable stdout instead of crashing raw", { skip: !hasPmCli() }, () => {
  const { pmRoot } = realEnvelope();
  assert.throws(
    () => buildCsvExport(pmRoot, EXPORT_OPTS, seamFor("not json")),
    /Could not parse `pm list --all --json` output/,
  );
});

test("all whole-tracker readers classify process and parse failures without inventing empty data", { skip: !hasPmCli() }, () => {
  const { pmRoot } = realEnvelope();
  const failed: PmSpawn = () => ({
    status: 1,
    stdout: "",
    stderr: "synthetic list failure",
    pid: 1,
    output: [],
  }) as unknown as SpawnSyncReturns<string>;
  assert.throws(() => loadKeyIndex(pmRoot, failed), /synthetic list failure/u);
  assert.throws(
    () => loadAppliedByTransaction(pmRoot, "csv-import-deadbeef", failed),
    /synthetic list failure/u,
  );
  assert.throws(() => buildCsvExport(pmRoot, EXPORT_OPTS, failed), /synthetic list failure/u);
  assert.throws(() => loadKeyIndex(pmRoot, seamFor("not json")), /building the upsert key index/u);
  assert.throws(
    () => loadAppliedByTransaction(pmRoot, "csv-import-deadbeef", seamFor("not json")),
    /scanning for applied rows/u,
  );

  for (const code of ["ENOBUFS", "ENOENT"] as const) {
    const error = Object.assign(new Error(`synthetic ${code}`), { code });
    const errored: PmSpawn = () => ({
      status: null,
      signal: code === "ENOBUFS" ? "SIGTERM" : null,
      error,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [],
    }) as unknown as SpawnSyncReturns<string>;
    assert.throws(
      () => buildCsvExport(pmRoot, EXPORT_OPTS, errored),
      code === "ENOBUFS" ? /read buffer/u : /synthetic ENOENT/u,
    );
    assert.throws(
      () => loadKeyIndex(pmRoot, errored),
      code === "ENOBUFS" ? /stdout buffer/u : /synthetic ENOENT/u,
    );
    assert.throws(
      () => loadAppliedByTransaction(pmRoot, "csv-import-deadbeef", errored),
      code === "ENOBUFS" ? /stdout buffer/u : /synthetic ENOENT/u,
    );
  }
});


test("all whole-tracker readers send the exact canonical strict unbounded argv", { skip: !hasPmCli() }, () => {
  const fx = realEnvelope();
  const calls: string[][] = [];
  buildCsvExport(fx.pmRoot, EXPORT_OPTS, seamFor(fx.stdout, calls));
  loadKeyIndex(fx.pmRoot, seamFor(fx.stdout, calls));
  loadAppliedByTransaction(fx.pmRoot, "csv-import-deadbeef", seamFor(fx.stdout, calls));
  assert.strictEqual(calls.length, 3);
  const expected = [
    "--pm-path",
    fx.pmRoot,
    "list",
    "--all",
    "--json",
    "--include-body",
    "--strict-read",
    "--no-truncate",
    "--output-budget",
    "unbounded",
    "--output-limit",
    "unbounded",
    "--output-include",
    "full",
  ];
  for (const argv of calls) {
    assert.deepStrictEqual(argv, expected);
  }
});

test("an envelope whose count disagrees with total is refused even with every flag clear", { skip: !hasPmCli() }, () => {
  const { pmRoot } = realEnvelope();
  assert.throws(
    () => buildCsvExport(pmRoot, EXPORT_OPTS, seamFor(mutatedStdout((env) => {
      env.count = 10;
      env.total = 682;
    }))),
    /count_mismatch:.*count=10 of total=682/u,
  );
});

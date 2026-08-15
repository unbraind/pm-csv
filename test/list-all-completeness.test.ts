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
// Regression tests for the list-all completeness refusal.
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
// pm CLI's `list-all --json` output against a real workspace) with exactly one
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

/** Captured real `pm list-all --json` envelope plus the root it came from. */
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
  // The exact argv buildCsvExport uses, so the captured envelope is the one
  // the production export path would have parsed.
  const read = spawnSync(
    "pm",
    ["--path", pmRoot, "list-all", "--json", "--include-body"],
    { encoding: "utf-8" },
  );
  assert.strictEqual(read.status, 0, `pm list-all failed: ${read.stderr}`);
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
  assert.ok(omission === undefined || omission.has_omissions === false);
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
      assert.match(err.message, /truncated=true/, "message must name the tripped signal");
      assert.match(err.message, /count 3 of total 3/, "message must name the counts");
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
      assert.match(err.message, /has_more=true/, "message must name the tripped signal");
      assert.match(err.message, /count 3 of total 3/, "message must name the counts");
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
      assert.match(err.message, /completeness\.status="partial"/, "message must name the tripped signal");
      assert.match(err.message, /count 3 of total 3/, "message must name the counts");
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
      assert.match(err.message, /count 3 of total 3/, "message must name the counts");
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
      assert.match(err.message, /truncated=true/);
      assert.match(err.message, /count 3 of total 3/);
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
      assert.match(err.message, /truncated=true/);
      assert.match(err.message, /count 3 of total 3/);
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

test("assertListAllComplete covers the missing-receipt and listed-groups shapes", () => {
  assert.throws(
    () => assertListAllComplete({ items: [], count: 0, total: 0, truncated: false, has_more: false }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /completeness\.status=\(missing\)/);
      return true;
    },
  );
  assert.throws(
    () => assertListAllComplete({
      items: [],
      count: 0,
      total: 0,
      truncated: false,
      has_more: false,
      completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 },
      omission_receipt: { has_omissions: true, omitted_field_groups: ["body"] },
    }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /omitted_field_groups: body/);
      return true;
    },
  );
  assert.throws(
    () => assertListAllComplete({
      items: [{ id: "a" }, { id: "b" }],
      truncated: true,
      completeness: { status: "complete" },
    }),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.match(err.message, /count 2 of total 2/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertListAllComplete({
    items: [{ id: "a" }],
    truncated: false,
    has_more: false,
    completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 },
    omission_receipt: { has_omissions: false },
  }));
});

test("export classifies an unparseable stdout instead of crashing raw", { skip: !hasPmCli() }, () => {
  const { pmRoot } = realEnvelope();
  assert.throws(
    () => buildCsvExport(pmRoot, EXPORT_OPTS, seamFor("not json")),
    /Could not parse `pm list-all --json` output/,
  );
});


test("no --limit reaches list-all, so the read is never bounded into a refusal", { skip: !hasPmCli() }, () => {
  // The stated contract is that `list-all` is invoked WITHOUT a row ceiling:
  // omitting --limit is what makes it return everything, and with the
  // completeness gate in place a ceiling converts every workspace past that size
  // from a large read into a hard refusal of export, resume and upsert. Nothing
  // pinned that, so a well-meaning "add a sensible limit" change would have
  // passed review and broken large workspaces silently.
  const fx = realEnvelope();
  const calls: string[][] = [];
  buildCsvExport(fx.pmRoot, EXPORT_OPTS, seamFor(fx.stdout, calls));
  assert.ok(calls.length > 0, "the seam should have been invoked");
  for (const argv of calls) {
    assert.ok(argv.includes("list-all"), `expected a list-all invocation, got: ${argv.join(" ")}`);
    assert.ok(
      !argv.includes("--limit"),
      `list-all must not be bounded by --limit, got: ${argv.join(" ")}`,
    );
  }
});

test("an envelope whose count disagrees with total is refused even with every flag clear", { skip: !hasPmCli() }, () => {
  const { pmRoot } = realEnvelope();
  assert.throws(
    () => buildCsvExport(pmRoot, EXPORT_OPTS, seamFor(mutatedStdout((env) => {
      env.count = 10;
      env.total = 682;
    }))),
    /disagree while every completeness flag is clear/,
  );
});

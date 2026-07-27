import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../dist/index.js";

/**
 * Activate pm-csv through pm's real host engine with the manifest's declared
 * capabilities.
 *
 * This deliberately replaces the hand-rolled `api` doubles these tests used to
 * build. A double accepts every registration unconditionally, so it cannot
 * observe host-side rejection — which is how a `--json` flag that shadows a
 * host-owned global stayed green in CI while `csv validate` failed to register
 * against a real pm host. The harness runs the same validation the CLI runs, so
 * an invalid registration fails the suite here.
 */
async function harness() {
  const created = await createExtensionTestHarness(extension, {
    name: "pm-csv",
    capabilities: ["commands", "importers", "schema"],
  });
  assert.deepEqual(created.activation.failed, [], "activation must not fail");
  return created;
}

test("extension activates cleanly against the real pm host", async () => {
  const ext = await harness();
  assert.strictEqual(ext.name, "pm-csv");
  await ext.deactivate();
});

test("extension registers the csv importer, exporter and schema field", async () => {
  const ext = await harness();

  const { registrations } = ext.activation;
  assert.strictEqual(registrations.importers.length, 1, "should register the csv importer");
  assert.strictEqual(registrations.exporters.length, 1, "should register the csv exporter");

  const { field } = ext.assertItemField({ name: "csv_source", type: "string" });
  assert.strictEqual(field.optional, true, "csv_source should be an optional string field");

  await ext.deactivate();
});

test("csv export declares --header (not a bare --no-header the host rejects)", async () => {
  // Regression: a bare `{ long: "--no-header" }` flag is unusable because the
  // host parses `--no-header` as the negation of a (missing) `--header` flag
  // ("Unknown option '--header'"). The export command must declare the positive
  // `--header` flag so the host accepts `--no-header` as its negation.
  const ext = await harness();

  const { flags } = ext.assertCommandContract({ name: "csv export", flags: ["--header"] });
  const longs = flags.map((flag) => flag.long);
  assert.ok(!longs.includes("--no-header"), "csv export must not declare a bare --no-header flag (host rejects it)");

  await ext.deactivate();
});

test("csv import and validate declare --auto-map", async () => {
  const ext = await harness();

  ext.assertCommandContract({ name: "csv import", flags: ["--auto-map"] });
  ext.assertCommandContract({ name: "csv validate", flags: ["--auto-map"] });

  await ext.deactivate();
});

test("csv import declares --skip-headers and --stream", async () => {
  const ext = await harness();

  ext.assertCommandContract({ name: "csv import", flags: ["--skip-headers", "--stream"] });

  await ext.deactivate();
});

test("csv validate declares --skip-headers", async () => {
  const ext = await harness();

  ext.assertCommandContract({ name: "csv validate", flags: ["--skip-headers"] });

  await ext.deactivate();
});

test("no command redeclares a host-owned global flag", async () => {
  // Guards the whole surface, not just the one command that regressed:
  // registering any of these makes the host reject the command outright, and
  // the value must be read from ctx.global instead.
  const hostOwned = new Set([
    "--json",
    "--quiet",
    "--path",
    "--lean",
    "--id-only",
    "--author",
    "--no-changed-fields",
    "--full-changed-fields",
    "--pm-path",
  ]);
  const ext = await harness();

  for (const registration of ext.activation.registrations.flags) {
    for (const flag of registration.flags) {
      assert.ok(
        flag.long === undefined || !hostOwned.has(flag.long),
        `${registration.target_command} must not redeclare host-owned global flag ${flag.long}`,
      );
    }
  }

  await ext.deactivate();
});

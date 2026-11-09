import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { packedScenarios } from "../scripts/packed-scenarios.ts";
import { resolve } from "node:path";
import test from "node:test";
import { assertCustomFieldExport, CUSTOM_FIELDS, CUSTOM_FIXTURES } from "../scripts/packed-custom-fields.ts";

/** Build independent expected cells so corruptions exercise the acceptance oracle. */
function expectedTable(): string[][] {
  return [["title", ...CUSTOM_FIELDS.map(([column]) => column)], ...CUSTOM_FIXTURES.map(fixture =>
    [fixture.title, ...CUSTOM_FIELDS.map(([column]) => {
      const value = fixture[column];
      return Array.isArray(value) ? value.join(",") : String(value);
    })])];
}

test("custom export proof rejects missing, duplicate and corrupted columns and fixtures", () => {
  assertCustomFieldExport(expectedTable());
  assert.throws(() => assertCustomFieldExport([["title"], [CUSTOM_FIXTURES[0].title]]), /custom column/);
  for (let column = 1; column <= CUSTOM_FIELDS.length; column++) {
    const missing = expectedTable().map(row => row.filter((_, index) => index !== column));
    assert.throws(() => assertCustomFieldExport(missing), /custom column/);
    const duplicate = expectedTable().map(row => [...row, row[column]]);
    assert.throws(() => assertCustomFieldExport(duplicate), /custom column/);
    for (let row = 1; row <= CUSTOM_FIXTURES.length; row++) {
      const corrupted = expectedTable();
      corrupted[row][column] = "corrupt";
      assert.throws(() => assertCustomFieldExport(corrupted), /custom value/);
    }
  }
  const missing = expectedTable();
  missing.pop();
  assert.throws(() => assertCustomFieldExport(missing), /custom fixture/);
  const duplicate = expectedTable();
  duplicate.push(duplicate[1]);
  assert.throws(() => assertCustomFieldExport(duplicate), /custom fixture/);
});

test("packed scenarios retain distinct hosts and deduplicate matching npm versions", () => {
  assert.deepEqual(packedScenarios("2026.11.5", "2026.11.5"), [
    { name: "npm-current", manager: "npm", hostVersion: "2026.11.5" },
    { name: "bun-current", manager: "bun", hostVersion: "2026.11.5" },
  ]);
  assert.deepEqual(packedScenarios("2026.11.6", "2026.11.5"), [
    { name: "npm-current", manager: "npm", hostVersion: "2026.11.6" },
    { name: "bun-current", manager: "bun", hostVersion: "2026.11.6" },
    { name: "npm-minimum", manager: "npm", hostVersion: "2026.11.5" },
  ]);
});

// Installed hosts also exercise native rollback at every row position.
test("packed acceptance proves custom columns on every installed host", { timeout: 600_000 }, () => {
  const childEnvironment = { ...process.env };
  delete childEnvironment.PM_PATH;
  const result = spawnSync(process.execPath, ["scripts/accept-packed.ts"], {
    cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 590_000,
    env: childEnvironment, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message ?? "Packed acceptance process error");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as { ok: boolean; receipts: Array<Record<string, unknown>> };
  assert.equal(output.ok, true);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    devDependencies: Record<string, string>; peerDependencies: Record<string, string>;
  };
  const current = pkg.devDependencies["@unbrained/pm-cli"], minimum = pkg.peerDependencies["@unbrained/pm-cli"].replace(/^>=/, "");
  const npmVersions = output.receipts.filter(receipt => String(receipt.scenario).startsWith("npm-")).map(receipt => receipt.host_version);
  assert.deepEqual(npmVersions, [...new Set([current, minimum])]);
  assert.deepEqual(output.receipts.map(receipt => receipt.scenario), ["npm-current", "bun-current", ...(new Set([current, minimum]).size === 1 ? [] : ["npm-minimum"])]);
  for (const receipt of output.receipts) {
    assert.equal(receipt.custom_columns_exported, 6, String(receipt.scenario));
    assert.equal(receipt.custom_fields_sdk_roundtrip, true, String(receipt.scenario));
    assert.equal(receipt.scope_clear_aliases_replayed, true, String(receipt.scenario));
    assert.equal(receipt.native_reference_replayed, true, String(receipt.scenario));
    assert.equal(receipt.prototype_keys_checked, true, String(receipt.scenario));
    assert.equal(receipt.atomic_compensation, true, String(receipt.scenario));
    assert.equal(receipt.settings_snapshot_checked, true, String(receipt.scenario));
    assert.equal(receipt.native_identity_checked, true, String(receipt.scenario));
    assert.equal(receipt.journal_recovery_checked, true, String(receipt.scenario));
  }
});

import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { create, getHistoryPath, listMutationEvents, readSettingsWithMetadata } from "@unbrained/pm-cli/sdk";
import { discoverCustomFields } from "../index.ts";
import { captureUpdateCompensation, compensateUpdate, readUpdateSnapshot } from "../atomic-update.ts";
import { applyEditSession, exportEditSession } from "../roundtrip.ts";

/** Initialize an isolated real tracker with no enclosing git repository. */
function tracker(): string {
  const root = mkdtempSync(join(tmpdir(), "csv-sdk-"));
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  const result = spawnSync(process.execPath, ["node_modules/@unbrained/pm-cli/dist/cli.js", "init", "--defaults", "--path", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return root;
}

test("SDK discovery uses canonical registry tokens and file overrides in definitions/array schemas without git", async () => {
  const root = tracker();
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = "";
    const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
    settings.schema = { files: { fields: "custom-fields.json" }, fields: [
      { key: "Zeta", metadata_key: "OLD" }, { key: "title" }, { key: "csv_source" },
    ] };
    writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
    const fields = [{ key: "Zeta", metadata_key: "NEW" }, { key: "Alpha", front_matter_key: "Severity" }];
    writeFileSync(join(root, "custom-fields.json"), JSON.stringify({ definitions: fields }));
    assert.deepEqual(await discoverCustomFields(root), [
      { key: "alpha", metadataKey: "severity" }, { key: "zeta", metadataKey: "new" },
    ]);
    writeFileSync(join(root, "custom-fields.json"), JSON.stringify(fields));
    assert.deepEqual(await discoverCustomFields(root), [
      { key: "alpha", metadataKey: "severity" }, { key: "zeta", metadataKey: "new" },
    ]);
    writeFileSync(join(root, "settings.json"), JSON.stringify({ schema: { fields: "invalid" } }));
    assert.ok((await readSettingsWithMetadata(root)).warnings.includes("settings_read_invalid_schema"));
    assert.deepEqual(await discoverCustomFields(root), []);
  } finally {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("SDK discovery preserves an initialized schema and settings without git", async () => {
  const root = tracker();
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = "";
    const before = readdirSync(join(root, "schema")).map(name => [name, readFileSync(join(root, "schema", name), "utf8")]);
    const settings = readFileSync(join(root, "settings.json"), "utf8");
    assert.deepEqual(await discoverCustomFields(root), []);
    assert.deepEqual(readdirSync(join(root, "schema")).map(name => [name, readFileSync(join(root, "schema", name), "utf8")]), before);
    assert.equal(readFileSync(join(root, "settings.json"), "utf8"), settings);
  } finally {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("SDK settings filesystem failures use the host fallback without partial fields", async () => {
  const root = tracker();
  try {
    rmSync(join(root, "settings.json"));
    mkdirSync(join(root, "settings.json"));
    assert.ok((await readSettingsWithMetadata(root)).warnings.includes("settings_read_fs_error"));
    assert.deepEqual(await discoverCustomFields(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("corrupt history after priming SDK caches still refuses checkout, apply and compensation without writes", async () => {
  const root = tracker();
  try {
    const { item } = await create({ title: "Cache integrity", priority: 2 }, { pmRoot: root });
    const id = item.id;
    const marker = "csv-txrow:integrity#0";
    const checkout = await exportEditSession(root, [id]);
    const captured = await captureUpdateCompensation(root, id, marker, "csv-test");
    const page = await listMutationEvents({ pmRoot: root, item: id, full: true });
    assert.ok(page.events.length > 0);
    assert.equal(page.source, "derived_index");
    const before = await readUpdateSnapshot(root, id);
    const historyPath = getHistoryPath(root, id);
    const entries = readFileSync(historyPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    // Keep the JSON and event projection readable while breaking chain integrity.
    entries[0].after_hash = "0".repeat(64);
    const corrupted = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(historyPath, corrupted);
    checkout.table[1][checkout.table[0].indexOf("title")] = "Must not persist";
    await assert.rejects(exportEditSession(root, [id]), /Verify item history/);
    await assert.rejects(applyEditSession(root, checkout.session, checkout.table, { author: "csv-test" }), /Verify item history/);
    await assert.rejects(captureUpdateCompensation(root, id, marker, "csv-test"), /unverified history/);
    await assert.rejects(compensateUpdate(root, id, marker, "csv-test", captured), /changed history or state/);
    assert.equal(readFileSync(before.located.itemPath, "utf8"), before.raw);
    assert.equal(readFileSync(historyPath, "utf8"), corrupted);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

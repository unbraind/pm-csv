import assert from "node:assert/strict";
import test from "node:test";

import extension from "../dist/index.js";

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers at least one capability", () => {
  const registered: string[] = [];
  const noop = () => {};
  // Mirror the full ExtensionApi surface so activate() can register every
  // capability the extension uses (commands, importer, exporter).
  const fieldRegistrations: any[] = [];
  const api = {
    registerCommand: () => { registered.push("command"); },
    registerParser: noop, registerPreflight: noop, registerService: noop,
    registerFlags: noop,
    registerItemFields: (fields: any[]) => { registered.push("itemFields"); fieldRegistrations.push(...fields); },
    registerItemTypes: noop,
    registerMigration: noop, registerRenderer: noop,
    registerImporter: () => { registered.push("importer"); },
    registerExporter: () => { registered.push("exporter"); },
    registerSearchProvider: noop, registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  extension.activate(api as any);
  assert.ok(registered.includes("importer"), "should register the csv importer");
  assert.ok(registered.includes("exporter"), "should register the csv exporter");
  assert.ok(registered.includes("itemFields"), "should register the csv_source schema field");
  assert.ok(
    fieldRegistrations.some((f) => f.name === "csv_source" && f.type === "string" && f.optional === true),
    "csv_source should be an optional string field",
  );
});

test("csv export declares --header (not a bare --no-header the host rejects)", () => {
  // Regression: a bare `{ long: "--no-header" }` flag is unusable because the
  // host parses `--no-header` as the negation of a (missing) `--header` flag
  // ("Unknown option '--header'"). The export command must declare the positive
  // `--header` flag so the host accepts `--no-header` as its negation.
  const commands: any[] = [];
  const noop = () => {};
  const api = {
    registerCommand: (def: any) => { commands.push(def); },
    registerParser: noop, registerPreflight: noop, registerService: noop,
    registerFlags: noop, registerItemFields: noop, registerItemTypes: noop,
    registerMigration: noop, registerRenderer: noop,
    registerImporter: noop, registerExporter: noop,
    registerSearchProvider: noop, registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  extension.activate(api as any);
  const exportCmd = commands.find((c) => c.name === "csv export");
  assert.ok(exportCmd, "csv export command should be registered");
  const longs = (exportCmd.flags ?? []).map((f: any) => f.long);
  assert.ok(longs.includes("--header"), "csv export should declare the positive --header flag");
  assert.ok(!longs.includes("--no-header"), "csv export must not declare a bare --no-header flag (host rejects it)");
});

test("activate degrades gracefully when registerItemFields is absent", () => {
  const registered: string[] = [];
  const noop = () => {};
  // Older host: no registerItemFields on the api surface.
  const api = {
    registerCommand: () => { registered.push("command"); },
    registerParser: noop, registerPreflight: noop, registerService: noop,
    registerFlags: noop, registerItemTypes: noop,
    registerMigration: noop, registerRenderer: noop,
    registerImporter: () => { registered.push("importer"); },
    registerExporter: () => { registered.push("exporter"); },
    registerSearchProvider: noop, registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  // Must not throw and must still register commands/importer/exporter.
  extension.activate(api as any);
  assert.ok(registered.includes("importer"), "importer still registers without schema support");
  assert.ok(registered.includes("exporter"), "exporter still registers without schema support");
});

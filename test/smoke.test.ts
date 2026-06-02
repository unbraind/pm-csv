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
  const api = {
    registerCommand: () => { registered.push("command"); },
    registerParser: noop, registerPreflight: noop, registerService: noop,
    registerFlags: noop, registerItemFields: noop, registerItemTypes: noop,
    registerMigration: noop, registerRenderer: noop,
    registerImporter: () => { registered.push("importer"); },
    registerExporter: () => { registered.push("exporter"); },
    registerSearchProvider: noop, registerVectorStoreAdapter: noop,
    hooks: { beforeCommand: noop, afterCommand: noop, onWrite: noop, onRead: noop, onIndex: noop },
  };
  extension.activate(api as any);
  assert.ok(registered.includes("importer"), "should register the csv importer");
  assert.ok(registered.includes("exporter"), "should register the csv exporter");
});

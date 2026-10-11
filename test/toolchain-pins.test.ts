import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertToolchainPins, type ToolchainMetadata } from "../scripts/toolchain-pins.ts";

/** Load the metadata bytes that npm actually installs and locks in this checkout. */
function metadata(path: string): ToolchainMetadata {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as ToolchainMetadata;
}

const manifest = metadata("package.json");
const lock = metadata("package-lock.json");
const installed: Record<string, string> = {};
for (const name of ["@unbrained/pm-cli", "pm-ops", "pm-changelog"]) {
  const document = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")) as { version: string };
  installed[name] = document.version;
}

test("all toolchain pins match root lock, resolved lock and installed metadata", () => {
  assertToolchainPins(manifest, lock, installed);
});

test("consistent future toolchain bumps pass without an approved-version edit", () => {
  const futureManifest = structuredClone(manifest);
  const futureLock = structuredClone(lock);
  const futureInstalled = { ...installed };
  for (const name of Object.keys(installed)) {
    const pin = "2099.12.31";
    futureManifest.devDependencies![name] = pin;
    futureLock.packages![""]!.devDependencies![name] = pin;
    futureLock.packages![`node_modules/${name}`]!.version = pin;
    futureInstalled[name] = pin;
  }
  assertToolchainPins(futureManifest, futureLock, futureInstalled);
});

for (const name of Object.keys(installed)) {
  test(`${name} rejects ranges and each inconsistent pin layer`, () => {
    const ranged = structuredClone(manifest);
    ranged.devDependencies![name] = `^${installed[name]}`;
    assert.throws(() => assertToolchainPins(ranged, lock, installed), /exact development pin/u);
    const rootMismatch = structuredClone(lock);
    delete rootMismatch.packages![""]!.devDependencies![name];
    assert.throws(() => assertToolchainPins(manifest, rootMismatch, installed), /root lock declaration/u);
    const resolvedMismatch = structuredClone(lock);
    resolvedMismatch.packages![`node_modules/${name}`]!.version = "0.0.0";
    assert.throws(() => assertToolchainPins(manifest, resolvedMismatch, installed), /resolved lock version/u);
    assert.throws(() => assertToolchainPins(manifest, lock, { ...installed, [name]: "0.0.0" }), /installed version/u);
  });
}

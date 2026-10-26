/** Regression coverage for the npm package links shipped in package.json. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

test("npm homepage points to the package catalog", () => {
  assert.equal(packageJson.homepage, "https://pm-cli.unbrained.dev/packages/pm-csv");
});

test("npm author links to the maintainer about page", () => {
  assert.deepEqual(packageJson.author, {
    name: "unbrained",
    url: "https://unbrained.dev/about",
  });
});

test("npm repository points to the package repository", () => {
  assert.deepEqual(packageJson.repository, {
    "type": "git",
    "url": "git+https://github.com/unbraind/pm-csv.git"
  });
});

test("npm bugs points to the package issue tracker", () => {
  assert.deepEqual(packageJson.bugs, {
    "url": "https://github.com/unbraind/pm-csv/issues"
  });
});

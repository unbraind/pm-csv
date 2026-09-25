/**
 * Tests for the npm `prepare` hook. `scripts/prepare-merge-driver.ts` must be the
 * canonical pm-ops launcher byte for byte: pm-ops exercises every branch of that
 * template against real fixtures (omit-dev skip, stale pm-ops, failing and killed
 * installers), so any local edit here would ship behaviour nothing has tested.
 * Running it in this checkout must then register pm's field-aware merge drivers.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// npm runs tests from the package root, which is also where it runs `prepare`.
const root = process.cwd();
const launcher = join(root, "scripts", "prepare-merge-driver.ts");

test("the prepare launcher is the unmodified pm-ops template", () => {
  const canonical = readFileSync(join(root, "node_modules", "pm-ops", "templates", "prepare-merge-driver.ts"), "utf8");
  assert.equal(readFileSync(launcher, "utf8"), canonical);
});

test("the prepare launcher registers pm's merge drivers in this checkout", () => {
  const run = spawnSync(process.execPath, [launcher], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const drivers = spawnSync("git", ["config", "--get-regexp", "^merge\\.pm"], { cwd: root, encoding: "utf8" });
  assert.match(drivers.stdout, /^merge\.pm/m);
});

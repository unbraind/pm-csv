import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

/** CodeQL workflow whose action references must be upgraded atomically. */
const workflow = readFileSync(new URL("../.github/workflows/codeql.yml", import.meta.url), "utf8");
/** Dependabot configuration that keeps the CodeQL action family together. */
const dependabot = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");

test("CodeQL actions use one shared revision and Dependabot groups future updates", () => {
  const revisions = [...workflow.matchAll(/github\/codeql-action\/[^@\s]+@([0-9a-f]{40})/g)].map(
    ([, revision]) => revision,
  );

  assert.ok(revisions.length >= 2, "the workflow should contain the CodeQL action pair");
  assert.deepEqual(
    [...new Set(revisions)],
    [revisions[0]],
    "every CodeQL action must use the same commit",
  );
  assert.match(dependabot, /groups:\s+codeql-action:\s+patterns:\s+- ["']github\/codeql-action\*["']/);
});

// Parse the trigger shape so an accidental paths-ignore cannot hide tracker code.
test("CodeQL re-includes executable tracker files after data exclusions", () => {
  const config = parse(workflow);
  const paths = [
    "**", "!.agents/pm/**", "!**/*.md", "!docs/**", "!package-lock.json",
    ".agents/pm/**/*.mjs", ".agents/pm/**/*.cjs", ".agents/pm/**/*.js", ".agents/pm/**/*.ts",
  ];
  for (const event of ["push", "pull_request"]) {
    assert.equal(config.on[event]["paths-ignore"], undefined);
    assert.deepEqual(config.on[event].paths, paths, `${event} must re-include executable tracker code last`);
  }
  assert.deepEqual(config.permissions, {});
  assert.deepEqual(config.jobs.codeql.permissions, { "security-events": "write", actions: "read", contents: "read" });
  assert.ok(config.on.schedule.length > 0, "weekly scan must still cover lockfile-only changes");
});

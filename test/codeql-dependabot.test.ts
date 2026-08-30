import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

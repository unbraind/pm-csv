import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/release.yml"),
  "utf-8"
);

function stepIndex(name: string): number {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^[ \\t]*-[ \\t]+name:[ \\t]+${escapedName}[ \\t]*(?:#[^\\r\\n]*)?$`,
    "m"
  ).exec(workflow);
  assert.ok(match, `release workflow should contain the exact ${name} step`);
  return match.index;
}

test("npm publication authenticates by OIDC, with no stored token anywhere in the workflow", () => {
  // A stored npm token is what silently broke the whole fleet: it was rejected
  // from 2026-08-17 onward, every release job failed at the publish step with a
  // registry E404 on PUT, and main kept bumping the version regardless. Trusted
  // publishing removes the credential that can expire, so this test fails closed
  // if a token is ever reintroduced.
  const withoutComments = workflow.replace(/^[ \t]*#[^\r\n]*$/gm, "");

  assert.doesNotMatch(withoutComments, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(withoutComments, /NPM_TOKEN/);
  assert.doesNotMatch(withoutComments, /secrets\.NPM/);
});


/** Strip whole-line comments so a commented-out directive can never satisfy an
 * assertion that the directive is present. Applied to a slice, never used to
 * compute offsets — removing text shifts every index after it. */
function executable(source: string): string {
  return source.replace(/^[ \t]*#[^\r\n]*$/gm, "");
}

/**
 * Extract the source of one workflow step, from its `- name:` line to the next.
 *
 * @param name - The exact `- name:` value of the step.
 * @returns That step's source alone, excluding neighbouring steps.
 */
function stepSource(name: string): string {
  const start = stepIndex(name);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {6}- name:/m);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

/**
 * Resolve the permissions block that actually applies to the `release` job.
 *
 * A job-level `permissions:` block REPLACES the workflow-level one for that job
 * rather than merging with it, so reading whichever is nearest is the only
 * answer that matches GitHub's semantics.
 *
 * @returns The effective permissions source for the release job.
 */
function effectiveReleasePermissions(): string {
  const jobsAt = workflow.indexOf("jobs:\n  release:");
  assert.ok(jobsAt >= 0, "release workflow should declare a jobs.release entry");
  const afterKey = jobsAt + "jobs:\n  release:".length;
  const rest = workflow.slice(afterKey);
  const nextJob = rest.search(/^ {2}[A-Za-z][\w-]*:/m);
  const job = nextJob === -1 ? rest : rest.slice(0, nextJob);

  const jobBlock = /^ {4}permissions:\n((?: {6}\S[^\n]*\n)+)/m.exec(executable(job));
  if (jobBlock) return jobBlock[1];

  const topBlock = /^permissions:\n((?: {2}\S[^\n]*\n)+)/m.exec(executable(workflow.slice(0, jobsAt)));
  assert.ok(topBlock, "release workflow should declare permissions the release job inherits");
  return topBlock[1];
}

test("the release job effectively holds id-token: write, and no comment can stand in for it", () => {
  // Matching /id-token: write/ against the whole file is satisfied by a comment
  // reading "# id-token: write", and by a permission on some other job. Neither
  // grants this job anything, and OIDC publication fails closed without it.
  assert.match(effectiveReleasePermissions(), /^ *id-token: write$/m);
});

test("the npm upgrade cannot be skipped and fails closed on the version it actually gets", () => {
  // Asserting that the install command appears is not enough: the step can be
  // disabled with `if: ${{ false }}` or its failure swallowed with `|| true`,
  // and npm 10 stays active while the assertion still passes. The workflow
  // checks the EFFECTIVE version and exits non-zero, and that is what is
  // asserted here.
  const step = stepSource("Use an npm that supports trusted publishing");

  assert.match(step, /npm install -g npm@\^11\.5\.1/);
  assert.doesNotMatch(step, /^ *if:/m);
  assert.match(step, /npm --version/);
  assert.match(step, /sort -V/);
  assert.match(step, /exit 1/);
  assert.doesNotMatch(step, /\|\|\s*true/);
  assert.match(step, /set -euo pipefail/);
});

test("nothing between the upgrade and the publish step can put an older npm back", () => {
  // Keeping the 11.x upgrade and then installing npm 10 later leaves trusted
  // publishing broken while every check above still passes.
  const upgrade = stepIndex("Use an npm that supports trusted publishing");
  const publish = stepIndex("Publish npm package");
  assert.ok(upgrade < publish, "npm must be upgraded before the publish step runs");

  const between = executable(workflow.slice(upgrade, publish));
  const installs = [...between.matchAll(/npm\s+(?:install|i|add)\s+-g\s+npm@\S+/g)];
  assert.equal(
    installs.length,
    1,
    `exactly one global npm install may precede publication, found ${installs.length}`
  );
  assert.doesNotMatch(between, /corepack\s+(?:prepare|use)\s+npm@/);
  assert.doesNotMatch(between, /uses:\s*actions\/setup-node/);
});

test("no registry auth token is configured anywhere in the release path", () => {
  // The token can come back as an .npmrc line rather than as an env var, which
  // the NODE_AUTH_TOKEN assertion alone would not see.
  const source = executable(workflow);
  assert.doesNotMatch(source, /_authToken/);
  assert.doesNotMatch(source, /npm\s+config\s+set\s+\/\/registry/);
});

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

  // Pinned exactly, not a caret range: a privileged publish job that resolves a
  // different npm on every run is not reproducible, and an unreviewed 11.x could
  // change publishing behaviour between two identical release commits.
  assert.match(step, /npm install -g npm@11\.19\.0(?!\S)/);
  assert.doesNotMatch(step, /npm install -g npm@[\^~]/);
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

test("no registry credential is configured, under any name or mechanism", () => {
  // Rejecting three literal token names is not enough: the credential can come
  // back as `secrets.PUBLISH_TOKEN` piped into an .npmrc `_authToken` line, or
  // through `npm login`, none of which mention NODE_AUTH_TOKEN. What matters is
  // that the publish step reaches the registry with no stored credential at all.
  const source = executable(workflow);

  assert.doesNotMatch(source, /_authToken\s*[=:]/);
  assert.doesNotMatch(source, /npm\s+config\s+set\s+\/\//);
  assert.doesNotMatch(source, /npm\s+login/);
  assert.doesNotMatch(source, /always-auth/);

  // The publish step must carry no secret at all. Elsewhere in the job
  // `secrets.GITHUB_TOKEN` is legitimate (the gh CLI needs it), so this is
  // scoped rather than global.
  const publish = executable(stepSource("Publish npm package"));
  assert.doesNotMatch(publish, /secrets\./);
});

test("the empty credential that setup-node generates is removed before publishing", () => {
  // `registry-url` makes setup-node write
  // `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into the npm
  // userconfig. With no token in the environment that expands to an EMPTY
  // credential, and npm treats a configured-but-empty token as legacy auth -
  // which blocks the OIDC exchange and fails with the very registry 404 this
  // migration removes. Deleting the token env is therefore NOT sufficient on
  // its own; the generated line has to go too.
  const publish = stepSource("Publish npm package");

  assert.match(publish, /NPM_CONFIG_USERCONFIG/);
  assert.match(publish, /_authToken/);
  assert.match(publish, /sed -i/);
  // The strip must happen before the publish command, not after it.
  assert.ok(
    publish.indexOf("_authToken") < publish.indexOf("npm publish"),
    "the generated credential must be removed before npm publish runs"
  );
});

test("publication is proven possible before anything is mutated", () => {
  // The failure this guards against is not "publish broke" - it is "publish
  // broke and nothing said so". Because the bump and the release commit land
  // before the publish step, ten days of rejected credentials still advanced
  // main to a new version every night and published nothing. A preflight that
  // asks the registry for a credential up front converts that into a run that
  // fails immediately, having changed nothing.
  const preflight = stepIndex("Verify npm will accept this workflow's OIDC identity");
  const bump = stepIndex("Update release version");
  const commit = stepIndex("Commit release files");
  const publish = stepIndex("Publish npm package");

  assert.ok(preflight < bump, "the OIDC check must run before the version is bumped");
  assert.ok(preflight < commit, "the OIDC check must run before the release commit");
  assert.ok(preflight < publish, "the OIDC check must run before publication");

  const step = executable(stepSource("Verify npm will accept this workflow's OIDC identity"));

  // It has to actually reach the registry: asserting only that an id-token was
  // minted would pass while npm still refuses the identity at publish time.
  assert.match(step, /oidc\/token\/exchange\/package\//);
  assert.match(step, /set -euo pipefail/);
  assert.match(step, /exit 1/);
  assert.doesNotMatch(step, /\|\|\s*true/);

  // Fails closed: no `continue-on-error`, which would restore the silent drift
  // while leaving every assertion above satisfied.
  assert.doesNotMatch(step, /continue-on-error/);

  // The exchange response carries a publish credential. Capturing the status
  // separately from the body is what keeps it out of the log.
  assert.match(step, /-o [^\s]*npm-oidc-exchange\.json/);
  assert.doesNotMatch(step, /echo\s+"?\$\{?id_token/);
});

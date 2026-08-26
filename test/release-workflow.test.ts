import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/** The release workflow source, read once and asserted against as text. */
const workflow = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/release.yml"),
  "utf-8"
);

/**
 * Locate a named workflow step so tests can assert on ordering between steps.
 *
 * Offsets are taken against the raw source rather than a comment-stripped copy:
 * removing text shifts every index after it, which would silently corrupt the
 * ordering comparisons these offsets exist to support.
 *
 * @param name - The exact `- name:` value of the step.
 * @returns The character offset of that step within the workflow source.
 */
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
 * Strip comments and the credential-scrub step's own deletion expressions.
 *
 * The scrub names every credential it removes, so a naive search for those names
 * matches the very code that deletes them. Removing `sed` deletion expressions
 * leaves only places a credential could actually be *configured*.
 *
 * @param source - Workflow source to filter.
 * @returns Source with comments and scrub deletion expressions removed.
 */
function withoutCredentialScrub(source: string): string {
  return executable(source)
    .replace(/^[ \t]*sed -i.*$/gm, "")
    .replace(/^[ \t]*-e '\/[^']*\/d'.*$/gm, "");
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
  const job = executable(nextJob === -1 ? rest : rest.slice(0, nextJob));

  // `permissions: { id-token: write }` - a flow mapping is still an override.
  const inline = /^ {4}permissions:[ \t]*(\{[^}]*\})[ \t]*$/m.exec(job);
  if (inline) return inline[1];

  // `permissions: read-all` and friends are overrides that grant no id-token.
  const scalar = /^ {4}permissions:[ \t]*([A-Za-z][\w-]*)[ \t]*$/m.exec(job);
  if (scalar) return scalar[1];

  const jobBlock = /^ {4}permissions:\n((?: {6}\S[^\n]*\n)+)/m.exec(job);
  if (jobBlock) return jobBlock[1];

  const topBlock = /^permissions:\n((?: {2}\S[^\n]*\n)+)/m.exec(
    executable(workflow.slice(0, jobsAt))
  );
  assert.ok(topBlock, "release workflow should declare permissions the release job inherits");
  return topBlock[1];
}

test("the release job effectively holds id-token: write, and no comment can stand in for it", () => {
  // Matching /id-token: write/ against the whole file is satisfied by a comment
  // reading "# id-token: write", and by a permission on some other job. Neither
  // grants this job anything, and OIDC publication fails closed without it.
  assert.match(effectiveReleasePermissions(), /(?:^|[{,\s])id-token:\s*write\s*(?:#[^\n]*)?$/m);
});

test("the npm upgrade cannot be skipped and fails closed on the version it actually gets", () => {
  // Asserting that the install command appears is not enough: the step can be
  // disabled with `if: ${{ false }}` or its failure swallowed with `|| true`,
  // and npm 10 stays active while the assertion still passes. The workflow
  // checks the EFFECTIVE version and exits non-zero, and that is what is
  // asserted here.
  const step = executable(stepSource("Use an npm that supports trusted publishing"));

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
  const installs = [
    ...between.matchAll(/npm\s+(?:install|i|add)\s+(?:-g|--global)\s+npm@\S+/g),
    ...between.matchAll(/npm\s+(?:-g|--global)\s+(?:install|i|add)\s+npm@\S+/g),
  ];
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
  const source = withoutCredentialScrub(workflow);

  // npm accepts a registry credential under several names, and rejecting only
  // the token spelling leaves the others open: `_auth` is basic auth,
  // `username`/`_password` is the legacy pair, and `certfile`/`keyfile` is mTLS.
  // Any one of them restores a stored credential the OIDC migration removed.
  for (const key of ["_authToken", "_auth", "username", "_password", "certfile", "keyfile"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`${key}\\s*[=:]`),
      `release workflow must not configure the npm credential '${key}'`
    );
  }

  assert.doesNotMatch(source, /npm\s+(?:config\s+)?set\s+["']?\/\//i);
  assert.doesNotMatch(source, /npm\s+login/i);
  assert.doesNotMatch(source, /always-auth/i);
  // `npm config set //registry.npmjs.org/:_authToken value` separates key and
  // value with a space rather than `=`, which the key-plus-`=` checks miss.
  assert.doesNotMatch(source, /:(?:_authToken|_auth|username|_password|certfile|keyfile)\s+\S/i);

  // The same credentials can arrive as environment overrides rather than as
  // .npmrc lines. NPM_CONFIG_USERCONFIG is the one legitimate member of that
  // family here - it is how the publish step finds the file it strips.
  for (const [, name] of source.matchAll(/\b(npm_config_[a-z0-9_]+|NPM_CONFIG_[A-Z0-9_]+)\b/gi)) {
    assert.equal(
      name.toUpperCase(),
      "NPM_CONFIG_USERCONFIG",
      `release workflow must not set ${name}, which can carry a registry credential`
    );
  }

  // The publish step must carry no secret at all. Elsewhere in the job
  // `secrets.GITHUB_TOKEN` is legitimate (the gh CLI needs it), so this is
  // scoped rather than global.
  const publish = executable(stepSource("Publish npm package"));
  assert.doesNotMatch(publish, /secrets\s*(?:\.|\[)/);
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
  assert.match(publish, /sed -i/);

  // Deleting only the token spelling leaves basic auth, the legacy pair and the
  // mTLS pair in place - each of which npm will use instead of the exchange.
  for (const key of ["_authToken", "_auth", "username", "_password", "certfile", "keyfile"]) {
    assert.ok(
      publish.includes(key),
      `the credential scrub must remove '${key}' from the npm userconfig`
    );
  }
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

  // A scoped name is not path-safe: @unbrained/pm-web must reach the registry as
  // %40unbrained%2Fpm-web, and sending it raw addresses a different path. The URL
  // must therefore be built from the ENCODED name, not from package.json's value.
  assert.match(step, /encodeURIComponent/);

  // An unbounded curl in a release gate turns a hung registry into a hung job
  // rather than a failed one, and the job holds an id-token while it hangs.
  assert.equal(
    (step.match(/curl\b/g) ?? []).length,
    (step.match(/--max-time\b/g) ?? []).length,
    "every curl in the preflight must be bounded with --max-time"
  );

  // A registry outage is not an identity refusal, and must not send a maintainer
  // to reconfigure a trusted publisher that is already correct.
  assert.match(step, /-ge 500/);
  assert.match(step, /exchange\/package\/\$\{pkg_path\}/);
  assert.doesNotMatch(step, /exchange\/package\/\$\{pkg_name\}/);

  // npm answers 201 on a successful exchange. Accepting only 200 fails a release
  // whose trusted publisher is correctly configured - a preflight that blocks
  // correct releases is worse than the outage it exists to prevent.
  assert.doesNotMatch(step, /\[ "\$\{status\}" = "200" \]/);
  assert.match(step, /-ge 200/);
  assert.match(step, /-lt 300/);
  assert.match(step, /set -euo pipefail/);
  assert.match(step, /exit 1/);
  assert.doesNotMatch(step, /\|\|\s*true/);

  // Fails closed: no `continue-on-error`, which would restore the silent drift
  // while leaving every assertion above satisfied.
  assert.doesNotMatch(step, /continue-on-error/);

  // The step legitimately carries an `if:`, so "has no condition" is the wrong
  // assertion - but that is exactly the hole `if: ${{ false }}` walks through,
  // leaving the step present, ordered correctly, and never executed while the
  // bump, commit and publish steps still run. Pin the EXACT condition, and pin
  // it to the same one the mutating steps use.
  const preflightCondition = /^ *if: steps\.decide\.outputs\.should_release == 'true'$/m;
  assert.match(step, preflightCondition);
  assert.equal(
    (step.match(/^ *if:/gm) ?? []).length,
    1,
    "the preflight must carry exactly one condition, so none can shadow the release condition"
  );
  assert.match(executable(stepSource("Update release version")), preflightCondition);

  // A second `trap ... EXIT` REPLACES the first, so appending one is enough to
  // keep the credential file on disk while every assertion above still passes.
  assert.equal(
    (step.match(/\btrap\b/g) ?? []).length,
    1,
    "exactly one EXIT trap may be installed, or a later one silently replaces the cleanup"
  );

  // The exchange response carries a publish credential. Capturing the status
  // separately from the body is what keeps it out of the log.
  assert.doesNotMatch(step, /echo\s+"?\$\{?id_token/);

  // The 200 response body IS a short-lived publish credential. Every later step
  // in this job runs as the same runner user, so leaving it on disk - and at a
  // predictable path - hands that credential to build, changelog and
  // release-check code that has no business holding it.
  assert.match(step, /response="\$\(mktemp\)"/);
  assert.match(step, /trap\s+'rm -f "\$\{response\}"'\s+EXIT/);
  assert.doesNotMatch(step, /-o\s+\/tmp\/[^\s"]+/);
  assert.match(step, /-o "\$\{response\}"/);
});

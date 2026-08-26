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

  // OIDC is only reachable when the job may mint an id-token.
  assert.match(workflow, /id-token: write/);
});

test("the npm used to publish is new enough to exchange an OIDC token", () => {
  // node 22 ships npm 10.x, which cannot do trusted publishing and would fall
  // back to token auth; 11.5.1 is the first release that can. The upgrade has to
  // happen before the publish step, or the job authenticates with nothing.
  const upgrade = stepIndex("Use an npm that supports trusted publishing");
  const publish = stepIndex("Publish npm package");

  assert.ok(upgrade < publish, "npm must be upgraded before the publish step runs");
  assert.match(workflow.slice(upgrade, publish), /npm install -g npm@\^11\.5\.1/);
});

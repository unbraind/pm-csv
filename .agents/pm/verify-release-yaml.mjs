/** Verify the release workflow alert job is wired correctly. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
const jobs = workflow.jobs;
const releaseJobs = Object.keys(jobs).filter((name) => name !== "alert-on-release-failure");
assert.ok(releaseJobs.length > 0, "no release jobs found");

const alert = jobs["alert-on-release-failure"];
assert.ok(alert, "missing alert-on-release-failure job");
assert.equal(alert.if, "failure() && github.event_name == 'schedule'");
assert.deepEqual(alert.concurrency, {
  group: "release-failure-alert-${{ github.repository }}",
  "cancel-in-progress": false,
});
const needs = Array.isArray(alert.needs) ? alert.needs : [alert.needs];
assert.deepEqual([...needs].sort(), [...releaseJobs].sort());
assert.deepEqual(alert.permissions, { contents: "read", issues: "write" });

assert.ok(
  alert.steps.some(
    (step) =>
      step.uses === "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" &&
      step.with?.ref === "${{ github.event.repository.default_branch }}" &&
      step.with?.["persist-credentials"] === false,
  ),
  "alert job must check out the default branch without persisted credentials",
);
assert.ok(
  alert.steps.some((step) => step.run === "bash scripts/alert-on-release-failure.sh"),
  "alert job must execute the tracked alert script",
);

const script = readFileSync("scripts/alert-on-release-failure.sh", "utf8");
assert.ok(script.includes("release-failure"), "dedup marker label missing from alert script");

const ciWorkflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
assert.ok(
  Object.values(ciWorkflow.jobs).some((job) =>
    job.steps?.some((step) => step.run === "npm run verify:release-workflow"),
  ),
  "pull-request CI must execute the parsed release-workflow verifier",
);

console.log("release.yml alert job verified");

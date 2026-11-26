import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

/** Dependabot configuration that keeps the pm-github workflow callers together. */
const dependabot = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");

// The callers pin one full commit with its release comment and never name an extension version. This test used to
// assert one literal commit, which made every Dependabot bump of these callers fail CI; the gated sync then ran an
// extension older than the pm CLI this package installs and refused its own writes.
test("pm-github callers share one pinned release and Dependabot moves them together", () => {
  const pins = ["sync", "closeout"].map(name => {
    const source = readFileSync(new URL(`../.github/workflows/pm-github-${name}.yml`, import.meta.url), "utf8");
    const job = parse(source).jobs[`gated-${name}`];
    const revision = new RegExp(`^unbraind/pm-github/\\.github/workflows/pm-github-${name}\\.yml@([0-9a-f]{40})$`).exec(job.uses)?.[1];
    assert.ok(revision, `${name} must pin a full commit`);
    const line = source.split("\n").find(candidate => candidate.trim().startsWith(`uses: ${job.uses}`)) ?? "";
    const release = /# pm-github (\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?)\s*$/.exec(line)?.[1];
    assert.ok(release, `the ${name} pin must carry its release comment on the same line`);
    assert.equal(job.with?.["pm-github-version"], undefined);
    return `${revision} ${release}`;
  });
  assert.equal(pins[0], pins[1], "sync and closeout must use one reviewed release");
  assert.match(dependabot, /pm-github-workflows:\s+patterns:\s+- ["']unbraind\/pm-github\/\*["']/);
});

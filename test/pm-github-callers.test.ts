import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

/** First pm-github release whose gated import works with the pm CLI this package installs. */
const MINIMUM_RELEASE = [2026, 11, 25, 0];

/** Workflow file of one pm-github caller. */
const callerFile = (name: string) => new URL(`../.github/workflows/pm-github-${name}.yml`, import.meta.url);

/** Whether a calendar release, written as numbers, is the floor or newer. */
function atLeast(release: number[], floor: number[]): boolean {
  for (let index = 0; index < floor.length; index++) {
    const difference = (release[index] ?? 0) - floor[index];
    if (difference !== 0) return difference > 0;
  }
  return true;
}

// Every caller this package has pins one full commit with its release comment and never names an extension version.
// This test used to assert one literal commit, which made every Dependabot bump of the callers fail CI; the gated
// sync then ran an extension older than the pm CLI this package installs and refused its own writes. A later bump
// may move the pin freely, but never below the first release that works with the installed pm CLI.
test("pm-github callers share one compatible pinned release and Dependabot moves them together", () => {
  const names = ["sync", "closeout"].filter(name => existsSync(callerFile(name)));
  assert.ok(names.includes("sync"), "the gated sync caller must exist");
  const pins = names.map(name => {
    const source = readFileSync(callerFile(name), "utf8");
    const job = parse(source).jobs[`gated-${name}`];
    const revision = new RegExp(`^unbraind/pm-github/\\.github/workflows/pm-github-${name}\\.yml@([0-9a-f]{40})$`).exec(job.uses)?.[1];
    assert.ok(revision, `${name} must pin a full commit`);
    const line = source.split("\n").find(candidate => /^\s*uses:/.test(candidate) && candidate.includes(job.uses)) ?? "";
    const release = /# pm-github (\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?\s*$/.exec(line);
    assert.ok(release, `the ${name} pin must carry its release comment on the same line`);
    assert.ok(atLeast(release.slice(1).map(part => Number(part ?? 0)), MINIMUM_RELEASE), `${name} must not pin a release older than ${MINIMUM_RELEASE.slice(0, 3).join(".")}`);
    assert.equal(job.with?.["pm-github-version"], undefined);
    return `${revision} ${release.slice(1).join(".")}`;
  });
  assert.equal(new Set(pins).size, 1, "every pm-github caller must use one reviewed release");
  const updates = parse(readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8")).updates as { "package-ecosystem": string; groups?: Record<string, { patterns?: string[] }> }[];
  const actions = updates.filter(update => update["package-ecosystem"] === "github-actions");
  assert.equal(actions.length, 1, "one github-actions update entry");
  assert.deepEqual(actions[0].groups?.["pm-github-workflows"]?.patterns, ["unbraind/pm-github/*"]);
});

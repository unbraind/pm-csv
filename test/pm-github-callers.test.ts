import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

// The callers must pin a full commit with its release comment and must not name an extension version. This test used
// to assert one literal commit, which made every Dependabot bump of these callers fail CI; the gated sync then ran an
// extension older than the pm CLI this package installs and refused its own writes.
test("pm-github callers pin a full commit with its release comment and no extension override", () => {
  for (const name of ["sync", "closeout"]) {
    const source = readFileSync(new URL(`../.github/workflows/pm-github-${name}.yml`, import.meta.url), "utf8");
    const job = parse(source).jobs[`gated-${name}`];
    assert.match(job.uses, new RegExp(`^unbraind/pm-github/\\.github/workflows/pm-github-${name}\\.yml@[0-9a-f]{40}$`));
    assert.match(source, new RegExp(`pm-github-${name}\\.yml@[0-9a-f]{40} # pm-github \\d{4}\\.\\d{1,2}\\.\\d{1,2}(-\\d+)?$`, "m"));
    assert.equal(job.with?.["pm-github-version"], undefined);
  }
});

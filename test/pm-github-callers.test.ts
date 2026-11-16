import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("pm-github callers use the bounded dispatch release without an extension override", () => {
  for (const name of ["sync", "closeout"]) {
    const source = readFileSync(new URL(`../.github/workflows/pm-github-${name}.yml`, import.meta.url), "utf8");
    const job = parse(source).jobs[`gated-${name}`];
    assert.equal(job.uses, `unbraind/pm-github/.github/workflows/pm-github-${name}.yml@a3a2e7ccbee2bbd23933d10be578422b967a519c`);
    assert.match(source, /# pm-github 2026\.11\.15/);
    assert.equal(job.with?.["pm-github-version"], undefined);
  }
});

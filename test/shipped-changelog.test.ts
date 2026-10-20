import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the changelog retains the original shipped cleanup fix and its reopened completion", () => {
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const releases = new Map(changelog.split(/^## /mu).slice(1).map((section) => {
    const [heading, ...body] = section.split("\n");
    return [heading.split(" - ")[0], body.join("\n")];
  }));
  assert.match(releases.get("2026.9.6") ?? "", /Temp-tree cleanup races.*\[pm-csv-yriu\]/u);
  assert.match(releases.get("2026.9.7") ?? "", /Test wrapper lets delegated writers.*\[pm-csv-yriu\]/u);
});

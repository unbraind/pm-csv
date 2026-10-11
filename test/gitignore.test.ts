import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("untracked evaluation queries are discoverable while search runtime contents stay ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "csv-ignore-"));
  try {
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
    writeFileSync(join(root, ".gitignore"), readFileSync(new URL("../.gitignore", import.meta.url)));
    const search = join(root, ".agents", "pm", "search");
    mkdirSync(join(search, "nested"), { recursive: true });
    const allowed = ".agents/pm/search/eval-queries.json";
    const ignored = [".agents/pm/search/index.json", ".agents/pm/search/nested/cache.json"];
    for (const file of [allowed, ...ignored]) writeFileSync(join(root, file), "{}\n");
    const check = spawnSync("git", ["check-ignore", "--no-index", allowed], { cwd: root, encoding: "utf8" });
    assert.equal(check.status, 1, `evaluation queries must be discoverable: ${check.stdout}${check.stderr}`);
    const runtime = spawnSync("git", ["check-ignore", "--no-index", ...ignored], { cwd: root, encoding: "utf8" });
    assert.equal(runtime.status, 0, runtime.stderr);
    assert.deepEqual(runtime.stdout.trim().split("\n"), ignored);
    const discoverable = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
    assert.equal(discoverable.status, 0, discoverable.stderr);
    assert.ok(discoverable.stdout.split("\n").includes(allowed));
    for (const file of ignored) assert.ok(!discoverable.stdout.split("\n").includes(file));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

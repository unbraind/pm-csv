import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

/** Capture durable tracker files; host runtime read caches are disposable. */
function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !join(entry.parentPath, entry.name).startsWith(join(root, "runtime") + "/"))
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      return [file.slice(root.length), createHash("sha256").update(readFileSync(file)).digest("hex")];
    }));
}

test("legacy CSV CLI shares native input, flags, errors and dry-run without git", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-csv-legacy-"));
  const repo = resolve(import.meta.dirname, "..");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  const tracker = join(root, ".agents/pm");
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(resolve(repo, "node_modules/@unbrained/pm-cli/dist/cli.js"), join(bin, "pm"));
  const env = { ...process.env, PATH: bin, HOME: root, PM_AUTHOR: "cli-regression", GIT_CEILING_DIRECTORIES: dirname(root) };
  /** Run the pinned host as a real process with no Git executable available. */
  function pm(args: string[]) {
    const result = spawnSync(join(bin, "pm"), ["--pm-path", tracker, ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, null);
    return result;
  }
  try {
    const initialized = pm(["init", "--defaults", "--agent-guidance", "skip", "--prefix", "fixture"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    const extension = join(tracker, "extensions/pm-csv");
    mkdirSync(extension, { recursive: true });
    cpSync(join(repo, "dist"), join(extension, "dist"), { recursive: true });
    cpSync(join(repo, "manifest.json"), join(extension, "manifest.json"));
    writeFileSync(join(root, "tasks.csv"), "Summary;Status\nLegacy fixture;Open\n");
    const flags = ["tasks.csv", "--delimiter", ";", "--auto-map", "--key", "title", "--strict"];
    const before = snapshot(tracker);
    for (const command of [["csv", "import"], ["csv-import", "import"]]) {
      const help = pm([...command, "--help"]);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /<file>/u);
      assert.match(help.stdout, /--dry-run/u);
      const missing = pm(command);
      assert.notEqual(missing.status, 0, missing.stdout + missing.stderr);
      const preview = pm([...command, ...flags, "--dry-run", "--json"]);
      assert.equal(preview.status, 0, preview.stdout + preview.stderr);
      assert.equal(JSON.parse(preview.stdout).wouldCreate, 1);
      assert.deepEqual(snapshot(tracker), before);
      const absent = pm([...command, "absent.csv"]);
      assert.notEqual(absent.status, 0, absent.stdout + absent.stderr);
      assert.deepEqual(snapshot(tracker), before);
    }
    const imported = pm(["csv-import", "import", ...flags, "--json"]);
    assert.equal(imported.status, 0, imported.stdout + imported.stderr);
    assert.equal(JSON.parse(imported.stdout).imported, 1);
    const repeated = pm(["csv", "import", ...flags, "--json"]);
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).updated, 1);
    const items = pm(["list", "--all", "--json"]);
    assert.equal(items.status, 0, items.stderr);
    assert.match(items.stdout, /Legacy fixture/u);
    const after = snapshot(tracker);
    const preview = pm(["csv-import", "import", ...flags, "--dry-run", "--json"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).wouldUpdate, 1);
    assert.deepEqual(snapshot(tracker), after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

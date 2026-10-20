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
  function pm(args: string[], timeout = 60_000) {
    const result = spawnSync(join(bin, "pm"), ["--pm-path", tracker, ...args], { cwd: root, env, encoding: "utf8", timeout });
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

    for (const command of [["csv", "import"], ["csv-import", "import"]]) {
      for (const stream of [false, true]) {
        const title = `Valid after failure ${command[0]} ${stream}`;
        writeFileSync(join(root, "partial.csv"), "title,priority,type\nLegacy fixture,99,Task\nLegacy fixture,2,Task\nInvalid,99,Task\n"
          + `${title},2,Task\nFiltered,2,Feature\n,2,Task\n`);
        const failed = pm([...command, "partial.csv", "--key", "title", "--type", "Task", "--json", ...(stream ? ["--stream"] : [])], 180_000);
        assert.equal(failed.status, 1, failed.stdout + failed.stderr);
        assert.match(failed.stderr, /Import completed with 2 row error\(s\): imported 1, updated 1, skipped 4 \(1 filtered out\)\./u);
        assert.match(failed.stderr, /Row 2: update failed/u);
        assert.match(failed.stderr, /Row 4: create failed/u);
        assert.doesNotMatch(failed.stdout, /"imported"/u, "failed imports must not emit a success receipt");
        const listed = pm(["list", "--all", "--json"]);
        assert.equal(listed.status, 0, listed.stderr);
        const rows = (JSON.parse(listed.stdout) as { items: Array<{ title: string; priority: number }> }).items;
        assert.ok(rows.some((item) => item.title === title), "valid rows after failures still import");
        assert.equal(rows.find((item) => item.title === "Legacy fixture")?.priority, 2);
        assert.ok(!rows.some((item) => item.title === "Invalid" || item.title === "Filtered"));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

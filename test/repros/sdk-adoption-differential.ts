import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Run a checked subprocess without printing source data or local paths. */
function run(command: string, args: string[], options: { cwd?: string; input?: Buffer; env?: NodeJS.ProcessEnv } = {}): Buffer {
  const result = spawnSync(command, args, { ...options, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr.toString()}`);
  return result.stdout;
}

/** Capture and make authoritative source files read-only, excluding derived runtime state. */
function sources(root: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, sources(root, relative));
    else if (entry.isFile()) {
      result[relative] = createHash("sha256").update(readFileSync(join(root, relative))).digest("hex");
      chmodSync(join(root, relative), 0o444);
    }
  }
  return result;
}

/** Run the actual command/exporter dispatch and discovery helper for one built package. */
function observe(modulePath: string, root: string, env: NodeJS.ProcessEnv): unknown {
  const source = `
    import extension, { discoverCustomFields } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    import { createExtensionTestHarness } from ${JSON.stringify(import.meta.resolve("@unbrained/pm-cli/sdk/testing"))};
    const harness = await createExtensionTestHarness(extension, { name: "pm-csv", capabilities: ["commands", "importers", "schema"] });
    const pmRoot = ${JSON.stringify(root)};
    const cases = [{}, { allFields: true }, { discoverFields: true, columns: "title,id" },
      { allFields: true, status: "open" }, { allFields: true, type: "Task", excel: true },
      { allFields: true, columns: "title,id", header: false, delimiter: ";" }];
    const results = [await discoverCustomFields(pmRoot)];
    for (const options of cases) {
      results.push(await harness.runCommand({ command: "csv export", options, pmRoot }));
      // Exporter presentation writes CSV to console; retain only its returned result.
      const log = console.log; console.log = () => {};
      try { results.push(await harness.runExporter({ exporter: "csv-export", options, pmRoot })); }
      finally { console.log = log; }
    }
    await harness.deactivate();
    process.stdout.write(JSON.stringify(results));
  `;
  return JSON.parse(run(process.execPath, ["--input-type=module", "-e", source], { env }).toString());
}

const [baselineRef, ...repositories] = process.argv.slice(2);
assert.ok(baselineRef && repositories.length > 0, "Provide a baseline ref and public fleet checkout paths.");
const scratch = mkdtempSync(join(tmpdir(), "csv-sdk-differential-"));
try {
  const baseline = join(scratch, "baseline");
  mkdirSync(baseline);
  run("tar", ["-x", "-C", baseline], { input: run("git", ["archive", baselineRef]) });
  symlinkSync(resolve("node_modules"), join(baseline, "node_modules"), "dir");
  run(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", join(baseline, "tsconfig.json")]);
  const env = { ...process.env, PATH: `${resolve("node_modules/.bin")}:${process.env.PATH}`,
    PM_GLOBAL_PATH: join(scratch, "global"), GIT_CEILING_DIRECTORIES: scratch,
    PM_SENTRY_DISABLED: "1", PM_TELEMETRY_DISABLED: "1", PM_TELEMETRY_OTEL_DISABLED: "1" };
  for (const repository of repositories) {
    const name = basename(repository);
    const remote = run("git", ["-C", repository, "remote", "get-url", "origin"]).toString().trim();
    assert.match(remote, /^https:\/\/github\.com\/unbraind\/pm-[\w-]+\.git$/);
    const slug = remote.replace("https://github.com/", "").replace(/\.git$/, "");
    const repositoryInfo = JSON.parse(run("gh", ["repo", "view", slug, "--json", "visibility"]).toString()) as { visibility: string };
    assert.equal(repositoryInfo.visibility, "PUBLIC");
    const head = run("git", ["-C", repository, "rev-parse", "origin/main"]).toString().trim();
    const copy = join(scratch, name);
    mkdirSync(copy);
    run("tar", ["-x", "-C", copy], { input: run("git", ["-C", repository, "archive", head, ".agents/pm"]) });
    const root = join(copy, ".agents/pm");
    const before = sources(root);
    const oldResult = observe(join(baseline, "dist/index.js"), root, env);
    const newResult = observe(resolve("dist/index.js"), root, env);
    assert.deepEqual(newResult, oldResult, `${name}: intentional SDK differences require an explicit fixture/receipt`);
    // Runtime read caches may be created; every archived authoritative byte must stay identical.
    for (const [path, hash] of Object.entries(before)) {
      assert.equal(createHash("sha256").update(readFileSync(join(root, path))).digest("hex"), hash);
    }
    console.log(`${slug}@${head}: 13/13 identical observations; ${Object.keys(before).length} authoritative files unchanged; non-git copies`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }

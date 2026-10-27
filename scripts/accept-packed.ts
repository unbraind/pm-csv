import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCSV } from "../index.ts";
import { decode } from "@toon-format/toon";
import { assertCustomFieldExport, CUSTOM_FIELDS } from "./packed-custom-fields.ts";

/** Package fields that define the packed acceptance matrix. */
interface PackageContract {
  readonly name: string;
  readonly version: string;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

/** One package-manager and host-version combination exercised in isolation. */
interface AcceptanceScenario {
  readonly name: string;
  readonly manager: "npm" | "bun";
  readonly hostVersion: string;
}

/** Machine-readable proof emitted for one successful installed extension. */
interface AcceptanceReceipt {
  readonly scenario: string;
  readonly host_version: string;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
  readonly all_fields_exported: true;
  readonly scope_clear_aliases_replayed: true;
  readonly native_reference_replayed: true;
  readonly prototype_keys_checked: true;
  readonly atomic_compensation: true;
  readonly settings_snapshot_checked: true;
  readonly native_identity_checked: true;
  readonly custom_columns_exported: number;
  readonly custom_fields_sdk_roundtrip: true;
  readonly created_fixture_present: true;
  readonly imported_fixture_present: true;
  readonly lineage_imported: 1;
  readonly lineage_replayed: 1;
  readonly schema_rows: 1;
  readonly schema_imported: 1;
  readonly schema_dry_run_imported: 0;
}

const repoRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as PackageContract;
const cliPackage = "@unbrained/pm-cli";
const developmentVersion = packageJson.devDependencies[cliPackage];
const minimumVersion = packageJson.peerDependencies[cliPackage]?.replace(/^>=/, "");
if (!developmentVersion || !minimumVersion) {
  throw new Error(`package.json must declare exact development and minimum peer versions for ${cliPackage}`);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
const bunxCommand = process.platform === "win32" ? "bunx.exe" : "bunx";
const cleanEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  npm_config_userconfig: devNull,
  NPM_CONFIG_USERCONFIG: devNull,
};
// A linked test may select its own tracker. Every scenario owns a fresh one.
delete cleanEnvironment.PM_PATH;
for (const key of Object.keys(cleanEnvironment)) {
  if (key.toLowerCase() === "npm_config_allow_scripts") delete cleanEnvironment[key];
}

/** Run one command without a shell and fail with bounded diagnostics.
 *
 * @param command - Executable resolved directly by the operating system.
 * @param args - Argument vector passed without interpolation.
 * @param cwd - Fresh scenario directory or the package root.
 * @returns Captured UTF-8 process output.
 */
function run(command: string, args: string[], cwd: string, expectedStatus = 0): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: cleanEnvironment,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== expectedStatus) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${String(result.status)}: ${(result.stderr || result.error?.message || result.stdout).trim()}`,
    );
  }
  return result;
}

/** Invoke the scenario-local pm host through its user-facing launcher.
 *
 * @param scenario - Package manager and host version under acceptance.
 * @param cwd - Fresh project holding only the tarball and selected host.
 * @param args - pm arguments after the executable name.
 * @returns Captured pm output.
 */
function runPm(scenario: AcceptanceScenario, cwd: string, args: string[], expectedStatus = 0): SpawnSyncReturns<string> {
  return scenario.manager === "npm"
    ? run(npxCommand, ["--no-install", "pm", ...args], cwd, expectedStatus)
    : run(bunxCommand, ["--no-install", "pm", ...args], cwd, expectedStatus);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "pm-csv-packed-acceptance-"));
try {
  cleanEnvironment.GIT_CEILING_DIRECTORIES = temporaryRoot;
  const packRoot = join(temporaryRoot, "pack");
  mkdirSync(packRoot);
  run(npmCommand, ["pack", "--silent", "--pack-destination", packRoot], repoRoot);
  const tarball = join(packRoot, `${packageJson.name}-${packageJson.version}.tgz`);
  const scenarios: AcceptanceScenario[] = [
    { name: "npm-current", manager: "npm", hostVersion: developmentVersion },
    { name: "bun-current", manager: "bun", hostVersion: developmentVersion },
    { name: "npm-minimum", manager: "npm", hostVersion: minimumVersion },
  ];
  const receipts: AcceptanceReceipt[] = [];

  for (const scenario of scenarios) {
    const scenarioRoot = join(temporaryRoot, scenario.name);
    mkdirSync(scenarioRoot);
    if (scenario.manager === "npm") {
      run(npmCommand, ["init", "-y"], scenarioRoot);
      run(npmCommand, ["install", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot);
    } else {
      run(bunCommand, ["init", "-y"], scenarioRoot);
      run(bunCommand, ["add", "--ignore-scripts", `${cliPackage}@${scenario.hostVersion}`, tarball], scenarioRoot);
    }

    runPm(scenario, scenarioRoot, ["init", "--defaults", "--agent-guidance", "skip", "--prefix", "accept"]);
    const createdTitle = `Packed CSV source ${scenario.name}`;
    runPm(scenario, scenarioRoot, [
      "create",
      "task",
      createdTitle,
      "--status",
      "open",
      "--create-mode",
      "progressive",
    ]);
    runPm(scenario, scenarioRoot, ["install", tarball, "--project"]);
    // Copy this SDK-only fixture module beside the scenario's installed host;
    // its static SDK import must resolve that host, not the development checkout.
    writeFileSync(join(scenarioRoot, "packed-custom-fields.mts"), readFileSync(join(repoRoot, "scripts/packed-custom-fields.ts")));
    run(process.execPath, ["--input-type=module", "-e",
      'import { seedCustomFields } from "./packed-custom-fields.mts"; await seedCustomFields(process.argv[1]);',
      join(scenarioRoot, ".agents/pm")], scenarioRoot);

    const importedTitle = `Packed CSV import ${scenario.name}`;
    const csvPath = join(scenarioRoot, "acceptance.csv");
    writeFileSync(csvPath, `title,status,type\n${importedTitle},open,Task\n`, "utf8");
    runPm(scenario, scenarioRoot, ["csv", "import", csvPath, "--strict"]);
    const exported = runPm(scenario, scenarioRoot, [
      "--json",
      "csv",
      "export",
      "--columns",
      "id,title,status,type",
    ]);
    const parsed: unknown = JSON.parse(exported.stdout);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${scenario.name} pm csv export stdout was not a JSON object`);
    }
    if (!exported.stdout.includes(createdTitle) || !exported.stdout.includes(importedTitle)) {
      throw new Error(`${scenario.name} pm csv export omitted a real created or imported fixture`);
    }
    if (exported.stderr.includes("deprecated") || exported.stderr.includes("list-all")) {
      throw new Error(`${scenario.name} pm csv export emitted a deprecated-command diagnostic: ${exported.stderr.trim()}`);
    }
    const allFields = runPm(scenario, scenarioRoot, ["--json", "csv", "export", "--all-fields"]);
    if (!allFields.stdout.includes(createdTitle) || !allFields.stdout.includes(importedTitle)) {
      throw new Error(`${scenario.name} SDK all-fields export omitted a fixture`);
    }
    const customExport = JSON.parse(allFields.stdout) as { csv: string };
    assertCustomFieldExport(parseCSV(customExport.csv));
    const selectedFields = runPm(scenario, scenarioRoot, ["--json", "csv", "export", "--all-fields",
      "--columns", ["title", ...CUSTOM_FIELDS.map(([column]) => column)].join(",")]);
    assertCustomFieldExport(parseCSV((JSON.parse(selectedFields.stdout) as { csv: string }).csv));
    const roundtripCsv = join(scenarioRoot, "custom-roundtrip.csv");
    writeFileSync(roundtripCsv, customExport.csv);
    run(process.execPath, ["--input-type=module", "-e",
      'import { readFileSync } from "node:fs"; import { parseCSV } from "pm-csv"; '
      + 'import { reimportCustomFields } from "./packed-custom-fields.mts"; '
      + 'await reimportCustomFields(process.argv[1], process.argv[2], parseCSV(readFileSync(process.argv[3], "utf8")));',
      join(scenarioRoot, ".agents/pm"), join(scenarioRoot, "roundtrip-tracker"), roundtripCsv], scenarioRoot);
    const bundleInput = join(scenarioRoot, "lineage.csv");
    writeFileSync(bundleInput, "title,priority,assignee,excluded\nPacked lineage,2,none,omit\n,9,null,omit\n");
    const firstBundle = join(scenarioRoot, "lineage-first");
    const bundleOutput = runPm(scenario, scenarioRoot, ["--json", "csv", "bundle", bundleInput, "--columns", "title,priority,assignee", "--output", firstBundle]);
    const receipt = JSON.parse(bundleOutput.stdout) as Record<string, unknown>;
    if (receipt.imported !== 1 || receipt.rejected !== 1 || receipt.replayed !== 0) throw new Error(`${scenario.name} lineage import counts differ`);
    const manifest = readFileSync(join(firstBundle, "manifest.json"), "utf8");
    if (manifest.includes("excluded") || manifest.includes('"omit"')) throw new Error(`${scenario.name} lineage disclosed excluded cells`);
    const retryOutput = runPm(scenario, scenarioRoot, ["--json", "csv", "bundle", bundleInput, "--columns", "title,priority,assignee", "--output", join(scenarioRoot, "lineage-replay")]);
    const replay = JSON.parse(retryOutput.stdout) as Record<string, unknown>;
    if (replay.imported !== 0 || replay.replayed !== 1 || replay.rejected !== 1) throw new Error(`${scenario.name} lineage replay duplicated an import`);
    const joinSource = join(scenarioRoot, "scope-joins.json"), joinPlan = join(scenarioRoot, "scope-plan.json");
    writeFileSync(joinSource, JSON.stringify({ version: 1, tables: [{ name: "scope", key: "key",
      csv: "key,title,assignee,sprint,release\na,Scope none,none,null,NONE\nb,Scope null, NuLl ,NONE,null\n",
      fields: { title: "title", assignee: "assignee", sprint: "sprint", release: "release" }, references: [] }] }));
    const joinPreview = JSON.parse(runPm(scenario, scenarioRoot, ["csv", "join", "preview", joinSource, "--output", joinPlan, "--json"]).stdout) as { ok: boolean };
    if (!joinPreview.ok) throw new Error(`${scenario.name} scope preview failed`);
    const joinApplied = JSON.parse(runPm(scenario, scenarioRoot, ["csv", "join", "apply", joinPlan, "--json"]).stdout) as { applied: number };
    const joinReplay = decode(runPm(scenario, scenarioRoot, ["csv", "join", "apply", joinPlan]).stdout) as { unchanged: number };
    if (joinApplied.applied !== 2 || joinReplay.unchanged !== 2) throw new Error(`${scenario.name} native clear aliases did not apply/replay`);
    // This static import resolves the scenario-local host, independently of the development SDK.
    run(process.execPath, ["--input-type=module", "-e",
      'import { get } from "@unbrained/pm-cli/sdk"; import { readFileSync } from "node:fs"; '
      + 'for (const id of JSON.parse(readFileSync(process.argv[2], "utf8")).ids) { '
      + 'const { item } = await get(id, {}, { pmRoot: process.argv[1] }); '
      + 'for (const field of ["parent", "assignee", "sprint", "release"]) if (item[field] !== undefined) throw new Error("Unreviewed scope: " + field); }',
      join(scenarioRoot, ".agents/pm"), joinPlan], scenarioRoot);
    // Reproduce bare local parent replay through each installed CLI and SDK.
    runPm(scenario, scenarioRoot, ["create", "--title", "Packed parent", "--id", "abcd", "--unset", "parent"]);
    const nativeInput = join(scenarioRoot, "native-reference.csv");
    writeFileSync(nativeInput, "title,parent,assignee,sprint,release\r\nPacked bare reference,#ABCD, NuLl ,none,NONE\r\n");
    runPm(scenario, scenarioRoot, ["csv", "import", nativeInput, "--atomic", "--json"]);
    runPm(scenario, scenarioRoot, ["csv", "import", nativeInput, "--atomic"]);
    run(process.execPath, ["--input-type=module", "-e",
      'import assert from "node:assert/strict"; import { create, get, listAllComplete, getHistoryPath } from "@unbrained/pm-cli/sdk"; '
      + 'import { readFileSync } from "node:fs"; import { importCSV, exportEditSession, applyEditSession } from "pm-csv"; '
      + 'const pmRoot = process.argv[1]; const items = await listAllComplete({ full: true }, { pmRoot }); '
      + 'const matches = items.items.filter(item => item.title === "Packed bare reference"); assert.equal(matches.length, 1); const id = matches[0].id; '
      + 'const saved = await get(id, { full: true }, { pmRoot }); '
      + 'const oracle = await create({ title: "SDK parent oracle", parent: "#ABCD" }, { pmRoot }); '
      + 'assert.equal(saved.item.parent, (await get(oracle.item.id, { full: true }, { pmRoot })).item.parent); '
      + 'const checkout = await exportEditSession(pmRoot, [id]); checkout.table[1][checkout.table[0].indexOf("body")] = "\\n\\nEdited packed body  "; '
      + 'assert.equal((await applyEditSession(pmRoot, checkout.session, checkout.table, { author: "packed-acceptance" })).applied, 1); '
      + 'const before = readFileSync(getHistoryPath(pmRoot, id), "utf8"); '
      + 'assert.equal((await applyEditSession(pmRoot, checkout.session, checkout.table, { author: "packed-acceptance" })).unchanged, 1); '
      + 'assert.equal(readFileSync(getHistoryPath(pmRoot, id), "utf8"), before);',
      join(scenarioRoot, ".agents/pm")], scenarioRoot);
    const prototypeSource = join(scenarioRoot, "prototype-types.json");
    writeFileSync(prototypeSource, JSON.stringify({ version: 1, tables: [{ name: "tasks", key: "key",
      csv: "key,title,type\na,Valid,Task\nb,Invalid,constructor\n", fields: { title: "title", type: "type" }, references: [] }] }));
    for (const format of [["--json"], []]) {
      const refused = runPm(scenario, scenarioRoot, ["csv", "join", "preview", prototypeSource, ...format], 2);
      if (!(refused.stdout + refused.stderr).includes("csv_join_invalid")) throw new Error(`${scenario.name} prototype lookup did not use JoinRefusal`);
    }
    run(process.execPath, ["--input-type=module", "-e",
      'import assert from "node:assert/strict"; import { previewJoins, applyJoins, JoinRefusal } from "pm-csv"; '
      + 'import { listAllComplete, locateItem } from "@unbrained/pm-cli/sdk"; const root = process.argv[1]; '
      + 'const input = { version: 1, tables: [{ name: "tasks", key: "key", csv: "key,title\\na,Atomic first\\nb,Atomic second\\nc,Atomic third\\n", fields: { title: "title" }, references: [] }] }; '
      + 'for (const persisted of [false, true]) for (let row = 0; row < 3; row++) { const { plan } = await previewJoins(root, input); '
      + 'const before = (await listAllComplete({}, { pmRoot: root })).items.length; '
      + 'await assert.rejects(applyJoins(root, plan, { author: "packed-acceptance", onBoundary: (phase, id) => { if (!persisted && phase === "before_create" && id === plan.ids[row]) throw new Error("Injected refusal"); }, '
      + 'onTransition: event => { if (persisted && event.transition === "step_applied" && event.stepId === plan.ids[row]) throw new Error("Injected persisted refusal"); } }), error => error instanceof JoinRefusal); '
      + 'assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, before); '
      + 'for (const id of plan.ids) assert.equal(await locateItem(root, id), null); }',
      join(scenarioRoot, ".agents/pm")], scenarioRoot);
    const schemaInput = join(scenarioRoot, "negotiated.csv");
    run(process.execPath, ["--input-type=module", "-e",
      'import assert from "node:assert/strict"; import { previewJoins, applyJoins, JoinRefusal } from "pm-csv"; '
      + 'import { schemaAddStatus, listAllComplete, locateItem, create, get } from "@unbrained/pm-cli/sdk"; const root = process.argv[1]; '
      + 'const input = { version: 1, tables: [{ name: "tasks", key: "key", csv: "key,title\\na,Snapshot first\\nb,Snapshot second\\nc,Snapshot third\\n", fields: { title: "title" }, references: [] }] }; '
      + 'const { plan } = await previewJoins(root, input); const count = (await listAllComplete({}, { pmRoot: root })).items.length; let changed = false; '
      + 'await assert.rejects(applyJoins(root, plan, { author: "packed-acceptance", onTransition: async event => { if (event.transition === "step_applied" && !changed) { changed = true; await schemaAddStatus("snapshot-active", { role: ["active"] }, { pmRoot: root }); } } }), error => error instanceof JoinRefusal && error.code === "csv_join_settings_changed"); '
      + 'assert.equal(changed, true); assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, count); for (const id of plan.ids) assert.equal(await locateItem(root, id), null); '
      + 'await assert.rejects(applyJoins(root, plan, { author: "packed-acceptance" }), error => error instanceof JoinRefusal && error.code === "csv_join_settings_changed"); '
      + 'const oracle = await create({ title: "Snapshot oracle", unset: ["parent"] }, { pmRoot: root }); const expected = (await get(oracle.item.id, {}, { pmRoot: root })).item.status; '
      + 'const fresh = (await previewJoins(root, input)).plan; assert.equal((await applyJoins(root, fresh, { author: "packed-acceptance" })).applied, 3); '
      + 'for (const id of fresh.ids) assert.equal((await get(id, {}, { pmRoot: root })).item.status, expected);',
      join(scenarioRoot, ".agents/pm")], scenarioRoot);
    for (const format of [["--json"], []]) {
      const refused = runPm(scenario, scenarioRoot, ["csv", "join", "apply", join(scenarioRoot, "scope-plan.json"), ...format], 2);
      if (!(refused.stdout + refused.stderr).includes("csv_join_settings_changed")) throw new Error(`${scenario.name} did not preserve the settings refusal family`);
    }
    const identityPlan = join(scenarioRoot, "identity-plan.json");
    run(process.execPath, ["--input-type=module", "-e",
      'import assert from "node:assert/strict"; import { createHash } from "node:crypto"; import { writeFileSync, readFileSync, readdirSync } from "node:fs"; import { join } from "node:path"; '
      + 'import { previewJoins, applyJoins, JoinRefusal, exportEditSession, EditRefusal } from "pm-csv"; import { normalizeItemId, readSettings } from "@unbrained/pm-cli/sdk"; '
      + 'const [root, output] = process.argv.slice(1), prefix = (await readSettings(root)).id_prefix; '
      + 'const input = { version: 1, tables: [{ name: "tasks", key: "key", csv: "key,title\\na,Identity first\\nb,Identity second\\nc,Identity third\\n", fields: { title: "title" }, references: [] }] }; '
      + 'const { plan } = await previewJoins(root, input); const bare = "identityalias"; const { digest, ...base } = { ...plan, ids: [bare, normalizeItemId(bare, prefix), plan.ids[2]] }; '
      + 'const invalid = { ...base, digest: createHash("sha256").update(JSON.stringify(base)).digest("hex") }; '
      + 'const bytes = () => JSON.stringify(readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => [join(e.parentPath, e.name).slice(root.length), readFileSync(join(e.parentPath, e.name)).toString("base64")]).sort()); '
      + 'const before = bytes(); for (let retry = 0; retry < 2; retry++) { await assert.rejects(applyJoins(root, invalid, { author: "packed-acceptance" }), error => error instanceof JoinRefusal && error.code === "csv_join_invalid"); assert.equal(bytes(), before); } '
      + 'await assert.rejects(exportEditSession(root, [normalizeItemId("abcd", prefix), "abcd"]), error => error instanceof EditRefusal && error.code === "csv_session_invalid"); assert.equal(bytes(), before); writeFileSync(output, JSON.stringify(invalid));',
      join(scenarioRoot, ".agents/pm"), identityPlan], scenarioRoot);
    for (const format of [["--json"], []]) {
      const refused = runPm(scenario, scenarioRoot, ["csv", "join", "apply", identityPlan, ...format], 2);
      if (!(refused.stdout + refused.stderr).includes("csv_join_invalid")) throw new Error(`${scenario.name} accepted an aliased native identity plan`);
    }
    const schemaOutput = join(scenarioRoot, "table.schema.json");
    const negotiatedTitle = `Negotiated; ${scenario.name}`;
    writeFileSync(schemaInput, `\uFEFFSummary;priority\r\n"${negotiatedTitle}";2\r\n`);
    runPm(scenario, scenarioRoot, ["csv", "schema", "describe", schemaInput, "--delimiter", "semicolon", "--auto-map", "--output", schemaOutput, "--json"]);
    const schemaPreview = JSON.parse(runPm(scenario, scenarioRoot, ["csv", "schema", "preview", schemaInput, "--schema", schemaOutput, "--json"]).stdout) as Record<string, unknown>;
    const schemaDryRun = JSON.parse(runPm(scenario, scenarioRoot, ["csv", "schema", "import", schemaInput, "--schema", schemaOutput, "--dry-run", "--json"]).stdout) as Record<string, unknown>;
    const afterPreview = runPm(scenario, scenarioRoot, ["csv", "export", "--columns", "title", "--json"]);
    if (schemaPreview.rows !== 1 || schemaDryRun.imported !== 0 || afterPreview.stdout.includes(negotiatedTitle)) throw new Error(`${scenario.name} schema preview mutated the tracker or returned incorrect counts`);
    const schemaImport = JSON.parse(runPm(scenario, scenarioRoot, ["csv", "schema", "import", schemaInput, "--schema", schemaOutput, "--json"]).stdout) as Record<string, unknown>;
    if (schemaImport.imported !== 1) throw new Error(`${scenario.name} negotiated import failed`);
    receipts.push({
      scenario: scenario.name,
      host_version: scenario.hostVersion,
      stdout_bytes: Buffer.byteLength(exported.stdout),
      stderr_bytes: Buffer.byteLength(exported.stderr),
      all_fields_exported: true,
      scope_clear_aliases_replayed: true,
      native_reference_replayed: true,
      prototype_keys_checked: true,
      atomic_compensation: true,
      settings_snapshot_checked: true,
      native_identity_checked: true,
      custom_columns_exported: CUSTOM_FIELDS.length,
      custom_fields_sdk_roundtrip: true,
      created_fixture_present: true,
      imported_fixture_present: true,
      lineage_imported: 1,
      lineage_replayed: 1,
      schema_rows: 1,
      schema_imported: 1,
      schema_dry_run_imported: 0,
    });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, receipts })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

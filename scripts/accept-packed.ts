import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCSV } from "../index.ts";
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
function run(command: string, args: string[], cwd: string): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: cleanEnvironment,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
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
function runPm(scenario: AcceptanceScenario, cwd: string, args: string[]): SpawnSyncReturns<string> {
  return scenario.manager === "npm"
    ? run(npxCommand, ["--no-install", "pm", ...args], cwd)
    : run(bunxCommand, ["--no-install", "pm", ...args], cwd);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "pm-csv-packed-acceptance-"));
try {
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
    writeFileSync(bundleInput, "title,priority,excluded\nPacked lineage,2,omit\n,9,omit\n");
    const firstBundle = join(scenarioRoot, "lineage-first");
    const bundleOutput = runPm(scenario, scenarioRoot, ["--json", "csv", "bundle", bundleInput, "--columns", "title,priority", "--output", firstBundle]);
    const receipt = JSON.parse(bundleOutput.stdout) as Record<string, unknown>;
    if (receipt.imported !== 1 || receipt.rejected !== 1 || receipt.replayed !== 0) throw new Error(`${scenario.name} lineage import counts differ`);
    const manifest = readFileSync(join(firstBundle, "manifest.json"), "utf8");
    if (manifest.includes("excluded") || manifest.includes('"omit"')) throw new Error(`${scenario.name} lineage disclosed excluded cells`);
    const retryOutput = runPm(scenario, scenarioRoot, ["--json", "csv", "bundle", bundleInput, "--columns", "title,priority", "--output", join(scenarioRoot, "lineage-replay")]);
    const replay = JSON.parse(retryOutput.stdout) as Record<string, unknown>;
    if (replay.imported !== 0 || replay.replayed !== 1 || replay.rejected !== 1) throw new Error(`${scenario.name} lineage replay duplicated an import`);
    const schemaInput = join(scenarioRoot, "negotiated.csv");
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

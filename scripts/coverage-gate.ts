/**
 * Coverage gate for the package test suite.
 *
 * Runs `node --test` with the runtime's built-in V8 coverage against the
 * TypeScript sources directly (Node executes `.ts` natively, so the reported
 * line numbers are the ones an author edits, not compiled output), enforces a
 * per-dimension threshold, and reconciles the reported file list against the
 * files actually on disk.
 *
 * That last step is the reason this script exists rather than a bare
 * `node --test --test-coverage-lines=...` invocation. Node only reports files
 * that were loaded during the run: a source module with no test at all is
 * omitted from the report entirely rather than reported at zero. The published
 * percentage is therefore computed over the tested subset, and a package can
 * satisfy a 100% threshold while an entire module goes unexercised. Comparing
 * the report against a directory walk turns that silent omission into a failure
 * naming the missing files, so the threshold cannot be passed by narrowing what
 * the suite touches.
 *
 * Configuration lives in `package.json` under `coverageGate` so the numbers the
 * gate enforces are visible in the same file that declares the scripts, and a
 * threshold change shows up in review as a deliberate diff.
 *
 * @example
 * ```bash
 * node scripts/coverage-gate.ts
 * ```
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Minimum acceptable percentage for each coverage dimension Node reports.
 *
 * Statement coverage is not listed because V8 reports statements as lines; the
 * line figure is the statement figure for this runtime.
 */
interface CoverageThresholds {
  /** Minimum percentage of executable lines that must be covered. */
  readonly lines: number;
  /** Minimum percentage of branch arms that must be taken. */
  readonly branches: number;
  /** Minimum percentage of declared functions that must be invoked. */
  readonly functions: number;
}

/** The `coverageGate` block read from `package.json`. */
interface CoverageGateConfig {
  /**
   * Source locations the gate requires to appear in the report. Each entry is
   * either a directory, which is walked recursively for `.ts` files, or a
   * single file, which lets a package whose entrypoint sits at the repository
   * root declare its sources without dragging in `test/` and `scripts/`.
   */
  readonly sources: readonly string[];
  /** Test file arguments handed to `node --test`. */
  readonly tests: readonly string[];
  /** Threshold enforced on the aggregate report. */
  readonly thresholds: CoverageThresholds;
  /**
   * Source files exempt from the presence check, each of which must be
   * type-only. A module that erases to nothing emits no coverage counters, so
   * requiring it in the report would make the gate unsatisfiable.
   */
  readonly ignore?: readonly string[];
}

/** Shape of the `package.json` fields this script reads. */
interface PackageManifest {
  readonly coverageGate?: CoverageGateConfig;
}

const repoRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageManifest;
const config = manifest.coverageGate;

if (!config) {
  console.error("coverage-gate: package.json has no `coverageGate` block.");
  process.exit(1);
}

/**
 * Collects every TypeScript source file at a configured location.
 *
 * A file entry resolves to itself; a directory entry is walked recursively.
 * Declaration files are skipped either way: they carry no runtime code and so
 * can never appear in a coverage report.
 *
 * @param target - Absolute path to a source file or directory.
 * @returns Repository-relative POSIX paths, in directory order.
 */
function collectSources(target: string): string[] {
  if (!statSync(target).isDirectory()) {
    return [relative(repoRoot, target).split(sep).join("/")];
  }
  const found: string[] = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const full = join(target, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSources(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(relative(repoRoot, full).split(sep).join("/"));
    }
  }
  return found;
}

const expected = config.sources.flatMap((source) => collectSources(join(repoRoot, source)));
const exempt = new Set(config.ignore ?? []);
const required = expected.filter((file) => !exempt.has(file));

if (required.length === 0) {
  console.error("coverage-gate: source walk found no files; check `coverageGate.sources`.");
  process.exit(1);
}

const lcovPath = join(repoRoot, "coverage", "lcov.info");
mkdirSync(join(repoRoot, "coverage"), { recursive: true });

const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--experimental-test-coverage",
    ...config.sources.map((source) =>
      statSync(join(repoRoot, source)).isDirectory()
        ? `--test-coverage-include=${source}/**`
        : `--test-coverage-include=${source}`,
    ),
    `--test-coverage-lines=${config.thresholds.lines}`,
    `--test-coverage-branches=${config.thresholds.branches}`,
    `--test-coverage-functions=${config.thresholds.functions}`,
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcovPath}`,
    ...config.tests,
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

if (result.error) {
  console.error(`coverage-gate: failed to start the test runner: ${result.error.message}`);
  process.exit(1);
}

/**
 * Source files the run actually reported on, read back from the lcov output.
 *
 * A missing or unreadable lcov file means the runner died before writing a
 * report; that is surfaced as an empty set so the presence check below fails
 * loudly rather than treating "no data" as "nothing missing".
 */
const reported = new Set<string>();
try {
  statSync(lcovPath);
  for (const line of readFileSync(lcovPath, "utf8").split("\n")) {
    if (line.startsWith("SF:")) {
      reported.add(line.slice(3).trim().split(sep).join("/"));
    }
  }
} catch {
  console.error(`coverage-gate: no coverage report was written to ${relative(repoRoot, lcovPath)}.`);
  process.exit(1);
}

const missing = required.filter((file) => !reported.has(file));

if (missing.length > 0) {
  console.error(
    [
      "",
      `coverage-gate: ${missing.length} source file(s) never loaded during the run and were`,
      "omitted from the coverage report, so the reported percentages exclude them entirely:",
      ...missing.map((file) => `  - ${file}`),
      "",
      "Import each file from a test (or exercise it through the CLI entrypoint under test).",
      "A file that is genuinely type-only belongs in `coverageGate.ignore` in package.json.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`\ncoverage-gate: ${required.length} source file(s) reported, thresholds met.`);

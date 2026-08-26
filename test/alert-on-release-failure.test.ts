/** Hermetic coverage for the exact release-alert script executed by CI. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/alert-on-release-failure.sh", import.meta.url);
const WORKFLOW = new URL("../.github/workflows/release.yml", import.meta.url);
const REPOSITORY = "unbraind/pm-csv";
type Mode = "fresh" | "existing" | "mutate-fail" | "list-fail";

interface AlertRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: string;
  readonly cleanup: () => void;
}

/** Execute the real alert script with a deterministic `gh` stub on PATH. */
function runAlert(mode: Mode): AlertRun {
  const workspace = mkdtempSync(path.join(tmpdir(), "alert-script-test-"));
  const binDir = path.join(workspace, "bin");
  const logPath = path.join(workspace, "gh-calls.log");
  mkdirSync(binDir);
  const ghPath = path.join(binDir, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env bash
{
  echo "CALL: $*"
  previous=""
  for argument in "$@"; do
    if [[ "$previous" == "--body-file" && -f "$argument" ]]; then
      echo "BODY-BEGIN"
      cat "$argument"
      echo "BODY-END"
    fi
    previous="$argument"
  done
} >> "\${ALERT_GH_LOG}"
if [[ "\${ALERT_GH_MODE}" == "mutate-fail" && "\${1:-}" == "issue" && "\${2:-}" != "list" ]]; then
  exit 1
fi
if [[ "\${ALERT_GH_MODE}" == "list-fail" && "\${1:-}" == "issue" && "\${2:-}" == "list" ]]; then
  exit 1
fi
if [[ "\${ALERT_GH_MODE}" == "existing" && "\${1:-}" == "issue" && "\${2:-}" == "list" ]]; then
  echo 77
fi
exit 0
`);
  chmodSync(ghPath, 0o755);
  const result = spawnSync("bash", [SCRIPT.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      ALERT_GH_LOG: logPath,
      ALERT_GH_MODE: mode,
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "424242",
      GITHUB_SHA: "abc123def4567890abcdef1234567890abcdef12",
      GH_TOKEN: "stub-token",
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    calls: readFileSync(logPath, "utf8"),
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

/** Count calls to a two-word `gh` command in the recorded stub log. */
function countCalls(calls: string, command: string): number {
  return calls.split("\n").filter((line) => line.startsWith(`CALL: ${command} `)).length;
}

/** Extract the final body-file payload recorded by the stub. */
function finalBody(calls: string): string {
  const bodies = calls.match(/BODY-BEGIN\n([\s\S]*?)BODY-END/g);
  assert.ok(bodies, "no body-file payload was recorded");
  return bodies[bodies.length - 1].replace("BODY-BEGIN\n", "").replace(/\nBODY-END$/, "");
}

test("creates one release-failure issue containing the run evidence", () => {
  const run = runAlert("fresh");
  try {
    assert.equal(run.status, 0);
    assert.equal(countCalls(run.calls, "issue create"), 1);
    assert.match(run.calls, /CALL: issue list .*--label release-failure/);
    assert.match(run.calls, /CALL: issue create .*--title Daily Release workflow is failing/);
    assert.match(finalBody(run.calls), new RegExp(`https://github.com/${REPOSITORY}/actions/runs/424242`));
    assert.doesNotMatch(run.stdout, /::warning::/);
  } finally {
    run.cleanup();
  }
});

test("comments on the existing issue instead of opening a duplicate", () => {
  const run = runAlert("existing");
  try {
    assert.equal(run.status, 0);
    assert.equal(countCalls(run.calls, "issue comment"), 1);
    assert.match(run.calls, /^CALL: issue comment 77 --repo /m);
    assert.equal(countCalls(run.calls, "issue create"), 0);
    assert.match(finalBody(run.calls), /actions\/runs\/424242/);
  } finally {
    run.cleanup();
  }
});

test("keeps a failed issue mutation non-blocking and visible", () => {
  const run = runAlert("mutate-fail");
  try {
    assert.equal(run.status, 0);
    assert.match(`${run.stdout}\n${run.stderr}`, /::warning::Could not open or update/);
  } finally {
    run.cleanup();
  }
});

test("does not create a duplicate when the dedup lookup itself fails", () => {
  const run = runAlert("list-fail");
  try {
    assert.equal(run.status, 0);
    assert.equal(countCalls(run.calls, "issue create"), 0);
    assert.equal(countCalls(run.calls, "issue comment"), 0);
    assert.equal(countCalls(run.calls, "label create"), 0);
    assert.match(`${run.stdout}\n${run.stderr}`, /::warning::.*duplicate/);
  } finally {
    run.cleanup();
  }
});

test("release workflow checks out and executes the tracked script", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const jobStart = workflow.indexOf("alert-on-release-failure:");
  assert.notEqual(jobStart, -1);
  const job = workflow.slice(jobStart);
  assert.match(job, /^\s+if: failure\(\) && github\.event_name == 'schedule'$/m);
  assert.match(job, /^\s+group: release-failure-alert-\$\{\{ github\.repository \}\}$/m);
  assert.match(job, /^\s+cancel-in-progress: false$/m);
  assert.match(job, /^\s+uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7$/m);
  assert.match(job, /^\s+ref: \$\{\{ github\.event\.repository\.default_branch \}\}$/m);
  assert.match(job, /^\s+persist-credentials: false$/m);
  assert.match(job, /^\s+run: bash scripts\/alert-on-release-failure\.sh$/m);
});

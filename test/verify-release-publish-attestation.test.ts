/**
 * Convergence tests for the publish-attestation gate.
 *
 * This repository no longer implements the gate; it consumes the canonical
 * auditor from `pm-ops/attestation`. So these tests deliberately do NOT
 * re-test the shell model - that suite lives with the implementation, where a
 * fix reaches every consumer at once. What they assert instead is that this
 * repository is still a consumer: that the gate resolves to the package export
 * rather than to a local copy, and that it still refuses an unattested publish
 * through that resolved path.
 *
 * The first is the one that matters over time. Fifteen fail-open constructions
 * have been found in this gate, three of them introduced by the fix for an
 * earlier one, and a copy frozen at any point in that sequence still admits
 * every construction closed after it. A hand-edit that re-forks the lineage
 * would otherwise be invisible.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { auditPublishAttestation, report, verify } from "pm-ops/attestation";

import { runIfMain } from "../scripts/verify-release-publish-attestation.ts";

const root = resolve(import.meta.dirname, "..");

test("the gate is the resolved package export, not a local copy", async () => {
  // Identity, not similarity. A vendored copy that happens to behave the same
  // today is exactly what this fleet spent a session removing, because it stops
  // behaving the same the moment the canonical implementation is fixed again.
  assert.equal(
    existsSync(resolve(root, "scripts/shell-command-scan.ts")),
    false,
    "a local shell-command-scan.ts means the lineage has been re-forked",
  );

  const launcher = await readFile(resolve(root, "scripts/verify-release-publish-attestation.ts"), "utf-8");
  assert.match(launcher, /from "pm-ops\/attestation"/u, "the gate must import the canonical auditor");
  assert.doesNotMatch(
    launcher,
    /from "\.\/shell-command-scan/u,
    "the gate must not resolve any part of its shell model locally",
  );

  // The functions the launcher runs are the package's own, by reference.
  assert.equal(typeof verify, "function");
  assert.equal(typeof report, "function");
});

test("the resolved gate still refuses an unattested publish", () => {
  // A behavioural check through the real resolved module, so "it imports the
  // package" cannot pass while the package fails to load or changes shape.
  const workflow = (publish: string): string =>
    ["jobs:", "  release:", "    steps:", "      - run: |", `          ${publish}`].join("\n");

  const unattested = auditPublishAttestation([
    { file: ".github/workflows/release.yml", text: workflow("npm publish --access public") },
  ]);
  assert.equal(unattested.failures.length, 1);

  const attested = auditPublishAttestation([
    { file: ".github/workflows/release.yml", text: workflow("npm publish --access public --provenance") },
  ]);
  assert.deepEqual(attested.failures, []);
  assert.deepEqual(attested.recognition, { kind: "recognized", count: 1 });
});

test("this repository's own workflows pass the gate", () => {
  // The gate pointed at this checkout, which is what CI runs. Reported through
  // captured streams rather than the process ones so a failure is readable.
  const lines: string[] = [];
  let exitCode = 0;
  report(verify(root), (line) => lines.push(line), (code) => { exitCode = code; });
  assert.equal(exitCode, 0, `the gate must pass on this repository:\n${lines.join("\n")}`);
  assert.ok(lines.some((line) => line.includes("every publish invocation is attested")));
});

test("the launcher runs only as the process entry point", () => {
  // A bare `if` at module scope leaves its own body unreachable from any
  // in-process test, which is how an entry point quietly stops running.
  // A real path that is not this module: isMainInvocation resolves the argv
  // entry, so a nonexistent one throws rather than answering the question.
  assert.equal(runIfMain(["node", resolve(root, "package.json")], import.meta.url, root), false);
});

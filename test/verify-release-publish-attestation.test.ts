/**
 * Executes the publish-attestation verifier's rules against fixtures.
 *
 * The verifier's own repository satisfies its rules, so running it here would
 * only prove that today's tree is fine. What these cases prove is that each
 * rule still FAILS on the defect it exists to catch -- an unattested publish
 * reachable from the release workflow -- and that the two shapes which make a
 * naive substring scan useless are handled: a publish spelled across a line
 * continuation, and a prose mention of the command inside a quoted string.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import {
  ATTESTATION_FLAG,
  attestationEnabled,
  auditPublishAttestation,
  isExecutableSource,
  isPublishCommand,
  manifestCommandLines,
  publishInvocationsIn,
  report,
  renderCommand,
  runIfMain,
  trackedPublishSources,
  verify,
} from "../scripts/verify-release-publish-attestation.ts";
import { commandArguments, commandCandidates, commandName, expandScalars, shellScalars, tokenizeCommands } from "../scripts/shell-command-scan.ts";

/** Tokenises one command and returns it, asserting the text held exactly one. */
function onlyCommand(text: string): ReturnType<typeof tokenizeCommands>[number] {
  const commands = tokenizeCommands(text);
  assert.equal(commands.length, 1, `expected one command in ${JSON.stringify(text)}`);
  return commands[0]!;
}

const ATTESTED = `npm publish --access public ${ATTESTATION_FLAG} --ignore-scripts`;
const UNATTESTED = "npm publish --access public --ignore-scripts";

/** Builds a throwaway git repository holding the given tracked files. */
function trackedFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "attestation-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

test("an unattested publish fails, naming the command that would run", () => {
  const result = auditPublishAttestation([{ file: "release.yml", text: `          ${UNATTESTED}` }]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /does not enable --provenance/);
  assert.match(result.failures[0]!, /npm publish --access public --ignore-scripts/);
});

test("an attested publish passes and is reported by file", () => {
  const result = auditPublishAttestation([{ file: "release.yml", text: `          ${ATTESTED}` }]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.notes, [`ok - release.yml: 1 publish invocation(s), each carrying ${ATTESTATION_FLAG}`]);
});

test("a file holding both an attested and an unattested publish fails, so one cannot cover for the other", () => {
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          ${ATTESTED}\n          ${UNATTESTED}` },
  ]);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.notes, [], "a file with an unattested publish must not also be reported as ok");
});

test("two publishes chained on one line are judged separately", () => {
  // Judging the line as a whole would let the flag on the first call satisfy
  // the second, which is exactly the shape a line-oriented scan misses.
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          ${ATTESTED} && ${UNATTESTED}` },
  ]);
  assert.equal(result.failures.length, 1);
});

test("a publish spelled across a line continuation is still seen with its flag", () => {
  const result = auditPublishAttestation([
    { file: "release.yml", text: "          npm publish --access public \\\n            --provenance --ignore-scripts" },
  ]);
  assert.deepEqual(result.failures, []);
});

test("a shared bash array holding the flag is expanded rather than read as an absent flag", () => {
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          flags=( --access public ${ATTESTATION_FLAG} )\n          npm publish "\${flags[@]}"` },
  ]);
  assert.deepEqual(result.failures, []);
});

test("a prose mention of the command inside quotes is not treated as an invocation", () => {
  // This repository's own workflow echoes advice naming the command. Reading
  // that echo as a publish makes the gate report a defect that is not there,
  // and a gate that cries wolf gets weakened until it reports nothing.
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          echo "The trusted publisher must have 'npm publish' selected."` },
  ]);
  assert.deepEqual(result.failures, ["no npm publish invocation was found in any tracked file - the scan is looking in the wrong place"]);
});

test("a commented-out publish is not treated as an invocation", () => {
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          # ${UNATTESTED}\n          ${ATTESTED}` },
  ]);
  assert.deepEqual(result.failures, []);
});

test("a trailing unquoted comment cannot supply the flag the command lacks", () => {
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          ${UNATTESTED}  # ${ATTESTATION_FLAG}` },
  ]);
  assert.equal(result.failures.length, 1);
});

test("a disabled attestation is not an attestation, in every spelling npm accepts", () => {
  // Greptile P2: a containment check accepts `--provenance=false`, which is
  // precisely the regression this gate exists to catch, and reports the file
  // as attested while doing it.
  for (const disabled of ["--provenance=false", "--no-provenance", "--provenance --no-provenance", "--provenance=0"]) {
    assert.equal(attestationEnabled(onlyCommand(`npm publish --access public ${disabled}`)), false, disabled);
    assert.equal(
      auditPublishAttestation([{ file: "release.yml", text: `          npm publish --access public ${disabled}` }]).failures.length,
      1,
      disabled,
    );
  }
  for (const enabled of ["--provenance", "--provenance=true", "--no-provenance --provenance"]) {
    assert.equal(attestationEnabled(onlyCommand(`npm publish --access public ${enabled}`)), true, enabled);
  }
});

test("a flag that merely starts with the attestation spelling does not enable it", () => {
  assert.equal(attestationEnabled(onlyCommand("npm publish --provenance-file x")), false);
});

test("a publish hidden in an npm script is found, because a manifest is JSON and its scripts are quoted", () => {
  // CodeRabbit: quoted spans are erased before a command is judged, which is
  // what stops the workflow's advisory echo reading as an invocation. Applied
  // to a manifest that erases the script bodies themselves, so a publish moved
  // into an npm script would be invisible while being entirely real.
  const manifest = JSON.stringify({ scripts: { release: UNATTESTED, build: "tsc" } });
  const result = auditPublishAttestation([{ file: "package.json", text: manifest }]);
  assert.equal(result.failures.length, 1, "an unattested publish in a script must fail");
  assert.match(result.failures[0]!, /does not enable --provenance/);
  const attested = JSON.stringify({ scripts: { release: ATTESTED } });
  assert.deepEqual(auditPublishAttestation([{ file: "package.json", text: attested }]).failures, []);
});

test("manifestCommandLines survives a manifest that is malformed, empty, or has no scripts", () => {
  // A malformed sibling manifest must not take the gate down; its own tooling
  // reports that far better than a publish audit can.
  assert.equal(manifestCommandLines("{ not json"), "");
  assert.equal(manifestCommandLines("null"), "");
  assert.equal(manifestCommandLines("[]"), "");
  assert.equal(manifestCommandLines("{}"), "");
  assert.equal(manifestCommandLines(JSON.stringify({ scripts: null })), "");
  assert.equal(manifestCommandLines(JSON.stringify({ scripts: "not-an-object" })), "");
  assert.equal(manifestCommandLines(JSON.stringify({ scripts: { a: "x", b: 3, c: "y" } })), "x\ny");
});

test("a publish with configuration flags before the subcommand is still a publish", () => {
  // Greptile: npm accepts its flags anywhere on the line, so requiring `publish`
  // to follow `npm` immediately discards a real unattested publish silently --
  // and an attested sibling elsewhere in the file then carries the audit to a
  // pass.
  const spread = "npm --access public publish --ignore-scripts";
  assert.equal(isPublishCommand(onlyCommand(spread)), true);
  const result = auditPublishAttestation([
    { file: "release.yml", text: `          ${ATTESTED}\n          ${spread}` },
  ]);
  assert.equal(result.failures.length, 1, "the unattested sibling must be counted and failed");
});

test("npm run publish is a script runner, not a publish", () => {
  // The script's own body is scanned from the manifest, so requiring the flag
  // on the runner would report a defect that is not there.
  assert.equal(isPublishCommand(onlyCommand("npm run publish")), false);
  assert.equal(isPublishCommand(onlyCommand("npm run-script publish")), false);
  assert.equal(isPublishCommand(onlyCommand("npm publish")), true);
  assert.equal(isPublishCommand(onlyCommand("npm ci")), false);
  assert.equal(isPublishCommand(onlyCommand("npm exec publish")), false, "exec runs a binary, it does not publish");
  assert.equal(isPublishCommand(onlyCommand("npm --access public publish")), true, "a flag value is not the subcommand");
  assert.equal(isPublishCommand(onlyCommand("npm --ignore-scripts publish")), true);
});

test("finding no publish at all fails, because an empty scan and a clean tree look identical", () => {
  const result = auditPublishAttestation([{ file: "release.yml", text: "          npm ci\n" }]);
  assert.deepEqual(result.failures, ["no npm publish invocation was found in any tracked file - the scan is looking in the wrong place"]);
});

test("only a command in command position is a publish, whatever else names npm", () => {
  // CodeRabbit: searching a whole line for the word `npm` classified an
  // announcement as an invocation and then failed it for lacking a flag no
  // announcement could carry. What decides the question is command POSITION.
  for (const mention of ["echo notnpm publish", "echo npm publish", "printf npm publish", "notnpm publish", "xnpm publish --access public"]) {
    assert.deepEqual(
      publishInvocationsIn({ file: "release.yml", text: `          ${mention}\n` }),
      [],
      mention,
    );
  }
  // The same words in command position, with a wrapper and a full path, are.
  for (const real of ["npm publish --provenance", "/usr/local/bin/npm publish --provenance", "env CI=1 npm publish --provenance", "NPM_CONFIG_LOGLEVEL=silly npm publish --provenance"]) {
    assert.equal(publishInvocationsIn({ file: "release.yml", text: `          ${real}\n` }).length, 1, real);
  }
});

test("quoting a flag does not hide it, because the shell strips quotes before npm sees them", () => {
  // CodeRabbit/Greptile: the scan blanked quoted spans, so an attested publish
  // written with a quoted flag read as unattested -- and, far worse, a publish
  // written inside a quoted string vanished from the audit entirely.
  for (const quoted of [
    `npm publish --access public "${ATTESTATION_FLAG}"`,
    `npm publish --access public '${ATTESTATION_FLAG}'`,
    `npm publish --access public --provenance"" `,
    `npm publish "--access" public ${ATTESTATION_FLAG}`,
  ]) {
    assert.deepEqual(auditPublishAttestation([{ file: "release.yml", text: `          ${quoted}` }]).failures, [], quoted);
  }
});

test("an unattested publish smuggled through an interpreter or a substitution is still found", () => {
  // Greptile P1 and CodeRabbit: `eval`, `bash -c` and `$(...)` payloads are
  // shell text. The previous scan blanked them as quoted spans, so each of
  // these published without an attestation while the workflow's own attested
  // publish carried the audit to green.
  for (const smuggled of [
    `eval "${UNATTESTED}"`,
    `eval '${UNATTESTED}'`,
    `bash -c "${UNATTESTED}"`,
    `sh -c '${UNATTESTED}'`,
    `output=$(${UNATTESTED})`,
    "output=`npm publish --access public`",
    `echo hi && eval "${UNATTESTED}"`,
  ]) {
    const failures = auditPublishAttestation([
      { file: "release.yml", text: `          ${ATTESTED}\n          ${smuggled}` },
    ]).failures;
    assert.equal(failures.length, 1, `${smuggled} -> ${JSON.stringify(failures)}`);
  }
});

test("every shell separator ends a command, so a flagged publish cannot cover an unflagged neighbour", () => {
  // The previous split knew `&&`, `||`, `;` and a space-surrounded `|` only, so
  // a backgrounding `&` and a compact pipe fused two commands into one line
  // that the flagged half then made pass.
  for (const separator of ["&&", "||", ";", " | ", "|", "&", "\n"]) {
    const text = `          ${ATTESTED} ${separator} ${UNATTESTED}`;
    assert.equal(
      auditPublishAttestation([{ file: "release.yml", text }]).failures.length,
      1,
      `separator ${JSON.stringify(separator)}`,
    );
  }
});

test("a publisher other than npm is refused rather than searched for a flag it has no equivalent of", () => {
  for (const publisher of ["yarn", "pnpm", "bun"]) {
    const result = auditPublishAttestation([
      { file: "release.yml", text: `          ${ATTESTED}\n          ${publisher} publish --access public` },
    ]);
    assert.equal(result.failures.length, 1, publisher);
    assert.match(result.failures[0]!, new RegExp(`\\\`${publisher} publish\\\``));
  }
});

test("npm accepts a boolean value as a separate word, and so must this", () => {
  // CodeRabbit: npm's option parser takes `--provenance false`. Reading only
  // `--provenance` there reports an attestation the publish does not carry.
  assert.equal(attestationEnabled(onlyCommand("npm publish --provenance false")), false);
  assert.equal(attestationEnabled(onlyCommand("npm publish --provenance true")), true);
  assert.equal(attestationEnabled(onlyCommand("npm publish --provenance --access public")), true, "a following flag is not a value");
  assert.equal(attestationEnabled(onlyCommand("npm publish --provenance false --provenance")), true, "the last spelling wins");
});

test("tokenizeCommands resolves quoting, comments and escapes the way a shell does", () => {
  assert.deepEqual(onlyCommand(`a "b c" d`).map((token) => token.value), ["a", "b c", "d"]);
  assert.deepEqual(onlyCommand("a 'b  c'").map((token) => token.value), ["a", "b  c"]);
  assert.deepEqual(onlyCommand("a\\ b").map((token) => token.value), ["a b"], "an escaped space joins one word");
  assert.deepEqual(onlyCommand('x "a\\"b"').map((token) => token.value), ["x", 'a"b'], "an escaped quote stays in the word");
  assert.deepEqual(tokenizeCommands("# only a comment"), []);
  assert.deepEqual(onlyCommand("npm ci # trailing comment").map((token) => token.value), ["npm", "ci"]);
  assert.deepEqual(tokenizeCommands("a\\"), [[{ value: "a", quoted: false, startsQuoted: false }]], "a trailing backslash does not read past the end");
  assert.deepEqual(tokenizeCommands("echo 'unterminated").map((c) => c.map((t) => t.value)), [["echo", "unterminated"]]);
  assert.equal(onlyCommand('cmd "unterminated')[1]!.quoted, true);
  assert.deepEqual(commandArguments(onlyCommand("env A=1 npm publish")).map((token) => token.value), ["publish"]);
  assert.equal(commandName([]), undefined);
  assert.equal(commandName(onlyCommand("A=1 B=2")), undefined, "assignments alone run no command");
  assert.equal(commandName(onlyCommand("'npm' publish")), "npm", "a quoted program name still runs it");
  // startsQuoted, not quoted, is what separates an assignment from a literal
  // that merely looks like one: the shell assigns for the first and not the
  // second, and only the second begins inside quotes.
  assert.equal(onlyCommand('A="b c" npm')[0]!.startsQuoted, false, "a quoted VALUE still starts unquoted");
  assert.equal(onlyCommand('"A=b" npm')[0]!.startsQuoted, true, "a wholly quoted word starts quoted");
  assert.equal(onlyCommand("'A=b' npm")[0]!.startsQuoted, true);
  assert.equal(onlyCommand("\\A=b npm")[0]!.startsQuoted, false, "an escape is not a quote");
  assert.equal(commandName(onlyCommand('NPM_CONFIG_REGISTRY="https://r.example" npm publish')), "npm");
  assert.equal(commandName(onlyCommand('"A=b" publish')), "A=b", "a quoted literal is the program, not an assignment");
});

test("every reading of a wrapper-led command is offered, so an unknown option value cannot hide a program", () => {
  // commandName answers once and is right to; an auditor cannot afford that,
  // because `-u` takes a value and nothing here enumerates which options do.
  const values = (command: ReturnType<typeof onlyCommand>) =>
    commandCandidates(command).map((candidate) => commandName(candidate));
  assert.deepEqual(values(onlyCommand("sudo -u root npm publish")), ["root", "npm", "publish"]);
  assert.deepEqual(values(onlyCommand("nice -n 10 npm publish")), ["10", "npm", "publish"]);
  // No wrapper means exactly one reading, so ordinary commands are untouched.
  assert.deepEqual(values(onlyCommand("npm publish --provenance")), ["npm"]);
  assert.deepEqual(values(onlyCommand("echo npm publish")), ["echo"]);
  // A command that is nothing but a wrapper offers no reading at all.
  assert.deepEqual(commandCandidates(onlyCommand("sudo")), []);
  assert.deepEqual(commandCandidates([]), []);
  // A reading that is only assignments names no program, and is skipped rather
  // than audited as one.
  // A trailing reading that is only assignments names no program, so it is
  // skipped rather than audited as one.
  assert.deepEqual(values(onlyCommand("sudo -u root npm publish A=1")), ["root", "npm", "publish", undefined]);
  assert.deepEqual(
    publishInvocationsIn({ file: "release.yml", text: "          sudo -u root npm publish --provenance A=1\n" }).length,
    1,
  );
});

test("two identical publish lines are two findings, not one", () => {
  // Collapsing them would report one invocation as if the other did not exist,
  // and an operator reading "1 unattested publish" would fix half the file.
  const result = auditPublishAttestation([
    { file: "release.yml", text: "          npm publish\n          npm publish\n" },
  ]);
  assert.equal(result.failures.length, 2);
});

test("a substitution inside double quotes is scanned, because the shell runs it before the quotes matter", () => {
  // `"$(npm publish)"` looks like one quoted word and is a real invocation.
  // Treating the quoting as decisive is exactly how the previous scan lost it.
  for (const smuggled of [
    `message="$(${UNATTESTED})"`,
    "message=\"`npm publish --access public`\"",
    `message="prefix $(${UNATTESTED}) suffix"`,
  ]) {
    const failures = auditPublishAttestation([
      { file: "release.yml", text: `          ${ATTESTED}\n          ${smuggled}` },
    ]).failures;
    assert.equal(failures.length, 1, `${smuggled} -> ${JSON.stringify(failures)}`);
  }
});

test("unterminated and nested substitutions terminate instead of reading past the end", () => {
  // A substitution's OUTPUT is not knowable here, so it contributes an empty
  // word to the command that contained it while its body is scanned as
  // commands in its own right. What matters is that neither shape loops or
  // swallows the rest of the file.
  const words = (text: string): string[][] => tokenizeCommands(text).map((command) => command.map((token) => token.value));
  assert.deepEqual(words('cmd "abc\\'), [["cmd", "abc"]], "a trailing backslash inside quotes stops at the end");
  assert.deepEqual(words('cmd "a\\\nb"'), [["cmd", "ab"]], "an escaped newline inside quotes continues the word");
  assert.deepEqual(words("cmd a\\\nb"), [["cmd", "ab"]], "and outside quotes too");
  assert.deepEqual(words("cmd $("), [["cmd", ""]], "an unterminated substitution yields an empty word and no command");
  assert.deepEqual(words("cmd `unterminated"), [["cmd", ""], ["unterminated"]], "an unterminated backtick still scans its body");
  assert.deepEqual(words("a $(echo $(npm publish)) b"), [["a", "", "b"], ["echo", ""], ["npm", "publish"]], "nesting is counted, so the inner command survives");
  assert.deepEqual(words("a $(echo \\) x) b"), [["a", "", "b"], ["echo", ")", "x"]], "an escaped paren does not close the substitution");
});

test("a tracked path that cannot be opened is skipped rather than taking the gate down", () => {
  const root = trackedFixture({
    ".github/workflows/release.yml": `          ${ATTESTED}`,
  });
  try {
    symlinkSync("nowhere-at-all", join(root, "dangling"));
    execFileSync("git", ["add", "dangling"], { cwd: root });
    assert.ok(!trackedPublishSources(root).includes("dangling"), "an unreadable tracked file is not a publish source");
    assert.deepEqual(verify(root).failures, [], "and it does not fail the gate either");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluator recursion is bounded, so hostile nesting cannot hang the gate", () => {
  let text = UNATTESTED;
  // Escape backslashes before quotes. Escaping only the quote leaves a literal
  // backslash in the payload able to consume the escape that follows it, so the
  // nesting this test builds would not be the nesting it asserts on.
  for (let depth = 0; depth < 12; depth += 1) {
    text = `eval "${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  assert.deepEqual(tokenizeCommands(text, 9), [], "past the bound the walk stops rather than recursing");
  assert.ok(tokenizeCommands(`eval "${UNATTESTED}"`).length > 1, "within the bound the payload is still scanned");
});

test("renderCommand joins the resolved tokens and caps the length of a report line", () => {
  assert.equal(renderCommand(onlyCommand(`npm publish "--access" public`)), "npm publish --access public");
  assert.equal(renderCommand(onlyCommand(`npm publish ${"x".repeat(400)}`)).length, 160);
});

test("trackedPublishSources asks git, so an untracked workflow copy cannot satisfy the gate", () => {
  const root = trackedFixture({
    ".github/workflows/release.yml": `          ${ATTESTED}`,
    "package.json": "{}",
  });
  try {
    writeFileSync(join(root, ".github/workflows/scratch.yml"), `          ${UNATTESTED}`);
    assert.deepEqual(trackedPublishSources(root).sort(), [".github/workflows/release.yml", "package.json"]);
    assert.deepEqual(verify(root).failures, [], "the untracked scratch copy must not be judged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a publish in any tracked executable is audited, not only workflows and the manifest", () => {
  // Greptile P1: the enumeration named `.github/workflows` and `package.json`,
  // so a publish added to a tracked script was never read -- and because the
  // workflow's own attested publish satisfied the non-vacuity check, the gate
  // reported that every invocation was attested.
  const root = trackedFixture({
    ".github/workflows/release.yml": `          ${ATTESTED}`,
    "package.json": "{}",
    "scripts/ship.sh": `#!/usr/bin/env bash\n${UNATTESTED}\n`,
  });
  try {
    assert.ok(trackedPublishSources(root).includes("scripts/ship.sh"));
    const failures = verify(root).failures;
    assert.equal(failures.length, 1, JSON.stringify(failures));
    assert.match(failures[0]!, /scripts\/ship\.sh/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an extensionless tracked script is audited when its shebang says it executes", () => {
  const root = trackedFixture({
    ".github/workflows/release.yml": `          ${ATTESTED}`,
    "tools/release": `#!/bin/sh\n${UNATTESTED}\n`,
    "docs/notes": `${UNATTESTED}\n`,
  });
  try {
    const sources = trackedPublishSources(root);
    assert.ok(sources.includes("tools/release"), "a shebang marks an executable source");
    assert.ok(!sources.includes("docs/notes"), "prose without a shebang is not a publish path");
    assert.equal(verify(root).failures.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("committed build output is not audited, because it is generated from sources already read", () => {
  const root = trackedFixture({
    ".github/workflows/release.yml": `          ${ATTESTED}`,
    "dist/bundle.sh": `#!/bin/sh\n${UNATTESTED}\n`,
  });
  try {
    assert.deepEqual(trackedPublishSources(root), [".github/workflows/release.yml"]);
    assert.deepEqual(verify(root).failures, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isExecutableSource recognises the shapes that can run a command", () => {
  for (const path of [".github/workflows/ci.yml", ".github/workflows/ci.yaml", "package.json", "web/package.json", "x.sh", "Makefile", "build/rules.mk", "Dockerfile", "Dockerfile.ci", "docker-compose.yml", "docker-compose.prod.yaml"]) {
    assert.equal(isExecutableSource(path, ""), true, path);
  }
  for (const path of ["README.md", "src/index.ts", ".github/dependabot.yml", "package.json.bak"]) {
    assert.equal(isExecutableSource(path, ""), false, path);
  }
  assert.equal(isExecutableSource("tools/release", "#!/bin/sh"), true, "a shebang overrides the shape");
  assert.equal(isExecutableSource("dist/bundle.sh", "#!/bin/sh"), false, "build output is excluded first");
  assert.equal(isExecutableSource("coverage/x.sh", ""), false);
});

test("verify reads the tracked files and fails on an unattested one", () => {
  const root = trackedFixture({ ".github/workflows/release.yml": `          ${UNATTESTED}`, "package.json": "{}" });
  try {
    assert.equal(verify(root).failures.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report prints notes then failures and asks for a failing exit code", () => {
  const lines: string[] = [];
  const codes: number[] = [];
  report({ failures: ["bad"], notes: ["fine"] }, (line) => lines.push(line), (code) => codes.push(code));
  assert.deepEqual(lines, ["fine", "FAIL - bad", "verify-release-publish-attestation: 1 failure(s)."]);
  assert.deepEqual(codes, [1]);
});

test("report on a clean result says so and asks for no exit code", () => {
  const lines: string[] = [];
  const codes: number[] = [];
  report({ failures: [], notes: [] }, (line) => lines.push(line), (code) => codes.push(code));
  assert.deepEqual(lines, ["verify-release-publish-attestation: every publish invocation is attested."]);
  assert.deepEqual(codes, []);
});

test("runIfMain runs only as the entry point, and reports when it does", () => {
  const root = trackedFixture({ ".github/workflows/release.yml": `          ${ATTESTED}`, "package.json": "{}" });
  const previous = process.exitCode;
  try {
    // isMainInvocation canonicalises both sides, so a non-entry argument must
    // name a file that exists; a missing path is a different failure entirely.
    assert.equal(runIfMain(["node", "scripts/main-invocation.ts"], pathToFileURL(resolve("scripts/verify-release-publish-attestation.ts")).href, root), false);
    assert.equal(
      runIfMain(
        ["node", "scripts/verify-release-publish-attestation.ts"],
        pathToFileURL(resolve("scripts/verify-release-publish-attestation.ts")).href,
        root,
      ),
      true,
    );
    assert.equal(process.exitCode, previous, "an attested tree must not set a failing exit code");
    const failing = trackedFixture({ ".github/workflows/release.yml": `          ${UNATTESTED}`, "package.json": "{}" });
    try {
      runIfMain(
        ["node", "scripts/verify-release-publish-attestation.ts"],
        pathToFileURL(resolve("scripts/verify-release-publish-attestation.ts")).href,
        failing,
      );
      assert.equal(process.exitCode, 1, "an unattested tree must set a failing exit code");
    } finally {
      rmSync(failing, { recursive: true, force: true });
    }
  } finally {
    process.exitCode = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package runner is a wrapper, so the publish behind its own options is still audited", () => {
  // Greptile raised the wrapper class generally: a publish reached through an
  // interpreter or a runner escapes a scan that reads only the first word. The
  // runners differ from `env` and `sudo` in that they carry their own options
  // before the program, so skipping the wrapper word alone is not enough.
  for (const wrapped of [
    "npx npm publish --provenance",
    "npx --yes npm publish --provenance",
    "bunx --bun npm publish --provenance",
    "pnpx -y npm publish --provenance",
  ]) {
    assert.equal(
      publishInvocationsIn({ file: "release.yml", text: `          ${wrapped}\n` }).length,
      1,
      wrapped,
    );
  }
  // The same shape without the flag must fail, or the pass above proves nothing.
  assert.equal(
    auditPublishAttestation([{ file: "release.yml", text: "          npx --yes npm publish\n" }])
      .failures.length,
    1,
  );
});

test("a runner spelled as two words is consumed only when its second word completes it", () => {
  for (const wrapped of ["pnpm dlx npm publish --provenance", "yarn exec npm publish --provenance", "bun x npm publish --provenance"]) {
    assert.equal(
      publishInvocationsIn({ file: "release.yml", text: `          ${wrapped}\n` }).length,
      1,
      wrapped,
    );
  }
  // Consuming the head word unconditionally would re-point an unrelated command
  // at its first argument, so a non-matching second word leaves it alone.
  assert.equal(commandName(onlyCommand("pnpm install npm publish")), "pnpm");
  assert.equal(commandName(onlyCommand("pnpm")), "pnpm");
  assert.equal(commandName(onlyCommand("bun run build")), "build");
  // And the unflagged two-word form must still fail.
  assert.equal(
    auditPublishAttestation([{ file: "release.yml", text: "          pnpm dlx npm publish\n" }])
      .failures.length,
    1,
  );
});

test("an option in first position names the command it is written on, not one of its arguments", () => {
  // Skipping option words is bounded to wrappers on purpose. Were it
  // unconditional, a command whose own first word is an option would be
  // re-pointed at an argument, and `--flag npm publish` would read as a publish
  // that nothing in the tree actually runs.
  assert.equal(commandName(onlyCommand("--yes npm publish")), "--yes");
  assert.deepEqual(
    commandArguments(onlyCommand("--yes npm publish")).map((token) => token.value),
    ["npm", "publish"],
  );
  // A wrapper with nothing after it names no program rather than throwing.
  assert.equal(commandName(onlyCommand("npx")), undefined);
  assert.deepEqual(commandArguments(onlyCommand("npx")), []);
  // A quoted option after a wrapper is a literal argument, not the wrapper's flag.
  assert.equal(commandName(onlyCommand(`npx "--yes"`)), "--yes");
});

test("a redirection and its target are not command words", () => {
  // Greptile: `> /dev/null npm publish` runs npm, but a scan reading words in
  // order sees `>` as the program and audits nothing.
  const cases = [
    "> /dev/null npm publish",
    ">/dev/null npm publish",
    "2>/dev/null npm publish",
    "2> /dev/null npm publish",
    "&> /dev/null npm publish",
    "npm publish > /dev/null",
    "npm publish 2>&1",
  ];
  for (const text of cases) {
    assert.equal(commandName(onlyCommand(text)), "npm", text);
  }
  // The publish is still audited beside an attested sibling, which is the shape
  // that made this a bypass rather than a curiosity.
  const withSibling = {
    file: "release.yml",
    text: "          npm publish --provenance\n          > /dev/null npm publish\n",
  };
  assert.equal(auditPublishAttestation([withSibling]).failures.length, 1);
});

test("a shell keyword introduces a command rather than being one", () => {
  for (const text of ["if npm publish", "while npm publish", "until npm publish", "! npm publish"]) {
    assert.equal(commandName(onlyCommand(text)), "npm", text);
  }
  // `npm exec` is a runner like `pnpm dlx`, with or without the `--` separator.
  assert.equal(commandName(onlyCommand("npm exec -- npm publish")), "npm");
  assert.equal(
    auditPublishAttestation([{
      file: "release.yml",
      text: "          npm publish --provenance\n          if npm publish; then echo ok; fi\n",
    }]).failures.length,
    1,
  );
});

test("a command held in a scalar is expanded, so the assignment is where the publish is found", () => {
  const scalars = shellScalars('CMD="npm publish"\nOTHER=\'npm publish --provenance\'\nBARE=npm\n');
  assert.equal(scalars.get("CMD"), "npm publish");
  assert.equal(scalars.get("OTHER"), "npm publish --provenance");
  assert.equal(scalars.get("BARE"), undefined, "an unquoted value cannot hold a command");
  assert.equal(expandScalars("$CMD", scalars), "npm publish");
  assert.equal(expandScalars("${CMD}", scalars), "npm publish");
  assert.equal(expandScalars("$UNKNOWN", scalars), "$UNKNOWN", "an unknown name is left in place, not erased");
  assert.equal(
    auditPublishAttestation([{
      file: "release.yml",
      text: '          npm publish --provenance\n          CMD="npm publish"\n          $CMD\n',
    }]).failures.length,
    1,
  );
});

test("a workflow key carries the command as its value, and is not the command", () => {
  // Workflow files are scanned as raw text, so a YAML key is a word like any
  // other: `run: npm publish` read `run:` as the program and audited nothing.
  assert.equal(commandName(onlyCommand("run: npm publish")), "npm");
  assert.equal(commandName(onlyCommand("- run: npm publish")), "npm");
  // Only a LEADING key is consumed, so an argument that ends in a colon is not.
  assert.equal(commandName(onlyCommand("echo label:")), "echo");
  assert.deepEqual(
    commandArguments(onlyCommand("echo label: value")).map((token) => token.value),
    ["label:", "value"],
  );
  assert.equal(
    auditPublishAttestation([{
      file: "release.yml",
      text: "          npm publish --provenance\n          - run: npm publish\n",
    }]).failures.length,
    1,
  );
});

test("a quoted parenthesis inside a substitution is a literal, not its delimiter", () => {
  // Counting it closed the substitution early and truncated the body, so the
  // publish after it was never scanned at all.
  const result = auditPublishAttestation([{
    file: "release.yml",
    text: '          npm publish --provenance\n          x=$(echo ")" && npm publish)\n',
  }]);
  assert.equal(result.failures.length, 1);
});

test("one package script cannot continue into the next", () => {
  // A body ending in a backslash was joined to the following script, so a
  // script beginning `--provenance` lent its flag to the unattested publish
  // that ended the script before it.
  const manifest = JSON.stringify({ scripts: { a: "npm publish \\", b: "--provenance echo done" } });
  assert.equal(manifestCommandLines(manifest), "npm publish \n--provenance echo done");
  assert.equal(auditPublishAttestation([{ file: "package.json", text: manifest }]).failures.length, 1);
});

test("npm selects a workspace with a flag, so a word after it does not excuse a publish", () => {
  // `workspace` was listed as a runner subcommand, which meant a `publish`
  // written after it was never audited. npm has no such subcommand.
  assert.equal(
    auditPublishAttestation([{
      file: "release.yml",
      text: "          npm publish --provenance\n          npm workspace pkg publish\n",
    }]).failures.length,
    1,
  );
  // A real runner subcommand still short-circuits: `npm run publish` runs a
  // script named publish and publishes nothing.
  assert.deepEqual(
    publishInvocationsIn({ file: "release.yml", text: "          npm run publish\n" }),
    [],
  );
});

test("a substitution tracks both quote kinds and an escape while finding its close", () => {
  // Each arm of the quote tracking has to be exercised or a later edit can
  // remove one without the suite noticing.
  const single = auditPublishAttestation([{
    file: "release.yml",
    text: "          npm publish --provenance\n          x=$(echo ')' && npm publish)\n",
  }]);
  assert.equal(single.failures.length, 1, "a single-quoted paren is a literal");
  const escaped = auditPublishAttestation([{
    file: "release.yml",
    text: "          npm publish --provenance\n          x=$(echo \\) && npm publish)\n",
  }]);
  assert.equal(escaped.failures.length, 1, "an escaped paren is a literal");
  // A double quote inside single quotes is literal, and vice versa.
  assert.deepEqual(
    tokenizeCommands(`x=$(echo '"' && npm publish --provenance)`).some(
      (command) => commandName(command) === "npm",
    ),
    true,
  );
});

test("a scalar carrying a substitution or a quote of its own is never inlined", () => {
  // This is a regression test for a defect this gate introduced in itself.
  // Inlining every quoted assignment put values like `x="$(node -p …)"` into
  // unrelated commands, which injected an unbalanced parenthesis, and the scan
  // then reported a publish that was not there while losing the one that was --
  // a false verdict in both directions. Every package's release gate failed.
  const scalars = shellScalars([
    'CMD="npm publish"',
    'SUBST="$(node -p 1)"',
    'TICK="`date`"',
    'QUOTED="he said \'hi\'"',
    'PAREN="a (b)"',
  ].join("\n"));
  assert.equal(scalars.get("CMD"), "npm publish", "a plain literal is still resolved");
  for (const name of ["SUBST", "TICK", "QUOTED", "PAREN"]) {
    assert.equal(scalars.get(name), undefined, `${name} must not be inlined`);
  }
  // The shape that actually broke: an attested publish elsewhere in the file
  // must still be found, and no phantom invented.
  const text = [
    '          pkg_name="$(node -p "require(\'./package.json\').name")"',
    "          # `npm publish` - mentioned in a comment",
    "          npm publish --access public --provenance --ignore-scripts",
  ].join("\n");
  const found = publishInvocationsIn({ file: "release.yml", text }).map((i) => renderCommand(i.command));
  assert.deepEqual(found, ["npm publish --access public --provenance --ignore-scripts"]);
});

test("a substitution's quote state does not leak across its lines", () => {
  // Workflow prose carries apostrophes inside double-quoted messages. If an
  // unbalanced one persisted past the newline, every later parenthesis would
  // look quoted and the substitution would run on past its real close,
  // swallowing unrelated commands into it.
  const text = [
    "          x=$(echo \"GitHub's endpoint\"",
    "             npm publish)",
    "          npm publish --provenance",
  ].join("\n");
  const found = publishInvocationsIn({ file: "release.yml", text }).map((i) => renderCommand(i.command));
  assert.ok(found.includes("npm publish"), "the publish inside the substitution is still found");
  assert.ok(found.includes("npm publish --provenance"), "and the one after it is not swallowed");
});

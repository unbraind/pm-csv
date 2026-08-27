import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/** Repository root, derived from this file's location. */
const root = resolve(import.meta.dirname, "..");

/**
 * Read a `.github` control file, stripping comments and blank lines.
 *
 * @param name - File name inside `.github`.
 * @returns The file's meaningful lines, in order.
 */
function controlFile(name: string): string[] {
  return readFileSync(resolve(root, ".github", name), "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Run git and return its stdout.
 *
 * @param args - Arguments passed to git.
 * @returns Standard output, with the trailing newline removed.
 */
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).trimEnd();
}

const approved = new Set(controlFile("approved-git-identities.txt"));
const [baseline] = controlFile("identity-baseline.txt");

test("the identity baseline is a commit this checkout actually has", () => {
  // A shallow clone would silently audit nothing and report success, which is
  // the one outcome worse than failing: the gate would be decorative.
  assert.ok(baseline, "identity-baseline.txt must name a commit");
  assert.doesNotThrow(
    () => git("cat-file", "-e", `${baseline}^{commit}`),
    `baseline ${baseline} is missing - the workflow must check out full history (fetch-depth: 0)`
  );
});

test("every commit added since the baseline uses an approved identity", () => {
  // Forward-only by design. Rewriting the history before the baseline would
  // orphan release tags and break published npm provenance; the maintainer
  // decision to freeze it is recorded in identity-baseline.txt. What this gate
  // guarantees is that the set of unapproved identities cannot grow.
  const log = git("log", "--format=%H%x00%ae%x00%ce", `${baseline}..HEAD`);
  if (log.length === 0) return;

  const offenders: string[] = [];
  for (const line of log.split("\n")) {
    const [sha, authorEmail, committerEmail] = line.split("\0");
    for (const [role, email] of [["author", authorEmail], ["committer", committerEmail]] as const) {
      if (!approved.has(email)) offenders.push(`${sha.slice(0, 8)} ${role} <${email}>`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `unapproved commit identities since the baseline:\n  ${offenders.join("\n  ")}\n` +
      "Add the address to .github/approved-git-identities.txt only if it is a deliberate " +
      "public identity; otherwise rewrite the offending commits before merging."
  );
});

test("no commit since the baseline adds an absolute home path", () => {
  // The reachable history already contains a handful of these inside .agents/pm
  // prose - including, unavoidably, records that describe removing them. The
  // point of this gate is that the count cannot grow, in prose or in source.
  const diff = git("diff", "--unified=0", `${baseline}..HEAD`);
  if (diff.length === 0) return;

  const offenders = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .filter((line) => /(?:^|[^\w])\/(?:home|Users)\/[A-Za-z][\w.-]*\//.test(line))
    .map((line) => line.slice(1).trim().slice(0, 120));

  assert.deepEqual(
    offenders,
    [],
    `lines added since the baseline contain an absolute home path:\n  ${offenders.join("\n  ")}\n` +
      "Use a relative path, or $HOME, or a placeholder."
  );
});

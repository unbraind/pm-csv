import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/** Repository root, derived from this file's location. */
const root = resolve(import.meta.dirname, "..");

/**
 * Run git and return its stdout.
 *
 * @param args - Arguments passed to git.
 * @returns Standard output, with the trailing newline removed.
 */
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).trimEnd();
}

/**
 * Strip comments and blank lines from a control file's contents.
 *
 * @param raw - Raw file contents.
 * @returns The meaningful lines, in order.
 */
function meaningful(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Resolve the trusted base ref this branch is measured against.
 *
 * The controls must not be read from the checkout under audit: a pull request
 * could otherwise advance the baseline past its own unapproved commit, or add
 * its own address to the approved list, and the gate would validate nothing.
 *
 * @returns The first base ref that resolves.
 */
function baseRef(): string {
  for (const candidate of ["origin/main", "refs/remotes/origin/main", "main"]) {
    try {
      git("rev-parse", "--verify", `${candidate}^{commit}`);
      return candidate;
    } catch {
      continue;
    }
  }
  assert.fail(
    "no base ref resolved (tried origin/main, main) - the workflow must fetch the default branch, " +
      "because reading the audit controls from the branch under audit would let a pull request approve itself"
  );
}

/** Control files, relative to the repository root. */
const CONTROL = {
  identities: ".github/approved-git-identities.txt",
  baseline: ".github/identity-baseline.txt",
} as const;

/**
 * Read a control file from the trusted base ref, falling back only when the
 * base does not carry it yet.
 *
 * @param path - Repository-relative control file path.
 * @returns The control values and whether they came from the trusted base.
 */
function trustedControl(path: string): { values: string[]; fromBase: boolean } {
  try {
    return { values: meaningful(git("show", `${baseRef()}:${path}`)), fromBase: true };
  } catch {
    return { values: meaningful(readFileSync(resolve(root, path), "utf-8")), fromBase: false };
  }
}

const identities = trustedControl(CONTROL.identities);
const baselineControl = trustedControl(CONTROL.baseline);
const approved = new Set(identities.values);
const [baseline] = baselineControl.values;

test("a control change this branch proposes does not take effect on this branch", () => {
  // The bypass this closes is self-approval: a pull request that adds its own
  // address to the approved list, or moves the baseline past its own commit,
  // and is then measured against the list it just widened.
  //
  // What closes it is that the audit READS the controls from the base ref - not
  // that the branch is forbidden from editing them. Asserting equality with the
  // base ref would forbid it, and would deadlock the gate: approving a new
  // identity is only ever done by editing this file, so the one remediation the
  // failure message names would itself be unmergeable, in every repository,
  // forever. A branch may propose a control change; it just does not get to
  // enjoy that change until the change is on the base ref.
  //
  // Judged PER FILE. A repository can legitimately be part-way through adopting
  // this gate - one control already on the base ref, the other introduced by
  // this branch - and an all-or-nothing rule reports that mixed state as a
  // spoof, which is both wrong and unactionable.
  for (const [path, control] of [
    [CONTROL.identities, identities],
    [CONTROL.baseline, baselineControl],
  ] as const) {
    if (control.fromBase) {
      // Re-read the base ref here rather than trusting `control.values`. If the
      // reader ever regressed to preferring the working tree, `control.values`
      // would be the working tree, this loop would compare it against itself,
      // find nothing proposed, and pass while validating nothing.
      const onBase = meaningful(git("show", `${baseRef()}:${path}`));
      for (const proposed of meaningful(readFileSync(resolve(root, path), "utf-8"))) {
        if (onBase.includes(proposed)) continue;
        assert.ok(
          !approved.has(proposed) && proposed !== baseline,
          `${path} proposes ${JSON.stringify(proposed)}, which is not on ${baseRef()}, and the audit is ` +
            "already treating it as in force. Controls must be read from the base ref, or a pull request " +
            "approves itself."
        );
      }
      continue;
    }

    // Bootstrap: this branch introduces the control, so there is nothing on the
    // base ref to measure it against. Assert that is genuinely the case rather
    // than skipping silently; the anchor becomes effective once this merges.
    let present = true;
    try {
      git("show", `${baseRef()}:${path}`);
    } catch {
      present = false;
    }
    assert.equal(
      present,
      false,
      `${path} exists on ${baseRef()} but was read from the working tree - the anchor must come from the base ref`
    );
  }
});

test("the identity baseline is a commit this checkout actually has", () => {
  // A shallow clone would audit nothing and report success, which is worse than
  // failing: the gate would be decorative.
  assert.ok(baseline, `${CONTROL.baseline} must name a commit`);
  assert.doesNotThrow(
    () => git("cat-file", "-e", `${baseline}^{commit}`),
    `baseline ${baseline} is missing - the workflow must check out full history (fetch-depth: 0)`
  );
});

test("every commit added since the baseline uses an approved identity", () => {
  // Forward-only by design. Rewriting history before the baseline would orphan
  // release tags and break published npm provenance; the maintainer decision to
  // freeze it is recorded in the baseline file. What this guarantees is that the
  // set of unapproved identities cannot grow.
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
      `Add the address to ${CONTROL.identities} only if it is a deliberate public identity; ` +
      "otherwise rewrite the offending commits before merging."
  );
});

test("no commit since the baseline adds an absolute home path", () => {
  // Per COMMIT, not the baseline..HEAD tree diff: adding a host path in one
  // commit and removing it in a later one leaves an empty diff while the value
  // stays reachable in the object store forever. The reachable history already
  // holds a handful of these inside .agents/pm prose - including records that
  // describe removing them - and the point is that the count cannot grow.
  const commits = git("log", "--format=%H", `${baseline}..HEAD`).split("\n").filter(Boolean);

  // Matches a home path with a child component and a bare home directory alike,
  // at end of line or before a delimiter. Requiring a trailing slash missed the
  // home directory on its own. The examples are described rather than written
  // out: this gate rejects its own source otherwise, which is the same reason
  // the surviving host paths in this repository sit in records that document
  // removing host paths.
  const homePath = /(?:^|[^\w])\/(?:home|Users)\/[A-Za-z][\w.-]*(?![\w.-])/;

  const offenders: string[] = [];
  for (const sha of commits) {
    for (const line of git("show", "--unified=0", "--format=", sha).split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      if (homePath.test(line)) offenders.push(`${sha.slice(0, 8)} ${line.slice(1).trim().slice(0, 100)}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `commits since the baseline add absolute home paths:\n  ${offenders.join("\n  ")}\n` +
      "Use a relative path, or $HOME, or a placeholder."
  );
});

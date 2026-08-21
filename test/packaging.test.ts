import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkExtensionManifestCompatibility } from "@unbrained/pm-cli/sdk/authoring";

/**
 * Shape of the fields this suite asserts on. Only the three dependency maps
 * matter here; the rest of the manifest is deliberately not modelled so an
 * unrelated field addition cannot fail this suite.
 */
interface DependencyManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

/** Untrusted extension-manifest JSON narrowed only where an assertion needs it. */
interface ExtensionManifestDocument {
  readonly pm_min_version?: unknown;
  readonly [key: string]: unknown;
}

/** The published manifest, read from disk rather than imported so the assertions run against the same bytes npm publishes. */
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as DependencyManifest;

/** The exact extension manifest bytes included in the published package. */
const extensionManifest = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
) as ExtensionManifestDocument;

/** Public documentation whose atomic guarantees must match runtime recovery behavior. */
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** Authoring surface containing the SDK option and registered flag descriptions. */
const extensionSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

/** The host CLI package whose placement in the manifest this suite governs. */
const HOST_CLI = "@unbrained/pm-cli";

/**
 * An exact version: digits and dots only, with no range operator, so npm
 * resolves one version rather than "whatever is newest and still matching".
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
/**
 * Shape required of the consumer-facing peer declaration: a `>=` floor.
 *
 * Deliberately distinct from {@link EXACT_VERSION}. The dev pin must be exact so
 * the gates are reproducible; the peer declaration must be a floor so a consumer
 * running any later host CLI is not a peer conflict.
 */
const MINIMUM_VERSION_RANGE = /^>=\d+\.\d+\.\d+$/;

/**
 * Order two dotted versions, returning a negative number when `left` precedes
 * `right`, zero when they are equal, and a positive number otherwise.
 *
 * Compares part by part and stops at the first difference, because comparing
 * the parts independently would rank `1.0.5` above `2.0.0` on the strength of
 * its final segment.
 */
function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * This package is a pure extension: the host CLI loads it, so the CLI must be
 * a peer the host satisfies, never a dependency npm installs underneath us.
 *
 * Declaring it in `dependencies` alongside the peer range let npm satisfy the
 * two independently: a consumer whose host pin sits below the dependency range
 * — while still inside the peer range this package declares — got their copy at
 * the tree root and a second, newer copy nested under this package. npm dedupes
 * only when the two ranges happen to overlap, so the tree was clean for some
 * host pins and skewed for others, which is why this survived review for as
 * long as it did.
 *
 * Skew is not cosmetic in this ecosystem: consecutive CLI releases have
 * disagreed about whether identical history bytes are fatal, a warning, or
 * invisible, so which copy loads can decide whether a workspace passes its own
 * gates.
 */
test("the host CLI is declared as a peer dependency and never as a runtime dependency", () => {
  assert.equal(
    manifest.dependencies?.[HOST_CLI],
    undefined,
    `${HOST_CLI} must not appear in dependencies: npm would install a second copy underneath this package whenever the consumer's host pin does not match this range`,
  );
  const peer = manifest.peerDependencies?.[HOST_CLI];
  assert.ok(peer, `${HOST_CLI} must be declared as a peer dependency so the host's copy is the one that loads`);
  // A FLOOR, not an exact pin — see companion decision pm-cli-website-j6oj.
  //
  // The dev and peer declarations have different audiences, so they have
  // different correct shapes. The dev pin decides which CLI this package's own
  // gates run against and must be exact. The peer declaration tells CONSUMERS
  // which hosts the plugin works with, and a pm extension does not choose the
  // host version — the user installs the CLI and this package must work with
  // whatever they have. An exact peer pin makes every other installed CLI a peer
  // conflict, so the next patch release breaks installs under strict peer
  // resolution until this package republishes.
  //
  // The counter-argument this replaced is real but unanswerable from a manifest:
  // npm 7+ auto-installs the newest version a peer range admits, so a floor does
  // admit a FUTURE regressed CLI. No range declared today can exclude a
  // regression that does not exist yet. What actually protects this package is
  // the SDK-backed runtime certification on every canonical complete-list
  // read, which detects a regressed host from source, pagination, projection,
  // omission, read-output, count, and identity receipts rather than guessing
  // version numbers.
  //
  // The floor's job is narrower: require the canonical list and public
  // complete-list SDK contracts shipped in 2026.8.20.
  assert.match(
    peer,
    MINIMUM_VERSION_RANGE,
    `${HOST_CLI} must declare a ">=x.y.z" floor, not "${peer}": a pm extension cannot pin the host CLI a user installs, so an exact peer pin makes every later CLI patch a peer conflict`,
  );
  assert.ok(
    compareVersions(peer.replace(/^>=/, ""), "2026.8.20") >= 0,
    `${HOST_CLI} peer floor "${peer}" must be at least 2026.8.20 so the canonical list and public complete-list SDK contracts are available`,
  );
});

/**
 * The dev declaration is what CI installs to run `pm health --strict-exit` and
 * the rest of `release:check`, so it decides the verdict those gates report.
 *
 * A caret range is not a pin: it admits any later release, and three
 * consecutive CLI releases disagreed about whether the same bytes on disk are
 * fatal, a warning, or invisible. Pinning exactly keeps the gate reproducible.
 *
 * The peer declaration is governed differently (see the peer test above): it is
 * a `>=` floor, because it addresses consumers rather than this package's CI.
 * The relationship this test enforces is therefore *satisfaction*, not equality
 * — the dev pin must sit at or above the advertised floor. A dev pin below the
 * floor would make that floor a claim no gate ever tested; a dev pin above it is
 * both normal and fine, and is what every routine CLI bump produces.
 *
 * The assertion is deliberately on the *shape* and the ordering rather than on
 * today's literal version. Hardcoding the number would turn every Dependabot
 * bump into a test failure needing a second, lockstep edit, without buying any
 * safety: what matters is that the pin is exact and not older than what this
 * package tells consumers it needs.
 */
test("the host CLI dev dependency is pinned to an exact version at or above the declared peer floor", () => {
  const declared = manifest.devDependencies?.[HOST_CLI];
  assert.ok(declared, `${HOST_CLI} must be a devDependency so the gates have a CLI to run`);
  assert.match(
    declared,
    EXACT_VERSION,
    `${HOST_CLI} must be pinned exactly, not declared as the range "${declared}": the gate verdict depends on which CLI version runs it`,
  );

  // The dev pin must SATISFY the peer floor, not equal it. Equality would force
  // a lockstep edit of the consumer-facing floor on every routine CLI bump; what
  // actually matters is that the gates never run against a CLI older than the
  // floor this package advertises, because then the floor would be a claim no
  // gate ever tested.
  const peer = manifest.peerDependencies?.[HOST_CLI] ?? "";
  assert.match(
    peer,
    MINIMUM_VERSION_RANGE,
    "the peer floor must be a concrete \">=x.y.z\" range for the dev pin to be checked against it",
  );
  assert.ok(
    compareVersions(declared, peer.replace(/^>=/, "")) >= 0,
    `${HOST_CLI} dev pin ${declared} must be at or above the declared peer floor ${peer}: gating against a CLI older than the floor this package advertises would make that floor an untested claim`,
  );
});

test("the extension manifest declares the same floor enforced by the peer dependency", () => {
  const peer = manifest.peerDependencies?.[HOST_CLI];
  assert.ok(peer, `${HOST_CLI} must be declared as a peer dependency`);
  const declared = extensionManifest.pm_min_version;
  assert.strictEqual(
    typeof declared,
    "string",
    "manifest.json must declare the top-level pm_min_version enforced by the host CLI",
  );
  assert.strictEqual(
    declared,
    peer.replace(/^>=/, ""),
    "manifest.json and package.json must advertise one compatibility floor",
  );
});

test("the complete published extension manifest satisfies minimum and development SDK hosts", () => {
  const dev = manifest.devDependencies?.[HOST_CLI];
  assert.ok(dev, `${HOST_CLI} must be a devDependency so the manifest has a tested host version`);
  const minimum = extensionManifest.pm_min_version;
  assert.equal(typeof minimum, "string");
  for (const host of [minimum as string, dev]) {
    const result = checkExtensionManifestCompatibility(extensionManifest, { pmVersion: host });
    assert.equal(result.compatible, true, `the declared version bounds must accept host ${host}`);
    assert.deepEqual(
      result.findings,
      [],
      `manifest.json must contain only SDK-supported keys and valid bounds on host ${host}: ${JSON.stringify(result.findings)}`,
    );
  }
});

test("whole-tracker changelog scripts explicitly disable every pm output bound", () => {
  for (const name of ["changelog:full", "release:notes"]) {
    const script = manifest.scripts?.[name];
    assert.ok(script, `package.json must declare ${name}`);
    assert.match(
      script,
      /--pm-arg=--output-budget\s+--pm-arg=unbounded/u,
      `${name} must disable pm's token budget before reading the complete tracker`,
    );
    assert.match(
      script,
      /--pm-arg=--output-limit\s+--pm-arg=unbounded/u,
      `${name} must disable pm's row limit before reading the complete tracker`,
    );
  }
});

test("public atomic contracts disclose best-effort compensation and reconciliation", () => {
  const publicContract = `${readme}\n${extensionSource}`;
  assert.doesNotMatch(publicContract, /all-or-nothing/u);
  assert.doesNotMatch(publicContract, /every applied create is compensated/u);
  assert.doesNotMatch(publicContract, /No committed \(open\) items from the import remain/u);
  assert.doesNotMatch(extensionSource, /markers before closing the item/u);
  assert.doesNotMatch(extensionSource, /best-effort empty map/u);
  assert.match(publicContract, /best-effort/u);
  assert.match(publicContract, /pre-existing item updates are intentionally not reverted/u);
  assert.match(publicContract, /inspect and reconcile/u);
  assert.match(extensionSource, /markers only after closure succeeds/u);
  assert.match(extensionSource, /following non-zero branch rejects ordinary command failures/u);
});

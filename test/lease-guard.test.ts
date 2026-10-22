import "./support/isolated-environment.ts";
import "./repros/sdk-lease-overrun.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { create, getHistoryPath, mutateItem, readSettings, setActiveExtensionHooks, writeSettings } from "@unbrained/pm-cli/sdk";
import type { OnReadHook, OnWriteHook } from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { captureUpdateCompensation, compensateUpdate, readUpdateSnapshot } from "../atomic-update.ts";
import { EditRefusal } from "../edit-refusal.ts";
import { assertEditLease } from "../lease-guard.ts";
import { applyEditSession, exportEditSession } from "../roundtrip.ts";

/** Build a real non-git tracker and persist its effective one-second lease. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "csv-guard-"));
  const initialized = spawnSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "--defaults", "--path", root], {
    encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const { item } = await create({ title: "Baseline" }, { pmRoot: root });
  const checkout = await exportEditSession(root, [item.id]);
  const settings = await readSettings(root);
  settings.locks.ttl_seconds = 1;
  settings.governance.force_required_for_stale_lock = false;
  await writeSettings(root, settings);
  return { root, id: item.id, settings, ...checkout };
}

/** Install real SDK observation hooks without replacing any SDK operation. */
async function observe(read: OnReadHook, write: OnWriteHook = () => {}) {
  const harness = await createExtensionTestHarness({ activate(api: ExtensionApi) {
    api.hooks.onRead(read);
    api.hooks.onWrite(write);
  } }, { name: "lease-observer", capabilities: ["hooks"] });
  setActiveExtensionHooks(harness.activation.hooks);
  return async () => { setActiveExtensionHooks(null); await harness.deactivate(); };
}

/** Read exact content and history; equality asserts content preservation only. */
async function evidence(root: string, id: string) {
  return { raw: (await readUpdateSnapshot(root, id)).raw, history: readFileSync(getHistoryPath(root, id), "utf8") };
}

/** Require a typed lease refusal with the operator's retry/reconcile remedy. */
function leaseRefusal(error: unknown): boolean {
  assert.ok(error instanceof EditRefusal);
  assert.equal(error.code, "csv_lease_expired");
  assert.equal(error.context.code, "csv_lease_expired");
  assert.match(error.remedy, /Re-run apply; another writer may have changed the item/);
  return true;
}

/** Locate the callback refusal through real transaction/compensation wrappers. */
function hasLeaseRefusal(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  for (const current of pending) {
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof EditRefusal && current.code === "csv_lease_expired") return true;
    pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}

/** A newer native writer takes over the expired lease and records its receipt. */
async function newerWriter(f: Awaited<ReturnType<typeof fixture>>) {
  await setTimeout(1100);
  await mutateItem({ pmRoot: f.root, settings: f.settings, id: f.id, op: "update", author: "newer-writer",
    mutate(document) { document.metadata.title = "Newer protected value"; return { changedFields: ["title"] }; },
  });
  return evidence(f.root, f.id);
}

test("lease safety margin is inclusive, capped and refuses invalid TTLs", () => {
  assert.doesNotThrow(() => assertEditLease(899, 1));
  assert.doesNotThrow(() => assertEditLease(98999, 100));
  for (const [elapsed, ttl] of [[900, 1], [1000, 1], [99000, 100], [0, 0], [0, -1], [0, NaN], [0, Infinity]]) {
    assert.throws(() => assertEditLease(elapsed, ttl), leaseRefusal);
  }
});

for (const operation of ["checkout", "capture"] as const) test(`${operation} refuses an expired snapshot lease`, async () => {
  const f = await fixture();
  let injected = false;
  const stop = await observe(async ({ path }) => {
    if (!injected && path === getHistoryPath(f.root, f.id)) { injected = true; await setTimeout(1100); }
  });
  try {
    const before = await evidence(f.root, f.id);
    // The evidence read does not read history through SDK hooks.
    await assert.rejects(operation === "checkout" ? exportEditSession(f.root, [f.id])
      : captureUpdateCompensation(f.root, f.id, "csv-txrow:lease#0", "csv-test"), leaseRefusal);
    assert.equal(injected, true);
    assert.deepEqual(await evidence(f.root, f.id), before);
  } finally { await stop(); rmSync(f.root, { recursive: true, force: true }); }
});

test("applyPlan refuses its expired callback and retains the newer native value", async () => {
  const f = await fixture();
  f.table[1][f.table[0].indexOf("title")] = "Spreadsheet edit";
  let leases = 0;
  let injected = false;
  let newer: Awaited<ReturnType<typeof evidence>> | undefined;
  const stop = await observe(async ({ path }) => {
    if (leases === 3 && !injected && path === getHistoryPath(f.root, f.id)) {
      injected = true;
      newer = await newerWriter(f);
    }
  }, ({ path, op }) => {
    if (op === "lock:create" && path === join(f.root, "locks", `${f.id}.lock`)) leases++;
  });
  try {
    await assert.rejects(applyEditSession(f.root, f.session, f.table, { author: "csv-test" }), error => {
      assert.ok(error instanceof EditRefusal);
      assert.equal(error.code, "csv_edit_apply_failed");
      assert.equal(hasLeaseRefusal(error), true);
      return true;
    });
    assert.equal(injected, true, "real forward-callback history read must be suspended");
    assert.ok(newer);
    assert.deepEqual(await evidence(f.root, f.id), newer);
  } finally { await stop(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const phase of ["callback", "representation"] as const) test(`compensation ${phase} retains a newer writer after lease expiry`, async () => {
  const f = await fixture();
  const marker = "csv-txrow:lease-comp#0";
  const prior = await captureUpdateCompensation(f.root, f.id, marker, "csv-test");
  await mutateItem({ pmRoot: f.root, settings: f.settings, id: f.id, op: "update", author: "csv-test", message: `${marker}:apply`,
    mutate(document) { document.metadata.title = "Spreadsheet edit"; return { changedFields: ["title"] }; },
  });
  let armed = phase === "callback";
  let injected = false;
  let newer: Awaited<ReturnType<typeof evidence>> | undefined;
  const stop = await observe(async ({ path }) => {
    if (armed && !injected && path === getHistoryPath(f.root, f.id)) {
      injected = true;
      newer = await newerWriter(f);
    }
  });
  try {
    await assert.rejects(compensateUpdate(f.root, f.id, marker, "csv-test", prior, event => {
      if (event === "canonical_restored") armed = true;
    }), leaseRefusal);
    assert.equal(injected, true);
    assert.ok(newer);
    assert.deepEqual(await evidence(f.root, f.id), newer);
  } finally { await stop(); rmSync(f.root, { recursive: true, force: true }); }
});

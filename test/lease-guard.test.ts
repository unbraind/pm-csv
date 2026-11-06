import "./support/isolated-environment.ts";
import "./repros/sdk-lease-overrun.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { registerLeaseObserver } from "./support/lease-observer.ts";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { create, getHistoryPath, mutateItem, readSettings, setActiveExtensionHooks, writeSettings, PmCliError, readHistoryEntries, verifyHistoryEntries, readSettingsSection } from "@unbrained/pm-cli/sdk";
import type { OnReadHook, OnWriteHook } from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { captureUpdateCompensation, compensateUpdate, readUpdateSnapshot } from "../atomic-update.ts";
import { EditRefusal } from "../edit-refusal.ts";
import { applyEditSession, exportEditSession } from "../roundtrip.ts";
import { withSettingsFence } from "../settings-snapshot.ts";

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

/** Install observations through both the real workspace lifecycle and direct SDK primitives. */
async function observeExtension(root: string, activate: (api: ExtensionApi) => void) {
  const unregister = registerLeaseObserver(root, activate);
  const installed = join(root, "extensions/lease-observer");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "manifest.json"), JSON.stringify({ name: "lease-observer", version: "1.0.0", entry: "./index.ts", capabilities: ["hooks"] }));
  const module = pathToFileURL(join(process.cwd(), "test/support/lease-observer.ts")).href;
  writeFileSync(join(installed, "index.ts"), `import { activateLeaseObserver } from ${JSON.stringify(module)};
    export default { activate(api: Parameters<typeof activateLeaseObserver>[1]) { activateLeaseObserver(${JSON.stringify(root)}, api); } };`);
  const harness = await createExtensionTestHarness({ activate }, { name: "lease-observer", capabilities: ["hooks"] });
  setActiveExtensionHooks(harness.activation.hooks);
  return async () => { setActiveExtensionHooks(null); await harness.deactivate(); unregister(); };
}

/** Register genuine SDK read/write hooks without replacing storage or lease operations. */
async function observe(root: string, read: OnReadHook, write: OnWriteHook = () => {}) {
  return observeExtension(root, api => { api.hooks.onRead(read); api.hooks.onWrite(write); });
}

/** Read exact content and history; equality asserts content preservation only. */
async function evidence(root: string, id: string) {
  return { raw: (await readUpdateSnapshot(root, id)).raw, history: readFileSync(getHistoryPath(root, id), "utf8") };
}

/** Require a typed lease refusal with the operator's retry/reconcile remedy. */
function leaseRefusal(error: unknown): boolean {
  assert.ok(error instanceof PmCliError);
  assert.equal(error.code, "lock_lost");
  return true;
}

/** Locate the callback refusal through real transaction/compensation wrappers. */
function hasLeaseRefusal(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  for (const current of pending) {
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof PmCliError && current.code === "lock_lost") return true;
    pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}

/** A newer native writer takes over the expired lease and records its receipt. */
async function newerWriter(f: Awaited<ReturnType<typeof fixture>>) {
  await setTimeout(1100);
  const result = spawnSync(process.execPath, ["test/support/lease-writer.ts", f.root, f.id], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return evidence(f.root, f.id);
}

for (const operation of ["checkout", "capture"] as const) test(`${operation} refuses an expired snapshot lease`, async () => {
  const f = await fixture();
  let injected = false;
  const stop = await observe(f.root, async ({ path }) => {
    if (!injected && path === getHistoryPath(f.root, f.id)) { injected = true; await newerWriter(f); }
  });
  try {
    const before = await evidence(f.root, f.id);
    // The evidence read does not read history through SDK hooks.
    await assert.rejects(operation === "checkout" ? exportEditSession(f.root, [f.id])
      : captureUpdateCompensation(f.root, f.id, "csv-txrow:lease#0", "csv-test"), leaseRefusal);
    assert.equal(injected, true);
    assert.notDeepEqual(await evidence(f.root, f.id), before);
    assert.equal((await readUpdateSnapshot(f.root, f.id)).document.metadata.title, "Newer protected value");
  } finally { await stop(); rmSync(f.root, { recursive: true, force: true }); }
});

test("applyPlan refuses its expired callback and retains the newer native value", async () => {
  const f = await fixture();
  f.table[1][f.table[0].indexOf("title")] = "Spreadsheet edit";
  let leases = 0;
  let injected = false;
  let newer: Awaited<ReturnType<typeof evidence>> | undefined;
  const stop = await observe(f.root, async ({ path }) => {
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
  const stop = await observe(f.root, async ({ path }) => {
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

for (const operation of ["checkout", "capture", "apply"] as const) test(`${operation} allows a slow owner whose lease generation has not changed`, async () => {
  const f = await fixture();
  let delayed = false, leases = 0;
  const stop = await observe(f.root, async ({ path }) => {
    if (!delayed && path === getHistoryPath(f.root, f.id) && (operation !== "apply" || leases === 3)) { delayed = true; await setTimeout(1100); }
  }, ({ path, op }) => {
    if (op === "lock:create" && path === join(f.root, "locks", `${f.id}.lock`)) leases++;
  });
  try {
    if (operation === "checkout") assert.equal((await exportEditSession(f.root, [f.id])).session.rows.length, 1);
    else if (operation === "capture") assert.ok(await captureUpdateCompensation(f.root, f.id, "csv-txrow:slow#0", "csv-test"));
    else {
      f.table[1][f.table[0].indexOf("title")] = "Slow protected edit";
      assert.equal((await applyEditSession(f.root, f.session, f.table, { author: "csv-test" })).applied, 1);
    }
    assert.equal(delayed, true);
  } finally { await stop(); rmSync(f.root, { recursive: true, force: true }); }
});

test("host delay after the mutation callback cannot publish stale bytes or history", async () => {
  const f = await fixture();
  f.table[1][f.table[0].indexOf("title")] = "Stale spreadsheet edit";
  let newer: Awaited<ReturnType<typeof evidence>> | undefined;
  let delayed = false;
  const itemPath = (await readUpdateSnapshot(f.root, f.id)).located.itemPath;
  const stop = await observeExtension(f.root, api => {
    api.hooks.beforeMutation(({ operation }) => {
      if (operation !== "update" || delayed) return;
      delayed = true;
      // A synchronous host pause blocks its timer too; the peer's real clock advances.
      const result = spawnSync(process.execPath, ["test/support/lease-writer.ts", f.root, f.id, "delayed"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      newer = { raw: readFileSync(itemPath, "utf8"), history: readFileSync(getHistoryPath(f.root, f.id), "utf8") };
    });
  });
  try {
    await assert.rejects(applyEditSession(f.root, f.session, f.table, { author: "csv-test" }), hasLeaseRefusal);
    assert.ok(newer);
    assert.deepEqual(await evidence(f.root, f.id), newer);
  } finally { await stop(); rmSync(f.root, { recursive: true, force: true }); }
});

/** Require a completed native lock refusal, rather than a pre-call readiness marker. */
async function waitForBlockedPeer(writer: ReturnType<typeof spawn>): Promise<void> {
  const abort = new AbortController();
  const timer = globalThis.setTimeout(() => abort.abort(), 15_000);
  try {
    const data = await once(writer.stdout!, "data", { signal: abort.signal });
    assert.equal(String(data[0]), "blocked\n", "the peer must complete an actual SDK lock attempt");
  } finally { globalThis.clearTimeout(timer); }
}

test("one SDK fence excludes OS-process takeover between representation and completion history", async () => {
  const f = await fixture(), marker = "csv-txrow:fenced-representation#0";
  const prior = await captureUpdateCompensation(f.root, f.id, marker, "csv-test");
  await mutateItem({ pmRoot: f.root, settings: f.settings, id: f.id, op: "update", author: "csv-test", message: `${marker}:apply`,
    mutate(document) { document.metadata.title = "Spreadsheet edit"; return { changedFields: ["title"] }; },
  });
  let writer: ReturnType<typeof spawn> | undefined;
  let finished: Promise<unknown> | undefined;
  let exited = false;
  try {
    await compensateUpdate(f.root, f.id, marker, "csv-test", prior, async phase => {
      if (phase !== "representation_written") return;
      await setTimeout(1100);
      writer = spawn(process.execPath, ["test/support/lease-writer.ts", f.root, f.id, "probe-item"], { stdio: ["pipe", "pipe", "pipe"] });
      finished = once(writer, "exit").then(([code]) => { exited = true; assert.equal(code, 0); });
      await waitForBlockedPeer(writer);
      assert.equal(exited, false, "a peer must wait until representation AND its receipt are durable");
    });
    assert.ok(finished);
    writer!.stdin!.end("retry\n");
    await finished;
    const history = await readHistoryEntries(getHistoryPath(f.root, f.id), f.id);
    assert.equal(history.at(-2)?.message, `${marker}:compensate`);
    assert.equal(history.at(-1)?.author, "newer-writer");
    assert.equal(verifyHistoryEntries(history, (await readUpdateSnapshot(f.root, f.id)).document).ok, true);
    const beforeReplay = await evidence(f.root, f.id);
    await compensateUpdate(f.root, f.id, marker, "csv-test", prior);
    assert.deepEqual(await evidence(f.root, f.id), beforeReplay);
  } finally {
    if (writer && !exited) writer.kill();
    await finished?.catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("settings fence excludes an expired-lease takeover by an SDK writer in another OS process", async () => {
  const f = await fixture();
  let writer: ReturnType<typeof spawn> | undefined, finished: Promise<unknown> | undefined;
  let exited = false;
  try {
    await withSettingsFence(f.root, async () => {
      await setTimeout(1100);
      writer = spawn(process.execPath, ["test/support/lease-writer.ts", f.root, f.id, "probe-settings"], { stdio: ["pipe", "pipe", "pipe"] });
      finished = once(writer, "exit").then(([code]) => { exited = true; assert.equal(code, 0); });
      await waitForBlockedPeer(writer);
      assert.equal(exited, false, "the settings writer cannot enter the protected callback");
    });
    assert.ok(finished); writer!.stdin!.end("retry\n"); await finished;
    assert.deepEqual((await readSettingsSection(f.root, "csv_fence_fixture")).value, { newer: true });
  } finally {
    if (writer && !exited) writer.kill();
    await finished?.catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

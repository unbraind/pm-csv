import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLockLease, get, getHistoryPath, locateItem, readHistoryEntries, readSettings, update, writeSettings } from "@unbrained/pm-cli/sdk";
import { applyJoins, previewJoins } from "../join-plans.ts";
import type { JoinInput } from "../join-plans.ts";
import { registerLeaseObserver } from "./support/lease-observer.ts";

test("dependency cleanup attempts every native lease for every subset of release failures", async () => {
  for (let mask = 0; mask < 8; mask++) {
    const { root } = await fixture("parent");
    const input: JoinInput = { version: 1, tables: [{ name: "rows", key: "key", fields: { title: "title" },
      csv: "key,title,parent,blocker,other\na,First,,,\nb,Second,,,\nc,Third,,,\nd,Child,a,b,c\n",
      references: [{ column: "parent", table: "rows", kind: "parent" },
        { column: "blocker", table: "rows", kind: "blocked_by" }, { column: "other", table: "rows", kind: "blocked_by" }] }] };
    const preview = await previewJoins(root, input); assert.ok(preview.plan);
    const plan = preview.plan, expected = plan.ids.slice(0, 3).sort().reverse(), released: string[] = [];
    let creating = false, cleaning = false;
    const stop = registerLeaseObserver(root, api => {
      api.hooks.beforeMutation(context => {
        if (context.operation === "create" && context.after?.metadata.id === plan.ids[3]) {
          creating = true;
          throw new Error("Refuse child persistence");
        }
      });
      const acquiring = new Set<string>();
      api.registerService("lock_acquire", async context => {
        const payload = context.payload as { id?: string; owner?: string; ttl_seconds: number };
        if (!cleaning || (payload.id && acquiring.has(payload.id)) || payload.owner !== "csv-test" || !payload.id || !expected.includes(payload.id)) return { handled: false };
        // A real provider delegates acquisition to the native store, then reports a release failure.
        acquiring.add(payload.id);
        let lease: Awaited<ReturnType<typeof acquireLockLease>>;
        try { lease = await acquireLockLease(root, payload.id, payload.ttl_seconds, payload.owner); }
        finally { acquiring.delete(payload.id); }
        const id = payload.id, index = expected.indexOf(id);
        return { handled: true, result: async () => {
          released.push(id);
          await lease.release();
          if (mask & (1 << index)) throw new Error(`Release failure ${index}`);
        } };
      });
    });
    const installed = join(root, "extensions/lease-observer"); mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "manifest.json"), JSON.stringify({ name: "lease-observer", version: "1.0.0", entry: "./index.ts", capabilities: ["hooks", "services"] }));
    const module = pathToFileURL(join(process.cwd(), "test/support/lease-observer.ts")).href;
    writeFileSync(join(installed, "index.ts"), `import { activateLeaseObserver } from ${JSON.stringify(module)};
      export default { activate(api: Parameters<typeof activateLeaseObserver>[1]) { activateLeaseObserver(${JSON.stringify(root)}, api); } };`);
    try {
      await assert.rejects(applyJoins(root, plan, { author: "csv-test", onBoundary(phase, id) {
        if (phase === "before_create" && id === plan.ids[3]) cleaning = true;
      }, onTransition(event) {
        if (event.transition === "compensating") cleaning = false;
      } }), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /csv_join_/);
        if (mask) {
          const first = expected.findIndex((_, index) => Boolean(mask & (1 << index)));
          assert.ok(error.cause instanceof Error);
          assert.match(error.cause.message, new RegExp(`Release failure ${first}`));
        }
        return true;
      });
      assert.equal(creating, true);
      assert.deepEqual(released, expected, `failure subset ${mask} must release every dependency in reverse acquisition order`);
      for (const id of expected) {
        const probe = await acquireLockLease(root, id, 60, "probe-test", false, false, 0, { maxWaitMs: 0 });
        await probe.release();
      }
      assert.equal(await locateItem(root, plan.ids[3]), null);
      assert.notEqual(journalStatus(root), "committed");
    } finally { stop(); rmSync(root, { recursive: true, force: true }); }
  }
});

/** Build a two-row reviewed plan in a real tracker with no git repository. */
async function fixture(kind: "parent" | "blocked_by", ttl?: number) {
  const root = mkdtempSync(join(tmpdir(), "csv-join-review-"));
  const initialized = spawnSync(process.execPath, ["node_modules/@unbrained/pm-cli/dist/cli.js", "init", "--defaults", "--path", root], {
    encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  if (ttl !== undefined) {
    const settings = await readSettings(root);
    settings.locks.ttl_seconds = ttl; settings.governance.force_required_for_stale_lock = false;
    await writeSettings(root, settings);
  }
  const input: JoinInput = { version: 1, tables: [{ name: "rows", key: "key", fields: { title: "title" },
    csv: "key,title,ref\na,Dependency,\nb,Child,a\n", references: [{ column: "ref", table: "rows", kind }] }] };
  const { plan } = await previewJoins(root, input); assert.ok(plan);
  return { root, plan };
}

/** Journal status is evidence of whether a failure reached compensation before committing. */
function journalStatus(root: string): string {
  const folder = join(root, "transactions/sdk"), files = readdirSync(folder).filter(name => name.endsWith(".json"));
  assert.equal(files.length, 1);
  return (JSON.parse(readFileSync(join(folder, files[0]), "utf8")) as { status: string }).status;
}

for (const kind of ["parent", "blocked_by"] as const) {
  test(`dependency changed just before ${kind} child creation never creates the child`, async () => {
    const { root, plan } = await fixture(kind);
    let changed = false;
    try {
      await assert.rejects(applyJoins(root, plan, { author: "csv-test", async onBoundary(phase, id) {
        if (phase === "before_create" && id === plan.ids[1]) {
          await update(plan.ids[0], { title: "Foreign dependency" }, { pmRoot: root }); changed = true;
        }
      } }), /csv_join_/);
      assert.equal(changed, true);
      assert.equal((await get(plan.ids[0], {}, { pmRoot: root })).item.title, "Foreign dependency");
      assert.equal(await locateItem(root, plan.ids[1]), null);
      assert.equal((await readHistoryEntries(getHistoryPath(root, plan.ids[1]), plan.ids[1])).length, 0);
      assert.notEqual(journalStatus(root), "committed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test(`dependency lease excludes a real peer during ${kind} child persistence`, async () => {
    const { root, plan } = await fixture(kind, 1);
    let probed = false;
    const stop = registerLeaseObserver(root, api => api.hooks.beforeMutation(async context => {
      if (context.operation !== "create" || context.after?.metadata.id !== plan.ids[1]) return;
      // Expiry alone must not let a peer enter an active dependency generation fence.
      await delay(1100);
      const peer = spawnSync(process.execPath, ["node_modules/@unbrained/pm-cli/dist/cli.js", "--pm-path", root,
        "update", plan.ids[0], "--title", "Foreign dependency", "--author", "peer-test", "--json"], {
        encoding: "utf8", env: { ...process.env, PM_LOCK_WAIT_MS: "0" },
      });
      assert.notEqual(peer.status, 0, peer.stdout);
      assert.match(peer.stdout + peer.stderr, /lock_conflict|locked by/);
      probed = true;
    }));
    const installed = join(root, "extensions/lease-observer"); mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "manifest.json"), JSON.stringify({ name: "lease-observer", version: "1.0.0", entry: "./index.ts", capabilities: ["hooks"] }));
    const module = pathToFileURL(join(process.cwd(), "test/support/lease-observer.ts")).href;
    writeFileSync(join(installed, "index.ts"), `import { activateLeaseObserver } from ${JSON.stringify(module)};
      export default { activate(api: Parameters<typeof activateLeaseObserver>[1]) { activateLeaseObserver(${JSON.stringify(root)}, api); } };`);
    try {
      assert.equal((await applyJoins(root, plan, { author: "csv-test" })).applied, 2);
      assert.equal(probed, true);
      assert.equal((await get(plan.ids[0], {}, { pmRoot: root })).item.title, "Dependency");
      await update(plan.ids[0], { title: "Allowed after commit" }, { pmRoot: root });
      assert.equal((await get(plan.ids[0], {}, { pmRoot: root })).item.title, "Allowed after commit");
    } finally { stop(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("precommit dependency conflict compensates the child and preserves the foreign dependency", async () => {
  const { root, plan } = await fixture("parent");
  try {
    await assert.rejects(applyJoins(root, plan, { author: "csv-test", async onTransition(event) {
      if (event.transition === "committing") await update(plan.ids[0], { title: "Foreign dependency" }, { pmRoot: root });
    } }), /csv_join_/);
    assert.equal((await get(plan.ids[0], {}, { pmRoot: root })).item.title, "Foreign dependency");
    assert.equal(await locateItem(root, plan.ids[1]), null);
    assert.deepEqual((await readHistoryEntries(getHistoryPath(root, plan.ids[1]), plan.ids[1])).map(entry => entry.op), ["create", "delete"]);
    assert.notEqual(journalStatus(root), "committed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing precommit target triggers compensation before committing the journal", async () => {
  const { root, plan } = await fixture("blocked_by");
  try {
    await assert.rejects(applyJoins(root, plan, { author: "csv-test", async onTransition(event) {
      if (event.transition !== "committing") return;
      const located = await locateItem(root, plan.ids[1]); assert.ok(located);
      rmSync(located.itemPath); rmSync(getHistoryPath(root, plan.ids[1]));
    } }), /csv_join_target_changed/);
    assert.equal(await locateItem(root, plan.ids[0]), null);
    assert.deepEqual((await readHistoryEntries(getHistoryPath(root, plan.ids[0]), plan.ids[0])).map(entry => entry.op), ["create", "delete"]);
    assert.equal(journalStatus(root), "compensated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("dependency removed after the initial check is refused inside its held lease", async () => {
  const { root, plan } = await fixture("blocked_by");
  try {
    await assert.rejects(applyJoins(root, plan, { author: "csv-test", async onBoundary(phase, id) {
      if (phase !== "before_create" || id !== plan.ids[1]) return;
      const located = await locateItem(root, plan.ids[0]); assert.ok(located);
      rmSync(located.itemPath); rmSync(getHistoryPath(root, plan.ids[0]));
    } }), /csv_join_target_changed/);
    assert.equal(await locateItem(root, plan.ids[1]), null);
    assert.equal((await readHistoryEntries(getHistoryPath(root, plan.ids[1]), plan.ids[1])).length, 0);
    assert.equal(journalStatus(root), "compensated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("multiple dependency leases release earlier acquisitions when a later dependency is busy", async () => {
  const { root } = await fixture("parent");
  const input: JoinInput = { version: 1, tables: [{ name: "rows", key: "key", fields: { title: "title" },
    csv: "key,title,parent,blocker\na,First,,\nb,Second,,\nc,Child,a,b\n",
    references: [{ column: "parent", table: "rows", kind: "parent" }, { column: "blocker", table: "rows", kind: "blocked_by" }] }] };
  let peer: Awaited<ReturnType<typeof acquireLockLease>> | undefined;
  try {
    const preview = await previewJoins(root, input); assert.ok(preview.plan);
    const plan = preview.plan, ids = plan.ids.slice(0, 2).sort();
    await assert.rejects(applyJoins(root, plan, { author: "csv-test", async onBoundary(phase, id) {
      if (phase === "before_create" && id === plan.ids[2]) peer = await acquireLockLease(root, ids[1], 60, "peer-test");
    } }), /csv_join_/);
    assert.ok(peer);
    // The earlier dependency lock must have been released despite partial acquisition.
    const available = await acquireLockLease(root, ids[0], 60, "probe-test", false, false, 0, { maxWaitMs: 0 });
    await available.release();
    await peer.release();
    assert.equal(await locateItem(root, plan.ids[2]), null);
    const fresh = await previewJoins(root, input); assert.ok(fresh.plan);
    assert.equal((await applyJoins(root, fresh.plan, { author: "csv-test" })).applied, 3);
  } finally { await peer?.release(); rmSync(root, { recursive: true, force: true }); }
});

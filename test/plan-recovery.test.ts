import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { commitWorkspaceTransaction, create, get, getHistoryPath, locateItem, runWorkspaceTransactionGc, WorkspaceTransactionInterruptedError } from "@unbrained/pm-cli/sdk";
import { applyJoins, previewJoins, JoinRefusal, joinTransactionId, resolveJoinJournal } from "../join-plans.ts";
import type { JoinInput, JoinPlan } from "../join-plans.ts";
import { buildMutationIntent } from "../mutation-intent.ts";
import { applyEditSession, exportEditSession, EditRefusal } from "../roundtrip.ts";
import { importCSV, CommandError } from "../index.ts";

/** Native tracker and CLI path isolated from Git and global tracker discovery. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "csv-plan-recovery-")), root = join(base, "tracker"), bin = join(base, "bin");
  mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), join(bin, "pm"));
  const initialized = spawnSync(process.execPath, [join(bin, "pm"), "init", "--defaults", "--path", root], {
    encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(base) },
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  return { base, root, bin };
}

/** Independent rows expose every mutable eligibility subset without dependency masking. */
function input(): JoinInput {
  return { version: 1, tables: [{ name: "tasks", key: "key", csv: "key,title\na,A\nb,B\nc,C\nd,D\n", fields: { title: "title" }, references: [] }] };
}

/** SDK inventory is read-only and preserves every terminal and active journal. */
async function journals(root: string) {
  return (await runWorkspaceTransactionGc(root, { dryRun: true, retentionDays: Infinity })).entries;
}

/** Read all persisted bytes to detect replacement journals and changes to foreign records. */
function bytes(root: string): string {
  return JSON.stringify(readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => [join(e.parentPath, e.name).slice(root.length), readFileSync(join(e.parentPath, e.name), "utf8")]).sort());
}

/** Require a typed join refusal, never a successful unchanged receipt over pending cleanup. */
function refused(error: unknown): boolean { assert.ok(error instanceof JoinRefusal); return true; }

/** Produce a native compensating journal using the old subset-key algorithm. */
async function legacyPending(root: string, plan: JoinPlan, modern: boolean): Promise<string> {
  const indices = [1, 2, 3];
  const transactionId = modern ? joinTransactionId(plan, indices) : `csv-join-${createHash("sha256").update(JSON.stringify([plan.digest, indices])).digest("hex")}`;
  await assert.rejects(commitWorkspaceTransaction({ pmRoot: root, transactionId, author: "recovery-test", steps: indices.map(i => ({
    id: plan.ids[i],
    inspect: async () => ({ state: await locateItem(root, plan.ids[i]) ? "applied" as const : "pending" as const }),
    apply: async () => {
      if (i === 2) throw new Error("Legacy forward failure");
      await create(buildMutationIntent({ id: plan.ids[i], title: "B", type: "Task", status: "open", message: `csv-join:${plan.digest}:${i}` }), { pmRoot: root });
      return plan.ids[i];
    },
    compensate: async () => { throw new WorkspaceTransactionInterruptedError(); },
  })) }));
  return transactionId;
}

test("every cleanup boundary resumes the original full-plan journal despite changed foreign eligibility", { timeout: 300000 }, async () => {
  const f = fixture();
  try {
    for (const boundary of ["compensating", "compensation_validated", "compensation_locked", "compensation_checked", "compensation_recorded", "compensation_removed"] as const) {
      for (const mask of [1, 2, 4, 7]) {
        const plan = (await previewJoins(f.root, input())).plan!;
        const before = (await journals(f.root)).length;
        await assert.rejects(applyJoins(f.root, plan, { author: "recovery-test", onBoundary: (phase, id) => {
          if (phase === "before_create" && id === plan.ids[1]) throw new Error("Forward failure after A");
          if (phase === boundary && id === plan.ids[0]) throw new WorkspaceTransactionInterruptedError();
        } }), refused);
        const original = (await journals(f.root)).find(e => e.file.endsWith(`${joinTransactionId(plan, [0, 1, 2, 3])}.json`))!;
        assert.equal(original.status, "compensating");
        const peers: Array<[string, string]> = [];
        for (let i = 1; i < 4; i++) if (mask & (1 << (i - 1))) {
          await create(buildMutationIntent({ id: plan.ids[i], title: `Peer ${i}` }), { pmRoot: f.root });
          peers.push([plan.ids[i], readFileSync(getHistoryPath(f.root, plan.ids[i]), "utf8")]);
        }
        const transitions = new Set<string>();
        await assert.rejects(applyJoins(f.root, plan, { author: "recovery-test", onTransition: e => { transitions.add(e.transactionId); } }), refused);
        assert.deepEqual([...transitions], [joinTransactionId(plan, [0, 1, 2, 3])]);
        assert.equal(await locateItem(f.root, plan.ids[0]), null, `A must be removed at ${boundary}, mask=${mask}`);
        for (const [id, history] of peers) {
          assert.match((await get(id, {}, { pmRoot: f.root })).item.title!, /^Peer /);
          assert.equal(readFileSync(getHistoryPath(f.root, id), "utf8"), history);
        }
        assert.equal((await journals(f.root)).length, before + 1);
        assert.equal((await journals(f.root)).find(e => e.file === original.file)?.status, "compensated");
        const snapshot = bytes(f.root);
        await assert.rejects(applyJoins(f.root, plan, { author: "recovery-test" }), refused);
        assert.equal(bytes(f.root), snapshot, "replay must not fork a completed compensation");
      }
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("historical subset journals keep their original key and steps when all remaining rows become foreign", async () => {
  const f = fixture();
  try {
    for (const modern of [false, true]) {
      const plan = (await previewJoins(f.root, input())).plan!;
      await create(buildMutationIntent({ id: plan.ids[0], title: "Prior foreign" }), { pmRoot: f.root });
      const transactionId = await legacyPending(f.root, plan, modern);
      await create(buildMutationIntent({ id: plan.ids[2], title: "New foreign" }), { pmRoot: f.root });
      await create(buildMutationIntent({ id: plan.ids[3], title: "Later foreign" }), { pmRoot: f.root });
      const count = (await journals(f.root)).length;
      const ids = new Set<string>();
      await assert.rejects(applyJoins(f.root, plan, { author: "recovery-test", onTransition: e => { ids.add(e.transactionId); } }), refused);
      assert.deepEqual([...ids], [transactionId]);
      assert.equal(await locateItem(f.root, plan.ids[1]), null);
      assert.equal((await journals(f.root)).length, count);
      assert.equal((await journals(f.root)).find(e => e.file.endsWith(`${transactionId}.json`))?.status, "compensated");
      for (const i of [0, 2, 3]) assert.match((await get(plan.ids[i], {}, { pmRoot: f.root })).item.title!, /foreign/i);
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("pending compensation wins over a historical committed fork and foreign journal records are ignored", async () => {
  const f = fixture();
  try {
    const plan = (await previewJoins(f.root, input())).plan!;
    await assert.rejects(applyJoins(f.root, plan, { author: "recovery-test", onBoundary: (phase, id) => {
      if (phase === "before_create" && id === plan.ids[1]) throw new Error("Forward failure");
      if (phase === "compensating") throw new Error("Interrupted cleanup");
    } }), refused);
    const fork = joinTransactionId(plan, [0]);
    await commitWorkspaceTransaction({ pmRoot: f.root, transactionId: fork, author: "recovery-test", steps: [{ id: plan.ids[0],
      inspect: async () => ({ state: "applied" }), apply: async () => plan.ids[0], compensate: async () => {},
    }] });
    for (const [name, value] of Object.entries({ unrelated: "{", wrong: JSON.stringify({ schemaVersion: 2 }), other: JSON.stringify({ schemaVersion: 1, transactionId: "not-owned", stepIds: plan.ids }) })) {
      writeFileSync(join(f.root, "transactions/sdk", `csv-join-${name}.json`), value);
    }
    await assert.rejects(applyJoins(f.root, plan, { author: "recovery-test" }), refused);
    assert.equal(await locateItem(f.root, plan.ids[0]), null);
    const before = bytes(f.root);
    await assert.rejects(applyJoins(f.root, plan, { author: "recovery-test" }), e => e instanceof JoinRefusal && e.code === "csv_join_reconcile");
    assert.equal(bytes(f.root), before);
    assert.equal((await resolveJoinJournal(f.root, { ...plan, digest: "0".repeat(64) }, [0, 1, 2, 3])), undefined);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("journal discovery ignores malformed and unrelated records without inventing ownership", async () => {
  const f = fixture();
  try {
    const plan = (await previewJoins(f.root, input())).plan!;
    const directory = join(f.root, "transactions/sdk"); mkdirSync(directory, { recursive: true });
    const values: unknown[] = [null, [], false, {}, { schemaVersion: 2 }, { schemaVersion: 1 },
      { schemaVersion: 1, transactionId: 7 }, { schemaVersion: 1, transactionId: "foreign" },
      { schemaVersion: 1, transactionId: "foreign", stepIds: null }, { schemaVersion: 1, transactionId: "foreign", stepIds: [] },
      { schemaVersion: 1, transactionId: "foreign", stepIds: ["unknown"] },
      { schemaVersion: 1, transactionId: "foreign", stepIds: [plan.ids[0], plan.ids[0]] },
      { schemaVersion: 1, transactionId: "foreign", stepIds: [plan.ids[1], plan.ids[0]] },
      { schemaVersion: 1, transactionId: "foreign", stepIds: plan.ids },
    ];
    for (const [i, value] of values.entries()) writeFileSync(join(directory, `csv-join-foreign-${i}.json`), JSON.stringify(value));
    writeFileSync(join(directory, "other-provider.json"), "{}");
    assert.equal(await resolveJoinJournal(f.root, plan, [0, 1, 2, 3]), undefined);
    assert.equal((await applyJoins(f.root, plan, { author: "recovery-test" })).applied, 4);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("convergent spreadsheet input cannot bypass pending compensation or an unfinished applying journal", async () => {
  const f = fixture();
  try {
    for (const rollback of [true, false]) {
      const item = await create(buildMutationIntent({ title: "Before" }), { pmRoot: f.root });
      const checkout = await exportEditSession(f.root, [item.item.id]);
      checkout.table[1][checkout.table[0].indexOf("title")] = "After";
      await assert.rejects(applyEditSession(f.root, checkout.session, checkout.table, { author: "recovery-test", onTransition: e => {
        if (rollback && e.transition === "committing") throw new Error("Forward failure");
        if (e.transition === (rollback ? "step_compensating" : "step_recorded")) throw new WorkspaceTransactionInterruptedError();
      } }));
      if (rollback) {
        const before = bytes(f.root);
        await assert.rejects(applyEditSession(f.root, checkout.session, checkout.table, { author: "recovery-test", dryRun: true }), e => e instanceof EditRefusal);
        assert.equal(bytes(f.root), before);
        await assert.rejects(applyEditSession(f.root, checkout.session, checkout.table, { author: "recovery-test" }), e => e instanceof EditRefusal);
        assert.equal((await get(item.item.id, {}, { pmRoot: f.root })).item.title, "Before");
        await assert.rejects(applyEditSession(f.root, checkout.session, checkout.table, { author: "recovery-test" }), e => e instanceof EditRefusal);
        assert.equal((await journals(f.root)).filter(e => e.status === "compensating").length, 0);
      } else {
        const history = readFileSync(getHistoryPath(f.root, item.item.id), "utf8");
        assert.equal((await applyEditSession(f.root, checkout.session, checkout.table, { author: "recovery-test" })).applied, 0);
        assert.equal(readFileSync(getHistoryPath(f.root, item.item.id), "utf8"), history);
        assert.equal((await journals(f.root)).filter(e => e.status === "applying").length, 0);
      }
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("recovery selection is revalidated inside SDK writer coordination before forward rows", async () => {
  const f = fixture();
  try {
    const plan = (await previewJoins(f.root, input())).plan!;
    await create(buildMutationIntent({ id: plan.ids[0], title: "Foreign first" }), { pmRoot: f.root });
    const transactionId = await legacyPending(f.root, plan, true);
    const entry = (await journals(f.root)).find(e => e.file.endsWith(`${transactionId}.json`))!;
    const path = join(f.root, entry.file), held = join(f.base, "held-journal.json");
    renameSync(path, held);
    let injected = false;
    await assert.rejects(applyJoins(f.root, plan, { author: "recovery-test", onTransition: e => {
      if (e.transition === "prepared" && !injected) { injected = true; renameSync(held, path); }
    } }), e => e instanceof JoinRefusal && e.code === "csv_join_reconcile");
    assert.equal(injected, true);
    for (const i of [2, 3]) assert.equal(await locateItem(f.root, plan.ids[i]), null);
    await assert.rejects(applyJoins(f.root, plan, { author: "recovery-test" }), refused);
    assert.equal(await locateItem(f.root, plan.ids[1]), null);
    assert.equal((await journals(f.root)).find(e => e.file === entry.file)?.status, "compensated");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("changed atomic filters cannot produce a successful empty or smaller receipt over pending recovery", async () => {
  const f = fixture(), path = process.env.PATH;
  try {
    process.env.PATH = f.bin;
    const file = join(f.base, "input.csv"); writeFileSync(file, "title,priority\nFirst,2\nSecond,3\n");
    const options = { delimiter: ",", dryRun: false, fieldMap: {}, atomic: true, filter: { priority: 2 } };
    await assert.rejects(importCSV(f.root, file, { ...options, commitTransaction: o => commitWorkspaceTransaction({ ...o, pmRoot: f.root, onTransition: e => {
      if (e.transition === "committing") throw new Error("Forward failure");
      if (e.transition === "step_compensating") throw new WorkspaceTransactionInterruptedError();
    } }) }));
    const before = bytes(f.root);
    await assert.rejects(importCSV(f.root, file, { ...options, dryRun: true }), e => e instanceof CommandError);
    assert.equal(bytes(f.root), before);
    const originalEntry = (await journals(f.root))[0], journalPath = join(f.root, originalEntry.file), originalJournal = readFileSync(journalPath, "utf8");
    try {
      writeFileSync(journalPath, "{");
      await assert.rejects(importCSV(f.root, file, { ...options, dryRun: true }), e => e instanceof CommandError);
    } finally { writeFileSync(journalPath, originalJournal); }
    assert.equal(bytes(f.root), before);
    for (const filter of [{ priority: 4 }, { priority: 3 }, undefined]) {
      await assert.rejects(importCSV(f.root, file, { ...options, filter, commitTransaction: o => commitWorkspaceTransaction({ ...o, pmRoot: f.root }) }),
        e => e instanceof CommandError);
      assert.equal(bytes(f.root), before);
    }
    await assert.rejects(importCSV(f.root, file, { ...options, commitTransaction: o => commitWorkspaceTransaction({ ...o, pmRoot: f.root }) }), e => e instanceof CommandError);
    assert.equal((await journals(f.root))[0].status, "compensated");
    assert.equal((await importCSV(f.root, file, { ...options, commitTransaction: o => commitWorkspaceTransaction({ ...o, pmRoot: f.root }) })).imported, 1);
    assert.equal((await journals(f.root)).length, 1);
    assert.equal((await journals(f.root))[0].status, "committed");
  } finally { process.env.PATH = path; rmSync(f.base, { recursive: true, force: true }); }
});

test("canonical checkout selection still refuses a stored document with a different identity", async () => {
  const f = fixture();
  try {
    const created = await create(buildMutationIntent({ title: "Corrupt identity fixture" }), { pmRoot: f.root });
    const located = await locateItem(f.root, created.item.id); assert.ok(located);
    const original = readFileSync(located.itemPath, "utf8");
    writeFileSync(located.itemPath, original.replace(created.item.id, "pm-otheridentity"));
    const before = bytes(f.root);
    await assert.rejects(exportEditSession(f.root, [created.item.id]), e => e instanceof EditRefusal && e.code === "csv_session_invalid");
    assert.equal(bytes(f.root), before);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("recovered cleanup never starts forward rows when its formerly owned target is now foreign", async () => {
  const f = fixture();
  try {
    const plan = (await previewJoins(f.root, input())).plan!;
    await create(buildMutationIntent({ id: plan.ids[0], title: "Foreign first" }), { pmRoot: f.root });
    const transactionId = await legacyPending(f.root, plan, true);
    const located = await locateItem(f.root, plan.ids[1]); assert.ok(located);
    // Preserve the old fixture records outside the tracker while simulating a foreign store replacement.
    renameSync(located.itemPath, join(f.base, "original-item.toon"));
    renameSync(getHistoryPath(f.root, plan.ids[1]), join(f.base, "original-birth.jsonl"));
    await create(buildMutationIntent({ id: plan.ids[1], title: "Foreign replacement" }), { pmRoot: f.root });
    const history = readFileSync(getHistoryPath(f.root, plan.ids[1]), "utf8");
    await assert.rejects(applyJoins(f.root, plan, { author: "recovery-test" }), refused);
    for (const i of [2, 3]) assert.equal(await locateItem(f.root, plan.ids[i]), null);
    assert.equal(readFileSync(getHistoryPath(f.root, plan.ids[1]), "utf8"), history);
    assert.equal((await get(plan.ids[1], {}, { pmRoot: f.root })).item.title, "Foreign replacement");
    assert.equal((await journals(f.root)).find(e => e.file.endsWith(`${transactionId}.json`))?.status, "compensated");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("empty and entirely foreign fresh plans remain non-writing", async () => {
  const f = fixture();
  try {
    const empty = input(); empty.tables[0].csv = "key,title\n";
    const zero = (await previewJoins(f.root, empty)).plan!;
    const initial = bytes(f.root);
    assert.equal((await applyJoins(f.root, zero, { author: "recovery-test" })).rows, 0);
    assert.equal(bytes(f.root), initial);
    const plan = (await previewJoins(f.root, input())).plan!;
    for (const id of plan.ids) await create(buildMutationIntent({ id, title: "Foreign" }), { pmRoot: f.root });
    const before = bytes(f.root);
    assert.equal((await applyJoins(f.root, plan, { author: "recovery-test" })).skipped, 4);
    assert.equal(bytes(f.root), before);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("an advanced SDK attempt generation cannot restart a frozen plan at the writer boundary", async () => {
  const f = fixture();
  try {
    const plan = (await previewJoins(f.root, input())).plan!;
    await assert.rejects(applyJoins(f.root, plan, { author: "recovery-test", onTransition: async e => {
      if (e.transition === "prepared") {
        const entry = (await journals(f.root)).find(row => row.file.endsWith(`${e.transactionId}.json`))!;
        const path = join(f.root, entry.file), value = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(path, JSON.stringify({ ...value, attempt: 2 }));
      }
    } }), e => e instanceof JoinRefusal && e.code === "csv_join_reconcile");
    for (const id of plan.ids) assert.equal(await locateItem(f.root, id), null);
    const before = bytes(f.root);
    await assert.rejects(applyJoins(f.root, plan, { author: "recovery-test" }), refused);
    assert.equal(bytes(f.root), before);
    assert.equal((await journals(f.root)).length, 1);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("a displaced prepared receipt never authorizes forward writes", async () => {
  const f = fixture();
  try {
    const plan = (await previewJoins(f.root, input())).plan!;
    await assert.rejects(applyJoins(f.root, plan, { author: "recovery-test", onTransition: async e => {
      if (e.transition === "prepared") {
        const entry = (await journals(f.root)).find(row => row.file.endsWith(`${e.transactionId}.json`))!;
        renameSync(join(f.root, entry.file), join(f.base, "displaced-native-receipt.json"));
      }
    } }), refused);
    for (const id of plan.ids) assert.equal(await locateItem(f.root, id), null);
    assert.equal((await journals(f.root)).length, 0);
    assert.equal(JSON.parse(readFileSync(join(f.base, "displaced-native-receipt.json"), "utf8")).status, "applying");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

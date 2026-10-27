import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { create, update, get, getHistoryPath, locateItem, listAllComplete, readHistoryEntries, readSettings, verifyHistoryEntries, emptyImportedDocument, deriveMutationTransactionId, commitWorkspaceTransaction, acquireLock, PmCliError, focus, deleteItem, appendHistoryEntry, createHistoryEntry, nowIso, schemaAddStatus } from "@unbrained/pm-cli/sdk";
import { previewJoins, applyJoins, JoinRefusal, joinTransactionId, mutateJoinIndex } from "../join-plans.ts";
import type { JoinInput, JoinPlan } from "../join-plans.ts";
import { parseFieldMap, applyFieldMap, normalizeStatus, readBoolOption, resolveImportFieldMap, buildCsvExport, parseCSV, importLineage } from "../index.ts";
import { describeTable } from "../table-schema.ts";
import { createHash } from "node:crypto";
import { readUpdateDocument } from "../atomic-update.ts";
import { buildMutationIntent } from "../mutation-intent.ts";

const TOKENS = ["constructor", "__proto__", "toString", "hasOwnProperty", "prototype"];
/** Real native tracker outside Git, with a CLI path containing no Git executable. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "csv-keyed-atomic-")), root = join(base, "tracker"), bin = join(base, "bin");
  mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), join(bin, "pm"));
  const init = spawnSync(process.execPath, [join(bin, "pm"), "init", "--defaults", "--path", root], { encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(base) } });
  assert.equal(init.status, 0, init.stderr);
  return { base, root, bin };
}
/** Three ordered rows with both hierarchy and dependency links. */
function input(): JoinInput {
  return { version: 1, tables: [{ name: "tasks", key: "key", csv: "key,title,parent,blocker\na,First,,\nb,Second,a,\nc,Third,,b\n",
    fields: { title: "title" }, references: [{ column: "parent", table: "tasks", kind: "parent" }, { column: "blocker", table: "tasks", kind: "blocked_by" }] }] };
}
/** Read all durable tracker bytes, excluding live SDK lock files. */
function bytes(root: string): string {
  return JSON.stringify(readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && !e.name.endsWith(".lock")).map(e => [join(e.parentPath, e.name).slice(root.length), readFileSync(join(e.parentPath, e.name), "utf8")]).sort());
}
/** Require the documented refusal family rather than a TypeError or inherited value. */
function refusal(error: unknown): boolean { assert.ok(error instanceof JoinRefusal); return true; }
/** Canonical SHA used only to test a validly hashed but adversarial saved artifact. */
function digest(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }

// Repeated keyed permutations exercise dictionaries independently of implementation constants.
test("500 keyed permutations never inherit prototype names in mappings, flags or status aliases", () => {
  for (let seed = 1; seed <= 500; seed++) {
    const key = TOKENS[seed % TOKENS.length], normalized = key.toLowerCase();
    assert.deepEqual(applyFieldMap([key], {}), [key]);
    assert.deepEqual(applyFieldMap([key], Object.create({ [key]: "body" })), [key]);
    const mapping = parseFieldMap(`${key}=title`);
    assert.equal(Object.hasOwn(mapping, normalized), true);
    assert.deepEqual(applyFieldMap([normalized], mapping), ["title"]);
    assert.equal(normalizeStatus(key), "open");
    assert.equal(readBoolOption({}, key), false);
    const resolved = resolveImportFieldMap([normalized], mapping, seed % 2 === 0);
    assert.equal(Object.hasOwn(resolved.fieldMap, normalized), true);
    assert.equal(resolved.fieldMap[normalized], "title");
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  }
});

test("prototype type/status/field values refuse before any row; prototype headers, external keys and references stay literal", { timeout: 180000 }, async () => {
  const f = fixture(), previousPath = process.env.PATH;
  try {
    process.env.PATH = f.bin;
    const valid = await previewJoins(f.root, input()); assert.ok(valid.plan);
    const before = bytes(f.root);
    for (const token of TOKENS) {
      for (const field of ["type", "status"]) {
        const bad = { version: 1, tables: [{ name: "tasks", key: "key", csv: `key,title,${field}\na,Valid,${field === "type" ? "Task" : "open"}\nb,Invalid,${token}\n`, fields: { title: "title", [field]: field }, references: [] }] };
        await assert.rejects(previewJoins(f.root, bad), refusal);
        const base = { ...valid.plan, ids: valid.plan.ids.slice(0, 2), input: bad, sources: [digest(bad.tables[0].csv)] }; const { digest: _digest, ...unsigned } = base;
        await assert.rejects(applyJoins(f.root, { ...unsigned, digest: digest(unsigned) }, { author: "key-test" }), refusal);
        assert.equal(bytes(f.root), before, `${field}=${token} must mutate zero bytes`);
      }
      const fields = Object.fromEntries([["title", "title"], [token, "title"]]);
      await assert.rejects(previewJoins(f.root, { version: 1, tables: [{ name: "tasks", key: "key", csv: "key,title\na,Valid\n", fields, references: [] }] }), refusal);
      assert.equal(bytes(f.root), before);
    }
    for (const token of TOKENS) {
      const mapped = parseFieldMap(`${token}=title`);
      const described = await describeTable(f.root, `${token}\nMapped\n`, { fieldMap: mapped });
      assert.equal(described.schema.columns[0].field, "title");
      const ignored = await describeTable(f.root, `title,${token}\nName,Value\n`);
      assert.equal(ignored.schema.columns[1].field, null);
      const lineage = await importLineage(f.root, [[token], [`Lineage ${token}`]], { columns: ["title"], fieldMap: { [token]: "title" } });
      assert.equal(lineage.receipt.imported, 1);
      const source: JoinInput = { version: 1, tables: [
        { name: "constructor", key: token, csv: `${token},title\n${token},Parent\n`, fields: { title: "title" }, references: [] },
        { name: "prototype", key: "key", csv: `key,${token},ref\nchild,Child,${token}\n`, fields: { title: token }, references: [{ column: "ref", table: "constructor", kind: "parent" }] },
      ] };
      const p = await previewJoins(f.root, source); assert.ok(p.plan);
      assert.equal((await applyJoins(f.root, p.plan, { author: "key-test" })).applied, 2);
      assert.equal((await get(p.plan.ids[1], {}, { pmRoot: f.root })).item.parent, p.plan.ids[0]);
      assert.equal((await applyJoins(f.root, p.plan, { author: "key-test" })).unchanged, 2);
    }
    for (const columnSource of [undefined, {}, Object.create({ title: "constructor" })]) {
      const exported = parseCSV(buildCsvExport(f.root, { columns: ["title", ...TOKENS], columnSource, delimiter: "," }).csvText);
      assert.ok(exported.slice(1).every(row => row.slice(1).every(cell => cell === "") && !row[0].startsWith("function")), "export must not stringify inherited functions");
    }
  } finally { process.env.PATH = previousPath; rmSync(f.base, { recursive: true, force: true }); }
});

test("failure at every row before/after persistence compensates all owned creates and retry revalidates SDK tombstones", { timeout: 180000 }, async () => {
  const f = fixture();
  try {
    const foreign = await create({ title: "Unrelated", unset: ["parent"] }, { pmRoot: f.root });
    const foreignHistory = readFileSync(getHistoryPath(f.root, foreign.item.id), "utf8");
    for (const persisted of [false, true]) for (let row = 0; row < 3; row++) {
      const p = (await previewJoins(f.root, input())).plan!;
      const count = (await listAllComplete({}, { pmRoot: f.root })).items.length;
      await assert.rejects(applyJoins(f.root, p, { author: "atomic-test",
        onBoundary: (phase, id) => { if (!persisted && phase === "before_create" && id === p.ids[row]) throw new Error("Injected row refusal"); },
        onTransition: e => { if (persisted && e.transition === "step_applied" && e.stepId === p.ids[row]) throw new Error("Injected persisted-row refusal"); },
      }), refusal);
      assert.equal((await listAllComplete({}, { pmRoot: f.root })).items.length, count);
      for (const [i, id] of p.ids.entries()) {
        assert.equal(await locateItem(f.root, id), null, `row ${row}, persisted ${persisted}, target ${i}`);
        const history = await readHistoryEntries(getHistoryPath(f.root, id), id);
        if (i < row || (persisted && i === row)) {
          assert.equal(history.length, 2); assert.equal(history[1].op, "delete");
          assert.equal(verifyHistoryEntries(history, emptyImportedDocument()).ok, true);
        } else assert.equal(history.length, 0);
      }
      if (row > 0 || persisted) await assert.rejects(applyJoins(f.root, p, { author: "atomic-test" }), refusal);
      const fresh = (await previewJoins(f.root, input())).plan!;
      assert.equal((await applyJoins(f.root, fresh, { author: "atomic-test" })).applied, 3);
      assert.equal((await applyJoins(f.root, fresh, { author: "atomic-test" })).unchanged, 3);
      assert.equal(readFileSync(getHistoryPath(f.root, foreign.item.id), "utf8"), foreignHistory);
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("compensation resumes every durable phase; peers cannot write inside its lease", { timeout: 180000 }, async () => {
  const f = fixture(), wait = process.env.PM_LOCK_WAIT_MS;
  try {
    for (const phase of ["compensating", "compensation_validated", "compensation_locked", "compensation_checked", "compensation_recorded", "compensation_removed"] as const) {
      const p = (await previewJoins(f.root, input())).plan!; let injected = false;
      await assert.rejects(applyJoins(f.root, p, { author: "atomic-test",
        onBoundary: async (seen, id) => {
          if (seen === "before_create" && id === p.ids[2]) throw new Error("Forward failure");
          if (seen === phase && id === p.ids[0] && !injected) {
            injected = true;
            if (phase === "compensation_locked" || phase === "compensation_checked" || phase === "compensation_recorded" || phase === "compensation_removed") {
              process.env.PM_LOCK_WAIT_MS = "0";
              await assert.rejects(acquireLock(f.root, id, 30, "competing-agent", false, false, 0, { maxWaitMs: 0 }),
                (error: unknown) => error instanceof PmCliError && error.context?.code === "lock_conflict");
              if (phase !== "compensation_removed") await assert.rejects(update(id, { priority: 4 }, { pmRoot: f.root }),
                (error: unknown) => error instanceof PmCliError && error.context?.code === "lock_conflict");
            }
            throw new Error("Interrupted compensation");
          }
        },
      }), refusal);
      assert.equal(injected, true, phase);
      await assert.rejects(applyJoins(f.root, p, { author: "atomic-test" }), refusal);
      for (const id of p.ids) assert.equal(await locateItem(f.root, id), null, "recovery finishes compensation before refusing frozen IDs");
      const fresh = (await previewJoins(f.root, input())).plan!;
      assert.equal((await applyJoins(f.root, fresh, { author: "atomic-test" })).applied, 3);
      assert.equal((await applyJoins(f.root, fresh, { author: "atomic-test" })).unchanged, 3);
    }
  } finally { if (wait === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = wait; rmSync(f.base, { recursive: true, force: true }); }
});

test("SDK transaction identity and old-host index capabilities remain portable", async () => {
  const f = fixture();
  try {
    const p = (await previewJoins(f.root, input())).plan!;
    assert.equal(joinTransactionId(p, [0, 1, 2]), joinTransactionId(p, [0, 1, 2], null));
    assert.equal(joinTransactionId(p, [0], deriveMutationTransactionId), joinTransactionId(p, [0]));
    assert.notEqual(joinTransactionId(p, [0]), joinTransactionId(p, [1]));
    const settings = await readSettings(f.root);
    const mutation = { id: "pm-missing", idPrefix: settings.id_prefix, pmRoot: f.root, preferredFormat: settings.item_format, typeToFolder: { Task: "tasks" }, schema: settings.schema, itemPath: join(f.root, "tasks/missing.toon"), document: null };
    let called = false; await mutateJoinIndex(mutation, async () => { called = true; }, {}); assert.equal(called, true);
    await assert.rejects(mutateJoinIndex(mutation, async () => { throw new Error("Real callback failure"); }), /Real callback failure/);
    // A pre-upgrade journal keeps its original identity instead of being bypassed.
    const legacy = `csv-join-${digest([p.digest, [0, 1, 2]])}`;
    await commitWorkspaceTransaction({ pmRoot: f.root, transactionId: legacy, author: "atomic-test", steps: p.ids.map((id, i) => ({ id,
      inspect: async () => ({ state: "pending" as const }),
      apply: async () => { await create({ id, title: ["First", "Second", "Third"][i], unset: ["parent"], message: `csv-join:${p.digest}:${i}` }, { pmRoot: f.root }); return id; },
      compensate: async () => {},
    })) });
    // Missing reviewed links are still refused before that legacy receipt is trusted.
    await assert.rejects(applyJoins(f.root, p, { author: "atomic-test" }), refusal);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("compensation preserves peer revisions and foreign replacements at both unlocked boundaries", { timeout: 180000 }, async () => {
  const f = fixture();
  try {
    const edited = (await previewJoins(f.root, input())).plan!;
    await assert.rejects(applyJoins(f.root, edited, { author: "atomic-test", onBoundary: async (phase, id) => {
      if (phase === "before_create" && id === edited.ids[2]) throw new Error("Forward failure");
      if (phase === "compensation_validated" && id === edited.ids[0]) await update(id, { priority: 4 }, { pmRoot: f.root });
    } }), refusal);
    assert.equal((await get(edited.ids[0], {}, { pmRoot: f.root })).item.priority, 4);
    for (const boundary of ["compensating", "compensation_validated"] as const) {
      const p = (await previewJoins(f.root, input())).plan!; let replaced = false;
      await assert.rejects(applyJoins(f.root, p, { author: "atomic-test", onBoundary: async (phase, id) => {
        if (phase === "before_create" && id === p.ids[2]) throw new Error("Forward failure");
        if (phase === boundary && id === p.ids[0] && !replaced) {
          replaced = true;
          const located = await locateItem(f.root, id); assert.ok(located);
          // Test-only replacement of both records simulates a foreign identity/store transition.
          rmSync(located.itemPath); rmSync(getHistoryPath(f.root, id));
          await create({ id, title: "Foreign replacement", unset: ["parent"] }, { pmRoot: f.root });
        }
      } }), refusal);
      assert.equal(replaced, true);
      const before = bytes(f.root);
      assert.equal((await applyJoins(f.root, p, { author: "atomic-test" })).skipped, 3);
      assert.equal(bytes(f.root), before);
      assert.equal((await get(p.ids[0], {}, { pmRoot: f.root })).item.title, "Foreign replacement");
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("inherited mutation scope cannot invent relationships or unset source-owned values", async () => {
  const f = fixture();
  try {
    const parent = (await create({ title: "Ambient", unset: ["parent"] }, { pmRoot: f.root })).item.id;
    await focus(parent, {}, { pmRoot: f.root });
    const source = Object.assign(Object.create({ parent, assignee: "Injected", sprint: "Injected", release: "Injected", unset: ["priority"], dep: [`kind=blocked_by,id=${parent}`] }), { title: "Own title", priority: 3 });
    const item = (await create(buildMutationIntent(source), { pmRoot: f.root })).item;
    const saved = (await get(item.id, { full: true }, { pmRoot: f.root })).item;
    assert.equal(saved.parent, undefined); assert.equal(saved.assignee, undefined); assert.equal(saved.sprint, undefined); assert.equal(saved.release, undefined);
    assert.equal(saved.dependencies?.length ?? 0, 0); assert.equal(saved.priority, 3);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

/** Simulate a peer completing native compensation, with optional external history loss. */
async function peerCleanup(root: string, p: JoinPlan, id: string, loseHistory: boolean): Promise<void> {
  const index = p.ids.indexOf(id);
  await deleteItem(id, { force: true, message: `csv-join:${p.digest}:${index}:compensate` }, { pmRoot: root });
  if (loseHistory) rmSync(getHistoryPath(root, id));
}

test("compensation rechecks a peer's completed cleanup both before validation and before acquiring its lease", { timeout: 180000 }, async () => {
  const f = fixture();
  try {
    for (const boundary of ["step_compensating", "compensation_validated"]) for (const loseHistory of [false, true]) {
      const p = (await previewJoins(f.root, input())).plan!; let injected = false;
      const compete = async (phase: string, id: string | undefined) => {
        if (phase === boundary && id === p.ids[1] && !injected) { injected = true; await peerCleanup(f.root, p, id, loseHistory); }
      };
      await assert.rejects(applyJoins(f.root, p, { author: "atomic-test",
        onTransition: e => compete(e.transition, e.stepId),
        onBoundary: async (phase, id) => { if (phase === "before_create" && id === p.ids[2]) throw new Error("Forward refusal"); await compete(phase, id); },
      }), refusal);
      assert.equal(injected, true);
      for (const id of p.ids) assert.equal(await locateItem(f.root, id), null);
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("compensation refuses changed settings and missing files after its locked revision check", { timeout: 180000 }, async () => {
  for (const fault of ["settings", "missing"]) {
    const f = fixture();
    try {
      const p = (await previewJoins(f.root, input())).plan!;
      await assert.rejects(applyJoins(f.root, p, { author: "atomic-test", onBoundary: async (phase, id) => {
        if (phase === "before_create" && id === p.ids[2]) throw new Error("Forward refusal");
        if (id === p.ids[0] && fault === "settings" && phase === "compensation_locked") await schemaAddStatus("policy-changed", { role: ["active"] }, { pmRoot: f.root });
        if (id === p.ids[0] && fault === "missing" && phase === "compensation_checked") { const located = await locateItem(f.root, id); assert.ok(located); rmSync(located.itemPath); }
      } }), refusal);
      if (fault === "settings") assert.equal((await get(p.ids[0], {}, { pmRoot: f.root })).item.title, "First");
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  }
});

/** Append a native tombstone under the same SDK item lease used by a concurrent drainer. */
async function peerTombstone(root: string, p: JoinPlan, id: string, invalid = false): Promise<void> {
  const settings = await readSettings(root), release = await acquireLock(root, id, settings.locks.ttl_seconds, "peer", false, false, 0);
  try {
    const document = await readUpdateDocument(root, id);
    await appendHistoryEntry(getHistoryPath(root, id), createHistoryEntry({ nowIso: nowIso(), author: "peer", op: "delete", before: document,
      after: invalid ? document : emptyImportedDocument(), message: `csv-join:${p.digest}:${p.ids.indexOf(id)}:compensate` }));
  } finally { await release(); }
}

test("pending and committed journal inspections cannot mistake a recorded tombstone for an unchanged live target", { timeout: 180000 }, async () => {
  const f = fixture();
  try {
    const source: JoinInput = { version: 1, tables: [{ name: "tasks", key: "key", csv: "key,title\na,First\n", fields: { title: "title" }, references: [] }] };
    const p = (await previewJoins(f.root, source)).plan!; let injected = false;
    await assert.rejects(applyJoins(f.root, p, { author: "atomic-test", onBoundary: async (phase, id) => {
      if (phase === "inspected" && !injected) {
        injected = true;
        await create(buildMutationIntent({ id, title: "First", message: `csv-join:${p.digest}:0` }), { pmRoot: f.root });
        await peerTombstone(f.root, p, id);
      }
    } }), refusal);
    assert.equal(await locateItem(f.root, p.ids[0]), null);
    for (const invalid of [false, true]) {
      const committed = (await previewJoins(f.root, source)).plan!;
      await applyJoins(f.root, committed, { author: "atomic-test" });
      await peerTombstone(f.root, committed, committed.ids[0], invalid);
      const before = bytes(f.root);
      await assert.rejects(applyJoins(f.root, committed, { author: "atomic-test" }), refusal);
      assert.equal(bytes(f.root), before);
    }
    const missing = (await previewJoins(f.root, source)).plan!;
    await applyJoins(f.root, missing, { author: "atomic-test" });
    const located = await locateItem(f.root, missing.ids[0]); assert.ok(located); rmSync(located.itemPath);
    await assert.rejects(applyJoins(f.root, missing, { author: "atomic-test" }), refusal);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("a committed pre-upgrade journal keeps its key and still revalidates current SDK state", async () => {
  const f = fixture();
  try {
    const source: JoinInput = { version: 1, tables: [{ name: "tasks", key: "key", csv: "key,title\na,Legacy\n", fields: { title: "title" }, references: [] }] };
    const p = (await previewJoins(f.root, source)).plan!;
    await commitWorkspaceTransaction({ pmRoot: f.root, transactionId: `csv-join-${digest([p.digest, [0]])}`, author: "atomic-test", steps: [{
      id: p.ids[0], inspect: async () => ({ state: "pending" }),
      apply: async () => { await create(buildMutationIntent({ id: p.ids[0], title: "Legacy", message: `csv-join:${p.digest}:0` }), { pmRoot: f.root }); return p.ids[0]; },
      compensate: async () => {},
    }] });
    assert.equal((await applyJoins(f.root, p, { author: "atomic-test" })).unchanged, 1);
    assert.equal((await readHistoryEntries(getHistoryPath(f.root, p.ids[0]), p.ids[0])).length, 1);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

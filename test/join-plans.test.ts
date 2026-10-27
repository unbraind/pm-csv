import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, cpSync, mkdirSync, symlinkSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { create, update, get, readHistoryEntries, getHistoryPath, WorkspaceTransactionInterruptedError, schemaAddStatus, deleteItem, locateItem, focus, acquireLock } from "@unbrained/pm-cli/sdk";
import { applyJoins, previewJoins, JoinRefusal, assertJoinNumbers } from "../join-plans.ts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { serializeCSV } from "../index.ts";
import { readUpdateDocument } from "../atomic-update.ts";
import type { JoinInput, JoinPlan } from "../join-plans.ts";

/** Initialize a genuine non-git tracker isolated from ancestor repositories. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "csv-joins-"));
  const result = spawnSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "--defaults", "--path", root], { encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } });
  assert.equal(result.status, 0, result.stderr);
  return root;
}
/** Three selected external tables with cross-table parent and dependency edges. */
function input(): JoinInput {
  return { version: 1, tables: [
    { name: "projects", key: "key", csv: "key,title\np1,Project\n", fields: { title: "title" }, references: [] },
    { name: "tasks", key: "key", csv: "key,title,project\nt1,Task,p1\n", fields: { title: "title" }, references: [{ column: "project", table: "projects", kind: "parent" }] },
    { name: "checks", key: "key", csv: "key,title,task\nc1,Check,t1\n", fields: { title: "title" }, references: [{ column: "task", table: "tasks", kind: "blocked_by" }] },
  ] };
}
/** Read every durable file to prove previews and refusals cannot mutate state. */
function snapshot(root: string): string {
  return JSON.stringify(readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && !e.name.endsWith(".lock")).map(e => [join(e.parentPath, e.name).slice(root.length), readFileSync(join(e.parentPath, e.name), "utf8")]).sort());
}
/** Require a valid preview artifact before entering mutation assertions. */
async function plan(root: string, value = input()): Promise<JoinPlan> {
  const result = await previewJoins(root, value);
  assert.equal(result.receipt.ok, true);
  assert.ok(result.plan);
  return result.plan;
}

test("three-table preview resolves every reference without git; apply and replay read SDK state", async () => {
  const root = fixture();
  try {
    const before = snapshot(root);
    const p = await plan(root);
    assert.equal(snapshot(root), before);
    const receipt = await applyJoins(root, p, { author: "join-test" });
    assert.equal(receipt.applied, 3);
    const task = await get(p.ids[1], {}, { pmRoot: root });
    const check = await get(p.ids[2], {}, { pmRoot: root });
    assert.equal(task.item.parent, p.ids[0]);
    assert.ok(check.item.dependencies?.some(e => e.id === p.ids[1] && e.kind === "blocked_by"));
    assert.equal((await applyJoins(root, p, { author: "join-test" })).unchanged, 3);
    for (const id of p.ids) assert.equal((await readHistoryEntries(getHistoryPath(root, id), id)).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("duplicates, unresolved references, empty keys and cycles expose coordinates and mutate zero bytes", async () => {
  const root = fixture();
  try {
    const before = snapshot(root);
    for (const csv of ["key,title\np1,One\np1,Two\n", "key,title\n,Blank\n", "key,title\np2,Missing\n"]) {
      const value = input(); value.tables[0].csv = csv;
      const result = await previewJoins(root, value);
      assert.equal(result.receipt.ok, false);
      assert.ok(result.receipt.issues.every(i => i.row >= 2 && i.column >= 1));
      assert.equal(result.plan, undefined);
    }
    const cyclic = input();
    cyclic.tables[0].csv = "key,title,ref\np1,Project,c1\n";
    cyclic.tables[0].references = [{ column: "ref", table: "checks", kind: "parent" }];
    assert.ok((await previewJoins(root, cyclic)).receipt.issues.some(i => i.code === "cycle"));
    assert.equal(snapshot(root), before);
    const optional = input(); optional.tables[2].csv = "key,title,task\nc1,Check,\n";
    assert.equal((await previewJoins(root, optional)).receipt.references, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("foreign targets skip their complete dependency closure and are never modified", async () => {
  const root = fixture();
  try {
    const p = await plan(root);
    await create({ id: p.ids[0], title: "Peer" }, { pmRoot: root });
    const before = snapshot(root);
    const receipt = await applyJoins(root, p, { author: "join-test" });
    assert.equal(receipt.skipped, 3);
    assert.deepEqual(receipt.issues.map(i => i.code), ["foreign", "dependency_skipped", "dependency_skipped"]);
    assert.equal(snapshot(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recovery revalidates current owned revisions even after journal commit", async () => {
  const root = fixture();
  try {
    const p = await plan(root);
    await assert.rejects(applyJoins(root, p, { author: "join-test", onTransition: context => {
      if (context.transition === "step_recorded") throw new WorkspaceTransactionInterruptedError();
    } }));
    await update(p.ids[0], { title: "Peer edit" }, { pmRoot: root });
    const before = snapshot(root);
    await assert.rejects(applyJoins(root, p, { author: "join-test" }), e => e instanceof JoinRefusal && e.code === "csv_join_target_changed");
    assert.equal(snapshot(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preflight refusal waits for earlier SDK leases and returns with no sibling inspections running", async () => {
  const root = fixture();
  let release: (() => Promise<void>) | undefined;
  let retry: Promise<unknown> | undefined;
  const savedWait = process.env.PM_LOCK_WAIT_MS;
  try {
    process.env.PM_LOCK_WAIT_MS = "3000";
    const p = await plan(root);
    await applyJoins(root, p, { author: "join-test" });
    await update(p.ids[1], { title: "Peer edit" }, { pmRoot: root });
    release = await acquireLock(root, p.ids[0], 30, "peer-test");
    const before = snapshot(root);
    let settled = false;
    retry = applyJoins(root, p, { author: "join-test" }).then(
      result => { settled = true; return result; },
      error => { settled = true; return error; },
    );
    await delay(150);
    assert.equal(settled, false, "a later target refusal cannot return while an earlier SDK lease inspection is pending");
    await release(); release = undefined;
    const error = await retry;
    assert.ok(error instanceof JoinRefusal);
    assert.equal(error.code, "csv_join_target_changed");
    assert.equal(snapshot(root), before);
    await delay(150);
    assert.equal(snapshot(root), before, "no late lease cleanup may change tracker bytes after the public refusal");
    assert.equal((await get(p.ids[1], {}, { pmRoot: root })).item.title, "Peer edit");
  } finally {
    await release?.();
    await retry;
    if (savedWait === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = savedWait;
    rmSync(root, { recursive: true, force: true });
  }
});

/** Assert the same structured refusal across malformed SDK and CLI boundaries. */
function refuses(error: unknown): boolean {
  assert.ok(error instanceof JoinRefusal);
  assert.equal(error.exitCode, 2);
  assert.ok(error.remedy.length > 30);
  return true;
}

test("strict shared boundary fuzz rejects sparse arrays, unknown keys, nonfinite and excessive inputs", async () => {
  const root = fixture();
  try {
    const bad: unknown[] = [null, false, [], {}, { ...input(), version: 2 }, { ...input(), extra: 1 }, { ...input(), tables: new Array(2) }, { ...input(), tables: [] }, { ...input(), tables: Array(17).fill(input().tables[0]) }];
    for (const change of [
      { name: 4 }, { name: "UPPER" }, { name: "a".repeat(65) }, { key: "" }, { key: null }, { csv: 7 }, { csv: "x".repeat(8 * 1024 * 1024 + 1) },
      { fields: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`field${i}`, "title"])) }, { fields: null }, { fields: [] }, { fields: {} }, { fields: { title: 7 } }, { fields: { title: "title", typo: "x" } },
      { references: new Array(1) }, { references: [{ column: "x", table: "projects", kind: "bad" }] },
      { references: [{ column: "x", table: "projects", kind: "parent" }, { column: "y", table: "projects", kind: "parent" }] },
    ]) bad.push({ version: 1, tables: [{ ...input().tables[0], ...change }] });
    const augmented = [input().tables[0]];
    Object.assign(augmented, { extra: true });
    bad.push({ version: 1, tables: augmented }, { version: 1, tables: [input().tables[0], input().tables[0]] });
    for (const value of bad) await assert.rejects(previewJoins(root, value), refuses);
    for (const change of [
      { key: "absent" }, { fields: { title: "missing" } }, { references: [{ column: "title", table: "missing", kind: "parent" }] },
      { csv: `key,title\n${Array.from({ length: 1001 }, (_, i) => `${i},Title`).join("\n")}\n` },
    ]) await assert.rejects(previewJoins(root, { version: 1, tables: [{ ...input().tables[0], ...change }] }), refuses);
    for (const [field, values] of Object.entries({ title: [" "], priority: ["-1", "5", "Infinity", "NaN", "1.5"], estimatedMinutes: ["", " ", "-1", "NaN", "Infinity", "1e309", "1000000001"], type: ["unknown"], status: ["unknown", "closed"] })) {
      for (const value of values) {
        const t = input().tables[0];
        t.csv = `key,title,value\np1,Title,${value}\n`;
        t.fields = { title: "title", [field]: "value" };
        await assert.rejects(previewJoins(root, { version: 1, tables: [t] }), refuses);
      }
    }
    const terminal = input().tables[0];
    terminal.csv = "key,title,state,reason\np1,Done,closed,Imported completion\n";
    terminal.fields = { title: "title", status: "state", closeReason: "reason" };
    assert.equal((await previewJoins(root, { version: 1, tables: [terminal] })).receipt.ok, true);
    terminal.csv = terminal.csv.replace("Imported completion", " ");
    await assert.rejects(previewJoins(root, { version: 1, tables: [terminal] }), refuses);
    const p = await plan(root);
    for (const change of [{ version: 2 }, { expected: "changed" }, { digest: "bad" }, { sources: [7] }, { sources: ["z".repeat(64)] }, { settings: "bad" }, { ids: ["UPPER"] }, { ids: [p.ids[0], p.ids[0]] }, { sources: new Array(1) }]) {
      await assert.rejects(applyJoins(root, { ...p, ...change }, { author: "join-test" }), refuses);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("all forward journal transition boundaries recover or preserve competing writes on one non-git tracker", async () => {
  const root = fixture();
  try {
    const baseline = await plan(root);
    const boundaries: { transition: string; stepId?: string }[] = [];
    await applyJoins(root, baseline, { author: "join-test", onTransition: e => { boundaries.push({ transition: e.transition, stepId: e.stepId }); } });
    for (const [boundary, event] of boundaries.entries()) {
      const p = await plan(root);
      let injected = false, step = 0;
      const receipt = await applyJoins(root, p, { author: "join-test", onTransition: async () => {
        if (step++ !== boundary) return;
        injected = true;
        // Race a native writer at EACH emitted transition, including between apply and journal record.
        if (event.transition === "prepared" || event.transition === "step_applied" || event.transition === "step_recorded") {
          try { await create({ id: p.ids[2], title: "Foreign target" }, { pmRoot: root }); } catch { /* already owned at later boundaries */ }
        }
      } });
      assert.equal(injected, true);
      assert.equal(receipt.applied + receipt.unchanged + receipt.skipped, 3);
      if (receipt.skipped) assert.equal((await get(p.ids[2], {}, { pmRoot: root })).item.title, "Foreign target");
    }
    // A second drainer's exact owned create is reported as unchanged, including unrecorded success.
    const p = await plan(root);
    const result = await applyJoins(root, p, { author: "join-test", onTransition: async e => {
      if (e.transition === "prepared") await create({ id: p.ids[0], title: "Project", author: "peer", message: `csv-join:${p.digest}:0` }, { pmRoot: root });
    } });
    assert.equal(result.applied, 2);
    assert.equal(result.unchanged, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("output-number fuzz and artifact digest/revision checks reject extremes before writes", async () => {
  const root = fixture();
  try {
    assertJoinNumbers([0, 1, 32000]);
    for (const n of [NaN, Infinity, -Infinity, -1, 0.1, 32001, Number.MAX_VALUE, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER]) assert.throws(() => assertJoinNumbers([n]), refuses);
    const p = await plan(root);
    const sign = (p: JoinPlan): JoinPlan => {
      const { digest: _digest, ...base } = p;
      return { ...base, digest: createHash("sha256").update(JSON.stringify(base)).digest("hex") };
    };
    const wrongSources = sign({ ...p, sources: p.sources.slice(1) });
    await assert.rejects(applyJoins(root, wrongSources, { author: "test" }), refuses);
    await assert.rejects(applyJoins(root, sign({ ...p, ids: p.ids.slice(1) }), { author: "test" }), refuses);
    const badGraph = structuredClone(p);
    badGraph.input.tables[0].csv = "key,title\nother,Changed\n";
    badGraph.sources[0] = createHash("sha256").update(badGraph.input.tables[0].csv).digest("hex");
    await assert.rejects(applyJoins(root, sign(badGraph), { author: "test" }), refuses);
    const extraSource = input();
    extraSource.tables[0].csv += `p2,${"x".repeat(4 * 1024 * 1024)}\n`;
    extraSource.tables[1].csv += `t2,${"x".repeat(4 * 1024 * 1024)},p2\n`;
    await assert.rejects(previewJoins(root, extraSource), refuses);
    await schemaAddStatus("custom-active", { role: ["active"] }, { pmRoot: root });
    await assert.rejects(applyJoins(root, p, { author: "test" }), e => e instanceof JoinRefusal && e.code === "csv_join_settings_changed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI JSON and TOON remain compact, save exclusively and preserve typed IO remedies without git", async () => {
  const root = fixture();
  const harness = await createExtensionTestHarness(extension, { name: "pm-csv", capabilities: ["commands", "importers", "schema"] });
  try {
    const file = join(root, "joins.json"), output = join(root, "reviewed.json");
    writeFileSync(file, JSON.stringify(input()));
    const command = (name: string, args: string[], options: Record<string, unknown> = {}) => harness.runCommand({ command: name, args, options, pmRoot: root });
    const preview = await command("csv join preview", [file], { output });
    assert.ok(preview);
    const applied = await command("csv join apply", [output]);
    assert.ok(applied);
    await command("csv join apply", [output]);
    await assert.rejects(command("csv join preview", [file], { output }), e => e instanceof JoinRefusal && e.code === "csv_join_io");
    await assert.rejects(command("csv join preview", [join(root, "missing.json")]), refuses);
    await command("csv join preview", [file]);
    const invalid = input(); invalid.tables[0].csv = "key,title\nx,Missing\n";
    writeFileSync(file, JSON.stringify(invalid));
    await command("csv join preview", [file], { output });
    truncateSync(file, 33 * 1024 * 1024);
    await assert.rejects(command("csv join preview", [file]), refuses);
    writeFileSync(file, Buffer.from([0xff]));
    await assert.rejects(command("csv join preview", [file]), refuses);
  } finally { await harness.deactivate(); rmSync(root, { recursive: true, force: true }); }
});

test("failure compensation removes unchanged owned creates, retains audit history and preserves foreign records", async () => {
  const root = fixture();
  try {
    const value = input();
    value.tables[2].csv = "key,title,task,completed\nc1,Check,t1,not-a-date\n";
    value.tables[2].fields.completedAt = "completed";
    const p = await plan(root, value);
    await assert.rejects(applyJoins(root, p, { author: "join-test" }), e => e instanceof JoinRefusal && e.code === "csv_join_apply_failed");
    for (const id of p.ids.slice(0, 2)) {
      assert.equal(await locateItem(root, id), null);
      const history = await readHistoryEntries(getHistoryPath(root, id), id);
      assert.equal(history.length, 2);
      assert.equal(history[1].op, "delete");
    }
    const independent = { version: 1 as const, tables: [input().tables[0]] };
    const p2 = await plan(root, independent);
    const result = await applyJoins(root, p2, { author: "join-test", onTransition: async e => {
      if (e.transition === "prepared") await create({ id: p2.ids[0], title: "Foreign at boundary" }, { pmRoot: root });
    } });
    assert.equal(result.skipped, 1);
    assert.equal(result.applied, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Reproducible random source, independent from native item-identity generation. */
function random(seed: number): () => number {
  let state = Math.imul(seed, 2654435761) >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}
/** Read every native field this join protocol touches; SDK, rather than test normalization, defines the values. */
async function nativeState(root: string, id: string): Promise<unknown> {
  const doc = await readUpdateDocument(root, id);
  const fields = ["title", "type", "status", "priority", "tags", "assignee", "sprint", "release", "estimated_minutes", "acceptance_criteria", "close_reason", "completed_at", "parent"] as const;
  return { body: doc.body, ...Object.fromEntries(fields.map(field => [field, doc.metadata[field]])), dependencies: doc.metadata.dependencies?.map(e => ({ id: e.id, kind: e.kind })) };
}

test("500 seeded model sequences compare SDK readback with native reference state across replay, variants and custom roles", { timeout: 900000 }, async t => {
  const template = fixture();
  const base = mkdtempSync(join(tmpdir(), "csv-join-model-"));
  const pool: { root: string; oracle: string; source: JoinInput; plan: JoinPlan; edited: boolean; ambient: string[]; cwd: string[] }[] = [];
  let operations = 0;
  const originalCwd = process.cwd();
  try {
    for (let seed = 1; seed <= 500; seed++) {
      const rng = random(seed), slot = (seed - 1) % 16;
      let model = pool[slot];
      if (!model) {
        const root = join(base, `target-${slot}`), oracle = join(base, `model-${slot}`);
        cpSync(template, root, { recursive: true });
        const role = ["active", "blocked", "terminal_done", "terminal_canceled"][Math.floor(rng() * 4)];
        const custom = (await schemaAddStatus(`custom-${seed}`, { role: [role] }, { pmRoot: root })).status.id;
        cpSync(root, oracle, { recursive: true });
        const ambient: string[] = [];
        for (let i = 0; i < 3; i++) ambient.push((await create({ title: `Ambient ${slot}-${i}`, unset: ["parent"],
          assignee: `ambient-owner-${i}`, sprint: `ambient-sprint-${i}`, release: `ambient-release-${i}` }, { pmRoot: root })).item.id);
        const cwd = [join(root, "cwd-a"), join(root, "cwd-b")];
        for (const dir of cwd) mkdirSync(dir);
        await focus(ambient[Math.floor(rng() * ambient.length)], {}, { pmRoot: root });
        const source = input();
        const expected: Parameters<typeof create>[0][] = [];
        const fields = ["title", "body", "type", "status", "priority", "tags", "assignee", "sprint", "release", "estimatedMinutes", "acceptanceCriteria", "closeReason"] as const;
        for (const [i, table] of source.tables.entries()) {
          const options = {
            title: `  Case ${seed} row ${i}  `, body: ` leading ${seed}\r\nline ${i} \t\n`, type: "Task", status: i === 2 ? "closed" : custom,
            priority: String(Math.floor(rng() * 5)), tags: `Tag-${seed},Shared`, assignee: ["", "none", " NONE ", "null", " NuLl ", `member-${seed}`][Math.floor(rng() * 6)], sprint: ["", "none", "null", `s-${seed}`][Math.floor(rng() * 4)], release: ["", "none", "null", `r-${seed}`][Math.floor(rng() * 4)],
            estimatedMinutes: String(Math.floor(rng() * 1000)), acceptanceCriteria: `  AC ${seed}  `, closeReason: `Imported ${seed}`,
          };
          expected.push(options);
          const head = ["key", ...fields, ...(i > 0 ? ["ref"] : [])];
          const cells = [i === 0 ? "p1" : i === 1 ? "t1" : "c1", ...fields.map(f => options[f]), ...(i > 0 ? [i === 1 ? " p1 " : " t1 "] : [])];
          if (i === 2) {
            head.push("completed"); cells.push("2026-10-20T12:00:00.000Z");
            expected[i] = { ...options, completedAt: cells.at(-1)! };
            table.fields.completedAt = "completed";
          }
          table.csv = serializeCSV([head, cells], { delimiter: ",", eol: rng() < .5 ? "\n" : "\r\n" });
          table.fields = { ...table.fields, ...Object.fromEntries(fields.map(f => [f, f])) };
          if (i > 0) table.references[0].column = "ref";
        }
        const p = await plan(root, source);
        await focus(ambient[Math.floor(rng() * ambient.length)], {}, { pmRoot: root });
        process.chdir(cwd[Math.floor(rng() * cwd.length)]);
        await applyJoins(root, p, { author: "model-test" });
        // Reference transition: create once at absent native identities. Canonical values come only from SDK readback.
        for (const [i, options] of expected.entries()) {
          const absent = ["assignee", "sprint", "release"].filter(field => options![field as "assignee" | "sprint" | "release"] === "");
          await create({ ...Object.fromEntries(Object.entries(options!).filter(([field]) => !absent.includes(field))), id: p.ids[i], author: "model-test",
            unset: [...(i === 1 ? [] : ["parent"]), ...absent],
            ...(i === 1 ? { parent: p.ids[0] } : {}), ...(i === 2 ? { dep: [`kind=blocked_by,id=${p.ids[1]}`] } : {}) }, { pmRoot: oracle });
        }
        model = { root, oracle, source, plan: p, edited: false, ambient, cwd };
        pool[slot] = model;
      }
      const { root, oracle, source, plan: p } = model;
      await focus(model.ambient[Math.floor(rng() * model.ambient.length)], {}, { pmRoot: root });
      process.chdir(model.cwd[Math.floor(rng() * model.cwd.length)]);
      assert.equal((await previewJoins(root, source)).receipt.ok, true);
      operations++;
      if (model.edited) await assert.rejects(applyJoins(root, p, { author: "model-test" }), refuses);
      else assert.equal((await applyJoins(root, p, { author: "model-test" })).applied, 0);
      operations++;
      for (let step = 0; step < 6; step++) {
        const op = Math.floor(rng() * 4);
        await focus(model.ambient[Math.floor(rng() * model.ambient.length)], {}, { pmRoot: root });
        process.chdir(model.cwd[Math.floor(rng() * model.cwd.length)]);
        if (op === 0) {
          if (model.edited) await assert.rejects(applyJoins(root, p, { author: "model-test" }), refuses);
          else assert.equal((await applyJoins(root, p, { author: "model-test" })).applied, 0);
        } else if (op === 1) {
          const variant = structuredClone(source);
          variant.tables[0].csv = variant.tables[0].csv.replace(/\r?\n/g, "\r\n");
          assert.equal((await previewJoins(root, variant)).receipt.ok, true);
        } else if (op === 2) {
          const old = structuredClone(p); old.input.tables[0].csv += "\n";
          await assert.rejects(applyJoins(root, old, { author: "model-test" }), refuses);
        } else {
          const priority = Math.floor(rng() * 5), body = `native ${seed}-${step}\r\n tail  \n`;
          await update(p.ids[2], { priority, body }, { pmRoot: root });
          await update(p.ids[2], { priority, body }, { pmRoot: oracle });
          model.edited = true;
        }
        operations++;
        for (const id of p.ids) assert.deepEqual(await nativeState(root, id), await nativeState(oracle, id), `seed=${seed} step=${step} op=${op}`);
      }
      if (seed % 100 === 0) t.diagnostic(`seeded join sequences=${seed}; operations=${operations}`);
    }
    assert.equal(operations, 4000);
  } finally { process.chdir(originalCwd); rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); }
});

test("each internal mutation boundary rechecks a competing writer and reports peer success truthfully", async () => {
  const root = fixture();
  try {
    for (const phase of ["inspected", "before_dependencies", "before_create"] as const) {
      for (const foreign of [false, true]) {
        const p = await plan(root);
        let injected = false, inspected = 0;
        const result = await applyJoins(root, p, { author: "join-test", onBoundary: async (seen, id) => {
          if (seen !== phase || id !== p.ids[0] || injected) return;
          if (phase === "inspected" && ++inspected < 2) return;
          injected = true;
          await create({ id, title: foreign ? "Foreign" : "Project", author: "peer", ...(foreign ? {} : { message: `csv-join:${p.digest}:0` }) }, { pmRoot: root });
        } });
        assert.equal(injected, true);
        if (foreign) assert.equal(result.skipped, 3);
        else { assert.equal(result.unchanged, 1); assert.equal(result.applied, 2); }
        assert.equal((await readHistoryEntries(getHistoryPath(root, p.ids[0]), p.ids[0])).length, 1);
      }
    }
    const p = await plan(root);
    let injected = false;
    await assert.rejects(applyJoins(root, p, { author: "join-test", onBoundary: async (phase, id) => {
      if (phase === "before_dependencies" && id === p.ids[1] && !injected) {
        injected = true;
        await deleteItem(p.ids[0], { force: true }, { pmRoot: root });
      }
    } }), refuses);
    assert.equal(injected, true);
    const missing = await plan(root);
    await assert.rejects(applyJoins(root, missing, { author: "join-test", onBoundary: async (phase, id) => {
      if (phase === "before_dependencies" && id === missing.ids[1]) {
        const located = await locateItem(root, missing.ids[0]); assert.ok(located);
        rmSync(located.itemPath); rmSync(getHistoryPath(root, missing.ids[0]));
      }
    } }), refuses);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("committed journals cannot hide removed targets or missing durable state", async () => {
  const root = fixture();
  try {
    const one = { version: 1 as const, tables: [input().tables[0]] };
    const p = await plan(root, one);
    await applyJoins(root, p, { author: "join-test" });
    await deleteItem(p.ids[0], { force: true }, { pmRoot: root });
    await assert.rejects(applyJoins(root, p, { author: "join-test" }), refuses);
    const p2 = await plan(root, one);
    await assert.rejects(applyJoins(root, p2, { author: "join-test", onTransition: async e => {
      if (e.transition === "committed") {
        const located = await locateItem(root, p2.ids[0]);
        assert.ok(located);
        rmSync(located.itemPath); rmSync(getHistoryPath(root, p2.ids[0]));
      }
    } }), refuses);
    await assert.rejects(applyJoins(root, p2, { author: "join-test" }), refuses);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("built join CLI emits real compact JSON/TOON and semantic refusals without a git executable", async () => {
  const root = fixture();
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), join(bin, "pm"));
    symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
    const installed = join(root, "extensions/pm-csv"); mkdirSync(installed, { recursive: true });
    cpSync("dist", join(installed, "dist"), { recursive: true }); cpSync("manifest.json", join(installed, "manifest.json"));
    writeFileSync(join(root, "joins.json"), JSON.stringify(input()));
    const pm = (args: string[]) => spawnSync(join(bin, "pm"), ["--pm-path", root, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: dirname(root) } });
    const preview = pm(["csv", "join", "preview", "joins.json", "--output", "reviewed.json", "--json"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).references, 2);
    assert.ok(preview.stdout.length < 400);
    const apply = pm(["csv", "join", "apply", "reviewed.json", "--author", "join-test", "--json"]);
    assert.equal(apply.status, 0, apply.stderr);
    assert.equal(JSON.parse(apply.stdout).applied, 3);
    const replay = pm(["csv", "join", "apply", "reviewed.json"]);
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.stdout, /unchanged: 3/);
    const refused = pm(["csv", "join", "apply", "joins.json", "--json"]);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr + refused.stdout, /csv_join_invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("foreign documents with no history are skipped and owned content corruption refuses replay", async () => {
  const root = fixture();
  try {
    const one = { version: 1 as const, tables: [input().tables[0]] };
    const p = await plan(root, one);
    await create({ id: p.ids[0], title: "Foreign" }, { pmRoot: root });
    rmSync(getHistoryPath(root, p.ids[0]));
    assert.equal((await applyJoins(root, p, { author: "join-test" })).skipped, 1);
    const p2 = await plan(root, one);
    await applyJoins(root, p2, { author: "join-test" });
    const located = await locateItem(root, p2.ids[0]); assert.ok(located);
    writeFileSync(located.itemPath, readFileSync(located.itemPath, "utf8").replace("Project", "Tampered"));
    await assert.rejects(applyJoins(root, p2, { author: "join-test" }), refuses);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

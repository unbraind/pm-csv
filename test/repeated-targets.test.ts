import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { create, update, listAllComplete, commitWorkspaceTransaction, schemaAddStatus, runWorkspaceTransactionGc, readHistoryEntries, getHistoryPath, serializeItemDocument } from "@unbrained/pm-cli/sdk";
import { importCSV, serializeCSV } from "../index.ts";
import type { CsvImportOptions } from "../index.ts";
import { AdmissionRefusal, admissionTargetRevision, admissionTargetSequence } from "../admission.ts";
import { inspectUpdate, readUpdateDocument, readUpdateSnapshot, captureUpdateCompensation, compensateUpdate } from "../atomic-update.ts";
import { describeTable, importNegotiatedTable } from "../table-schema.ts";

/** Real independent non-git fixtures; repeated source keys resolve through SDK provenance tags. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "csv-sequence-"));
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  const result = spawnSync(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "--defaults", "--path", root],
    { encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } });
  assert.equal(result.status, 0, result.stderr);
  return root;
}
/** Compare native fields through SDK readback; omit only clocks and package audit tags. */
async function state(root: string, id: string): Promise<unknown> {
  const { metadata, body } = await readUpdateDocument(root, id);
  const fields = ["title", "type", "status", "priority", "assignee", "parent", "blocked_by", "sprint", "release", "reviewer", "goal", "objective", "files", "docs", "tests", "close_reason"];
  return { body, ...Object.fromEntries(fields.map(field => [field, metadata[field]])),
    dependencies: metadata.dependencies?.map(edge => ({ id: edge.id, kind: edge.kind })) };
}
/** Bind the real coordinator without substituting native SDK behavior. */
function options(root: string): CsvImportOptions {
  return { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {}, keyField: "external",
    commitTransaction: input => commitWorkspaceTransaction({ ...input, pmRoot: root }) };
}
/** Use SDK creates with explicit scope in every reference and target tracker. */
async function seed(root: string): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 0; n < 2; n++) ids.push((await create({ id: `sequence-${n}`, title: "Existing", body: "Original", assignee: "Original",
    tags: n ? "csv-key:c" : "csv-key:a,csv-key:b", unset: ["parent", "sprint", "release", "blocked_by", "reviewer", "goal", "objective"],
    clearDeps: true, clearFiles: true, clearDocs: true, clearTests: true }, { pmRoot: root })).item.id);
  return ids;
}

test("ordered existing-target writes match SDK reference transitions across admitted, atomic, streaming and ordinary imports", { timeout: 180000 }, async () => {
  const base = fixture(), scratch = mkdtempSync(join(tmpdir(), "csv-sequence-model-")), priorPath = process.env.PATH;
  process.env.PATH = resolve("node_modules/.bin") + delimiter + priorPath;
  try {
    const ids = await seed(base);
    for (let sequence = 0; sequence < 16; sequence++) {
      const root = join(scratch, `target-${sequence}`), oracle = join(scratch, `reference-${sequence}`);
      cpSync(base, root, { recursive: true }); cpSync(base, oracle, { recursive: true });
      let random = sequence + 1;
      const rows = Array.from({ length: 3 + sequence % 4 }, (_, n) => {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const key = n === 0 ? "a" : n === 1 ? "c" : n === 2 ? "b" : ["a", "b", "c"][random % 3];
        return [` ${key.toUpperCase()} `, "Existing", ` Value ${sequence}-${n}\r\n tail \n`, String(random % 5), n % 2 ? "none" : " Person "];
      });
      const file = join(root, "input.csv"); writeFileSync(file, serializeCSV([["external", "title", "body", "priority", "assignee"], ...rows], { delimiter: ",", eol: sequence % 2 ? "\r\n" : "\n" }));
      const selected = options(root);
      if (sequence === 0) { selected.atomic = false; selected.admission = undefined; }
      if (sequence === 1) { selected.atomic = false; selected.admission = undefined; selected.stream = true; }
      if (sequence === 2) selected.admission = undefined;
      const preview = await importCSV(root, file, { ...selected, dryRun: true });
      assert.equal(preview.updated, rows.length);
      const result = await importCSV(root, file, selected);
      assert.equal(result.updated, rows.length); assert.equal(result.skipped, 0);
      for (const [key, title, body, priority, assignee] of rows) {
        const id = key === " C " ? ids[1] : ids[0];
        await update(id, { title, body, priority, assignee }, { pmRoot: oracle });
      }
      for (const id of ids) assert.deepEqual(await state(root, id), await state(oracle, id), `sequence=${sequence}`);
      if (selected.atomic) assert.equal((await importCSV(root, file, selected)).updated, 0);
      for (const id of ids) assert.deepEqual(await state(root, id), await state(oracle, id));
    }
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    rmSync(base, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true });
  }
});

test("same-target recovery compensates every own prefix and refuses peer writes at every row boundary", { timeout: 180000 }, async () => {
  const base = fixture(), scratch = mkdtempSync(join(tmpdir(), "csv-sequence-races-"));
  try {
    const [id] = await seed(base);
    for (const persisted of [false, true]) for (let boundary = 0; boundary < 3; boundary++) for (const peer of [false, true]) {
      const root = join(scratch, `${persisted}-${boundary}-${peer}`); cpSync(base, root, { recursive: true });
      const file = join(root, "input.csv"); writeFileSync(file, "external,title,body,assignee\na,Existing,First,none\nb,Existing,Second,Person\na,Existing,Third,none\n");
      let injected = false;
      const selected = options(root), original = await state(root, id);
      selected.commitTransaction = input => commitWorkspaceTransaction({ ...input, pmRoot: root,
        steps: input.steps.map((step, n) => ({ ...step, apply: async () => {
          if (!persisted && n === boundary) {
            injected = true;
            if (peer) await update(id, { body: "Peer wins" }, { pmRoot: root });
            else throw new Error("Before-write failure");
          }
          const result = await step.apply();
          if (persisted && n === boundary) {
            injected = true;
            if (peer) await update(id, { body: "Peer wins" }, { pmRoot: root });
            throw new Error("After-write failure");
          }
          return result;
        } })),
      });
      await assert.rejects(importCSV(root, file, selected)); assert.equal(injected, true);
      if (peer) assert.equal((await readUpdateDocument(root, id)).body, "Peer wins");
      else assert.deepEqual(await state(root, id), original);
      if (peer) await assert.rejects(importCSV(root, file, options(root)), error => error instanceof AdmissionRefusal && error.code === "csv_admission_target_changed");
      else {
        // Compensation keeps append-only history, then a retry revalidates the restored native target.
        const retried = await importCSV(root, file, options(root));
        assert.equal(retried.updated, 3); assert.equal((await readUpdateDocument(root, id)).body, "Third");
        assert.equal((await importCSV(root, file, options(root))).updated, 0);
      }
    }
  } finally { rmSync(base, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); }
});

test("repeated native lifecycle roles and stale replay use current SDK target progress", async () => {
  const root = fixture();
  try {
    const [id] = await seed(root), roles = ["active", "terminal_done", "terminal_canceled", "active"];
    const statuses: string[] = [];
    for (const [n, role] of roles.entries()) statuses.push((await schemaAddStatus(`sequence-role-${n}`, { role: [role] }, { pmRoot: root })).status.id);
    const file = join(root, "input.csv"); writeFileSync(file, serializeCSV([["external", "title", "status"], ...statuses.map(status => ["a", "Existing", status])], ","));
    assert.equal((await importCSV(root, file, options(root))).updated, 4);
    assert.equal((await importCSV(root, file, options(root))).updated, 0);
    assert.equal((await listAllComplete({}, { pmRoot: root })).items.find(item => item.id === id)!.status, statuses[3]);
    await update(id, { body: "Peer", assignee: "none" }, { pmRoot: root });
    await assert.rejects(importCSV(root, file, options(root)), error => error instanceof AdmissionRefusal && error.code === "csv_admission_target_changed");
    assert.equal((await readUpdateDocument(root, id)).body, "Peer");
    const shared = join(root, "shared.csv"); writeFileSync(shared, "external,title,body\na,Existing,First\nb,Existing,Second\n");
    let invited = false, peerWrites = 0;
    const result = await importCSV(root, shared, { ...options(root), onAdmissionBoundary: async phase => {
      if (phase === "targets_read" && !invited) { invited = true; peerWrites = (await importCSV(root, shared, options(root))).updated; }
    } });
    assert.equal(peerWrites, 2); assert.equal(result.updated, 0);
    assert.equal((await readUpdateDocument(root, id)).body, "Second");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SDK explicit-unset audit messages retain ownership across inspection and every sequence recovery phase", async () => {
  const root = fixture();
  try {
    const [id] = await seed(root), revision = await admissionTargetRevision(root, id);
    const markers = ["csv-txrow:sequence#0", "csv-txrow:sequence#1"];
    assert.equal((await admissionTargetSequence(root, id, revision, markers)).completed, -1);
    const prior = await captureUpdateCompensation(root, id, markers[0], "pm-csv");
    // The older pinned host accepts this released audit shape; packed current-host checks exercise its producer.
    const applied = spawnSync(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", root, "update", id,
      "--body", "First", "--status", "open", "--unset", "assignee", "--add-tags", markers[0], "--message", `${markers[0]}:apply | explicit_unset=assignee`, "--author", "pm-csv"], { encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    assert.match((await readHistoryEntries(getHistoryPath(root, id), id)).at(-1)!.message!, /explicit_unset=assignee/);
    assert.equal((await admissionTargetSequence(root, id, revision, markers)).completed, 0);
    await assert.rejects(inspectUpdate(root, id, markers[0], true), /incomplete terminal transition/);
    await compensateUpdate(root, id, markers[0], "pm-csv", prior);
    assert.equal((await readUpdateDocument(root, id)).body, "Original");
    await update(id, { body: "First", message: `${markers[0]}:apply` }, { pmRoot: root });
    await update(id, { status: "closed", closeReason: "Sequence fixture", message: `${markers[1]}:close` }, { pmRoot: root });
    assert.equal((await admissionTargetSequence(root, id, revision, markers)).completed, 1);
    await update(id, { body: "First", status: "open", message: `${markers[1]}:restore` }, { pmRoot: root });
    assert.equal((await admissionTargetSequence(root, id, revision, markers)).completed, 1);
    await update(id, { body: "Restored first", unset: ["assignee"], addTags: [markers[1]], message: `${markers[1]}:compensate` }, { pmRoot: root });
    assert.equal((await admissionTargetSequence(root, id, revision, markers)).completed, 0);
    assert.equal((await inspectUpdate(root, id, markers[1], false)).state, "pending");
    await update(id, { body: "Original", message: `${markers[0]}:compensate` }, { pmRoot: root });
    assert.equal((await admissionTargetSequence(root, id, revision, markers)).completed, -1);
    await update(id, { body: "Peer" }, { pmRoot: root });
    await assert.rejects(admissionTargetSequence(root, id, revision, markers), error => error instanceof AdmissionRefusal && error.code === "csv_admission_target_changed");
    const snapshot = await readUpdateSnapshot(root, id);
    writeFileSync(snapshot.located.itemPath, serializeItemDocument({ ...snapshot.document, body: "Unjournalled edit" }));
    await assert.rejects(admissionTargetRevision(root, id), error => error instanceof AdmissionRefusal && error.code === "csv_admission_target_changed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("negotiated table imports preserve repeated existing-key source order through the shared mutation core", async () => {
  const root = fixture(), priorPath = process.env.PATH;
  process.env.PATH = resolve("node_modules/.bin") + delimiter + priorPath;
  try {
    const id = (await create({ title: "Existing", body: "Original", tags: "csv-key:existing", unset: ["parent", "assignee", "sprint", "release", "blocked_by"], clearDeps: true }, { pmRoot: root })).item.id;
    const text = "title,body\r\nExisting,First\r\nExisting,Second\r\n", { schema } = await describeTable(root, text);
    assert.equal((await importNegotiatedTable(root, text, schema, { dryRun: true, keyField: "title" })).rows, 2);
    assert.equal((await importNegotiatedTable(root, text, schema, { keyField: "title" })).updated, 2);
    assert.equal((await readUpdateDocument(root, id)).body, "Second");
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted same-target compensation resumes without resurrecting an already restored predecessor", async () => {
  const root = fixture();
  try {
    const [id] = await seed(root), before = await state(root, id), selected = options(root);
    const file = join(root, "input.csv"); writeFileSync(file, "external,title,body,assignee\na,Existing,First,none\nb,Existing,Second,Person\na,Existing,Third,none\n");
    selected.commitTransaction = input => commitWorkspaceTransaction({ ...input, pmRoot: root,
      steps: input.steps.map((step, n) => ({ ...step,
        apply: n === 2 ? async () => { throw new Error("Forward interruption"); } : step.apply,
        compensate: n === 1 ? async () => { throw new Error("Cleanup interruption"); } : step.compensate,
      })),
    });
    await assert.rejects(importCSV(root, file, selected));
    const status = async () => (await runWorkspaceTransactionGc(root, { dryRun: true, retentionDays: Infinity })).entries[0].status;
    assert.equal(await status(), "compensating");
    const duringRecovery = await state(root, id);
    await assert.rejects(importCSV(root, file, { ...options(root), dryRun: true }), error => error instanceof AdmissionRefusal && error.code === "csv_admission_target_changed");
    assert.deepEqual(await state(root, id), duringRecovery);
    let restored = (await readUpdateDocument(root, id)).body === "Original";
    for (let attempt = 0; attempt < 4 && await status() === "compensating"; attempt++) {
      await assert.rejects(importCSV(root, file, options(root)), /compensation was recovered/);
      const current = await readUpdateDocument(root, id);
      if (restored) assert.equal(current.body, "Original");
      restored ||= current.body === "Original";
    }
    assert.equal(await status(), "compensated"); assert.deepEqual(await state(root, id), before);
    assert.equal((await importCSV(root, file, options(root))).updated, 3);
    assert.equal((await importCSV(root, file, options(root))).updated, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a single existing target shares the same verified own-compensation retry contract", async () => {
  const root = fixture();
  try {
    const [id] = await seed(root), before = await state(root, id), file = join(root, "input.csv");
    writeFileSync(file, "external,title,body,assignee\na,Existing,Updated,none\n");
    const selected = options(root);
    selected.commitTransaction = input => commitWorkspaceTransaction({ ...input, pmRoot: root,
      steps: input.steps.map(step => ({ ...step, apply: async () => { await step.apply(); throw new Error("After-write failure"); } })),
    });
    await assert.rejects(importCSV(root, file, selected)); assert.deepEqual(await state(root, id), before);
    assert.equal((await importCSV(root, file, options(root))).updated, 1);
    assert.equal((await importCSV(root, file, options(root))).updated, 0);
    assert.equal((await readUpdateDocument(root, id)).body, "Updated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

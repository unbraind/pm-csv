import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, openSync, closeSync, writeSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { commitWorkspaceTransaction, listAllComplete, schemaAddStatus, get, create, update, focus, previewItemMutations, deleteItem, runWorkspaceTransactionGc } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { importCSV, serializeCSV, StreamingCSVParser, validateParsedCSV, strictValidationIssues } from "../index.ts";
import { admitCSV, assertCSVAdmission, assertAdmissionNumbers, readAdmittedSource, findAdmissionFailure, admissionPreviewFailure, requireAdmissionCapability, ADMISSION_LIMITS, AdmissionRefusal } from "../admission.ts";
import type { AdmissionOptions, AdmissionReceipt } from "../admission.ts";
import { readUpdateDocument } from "../atomic-update.ts";

/** Genuine non-git tracker, independent from parent session focus. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "csv-admission-"));
  const init = spawnSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "--defaults", "--path", root],
    { encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } });
  assert.equal(init.status, 0, init.stderr);
  return root;
}
/** Snapshot tracker bytes, excluding source fixtures, to prove read-only refusals. */
function snapshot(root: string): string {
  return JSON.stringify(readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && !e.name.endsWith(".csv"))
    .map(e => [join(e.parentPath, e.name).slice(root.length), readFileSync(join(e.parentPath, e.name), "utf8")]).sort());
}
/** Require stable typed refusals without input values. */
function refused(code?: string): (error: unknown) => boolean {
  return error => { assert.ok(error instanceof AdmissionRefusal); assert.equal(error.exitCode, 2); if (code) assert.equal(error.code, code); assert.ok(error.remedy.length > 20); return true; };
}

test("full and initial admission distinguish exact counts, upper bounds and materialization limits without git", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    writeFileSync(file, '\uFEFFtitle,body,priority\r\nAlpha,"multi\r\nline",0\r\nBeta,"a""b",4\r\n');
    const before = snapshot(root), full = await admitCSV(root, file);
    assert.equal(full.ok, true); assert.equal(full.admitted, true);
    assert.deepEqual(full.rows, { value: 2, kind: "exact" });
    assert.deepEqual(full.mutationWork, { value: 2, kind: "upper_bound" });
    assert.equal(full.fieldWidths[1], 11);
    assert.equal(full.digest, createHash("sha256").update(readFileSync(file)).digest("hex"));
    assertCSVAdmission(full); assertAdmissionNumbers(full);
    assert.deepEqual(readAdmittedSource(file, full.digest!), readFileSync(file));
    assert.throws(() => readAdmittedSource(file, full.digest!, 1), refused("csv_admission_limit"));
    assert.throws(() => readAdmittedSource("unopened", "unopened", NaN), refused("csv_admission_options"));
    const initial = await admitCSV(root, file, { mode: "initial", initialRows: 1 });
    assert.deepEqual(initial.rows, { value: 1, kind: "lower_bound" });
    assert.equal(initial.digest, undefined); assert.equal(initial.mutationWork.value, full.sourceBytes);
    assert.throws(() => assertCSVAdmission(initial), refused("csv_admission_incomplete"));
    const limited = await admitCSV(root, file, { maxAtomicRows: 1 });
    assert.equal(limited.admitted, false); assert.equal(limited.ok, true);
    assert.throws(() => assertCSVAdmission(limited), refused("csv_admission_limit"));
    assert.equal((await admitCSV(root, file, { maxAtomicRows: 2 })).admitted, true);
    assert.equal((await admitCSV(root, file, { maxAtomicBytes: full.sourceBytes })).admitted, true);
    assert.equal((await admitCSV(root, file, { maxAtomicBytes: full.sourceBytes - 1 })).admitted, false);
    assert.equal(snapshot(root), before);
    writeFileSync(file, "title\nChanged\n");
    assert.throws(() => readAdmittedSource(file, full.digest!), refused("csv_admission_source_changed"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("late invalid rows prevent every atomic write and compact diagnostics retain total invalid counts", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    const before = snapshot(root);
    const cases = ["Bad,9", "Bad,Infinity", ",2", "Bad,2,extra"];
    for (const final of cases) {
      writeFileSync(file, `title,priority\nGood,1\n${final}\n`);
      const receipt = await admitCSV(root, file);
      assert.equal(receipt.ok, false); assert.equal(receipt.invalidRows, 1); assert.equal(receipt.rows.value, 2);
      assert.equal(receipt.issues[0].row, 3);
      assert.throws(() => assertCSVAdmission(receipt), refused("csv_admission_invalid"));
      await assert.rejects(importCSV(root, file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {},
        commitTransaction: opts => commitWorkspaceTransaction({ ...opts, pmRoot: root }) }), refused("csv_admission_invalid"));
      assert.equal(snapshot(root), before);
    }
    writeFileSync(file, `title,priority\n${"Bad,9\n".repeat(20)}`);
    const many = await admitCSV(root, file);
    assert.equal(many.invalidRows, 20); assert.equal(many.issues.length, 8);
    assert.ok(JSON.stringify(many).length < 2000);
    await assert.rejects(importCSV(root, file, { delimiter: ",", fieldMap: {}, dryRun: false, admission: {} }), /csv_admission_options/);
    await assert.rejects(importCSV(root, file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, stream: true, admission: {} }), /csv_admission_options/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one strict options schema rejects extreme SDK inputs before IO and permits released producer output", async () => {
  const bad: unknown[] = [ ...[null, [], new Map(), { unknown: 1 }, { status: 4 }, { status: " " }, { type: "x".repeat(129) }, { priority: NaN }, { priority: Infinity }, { priority: -1 }, { priority: 5 }, { priority: 1.5 }, { priority: "2" }].map(filter => ({ filter })), new Date(), new Map(), { [Symbol("unknown")]: true }, { fieldMap: new Map() }, { fieldMap: { [Symbol("unknown")]: "title" } }, { fieldMap: null }, null, [], false, { typo: 1 }, { mode: "sample" }, { skipHeaders: 1 }, { autoMap: "true" }, { delimiter: 3 },
    { delimiter: "multi" }, { delimiter: '"' }, { encoding: 4 }, { encoding: "bad" }, { fieldMap: [] }, { fieldMap: "bad" },
    { fieldMap: { title: 4 } }, { fieldMap: { title: "unknown" } }, { fieldMap: { " ": "title" } }, { fieldMap: { ["x".repeat(129)]: "title" } },
    { fieldMap: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`c${i}`, "title"])) }];
  for (const key of [...Object.keys(ADMISSION_LIMITS), "initialRows"]) for (const value of [0, -1, .5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, "2"]) bad.push({ [key]: value });
  for (const value of bad) await assert.rejects(admitCSV("unopened", "unopened", value as AdmissionOptions), refused("csv_admission_options"));
  const root = fixture(), file = join(root, "input.csv");
  try {
    for (const text of ["", " ", "body\ntext\n", "title,title\nA,B\n"]) {
      writeFileSync(file, text); await assert.rejects(admitCSV(root, file), refused("csv_admission_invalid"));
    }
    writeFileSync(file, "summary,rank\nA,1\n");
    await assert.rejects(admitCSV(root, file, { fieldMap: { missing: "title" } }), refused("csv_admission_invalid"));
    assert.equal((await admitCSV(root, file, { fieldMap: { summary: "title", rank: "priority" } })).admitted, true);
    assert.equal((await admitCSV(root, file, { autoMap: true })).ok, true);
    for (const eol of ["\n", "\r\n"] as const) for (const delimiter of [",", ";", "\t", "|"]) {
      const text = serializeCSV([["title", "body", "priority"], [" T ", ' quote "\r\n tail ', "4"]], { delimiter, eol });
      writeFileSync(file, text);
      assert.equal((await admitCSV(root, file, { delimiter })).admitted, true);
      assert.equal(strictValidationIssues(validateParsedCSV(["title", "body", "priority"], [[" T ", ' quote "\r\n tail ', "4"]], {})).length, 0);
    }
    writeFileSync(file, "A,Task,open,0,,,,,,,,\n");
    assert.equal((await admitCSV(root, file, { skipHeaders: true })).rows.value, 1);
    writeFileSync(file, "A,Task,open,9,,,,,,,,\n");
    assert.equal((await admitCSV(root, file, { skipHeaders: true })).issues[0].row, 1);
    await assert.rejects(admitCSV(root, join(root, "missing.csv")), refused("csv_admission_io"));
    await assert.rejects(admitCSV(root, root), refused("csv_admission_limit"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("field, record and empty-column allocations are bounded even with unterminated final records", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    for (const [text, options, code] of [
      ["title\n" + "x".repeat(65537), {}, "csv_admission_limit"],
      ['title\n"' + "x".repeat(65537), {}, "csv_admission_limit"],
      ['title\n"unterminated', {}, "csv_admission_invalid"],
      ["title\n" + ",".repeat(128), {}, "csv_admission_limit"],
      ["a,b\nabc,def", { maxRecordCodeUnits: 5, fieldMap: { a: "title", b: "body" } }, "csv_admission_limit"],
      ["title\ntext", { maxSourceBytes: 5 }, "csv_admission_limit"],
    ] as const) {
      writeFileSync(file, text); await assert.rejects(admitCSV(root, file, options), refused(code));
    }
    writeFileSync(file, "title\nabc\n");
    assert.equal((await admitCSV(root, file, { maxFieldCodeUnits: 5, maxRecordCodeUnits: 5 })).admitted, true);
    writeFileSync(file, Buffer.from([0x74,0x69,0x74,0x6c,0x65,0x0a,0xff]));
    await assert.rejects(admitCSV(root, file), refused("csv_admission_invalid"));
    for (const encoding of ["utf16le", "latin1", "utf8"] as const) {
      writeFileSync(file, "title\nCafé\n", encoding);
      assert.equal((await admitCSV(root, file, { encoding })).admitted, true);
    }
    writeFileSync(file, "x".repeat(ADMISSION_LIMITS.maxAtomicBytes + 1));
    assert.throws(() => readAdmittedSource(file, "unmatched"), refused("csv_admission_limit"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every parser chunk boundary agrees with released serializer and complete parser semantics", () => {
  const table = [["title", "body"], ["A", 'x"y\r\nz'], ["B", ""], ["C", "tail\r"]];
  const text = serializeCSV(table, { delimiter: ",", eol: "\r\n" });
  for (let cut = 0; cut <= text.length; cut++) {
    const rows: string[][] = [], parser = new StreamingCSVParser(",", row => rows.push(row), ADMISSION_LIMITS);
    parser.push(text.slice(0, cut)); parser.push(text.slice(cut)); parser.end();
    assert.deepEqual(rows, table, `cut=${cut}`);
  }
});

test("every emitted count rejects nonfinite and out-of-domain corruption", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    writeFileSync(file, "title\nA\n"); const valid = await admitCSV(root, file);
    const bad: AdmissionReceipt[] = [ { ...valid, sourceBytes: ADMISSION_LIMITS.maxSourceBytes + 1 },
      { ...valid, rows: { kind: "exact", value: valid.sourceBytes + 1 } }, { ...valid, invalidRows: 2 },
      { ...valid, fieldWidths: Array(129).fill(1) }, { ...valid, fieldWidths: [65537] },
      { ...valid, issues: Array(9).fill({ row: 1, code: "row_invalid" }) },
      { ...valid, issues: [{ row: 0, code: "row_invalid" }] }, { ...valid, issues: [{ row: valid.sourceBytes + 1, code: "row_invalid" }] },
      { ...valid, limits: { ...valid.limits, maxAtomicRows: 0 } }, { ...valid, limits: { ...valid.limits, maxAtomicRows: 1001 } },
      { ...valid, mutationWork: { kind: "upper_bound", value: Number.MAX_SAFE_INTEGER } } ];
    for (const value of [Infinity, NaN, -1, .5, Number.MAX_SAFE_INTEGER + 1]) bad.push({ ...valid, mutationWork: { kind: "upper_bound", value } });
    for (const receipt of bad) assert.throws(() => assertAdmissionNumbers(receipt), refused("csv_admission_limit"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("custom configured statuses use SDK normalization during admission and atomic writes", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    const custom = (await schemaAddStatus("working-custom", { role: ["active"] }, { pmRoot: root })).status.id;
    writeFileSync(file, `title,type,status,priority\nNative status,Task,${custom},2\n`);
    assert.equal((await admitCSV(root, file)).admitted, true);
    const result = await importCSV(root, file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {},
      commitTransaction: opts => commitWorkspaceTransaction({ ...opts, pmRoot: root }) });
    assert.equal(result.imported, 1);
    const list = await listAllComplete({ includeBody: true }, { pmRoot: root });
    const item = list.items.find(item => item.title === "Native status");
    assert.equal(item?.status, custom);
    assert.equal((await get(item!.id, {}, { pmRoot: root })).item.parent, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compact host CLI receipts and malformed guard flags share the SDK boundary", async () => {
  const root = fixture(), file = join(root, "input.csv"), harness = await createExtensionTestHarness(extension, { name: "pm-csv", capabilities: ["commands", "importers", "schema"] });
  try {
    writeFileSync(file, "title\nA\n");
    const full = await harness.runCommand({ command: "csv admit", args: [file], pmRoot: root });
    assert.equal(full.handled, true); assert.equal((full.result as AdmissionReceipt).rows.value, 1);
    for (const options of [{ "initial-rows": "1" }, { initialRows: "1", maxAtomicRows: "1" }, { "max-atomic-rows": "1" }]) {
      const result = await harness.runCommand({ command: "csv admit", args: [file], options, pmRoot: root }); assert.equal(result.handled, true);
    }
    for (const options of [{ "initial-rows": "" }, { maxAtomicRows: "-1" }, { maxAtomicRows: "NaN" }, { map: "bad" }]) {
      await assert.rejects(harness.runCommand({ command: "csv admit", args: [file], options, pmRoot: root }), refused("csv_admission_options"));
    }
  } finally { await harness.deactivate(); rmSync(root, { recursive: true, force: true }); }
});

test("million-row source larger than heap stays below a fixed 128 MiB V8 heap cap", { timeout: 240000 }, t => {
  const root = fixture(), file = join(root, "million.csv"), fd = openSync(file, "w");
  try {
    writeSync(fd, "title,priority\n");
    const block = `${"x".repeat(160)},2\n`.repeat(1000);
    for (let i = 0; i < 1000; i++) writeSync(fd, block);
    closeSync(fd);
    const result = spawnSync(process.execPath, ["--max-old-space-size=96", "--max-semi-space-size=4", "test/support/admission-million.ts", root, file],
      { encoding: "utf8", timeout: 170000, maxBuffer: 8192, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } });
    assert.equal(result.status, 0, result.stderr);
    const measured = JSON.parse(result.stdout) as { rows: number; sourceBytes: number; heapUsed: number; heapLimit: number };
    assert.equal(measured.rows, 1000000); assert.ok(measured.sourceBytes > 128 * 1024 * 1024);
    assert.ok(measured.heapUsed < 128 * 1024 * 1024); t.diagnostic(JSON.stringify(measured));
    assert.ok(measured.heapLimit <= 128 * 1024 * 1024);
    const before = snapshot(root);
    appendFileSync(file, "Invalid final,9\n");
    const invalid = spawnSync(process.execPath, ["--max-old-space-size=96", "--max-semi-space-size=4", "test/support/admission-million.ts", root, file, "invalid-final"],
      { encoding: "utf8", timeout: 170000, maxBuffer: 8192, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } });
    assert.equal(invalid.status, 0, invalid.stderr);
    assert.equal((JSON.parse(invalid.stdout) as { invalidFinalRefused: boolean }).invalidFinalRefused, true);
    assert.equal(snapshot(root), before, "invalid row 1000001 must leave every tracker byte unchanged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source and settings interleavings at every admission boundary refuse before atomic commitment", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    for (const phase of ["opened", "read", "validated"] as const) {
      writeFileSync(file, "title\nOriginal\n"); let injected = false;
      await assert.rejects(admitCSV(root, file, {}, { onBoundary: at => {
        if (at === phase && !injected) { injected = true; writeFileSync(file, "title\nReplacement\n"); }
      } }), refused("csv_admission_source_changed"));
      assert.equal(injected, true);
      writeFileSync(file, "title\nOriginal\n"); injected = false;
      await assert.rejects(admitCSV(root, file, {}, { onBoundary: async at => {
        if (at === phase && !injected) { injected = true; await schemaAddStatus(`interleave-${phase}`, { role: ["active"] }, { pmRoot: root }); }
      } }), refused("csv_admission_settings_changed"));
      assert.equal(injected, true);
    }
    writeFileSync(file, "title\nOriginal\n");
    await assert.rejects(admitCSV(root, file, { maxSourceBytes: 20 }, { onBoundary: phase => {
      if (phase === "opened") writeFileSync(file, "title\n" + "x".repeat(100));
    } }), refused("csv_admission_limit"));
    assert.throws(() => readAdmittedSource(root, "unused"), refused("csv_admission_io"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("admitted atomic replay binds step identities to native history and refuses ABA edits", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    const existing = (await create({ title: "Existing", body: "Before", tags: "csv-key:existing", unset: ["parent", "assignee", "sprint", "release", "blocked_by"], clearDeps: true }, { pmRoot: root })).item.id;
    writeFileSync(file, "title,body,priority\nExisting,After,2\n");
    const options = { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, keyField: "title", admission: {},
      commitTransaction: (opts: Omit<Parameters<typeof commitWorkspaceTransaction>[0], "pmRoot">) => commitWorkspaceTransaction({ ...opts, pmRoot: root }) };
    assert.equal((await importCSV(root, file, options)).updated, 1);
    assert.equal((await get(existing, {}, { pmRoot: root })).item.priority, 2);
    assert.equal((await importCSV(root, file, options)).updated, 0);
    assert.equal((await importCSV(root, file, { ...options, dryRun: true })).previews.length, 1);
    await update(existing, { priority: 3, unset: ["parent", "assignee", "sprint", "release", "blocked_by"], clearDeps: true }, { pmRoot: root });
    await update(existing, { priority: 2, unset: ["parent", "assignee", "sprint", "release", "blocked_by"], clearDeps: true }, { pmRoot: root });
    const before = snapshot(root);
    await assert.rejects(importCSV(root, file, options), refused("csv_admission_target_changed"));
    await assert.rejects(importCSV(root, file, { ...options, dryRun: true }), refused("csv_admission_target_changed"));
    assert.equal(snapshot(root), before);
    assert.throws(() => readAdmittedSource(join(root, "missing.csv"), "unused"), refused("csv_admission_io"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ordinary writers interleaved at each native transaction step boundary retain their winning state", async () => {
  for (const boundary of ["inspect", "prepareCompensation", "apply"] as const) {
    const root = fixture(), file = join(root, "input.csv");
    try {
      const id = (await create({ title: "Existing", body: "Initial", tags: "csv-key:existing", unset: ["parent", "assignee", "sprint", "release", "blocked_by"], clearDeps: true }, { pmRoot: root })).item.id;
      writeFileSync(file, "title,body\nExisting,Import\n"); let injected = false;
      await assert.rejects(importCSV(root, file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, keyField: "title", admission: {},
        commitTransaction: opts => commitWorkspaceTransaction({ ...opts, pmRoot: root, steps: opts.steps.map(step => ({ ...step,
          [boundary]: async () => {
            if (!injected) {
              injected = true;
              await update(id, { body: "Peer wins", unset: ["parent", "assignee", "sprint", "release", "blocked_by"], clearDeps: true }, { pmRoot: root });
            }
            return step[boundary]?.();
          },
        })) }),
      }), refused("csv_admission_target_changed"));
      assert.equal(injected, true);
      assert.equal((await readUpdateDocument(root, id)).body, "Peer wins");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("nested typed failures preserve remedies and cycle safely through native aggregate causes", () => {
  const refusal = new AdmissionRefusal("csv_admission_target_changed", "Review the retained SDK history before retrying this import.");
  const cycle = new Error("cycle"); cycle.cause = cycle;
  assert.equal(findAdmissionFailure(cycle), undefined);
  assert.equal(findAdmissionFailure(0), undefined);
  assert.equal(findAdmissionFailure(new AggregateError([new Error("ordinary"), 1], "ordinary aggregate")), undefined);
  assert.equal(findAdmissionFailure(new AggregateError([cycle, new Error("wrapped", { cause: refusal })], "native aggregate")), refusal);
});

test("admitted SDK writes honor every custom status role and need no git or executable PATH", async () => {
  const root = fixture(), file = join(root, "input.csv"), savedPath = process.env.PATH;
  try {
    const statuses: string[] = [];
    for (const [n, role] of ["active", "blocked", "terminal_done", "terminal_canceled"].entries()) statuses.push((await schemaAddStatus(`role-${n}-opaque`, { role: [role] }, { pmRoot: root })).status.id);
    writeFileSync(file, serializeCSV([["title", "status", "priority"], ...statuses.map((status, n) => [`Role ${n}`, status, String(n)])], ","));
    process.env.PATH = join(root, "no-executables");
    const options = { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {},
      commitTransaction: (opts: Omit<Parameters<typeof commitWorkspaceTransaction>[0], "pmRoot">) => commitWorkspaceTransaction({ ...opts, pmRoot: root }) };
    assert.equal((await importCSV(root, file, options)).imported, 4);
    assert.equal((await importCSV(root, file, options)).imported, 0);
    const items = (await listAllComplete({}, { pmRoot: root })).items;
    for (const [n, status] of statuses.entries()) {
      const item = items.find(item => item.title === `Role ${n}`)!;
      assert.equal(item.status, status);
      assert.equal(item.parent, undefined);
      const oracle = await create({ title: `Oracle ${n}`, status, priority: n,
        ...(n >= 2 ? { closeReason: `Imported (source status: ${status})` } : {}),
        unset: ["parent", "assignee", "sprint", "release", "blocked_by", "reviewer", "goal", "objective"], clearDeps: true, clearFiles: true, clearDocs: true, clearTests: true }, { pmRoot: root });
      assert.equal((await readUpdateDocument(root, item.id)).metadata.close_reason, (await readUpdateDocument(root, oracle.item.id)).metadata.close_reason);
    }
  } finally { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; rmSync(root, { recursive: true, force: true }); }
});

test("admitted keyed creates, filtered dry runs and native compensation retain safe revisions", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    writeFileSync(file, "title,priority\nKeyed,2\n");
    const options = { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, keyField: "title", source: "fixture", admission: {},
      commitTransaction: (opts: Omit<Parameters<typeof commitWorkspaceTransaction>[0], "pmRoot">) => commitWorkspaceTransaction({ ...opts, pmRoot: root }) };
    assert.equal((await importCSV(root, file, { ...options, dryRun: true, filter: { priority: 4 } })).filtered, 1);
    assert.equal((await importCSV(root, file, { ...options, dryRun: true })).previews.length, 1);
    assert.equal((await importCSV(root, file, options)).imported, 1);
    assert.equal((await importCSV(root, file, options)).imported, 0);
    writeFileSync(file, "title,status\nFirst,closed\nSecond,open\n");
    await assert.rejects(importCSV(root, file, { ...options, keyField: undefined, source: undefined,
      commitTransaction: opts => commitWorkspaceTransaction({ ...opts, pmRoot: root, steps: opts.steps.map((step, n) => n === 0 ? step : {
        ...step, apply: async () => { throw new Error("Injected second-row failure"); },
      }) }),
    }), /Atomic CSV import failed/);
    const first = (await listAllComplete({}, { pmRoot: root })).items.find(item => item.title === "First")!;
    assert.equal(first.status, "closed");
    assert.ok(!first.tags?.some(tag => tag.startsWith("csv-tx")));
    await assert.rejects(importCSV(root, file, { ...options, keyField: undefined, source: undefined }), refused("csv_admission_target_changed"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("full native validation rejects an invalid final deadline before any atomic application", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    writeFileSync(file, "title,deadline\nValid,2027-01-01\nInvalid,not-a-date\n");
    await listAllComplete({}, { pmRoot: root }); const before = snapshot(root);
    await assert.rejects(importCSV(root, file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {},
      commitTransaction: opts => commitWorkspaceTransaction({ ...opts, pmRoot: root }) }), refused("csv_admission_invalid"));
    assert.equal(snapshot(root), before);
    assert.throws(() => requireAdmissionCapability(undefined), refused("csv_admission_sdk"));
    assert.equal(requireAdmissionCapability(previewItemMutations), previewItemMutations);
    for (const error of [undefined, null, 7, {}, new Error("native invalid"), { code: "other" }]) {
      const failure = admissionPreviewFailure(error);
      assert.equal(failure.code, "csv_admission_invalid"); assert.equal(failure.cause, error);
    }
    const storage = { code: "transaction_preview_non_regular_file" };
    const failure = admissionPreviewFailure(storage);
    assert.equal(failure.code, "csv_admission_sdk"); assert.match(failure.remedy, /2026\.10\.28/);
    assert.equal(failure.cause, storage);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("deleted admitted targets retain tombstones and cannot be recreated by a frozen journal", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    writeFileSync(file, "title\nRetained\n");
    const options = { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {},
      commitTransaction: (opts: Omit<Parameters<typeof commitWorkspaceTransaction>[0], "pmRoot">) => commitWorkspaceTransaction({ ...opts, pmRoot: root }) };
    assert.equal((await importCSV(root, file, options)).imported, 1);
    const id = (await listAllComplete({}, { pmRoot: root })).items[0].id;
    await deleteItem(id, {}, { pmRoot: root });
    await assert.rejects(importCSV(root, file, options), refused("csv_admission_target_changed"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("overlapping agents adopt the peer's durable admitted identities and report only their own writes", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    writeFileSync(file, "title,priority\nShared,2\nFiltered,4\n");
    const options = { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {}, filter: { priority: 2 },
      commitTransaction: (opts: Omit<Parameters<typeof commitWorkspaceTransaction>[0], "pmRoot">) => commitWorkspaceTransaction({ ...opts, pmRoot: root }) };
    let injected = false;
    const peerResults: number[] = [];
    const result = await importCSV(root, file, { ...options, onAdmissionBoundary: async phase => {
      if (phase === "targets_read" && !injected) { injected = true; peerResults.push((await importCSV(root, file, options)).imported); }
    } });
    assert.equal(result.imported, 0); assert.equal(result.filtered, 1);
    assert.deepEqual(peerResults, [1]);
    assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
    const peers = await Promise.all(Array.from({ length: 3 }, () => importCSV(root, file, options)));
    assert.equal(peers.reduce((sum, receipt) => sum + receipt.imported + receipt.updated, 0), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a foreign keyed creation and a peer edit during compensation never get overwritten", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    writeFileSync(file, "title\nCollision\n"); let injected = false;
    await assert.rejects(importCSV(root, file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, keyField: "title", admission: {},
      onAdmissionBoundary: async phase => {
        if (phase === "before_write" && !injected) {
          injected = true; await create({ title: "Peer", tags: "csv-key:collision", unset: ["parent", "assignee", "sprint", "release", "blocked_by"], clearDeps: true }, { pmRoot: root });
        }
      }, commitTransaction: opts => commitWorkspaceTransaction({ ...opts, pmRoot: root }),
    }), refused("csv_admission_target_changed"));
    assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 1);
    writeFileSync(file, "title\nOwned\nFail\n"); let edited: string | undefined;
    await assert.rejects(importCSV(root, file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {},
      onAdmissionBoundary: async (phase, id) => {
        if (phase === "before_compensate") {
          edited = id; await update(id!, { body: "Peer preserved", unset: ["parent", "assignee", "sprint", "release", "blocked_by"], clearDeps: true }, { pmRoot: root });
        }
      }, commitTransaction: opts => commitWorkspaceTransaction({ ...opts, pmRoot: root, steps: opts.steps.map((step, n) => n === 0 ? step : { ...step, apply: async () => { throw new Error("Injected forward failure"); } }) }),
    }), refused("csv_admission_target_changed"));
    assert.ok(edited); assert.equal((await readUpdateDocument(root, edited)).body, "Peer preserved");
    assert.equal((await readUpdateDocument(root, edited)).metadata.status, "open");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("admitted keyed patches preserve unselected native scope and all relationships under ambient focus", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    const parent = (await create({ title: "Parent", unset: ["parent", "assignee", "sprint", "release", "blocked_by"], clearDeps: true }, { pmRoot: root })).item.id;
    const ambient = (await create({ title: "Ambient", unset: ["parent", "assignee", "sprint", "release", "blocked_by"], clearDeps: true }, { pmRoot: root })).item.id;
    const id = (await create({ title: "Existing", tags: "csv-key:existing", parent, assignee: "Original", sprint: "Scope", release: "Scope", unset: ["blocked_by"],
      dep: [`kind=related,id=${parent}`] }, { pmRoot: root })).item.id;
    const before = await readUpdateDocument(root, id);
    await focus(ambient, {}, { pmRoot: root });
    writeFileSync(file, "title,body\nExisting,Changed\n");
    const result = await importCSV(root, file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {}, keyField: "title",
      commitTransaction: opts => commitWorkspaceTransaction({ ...opts, pmRoot: root }) });
    assert.equal(result.updated, 1);
    const after = await readUpdateDocument(root, id);
    for (const field of ["parent", "assignee", "sprint", "release", "dependencies"]) assert.deepEqual(after.metadata[field], before.metadata[field]);
    assert.equal(after.body, "Changed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("settings transitions during admitted planning and immediately before writes refuse without native changes", async () => {
  for (const boundary of ["targets_read", "before_write"] as const) {
    const root = fixture(), file = join(root, "input.csv");
    try {
      writeFileSync(file, "title\nUnapplied\n"); let injected = false;
      await assert.rejects(importCSV(root, file, { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {},
        onAdmissionBoundary: async phase => {
          if (phase === boundary && !injected) { injected = true; await schemaAddStatus(`transition-${boundary}`, { role: ["active"] }, { pmRoot: root }); }
        }, commitTransaction: opts => commitWorkspaceTransaction({ ...opts, pmRoot: root }),
      }), refused("csv_admission_settings_changed"));
      assert.equal((await listAllComplete({}, { pmRoot: root })).items.length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("initial observation is bounded on blank prefixes and never authorizes a small file at EOF", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    writeFileSync(file, "title\nSmall\n");
    const small = await admitCSV(root, file, { mode: "initial", initialRows: 100 });
    assert.equal(small.complete, true); assert.equal(small.rows.kind, "exact"); assert.equal(small.admitted, false);
    assert.throws(() => assertCSVAdmission(small), refused("csv_admission_incomplete"));
    writeFileSync(file, "\n\n\n\ntitle\nLater\n");
    const blanks = await admitCSV(root, file, { mode: "initial", initialRows: 1 });
    assert.equal(blanks.complete, false); assert.equal(blanks.rows.value, 0); assert.equal(blanks.ok, false);
    assert.equal(blanks.fieldWidths.length, 0); assert.equal(blanks.admitted, false);
    writeFileSync(file, "A,Task,open,0,,,,,,,,\n");
    const positional = await admitCSV(root, file, { skipHeaders: true, maxFieldCodeUnits: 4, mode: "initial", initialRows: 1 });
    assert.equal(positional.rows.value, 1); assert.equal(positional.fieldWidths[0], 1); assert.equal(positional.complete, false);
    writeFileSync(file, "\nA,Task,open,0,,,,,,,,\n");
    assert.equal((await admitCSV(root, file, { skipHeaders: true, mode: "initial", initialRows: 1 })).rows.value, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("admitted CLI/importer mapping and configured status filters share native SDK behavior", async () => {
  const root = fixture(), file = join(root, "input.csv"), harness = await createExtensionTestHarness(extension, { name: "pm-csv", capabilities: ["commands", "importers", "schema"] });
  try {
    const status = (await schemaAddStatus("opaque-filter", { role: ["active"] }, { pmRoot: root })).status.id;
    writeFileSync(file, `summary;status;priority\nConfigured;${status};4\n`, "utf16le");
    const options = { atomic: true, admission: true, strict: true, "auto-map": true, delimiter: "semicolon", encoding: "utf16le", status: ` ${status.toUpperCase()} ` };
    const result = await harness.runCommand({ command: "csv import", args: [file], pmRoot: root, options });
    assert.equal(result.handled, true, result.errorMessage ?? "command not handled");
    assert.equal((result.result as { imported: number }).imported, 1);
    const replay = await harness.runCommand({ command: "csv-import import", args: [file], pmRoot: root, options });
    assert.equal(replay.handled, true, replay.errorMessage ?? "importer not handled");
    assert.equal((replay.result as { imported: number }).imported, 0);
    const input = { delimiter: ";", fieldMap: {}, dryRun: false, atomic: true, autoMap: true, encoding: "utf16le" as const, admission: {}, filter: { status: "missing-status" } };
    await assert.rejects(importCSV(root, file, input), refused("csv_admission_options"));
    for (const filter of [{ status: "" }, { type: " " }, { priority: "" }, { priority: "9" }]) {
      await assert.rejects(harness.runCommand({ command: "csv import", args: [file], pmRoot: root, options: { ...options, ...filter } }), refused("csv_admission_options"));
    }
    writeFileSync(file, "Positional,Task,open,2,,,,,,,,\n");
    const positional = await importCSV(root, file, { delimiter: ",", fieldMap: {}, dryRun: true, atomic: true, admission: {}, skipHeaders: true,
      filter: { status: "open", type: " TASK ", priority: 2 } });
    assert.equal(positional.imported, 1);
  } finally { await harness.deactivate(); rmSync(root, { recursive: true, force: true }); }
});

test("foreign creation bindings in retained journals refuse without touching native targets", async () => {
  const root = fixture(), file = join(root, "input.csv");
  try {
    writeFileSync(file, "title\nOwned source\n");
    const options = { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {},
      commitTransaction: (opts: Omit<Parameters<typeof commitWorkspaceTransaction>[0], "pmRoot">) => commitWorkspaceTransaction({ ...opts, pmRoot: root }) };
    await importCSV(root, file, options);
    const entry = (await runWorkspaceTransactionGc(root, { dryRun: true, retentionDays: Infinity })).entries.find(entry => basename(entry.file).startsWith("csv-import-"))!;
    const journalFile = join(root, entry.file), journal = JSON.parse(readFileSync(journalFile, "utf8")) as { stepIds: string[] };
    journal.stepIds = journal.stepIds.map(step => step.replace(/create-.+-row-0/, "create-foreign-row-0"));
    writeFileSync(journalFile, JSON.stringify(journal));
    const before = snapshot(root);
    await assert.rejects(importCSV(root, file, options), refused("csv_admission_target_changed"));
    assert.equal(snapshot(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

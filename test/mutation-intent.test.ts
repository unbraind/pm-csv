import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { create, focus, update, commitWorkspaceTransaction, listAllComplete, mutateItem, readSettings } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { importCSV, importLineage, serializeCSV, CommandError } from "../index.ts";
import { describeTable, importNegotiatedTable, TableSchemaRefusal } from "../table-schema.ts";
import { previewJoins, applyJoins, JoinRefusal } from "../join-plans.ts";
import { readUpdateDocument } from "../atomic-update.ts";
import { buildMutationIntent, mutationScopeArguments, mutationMessageBase, matchesMutationScope, explicitDocumentMutation } from "../mutation-intent.ts";
import type { JoinPlan } from "../join-plans.ts";
import { createHash } from "node:crypto";

/** Initialize a tracker with explicit PM identity and no enclosing Git repository. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "csv-scope-"));
  const result = spawnSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "--defaults", "--path", root], {
    encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
  });
  assert.equal(result.status, 0, result.stderr);
  return root;
}
/** A selected table explicitly declares an optional empty parent cell. */
function input() {
  return { version: 1, tables: [{ name: "tasks", key: "key", csv: "key,title,parent,assignee,sprint,release\na,Selected,,,,\n",
    fields: { title: "title", assignee: "assignee", sprint: "sprint", release: "release" },
    references: [{ column: "parent", table: "tasks", kind: "parent" }] }] };
}
/** Require the complete empty relationship/scope projection from authoritative SDK state. */
async function emptyScope(root: string, id: string): Promise<void> {
  const { metadata } = await readUpdateDocument(root, id);
  for (const field of ["parent", "assignee", "sprint", "release", "blocked_by", "reviewer", "goal", "objective"] as const) assert.equal(metadata[field], undefined, field);
  for (const field of ["dependencies", "files", "docs", "tests"] as const) assert.equal(metadata[field]?.length ?? 0, 0, field);
}
/** Refusals preserve the documented family and useful underlying diagnostic category. */
function joinRefused(error: unknown): boolean {
  assert.ok(error instanceof JoinRefusal);
  assert.equal(error.exitCode, 2);
  assert.ok(error.remedy.length > 20);
  return true;
}

test("builder declares absent scope, honors reviewed values, clears selected empty patches and preserves unselected patches", async () => {
  const root = fixture();
  try {
    const ambient = await create({ title: "Ambient owner", unset: ["parent"] }, { pmRoot: root });
    await focus(ambient.item.id, {}, { pmRoot: root });
    const absent = buildMutationIntent({ title: "Empty scope", parent: " ", dep: [] });
    assert.ok(absent.unset?.includes("parent"));
    assert.equal(absent.clearDeps, true);
    const created = await create(absent, { pmRoot: root });
    await emptyScope(root, created.item.id);
    const explicit = buildMutationIntent({ title: "Reviewed scope", parent: ambient.item.id, assignee: "Owner", sprint: "Sprint", release: "Release",
      reviewer: "Reviewer", goal: "Goal", objective: "Objective", unset: ["parent"], dep: [`kind=blocked_by,id=${ambient.item.id}`],
      doc: ["path=guide.md"], file: ["path=source.ts"], test: ["command=node --version"] });
    const linked = await create(explicit, { pmRoot: root });
    const stored = await readUpdateDocument(root, linked.item.id);
    assert.equal(stored.metadata.parent, ambient.item.id);
    assert.equal(stored.metadata.dependencies?.length, 1);
    assert.equal(stored.metadata.docs?.length, 1);
    assert.equal(matchesMutationScope(stored, { parent: ambient.item.id }, undefined, "patch"), true);
    assert.equal(matchesMutationScope(stored, { parent: ambient.item.id, doc: [] }, undefined, "patch"), false);
    assert.equal(matchesMutationScope(stored, { parent: ambient.item.id, file: [] }, undefined, "patch"), false);
    assert.equal(matchesMutationScope(stored, { parent: ambient.item.id, test: [] }, undefined, "patch"), false);
    const preserve = buildMutationIntent({ title: "Patch title" }, "patch");
    assert.deepEqual(preserve.unset, []);
    await update(linked.item.id, preserve, { pmRoot: root });
    assert.equal((await readUpdateDocument(root, linked.item.id)).metadata.parent, ambient.item.id);
    await update(linked.item.id, buildMutationIntent({ parent: "", assignee: undefined, sprint: "", release: "", blockedBy: undefined,
      reviewer: undefined, goal: undefined, objective: undefined, dep: [], file: [], doc: [], test: [] }, "patch"), { pmRoot: root });
    await emptyScope(root, linked.item.id);
    assert.ok(mutationScopeArguments(explicit, "create").includes("--parent"));
    assert.ok(mutationScopeArguments(explicit, "create").includes("--dep"));
    assert.deepEqual(mutationScopeArguments({}, "patch"), []);
    assert.equal(mutationMessageBase("owned | explicit_unset=parent"), "owned");
    assert.equal(mutationMessageBase(undefined), undefined);
    for (const value of ["none", " NONE "]) {
      const cleared = await create(buildMutationIntent({ title: `Clear alias ${value}`, parent: value, sprint: value, release: value }), { pmRoot: root });
      await emptyScope(root, cleared.item.id);
    }
    // A stored snapshot is state, not command input: literal sentinels and empty representation survive the builder.
    await mutateItem({ pmRoot: root, settings: await readSettings(root), id: created.item.id, op: "update", author: "scope-test",
      mutate: explicitDocumentMutation(document => { document.metadata.sprint = "none"; document.metadata.assignee = "";
        return { changedFields: ["sprint", "assignee"] }; }) });
    assert.equal((await readUpdateDocument(root, created.item.id)).metadata.sprint, "none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("focus changes do not alter reviewed empty parents; previously inherited scope refuses replay", async () => {
  const root = fixture(), originalCwd = process.cwd();
  try {
    const parents = [];
    for (let i = 0; i < 3; i++) parents.push((await create({ title: `Ambient ${i}`, unset: ["parent"] }, { pmRoot: root })).item.id);
    await focus(parents[0], {}, { pmRoot: root });
    const { plan } = await previewJoins(root, input()); assert.ok(plan);
    const elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere); process.chdir(elsewhere);
    await focus(parents[1], {}, { pmRoot: root });
    assert.equal((await applyJoins(root, plan, { author: "scope-test" })).applied, 1);
    await emptyScope(root, plan.ids[0]);
    await focus(parents[2], {}, { pmRoot: root });
    assert.equal((await applyJoins(root, plan, { author: "scope-test" })).unchanged, 1);
    const aliasInput = input(); aliasInput.tables[0].csv = aliasInput.tables[0].csv.replace("a,Selected,,,,", "a,Selected,,,none,NONE");
    const aliasPlan = (await previewJoins(root, aliasInput)).plan; assert.ok(aliasPlan);
    assert.equal((await applyJoins(root, aliasPlan, { author: "scope-test" })).applied, 1);
    await emptyScope(root, aliasPlan.ids[0]);
    assert.equal((await applyJoins(root, aliasPlan, { author: "scope-test" })).unchanged, 1);
    const { plan: old } = await previewJoins(root, input()); assert.ok(old);
    // Reproduce the previous package behavior with its exact ownership message and no explicit unset.
    await create({ id: old.ids[0], title: "Selected", message: `csv-join:${old.digest}:0` }, { pmRoot: root });
    assert.equal((await readUpdateDocument(root, old.ids[0])).metadata.parent, parents[2]);
    await assert.rejects(applyJoins(root, old, { author: "scope-test" }), error => { joinRefused(error); assert.ok(error instanceof JoinRefusal); return error.code === "csv_join_target_changed"; });
  } finally { process.chdir(originalCwd); rmSync(root, { recursive: true, force: true }); }
});

test("lineage and every legacy importer suppress focus on create and preserve empty update cells", async () => {
  const root = fixture(), oldPath = process.env.PATH;
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), join(bin, "pm"));
    process.env.PATH = `${bin}${delimiter}${oldPath}`;
    const ambient = (await create({ title: "Ambient", unset: ["parent"] }, { pmRoot: root })).item.id;
    await focus(ambient, {}, { pmRoot: root });
    const lineage = await importLineage(root, [["title"], ["Lineage scope"]], { columns: ["title"] });
    assert.equal(lineage.receipt.imported, 1);
    await emptyScope(root, lineage.manifest.rows[0].item!);
    for (const mode of ["standard", "stream", "atomic", "schema"] as const) {
      const file = join(root, `${mode}.csv`), title = `Legacy ${mode}`;
      const table = [["title", "parent", "assignee", "sprint", "release", "blocked_by"], [title, "", "", "", "", ""]];
      writeFileSync(file, serializeCSV(table, ","));
      const options = { delimiter: ",", fieldMap: {}, dryRun: false, keyField: "title" as const, stream: mode === "stream", atomic: mode === "atomic",
        commitTransaction: (options: Omit<Parameters<typeof commitWorkspaceTransaction>[0], "pmRoot">) => commitWorkspaceTransaction({ ...options, pmRoot: root }) };
      const result = mode === "schema" ? await importNegotiatedTable(root, serializeCSV(table, ","), (await describeTable(root, serializeCSV(table, ","))).schema, { keyField: "title" }) : await importCSV(root, file, options);
      assert.equal(result.imported, 1, mode);
      const imported = (await listAllComplete({}, { pmRoot: root })).items.find(item => item.title === title); assert.ok(imported);
      await emptyScope(root, imported.id);
      await focus(imported.id, {}, { pmRoot: root });
      if (mode !== "atomic") await update(imported.id, { parent: ambient, assignee: "Other", sprint: "Other", release: "Other", blockedBy: ambient }, { pmRoot: root });
      const replay = mode === "schema" ? await importNegotiatedTable(root, serializeCSV(table, ","), (await describeTable(root, serializeCSV(table, ","))).schema, { keyField: "title" }) : await importCSV(root, file, options);
      assert.equal(replay.imported, 0, mode);
      if (mode === "atomic") await emptyScope(root, imported.id);
      else {
        const stored = (await readUpdateDocument(root, imported.id)).metadata;
        assert.equal(stored.parent, ambient);
        assert.equal(stored.assignee, "Other");
        assert.equal(stored.sprint, "Other");
        assert.equal(stored.release, "Other");
        assert.equal(stored.dependencies?.[0].id, ambient);
      }
      if (mode === "atomic") {
        const linkedFile = join(root, "atomic-linked.csv");
        writeFileSync(linkedFile, serializeCSV([["title", "blocked_by"], ["Legacy dependency", ambient]], ","));
        assert.equal((await importCSV(root, linkedFile, options)).imported, 1);
        assert.equal((await importCSV(root, linkedFile, options)).imported, 0);
        await update(imported.id, { parent: ambient }, { pmRoot: root });
        await assert.rejects(importCSV(root, file, options), error => error instanceof CommandError && /replay scope/.test(error.message));
      }
    }
  } finally { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); }
});

test("owned records with unreviewed link defaults refuse joins and lineage replay", async () => {
  const root = fixture();
  try {
    const dependency = (await create({ title: "Dependency", unset: ["parent"] }, { pmRoot: root })).item.id;
    for (const options of [{ doc: ["path=unexpected.md"] }, { file: ["path=unexpected.ts"] }, { test: ["command=node --version"] },
      { dep: [`kind=blocked_by,id=${dependency}`] }, { reviewer: "Unexpected" }, { goal: "Unexpected" }, { objective: "Unexpected" }]) {
      const { plan } = await previewJoins(root, input()); assert.ok(plan);
      await create({ ...options, id: plan.ids[0], title: "Selected", message: `csv-join:${plan.digest}:0`, unset: ["parent"] }, { pmRoot: root });
      await assert.rejects(applyJoins(root, plan, { author: "scope-test" }), joinRefused);
    }
    const table = [["title"], ["Lineage replay"]];
    const imported = await importLineage(root, table, { columns: ["title"] });
    const id = imported.manifest.rows[0].item!;
    await update(id, { parent: dependency }, { pmRoot: root });
    const replay = await importLineage(root, table, { columns: ["title"] });
    assert.equal(replay.receipt.replayed, 0);
    assert.equal(replay.manifest.rows[0].code, "identity_conflict");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Sign a source-bearing artifact to exercise lower-level parsing rather than checksum refusal. */
function signed(plan: JoinPlan, csv: string): JoinPlan {
  const next = structuredClone(plan); next.input.tables[0].csv = csv;
  next.sources[0] = createHash("sha256").update(csv).digest("hex");
  const { digest: _old, ...base } = next;
  return { ...base, digest: createHash("sha256").update(JSON.stringify(base)).digest("hex") };
}

test("all join boundaries wrap malformed CSV and encodings in JoinRefusal retaining lower code and remedy", async () => {
  const root = fixture();
  const harness = await createExtensionTestHarness(extension, { name: "pm-csv", capabilities: ["commands", "schema", "importers"] });
  try {
    const { plan } = await previewJoins(root, input()); assert.ok(plan);
    for (const csv of ['key,title\na,"unfinished', 'key,title\na,Name,extra\n', 'key,title\na,Name\rb,Other', 'key,title\na,Name\r\nb,Other\n']) {
      const invalid = input(); invalid.tables[0].csv = csv;
      for (const operation of [() => previewJoins(root, invalid), () => applyJoins(root, signed(plan, csv), { author: "scope-test" })]) {
        await assert.rejects(operation(), error => {
          assert.ok(error instanceof JoinRefusal); assert.equal(error.code, "csv_join_invalid");
          assert.equal(error.sourceCode, "csv_table_invalid"); assert.ok(error.cause instanceof TableSchemaRefusal);
          assert.equal(error.remedy, error.cause.remedy); assert.equal((error.context as Record<string, unknown>).sourceCode, error.cause.code);
          return true;
        });
      }
    }
    const file = join(root, "bad.json");
    for (const bytes of [Buffer.from([0xff]), Buffer.from('{"version":')]) {
      writeFileSync(file, bytes);
      await assert.rejects(harness.runCommand({ command: "csv join preview", pmRoot: root, args: [file] }), error => {
        assert.ok(error instanceof JoinRefusal); assert.equal(error.code, "csv_join_io"); assert.ok(error.sourceCode); assert.ok(error.cause instanceof Error); return true;
      });
    }
  } finally { await harness.deactivate(); rmSync(root, { recursive: true, force: true }); }
});

test("join SDK refusal boundaries also contain arbitrary lower-layer failures without changing family", async () => {
  const root = fixture();
  try {
    for (const failure of [null, "opaque failure", { code: 17, remedy: 17 }, new Error("lower failure")]) {
      const { plan } = await previewJoins(root, input()); assert.ok(plan);
      await assert.rejects(applyJoins(root, plan, { author: "scope-test", onTransition: () => { throw failure; } }), error => {
        assert.ok(error instanceof JoinRefusal); assert.equal(error.sourceCode, "unexpected_error");
        assert.equal(error.cause, failure); return true;
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

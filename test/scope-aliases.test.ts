import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { create, update, focus, readSettings, commitWorkspaceTransaction } from "@unbrained/pm-cli/sdk";
import type { ItemDocument } from "@unbrained/pm-cli/sdk";
import { decode } from "@toon-format/toon";
import { buildMutationIntent, matchesMutationScope, mutationScopeArguments } from "../mutation-intent.ts";
import { previewJoins, applyJoins } from "../join-plans.ts";
import { importLineage, importCSV, serializeCSV } from "../index.ts";
import { describeTable, importNegotiatedTable } from "../table-schema.ts";
import { readUpdateDocument } from "../atomic-update.ts";

const SCALARS = [["parent", "parent"], ["assignee", "assignee"], ["sprint", "sprint"], ["release", "release"],
  ["blockedBy", "blocked_by"], ["reviewer", "reviewer"], ["goal", "goal"], ["objective", "objective"]] as const;
const ALIASES = ["none", " NONE ", "null", "\tNuLl\r\n"];

/** Initialize a real non-git tracker and a pinned CLI launcher with no git executable. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "csv-aliases-")), root = join(base, "target"), oracle = join(base, "oracle"), bin = join(base, "bin");
  mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  const cli = join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"); symlinkSync(cli, join(bin, "pm"));
  for (const path of [root, oracle]) {
    const result = spawnSync(process.execPath, [cli, "init", "--defaults", "--path", path], {
      encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(base) },
    });
    assert.equal(result.status, 0, result.stderr);
  }
  return { base, root, oracle, bin };
}
/** Compare native values only: independent mutations naturally have different audit clocks. */
function scope(document: ItemDocument) {
  return { ...Object.fromEntries(SCALARS.map(([, field]) => [field, document.metadata[field]])),
    dependencies: document.metadata.dependencies?.map(({ id, kind }) => ({ id, kind })),
    files: document.metadata.files, docs: document.metadata.docs, tests: document.metadata.tests };
}

// The field matrix is independent of the implementation's SCALARS table: missing any
// option, clear token or command mode must disagree with the actual native SDK.
test("every scope scalar and linked collection follows native none/null semantics while snapshots and silent patches remain literal", { timeout: 180000 }, async () => {
  const f = fixture();
  try {
    const parent = (await create({ title: "Ambient", unset: ["parent"] }, { pmRoot: f.root })).item.id;
    await create({ id: parent, title: "Ambient", unset: ["parent"] }, { pmRoot: f.oracle });
    await focus(parent, {}, { pmRoot: f.root });
    for (const alias of ALIASES) {
      const concrete = { parent, assignee: "Owner", sprint: "Sprint", release: "Release", blockedBy: parent, reviewer: "Reviewer", goal: "Goal", objective: "Objective" };
      for (const [index, [option]] of SCALARS.entries()) {
        const options = { ...concrete, title: `Scope ${index}`, [option]: alias };
        const actual = await create(buildMutationIntent(options), { pmRoot: f.root });
        const expected = await create(options, { pmRoot: f.oracle });
        const document = await readUpdateDocument(f.root, actual.item.id);
        assert.deepEqual(scope(document), scope(await readUpdateDocument(f.oracle, expected.item.id)), `${option}=${JSON.stringify(alias)} create`);
        assert.equal(matchesMutationScope(document, options, await readSettings(f.root), document.metadata.dependencies), true, `${option} create comparison`);
        await update(actual.item.id, buildMutationIntent({ [option]: alias }, "patch"), { pmRoot: f.root });
        await update(expected.item.id, { [option]: alias }, { pmRoot: f.oracle });
        assert.deepEqual(scope(await readUpdateDocument(f.root, actual.item.id)), scope(await readUpdateDocument(f.oracle, expected.item.id)), `${option} patch`);
        assert.equal(buildMutationIntent({ [option]: alias }, "snapshot")[option], alias, `${option} snapshot`);
        assert.deepEqual(mutationScopeArguments({ [option]: alias }, "patch"), ["--unset", SCALARS[index][1]]);
      }
      for (const option of ["dep", "file", "doc", "test"] as const) {
        const options = { title: "Collection clear", [option]: [alias], unset: ["parent"] };
        const actual = await create(buildMutationIntent(options), { pmRoot: f.root });
        const expected = await create(options, { pmRoot: f.oracle });
        assert.deepEqual(scope(await readUpdateDocument(f.root, actual.item.id)), scope(await readUpdateDocument(f.oracle, expected.item.id)), option);
      }
    }
    for (const option of ["dep", "file", "doc", "test"] as const) {
      const options = { [option]: ["none", "path=concrete"] };
      assert.deepEqual(buildMutationIntent(options, "patch")[option], options[option], "mixed aliases remain native validation errors");
      await assert.rejects(create(buildMutationIntent({ ...options, title: "Invalid mixed collection" }), { pmRoot: f.root }), /Cannot mix legacy clear token/);
      assert.deepEqual(buildMutationIntent({ [option]: ["none"] }, "snapshot")[option], ["none"]);
    }
    assert.deepEqual(mutationScopeArguments({}, "patch"), []);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("clear aliases apply and replay through join, lineage and keyed CSV APIs with JSON/TOON CLI receipts in non-git trackers", { timeout: 180000 }, async () => {
  const f = fixture(), oldPath = process.env.PATH;
  try {
    process.env.PATH = f.bin;
    const parent = (await create({ title: "Ambient", unset: ["parent"] }, { pmRoot: f.root })).item.id;
    await focus(parent, {}, { pmRoot: f.root });
    const input = { version: 1, tables: [{ name: "tasks", key: "key", csv: serializeCSV([["key", "title", "assignee", "sprint", "release"],
      ...ALIASES.map((alias, i) => [`k${i}`, `Alias ${i}`, alias, alias, alias])], ","), fields: { title: "title", assignee: "assignee", sprint: "sprint", release: "release" }, references: [] }] };
    const planned = await previewJoins(f.root, input); assert.ok(planned.plan);
    assert.equal((await applyJoins(f.root, planned.plan, { author: "alias-test" })).applied, ALIASES.length);
    assert.equal((await applyJoins(f.root, planned.plan, { author: "alias-test" })).unchanged, ALIASES.length);
    for (const id of planned.plan.ids) {
      const document = await readUpdateDocument(f.root, id);
      assert.equal(document.metadata.assignee, undefined); assert.equal(document.metadata.parent, undefined);
    }
    const columns = ["title", "assignee", "sprint", "release"] as const;
    const table = [[...columns], ...ALIASES.map((alias, i) => [`Lineage ${i}`, alias, alias, alias])];
    const interrupted = await previewJoins(f.root, input); assert.ok(interrupted.plan);
    await create({ id: interrupted.plan.ids[0], title: "Alias 0", assignee: "none", sprint: "null", release: "NONE",
      unset: ["parent"], message: `csv-join:${interrupted.plan.digest}:0` }, { pmRoot: f.root });
    const recovered = await applyJoins(f.root, interrupted.plan, { author: "alias-test" });
    assert.equal(recovered.unchanged, 1, "a previously persisted native-cleared row is recovered as peer success");
    assert.equal(recovered.applied, ALIASES.length - 1);

    assert.equal((await importLineage(f.root, table, { columns })).receipt.imported, ALIASES.length);
    assert.equal((await importLineage(f.root, table, { columns })).receipt.replayed, ALIASES.length);
    const file = join(f.base, "legacy.csv"); writeFileSync(file, serializeCSV(table, ","));
    const options = { delimiter: ",", fieldMap: {}, dryRun: false, keyField: "title" };
    assert.equal((await importCSV(f.root, file, options)).imported, ALIASES.length);
    assert.equal((await importCSV(f.root, file, { ...options, stream: true })).updated, ALIASES.length);
    const atomic = { ...options, atomic: true,
      commitTransaction: (options: Omit<Parameters<typeof commitWorkspaceTransaction>[0], "pmRoot">) => commitWorkspaceTransaction({ ...options, pmRoot: f.root }) };
    assert.equal((await importCSV(f.root, file, atomic)).updated, ALIASES.length);
    const atomicFile = join(f.base, "atomic.csv");
    writeFileSync(atomicFile, serializeCSV([table[0], ...table.slice(1).map(row => [`Atomic ${row[0]}`, ...row.slice(1)])], ","));
    assert.equal((await importCSV(f.root, atomicFile, atomic)).imported, ALIASES.length);
    assert.equal((await importCSV(f.root, atomicFile, atomic)).imported, 0);
    const csv = serializeCSV(table, ","), schema = (await describeTable(f.root, csv)).schema;
    assert.equal((await importNegotiatedTable(f.root, csv, schema, { keyField: "title" })).updated, ALIASES.length);
    const source = join(f.base, "joins.json"), plan = join(f.base, "plan.json"); writeFileSync(source, JSON.stringify(input));
    const installed = join(f.root, "extensions/pm-csv"); mkdirSync(installed, { recursive: true });
    cpSync("dist", join(installed, "dist"), { recursive: true }); cpSync("manifest.json", join(installed, "manifest.json"));
    symlinkSync(join(process.cwd(), "node_modules"), join(f.root, "node_modules"), "dir");
    const cli = join(f.bin, "pm");
    const actualPlan = join(f.base, "cli-plan.json");
    const first = spawnSync(cli, ["--path", f.root, "csv", "join", "preview", source, "--output", actualPlan, "--json"], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr); assert.equal((JSON.parse(first.stdout) as { ok: boolean }).ok, true);
    const applied = spawnSync(cli, ["--path", f.root, "csv", "join", "apply", actualPlan, "--json"], { encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr); assert.equal((JSON.parse(applied.stdout) as { applied: number }).applied, ALIASES.length);
    const replayed = spawnSync(cli, ["--path", f.root, "csv", "join", "apply", actualPlan], { encoding: "utf8" });
    assert.equal(replayed.status, 0, replayed.stderr); assert.equal((decode(replayed.stdout) as { unchanged: number }).unchanged, ALIASES.length);
  } finally { process.env.PATH = oldPath; rmSync(f.base, { recursive: true, force: true }); }
});

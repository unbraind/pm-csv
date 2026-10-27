import "./support/isolated-environment.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { acquireLock, create, get, getHistoryPath, listAllComplete, locateItem, normalizeItemId, readSettings } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { applyJoins, previewJoins, JoinRefusal } from "../join-plans.ts";
import type { JoinInput } from "../join-plans.ts";
import { exportEditSession, applyEditSession, EditRefusal } from "../roundtrip.ts";
import { assertCanonicalMutationIds } from "../mutation-intent.ts";

/** Initialize a real non-git tracker, including the accepted prefix-without-dash fixture. */
function fixture(prefix = "review"): string {
  const root = mkdtempSync(join(tmpdir(), "csv-native-identities-"));
  const result = spawnSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "init", prefix, "--defaults", "--path", root], {
    encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
  });
  assert.equal(result.status, 0, result.stderr);
  const path = join(root, "settings.json"), settings = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...settings, id_prefix: prefix }));
  return root;
}

/** Three related rows make every position and both relationship kinds observable. */
function source(): JoinInput {
  return { version: 1, tables: [{ name: "tasks", key: "key", csv: "key,title,parent,blocker\na,First,,\nb,Second,a,\nc,Third,,b\n",
    fields: { title: "title" }, references: [{ column: "parent", table: "tasks", kind: "parent" }, { column: "blocker", table: "tasks", kind: "blocked_by" }] }] };
}

/** Sign adversarial artifacts exactly as version-one artifacts specify; no bypassed hash checks. */
function signed<T extends { digest: string }>(value: T): T {
  const { digest: _old, ...base } = value;
  return { ...value, digest: createHash("sha256").update(JSON.stringify(base)).digest("hex") };
}

/** Complete tracker byte inventory: preflight refusals must not create even journals or history. */
function trackerBytes(root: string): string {
  return JSON.stringify(readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => [join(entry.parentPath, entry.name).slice(root.length), readFileSync(join(entry.parentPath, entry.name)).toString("base64")]).sort());
}

/** Compare all SDK-visible live documents byte for byte; native compensation retains audit history. */
async function liveBytes(root: string): Promise<string> {
  const items = (await listAllComplete({}, { pmRoot: root })).items;
  const bytes: string[][] = [];
  for (const item of items) {
    const located = await locateItem(root, item.id);
    assert.ok(located);
    bytes.push([item.id, readFileSync(located.itemPath).toString("base64")]);
  }
  return JSON.stringify(bytes.sort());
}

/** Refuse in the public join family with a remedy before exposing a lower SDK failure. */
function invalid(error: unknown): boolean {
  assert.ok(error instanceof JoinRefusal);
  assert.equal(error.code, "csv_join_invalid");
  assert.ok(error.remedy.length > 30);
  return true;
}

test("500 native identity families reject normalized collisions and noncanonical artifact spellings", async () => {
  const root = fixture();
  try {
    const plan = (await previewJoins(root, source())).plan!;
    const before = trackerBytes(root);
    for (const ids of [new Array<string>(1), [undefined] as unknown as string[]]) {
      assert.throws(() => assertCanonicalMutationIds(ids, "review", () => new Error("Identity refusal")), /Identity refusal/);
    }
    for (let seed = 1; seed <= 500; seed++) {
      const prefix = ["review", "review-", "pm-", "other"][seed % 4], bare = `key${seed}`;
      const canonical = normalizeItemId(bare, prefix), second = normalizeItemId(`second${seed}`, prefix);
      assert.doesNotThrow(() => assertCanonicalMutationIds([canonical, second], prefix, () => new Error("Identity refusal")));
      for (const alias of [bare, bare.toUpperCase(), canonical.toUpperCase(), ` ${canonical} `]) {
        assert.equal(normalizeItemId(alias, prefix), canonical, "the SDK owns identity equivalence");
        assert.throws(() => assertCanonicalMutationIds([canonical, alias], prefix, () => new Error("Identity refusal")), /Identity refusal/);
      }
      const collision = signed({ ...plan, ids: [normalizeItemId(bare, "review"), bare, plan.ids[2]] });
      await assert.rejects(applyJoins(root, collision, { author: "identity-test" }), invalid);
    }
    assert.equal(trackerBytes(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every alias position refuses before writes and replay, while canonical plans and legacy SDK IDs remain usable", async () => {
  for (const prefix of ["review", "review-", "pm-"]) {
    const root = fixture(prefix);
    try {
      const old = await create({ id: "abcd", title: "Previously written native item", unset: ["parent"] }, { pmRoot: root });
      const plan = (await previewJoins(root, source())).plan!;
      const canonical = normalizeItemId("alias", (await readSettings(root)).id_prefix);
      for (const position of [0, 1, 2]) {
        const ids = [...plan.ids]; ids[position] = "alias"; ids[(position + 1) % ids.length] = canonical;
        const collision = signed({ ...plan, ids }), before = trackerBytes(root);
        for (let replay = 0; replay < 2; replay++) {
          let visited = false;
          await assert.rejects(applyJoins(root, collision, { author: "identity-test", onBoundary: () => { visited = true; }, onTransition: () => { visited = true; } }), invalid);
          assert.equal(visited, false, "all identities must validate before inspection or coordinator execution");
          assert.equal(trackerBytes(root), before, `prefix=${prefix}, position=${position}, replay=${replay}`);
        }
      }
      const noncanonical = signed({ ...plan, ids: ["unique-bare", ...plan.ids.slice(1)] });
      const before = trackerBytes(root);
      await assert.rejects(applyJoins(root, noncanonical, { author: "identity-test" }), invalid);
      assert.equal(trackerBytes(root), before);
      assert.equal((await applyJoins(root, plan, { author: "identity-test" })).applied, 3);
      assert.equal((await applyJoins(root, plan, { author: "identity-test" })).unchanged, 3);
      assert.equal((await get(plan.ids[1], {}, { pmRoot: root })).item.parent, plan.ids[0]);
      assert.equal((await get(old.item.id, {}, { pmRoot: root })).item.title, "Previously written native item");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("external keys retain provider spelling even when the SDK would normalize them to one native ID", async () => {
  const root = fixture();
  try {
    const input = source();
    input.tables[0].csv = "key,title,parent,blocker\nabcd,First,,\nreview-abcd,Second,abcd,\nABCD,Third,,review-abcd\n";
    const { receipt, plan } = await previewJoins(root, input);
    assert.equal(receipt.ok, true); assert.ok(plan);
    assert.equal((await applyJoins(root, plan, { author: "identity-test" })).applied, 3);
    assert.equal((await applyJoins(root, plan, { author: "identity-test" })).unchanged, 3);
    assert.equal((await get(plan.ids[1], {}, { pmRoot: root })).item.parent, plan.ids[0]);
    assert.equal((await get(plan.ids[2], {}, { pmRoot: root })).item.dependencies?.[0].id, plan.ids[1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("join CLI JSON/TOON and spreadsheet SDK/CLI refuse aliased identities before all writes", async () => {
  const root = fixture();
  try {
    const harness = await createExtensionTestHarness(extension, { name: "pm-csv", capabilities: ["commands", "importers", "schema"] });
    assert.deepEqual(harness.activation.failed, []);
    const plan = (await previewJoins(root, source())).plan!;
    const forged = signed({ ...plan, ids: ["abcd", "review-abcd", plan.ids[2]] });
    const path = join(root, "join-plan.json"); writeFileSync(path, JSON.stringify(forged));
    for (const options of [{ json: true }, {}]) {
      const before = trackerBytes(root);
      await assert.rejects(harness.runCommand({ command: "csv join apply", pmRoot: root, args: [path], options }), invalid);
      assert.equal(trackerBytes(root), before);
    }
    const one = await create({ id: "abcd", title: "First native", unset: ["parent"] }, { pmRoot: root });
    const two = await create({ id: "efgh", title: "Second native", unset: ["parent"] }, { pmRoot: root });
    const checkout = await exportEditSession(root, [one.item.id, two.item.id]);
    const before = trackerBytes(root);
    for (const ids of [[one.item.id, "abcd"], [one.item.id.toUpperCase()], ["abcd"]]) {
      await assert.rejects(exportEditSession(root, ids), error => error instanceof EditRefusal && error.code === "csv_session_invalid");
    }
    const session = structuredClone(checkout.session); session.rows[1].id = "abcd";
    const forgedSession = signed(session), forgedTable = structuredClone(checkout.table);
    for (const row of forgedTable.slice(1)) row[0] = forgedSession.digest;
    forgedTable[2][1] = "abcd";
    await assert.rejects(applyEditSession(root, forgedSession, forgedTable, { author: "identity-test" }),
      error => error instanceof EditRefusal && error.code === "csv_session_invalid");
    const release = await acquireLock(root, one.item.id, 30, "peer-test"), savedWait = process.env.PM_LOCK_WAIT_MS;
    try {
      process.env.PM_LOCK_WAIT_MS = "0";
      await assert.rejects(exportEditSession(root, [one.item.id, "abcd"]),
        error => error instanceof EditRefusal && error.code === "csv_session_invalid");
      await assert.rejects(applyEditSession(root, forgedSession, forgedTable, { author: "identity-test" }),
        error => error instanceof EditRefusal && error.code === "csv_session_invalid");
    } finally {
      if (savedWait === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = savedWait;
      await release();
    }
    await assert.rejects(harness.runCommand({ command: "csv checkout", pmRoot: root, args: [], options: { ids: `${one.item.id},abcd`, output: join(root, "refused-checkout.csv") } }),
      error => error instanceof EditRefusal && error.code === "csv_session_invalid");
    assert.equal(trackerBytes(root), before);
    assert.equal((await applyEditSession(root, checkout.session, checkout.table, { author: "identity-test" })).unchanged, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one whole-plan SDK transaction compensates every row failure and replay to byte-identical live state", async () => {
  const root = fixture();
  try {
    const foreign = await create({ title: "Foreign record", assignee: "Owner", sprint: "Sprint", unset: ["parent"] }, { pmRoot: root });
    const priorHistory = readFileSync(getHistoryPath(root, foreign.item.id), "utf8");
    for (const persisted of [false, true]) for (let position = 0; position < 3; position++) {
      const plan = (await previewJoins(root, source())).plan!;
      const before = await liveBytes(root), transactions = new Set<string>();
      for (let replay = 0; replay < 2; replay++) {
        await assert.rejects(applyJoins(root, plan, { author: "identity-test",
          onBoundary: (phase, id) => { if (!persisted && phase === "before_create" && id === plan.ids[position]) throw new Error("Injected row failure"); },
          onTransition: event => {
            transactions.add(event.transactionId);
            if (persisted && event.transition === "step_applied" && event.stepId === plan.ids[position]) throw new Error("Injected persisted-row failure");
          },
        }), error => error instanceof JoinRefusal);
        assert.equal(await liveBytes(root), before, `position=${position}, persisted=${persisted}, replay=${replay}`);
        assert.equal(readFileSync(getHistoryPath(root, foreign.item.id), "utf8"), priorHistory);
        for (const id of plan.ids) assert.equal(await locateItem(root, id), null);
      }
      assert.equal(transactions.size, 1, "all rows and compensation belong to exactly one SDK transaction");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

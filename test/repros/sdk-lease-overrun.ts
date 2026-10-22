import "../support/isolated-environment.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { create, mutateItem, readSettings } from "@unbrained/pm-cli/sdk";
import { readUpdateDocument } from "../../atomic-update.ts";

// Standalone safety assertion for the unresolved host contract. Run explicitly:
// node --test test/repros/sdk-lease-overrun.ts
// The pinned unfenced SDK fails this assertion; this is blocker evidence, not
// a passing regression or part of the package's release-gate test glob.
test("host SDK must refuse a stale write after lease takeover", async () => {
  const root = mkdtempSync(join(tmpdir(), "csv-sdk-lease-"));
  try {
    const initialized = spawnSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "--defaults", "--path", root], {
      encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    const { item } = await create({ title: "Baseline" }, { pmRoot: root });
    const settings = await readSettings(root);
    settings.locks.ttl_seconds = 1;
    settings.governance.force_required_for_stale_lock = false;
    const before = await readUpdateDocument(root, item.id);
    let takeoverCompleted = false;
    let staleError: unknown;
    try {
      await mutateItem({ pmRoot: root, settings, id: item.id, op: "update", author: "stale-writer",
        async mutate(document) {
          document.metadata.title = "Stale overwrite";
          // Exceed the real lease TTL; do not mock the SDK, clock or lock files.
          await setTimeout(1100);
          await mutateItem({ pmRoot: root, settings, id: item.id, op: "update", author: "newer-writer",
            mutate(newer) {
              newer.metadata.title = "Newer protected value";
              return { changedFields: ["title"] };
            },
          });
          assert.equal((await readUpdateDocument(root, item.id)).metadata.title, "Newer protected value");
          takeoverCompleted = true;
          return { changedFields: ["title"] };
        },
      });
    } catch (error) { staleError = error; }
    assert.equal(takeoverCompleted, true, "the second native SDK writer must really commit");
    assert.notEqual(before.metadata.title, "Newer protected value");
    const current = await readUpdateDocument(root, item.id);
    console.log(JSON.stringify({ takeoverCompleted, staleWriterRefused: staleError !== undefined, newerValuePreserved: current.metadata.title === "Newer protected value" }));
    assert.equal(current.metadata.title, "Newer protected value", "a stale SDK mutation must never overwrite the newer committed value");
    assert.ok(staleError instanceof Error, "the stale writer must receive an explicit refusal");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

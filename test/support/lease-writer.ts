import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { mutateItem, readSettings, writeSettingsSection, PmCliError } from "@unbrained/pm-cli/sdk";

const [root, id, mode] = process.argv.slice(2);
const settings = await readSettings(root);

/** Perform the actual SDK mutation; no lock, filesystem or persistence API is replaced. */
async function write(): Promise<void> {
  if (mode === "settings" || mode === "probe-settings") await writeSettingsSection(root, "csv_fence_fixture", { newer: true }, { author: "newer-writer" });
  else await mutateItem({ pmRoot: root, settings, id, op: "update", author: "newer-writer",
    mutate(document) { document.metadata.title = "Newer protected value"; return { changedFields: ["title"] }; },
  });
}

settings.locks.wait_ms = 5000;
process.env.PM_LOCK_WAIT_MS = "5000";
if (mode === "probe-item" || mode === "probe-settings") {
  // A completed fail-fast SDK attempt proves contention while the parent's fence is held.
  process.env.PM_LOCK_WAIT_MS = "0";
  let outcome = "entered";
  try { await write(); }
  catch (error) {
    assert.ok(error instanceof PmCliError && error.code === "lock_conflict");
    outcome = "blocked";
  }
  process.stdout.write(`${outcome}\n`);
  const [retry] = await once(process.stdin, "data");
  assert.equal(String(retry), "retry\n");
  process.env.PM_LOCK_WAIT_MS = "5000";
  await write();
  process.stdin.destroy();
} else {
  process.stdout.write("ready\n");
  if (mode === "delayed") await setTimeout(1100);
  await write();
}

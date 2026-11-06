import { setTimeout } from "node:timers/promises";
import { mutateItem, readSettings, writeSettingsSection } from "@unbrained/pm-cli/sdk";

const [root, id, mode] = process.argv.slice(2);
const settings = await readSettings(root);
settings.locks.wait_ms = 5000;
process.env.PM_LOCK_WAIT_MS = "5000";
process.stdout.write("ready\n");
if (mode === "delayed") await setTimeout(1100);
if (mode === "settings") await writeSettingsSection(root, "csv_fence_fixture", { newer: true }, { author: "newer-writer" });
else await mutateItem({ pmRoot: root, settings, id, op: "update", author: "newer-writer",
  mutate(document) { document.metadata.title = "Newer protected value"; return { changedFields: ["title"] }; },
});

import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { runWithActiveExtensions } from "@unbrained/pm-cli/sdk";

const workspace = new AsyncLocalStorage<string>();

/** Reuse this package's activation only for the same explicit workspace. */
export function withWorkspaceExtensions<T>(pmRoot: string, run: () => Promise<T>): Promise<T> {
  const root = resolve(pmRoot);
  if (workspace.getStore() === root) return run();
  return runWithActiveExtensions({ path: root }, () => workspace.run(root, run));
}

import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";

/** Real installed extensions attach test observers only in the owning process. */
const observers = new Map<string, (api: ExtensionApi) => void>();

/** Publish an activation callback shared with the installed fixture module. */
export function registerLeaseObserver(root: string, activate: (api: ExtensionApi) => void): () => void {
  observers.set(root, activate);
  return () => { observers.delete(root); };
}

/** Peer processes load the same extension without inheriting the owner's observer. */
export function activateLeaseObserver(root: string, api: ExtensionApi): void {
  observers.get(root)?.(api);
}

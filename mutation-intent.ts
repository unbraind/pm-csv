import { canonicalDocument } from "@unbrained/pm-cli/sdk";
import type { create, mutateItem, ItemDocument } from "@unbrained/pm-cli/sdk";

/** Native create/update options accepted by the shared explicit-scope builder. */
type MutationOptions = NonNullable<Parameters<typeof create>[0]>;
/** Scope scalars have native option spellings and SDK unset metadata names. */
const SCALARS = [
  ["parent", "parent"], ["assignee", "assignee"], ["sprint", "sprint"], ["release", "release"],
  ["blockedBy", "blocked_by"], ["reviewer", "reviewer"], ["goal", "goal"], ["objective", "objective"],
] as const;
/** Linked resources must not acquire template defaults when a create omits them. */
const LINKS = [["dep", "clearDeps", "--dep", "--clear-deps"], ["file", "clearFiles", "--file", "--clear-files"],
  ["doc", "clearDocs", "--doc", "--clear-docs"], ["test", "clearTests", "--test", "--clear-tests"]] as const;

/**
 * Freeze relationship/scope intent before native mutation. Creates explicitly unset
 * absent scalars and clear absent links. Patches preserve unselected fields; an
 * explicitly present empty/undefined scalar clears it. Neither mode reads focus,
 * templates, working directories or other ambient session state.
 */
export function buildMutationIntent(options: MutationOptions, mode: "create" | "patch" = "create"): MutationOptions {
  const result = { ...options };
  const unset = new Set(options.unset);
  for (const [option, field] of SCALARS) {
    if (mode === "patch" && !Object.hasOwn(options, option)) continue;
    if (options[option]?.trim()) unset.delete(field);
    else { delete result[option]; unset.add(field); }
  }
  for (const [option, clear] of LINKS) {
    if (mode === "patch" && !Object.hasOwn(options, option)) continue;
    if (options[option]?.length) result[clear] = false;
    else { delete result[option]; result[clear] = true; }
  }
  result.unset = [...unset];
  return result;
}

/** Render only scope/link flags from the same builder for legacy CLI mutations. */
export function mutationScopeArguments(options: MutationOptions, mode: "create" | "patch"): string[] {
  const intent = buildMutationIntent(options, mode), args: string[] = [];
  for (const [option, field] of SCALARS) if (intent[option] !== undefined) args.push(`--${field.replaceAll("_", "-")}`, intent[option]!);
  for (const field of intent.unset!) args.push("--unset", field);
  for (const [option, clear, flag, clearFlag] of LINKS) {
    for (const value of intent[option] ?? []) args.push(flag, value);
    if (intent[clear]) args.push(clearFlag);
  }
  return args;
}

/**
 * Scope raw SDK patches/restores from the document read under the native item
 * lock. Explicit selected scalars go through the same builder; untouched native
 * link arrays remain the exact current/restore document, with no ambient lookup.
 */
export function explicitDocumentMutation(mutate: Parameters<typeof mutateItem>[0]["mutate"]): Parameters<typeof mutateItem>[0]["mutate"] {
  return async document => {
    const result = await mutate(document);
    const intent = buildMutationIntent(Object.fromEntries(SCALARS.map(([option, field]) => [option, document.metadata[field]])), "patch");
    for (const [option, field] of SCALARS) {
      if (intent[option] === undefined) delete document.metadata[field];
      else document.metadata[field] = intent[option];
    }
    return result;
  };
}

/** Read the caller-authored ownership marker without the SDK explicit-unset audit suffix. */
export function mutationMessageBase(message: string | undefined): string | undefined {
  return message?.split(" | explicit_unset=", 1)[0];
}

/** Compare reviewed scope with current native state using SDK canonicalization, never session defaults. */
export function matchesMutationScope(document: ItemDocument, options: MutationOptions, edges?: readonly { id: string; kind: string }[], mode: "create" | "patch" = "create"): boolean {
  const intent = buildMutationIntent(options, mode);
  const expected = canonicalDocument({ metadata: { ...document.metadata,
    ...Object.fromEntries(SCALARS.map(([option, field]) => [field, mode === "patch" && !Object.hasOwn(options, option) ? document.metadata[field] : intent[option]])),
  }, body: document.body });
  if (SCALARS.some(([, field]) => document.metadata[field] !== expected.metadata[field])) return false;
  if ((intent.clearFiles && document.metadata.files?.length) || (intent.clearDocs && document.metadata.docs?.length) ||
      (intent.clearTests && document.metadata.tests?.length)) return false;
  const actualEdges = (document.metadata.dependencies ?? []).map(e => JSON.stringify([e.id, e.kind])).sort();
  const expectedEdges = edges === undefined && mode === "patch" && !intent.clearDeps ? actualEdges
    : (edges ?? []).map(e => JSON.stringify([e.id, e.kind])).sort();
  return JSON.stringify(actualEdges) === JSON.stringify(expectedEdges);
}

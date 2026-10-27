import * as nativeSdk from "@unbrained/pm-cli/sdk";
import { canonicalDocument, validateSprintOrReleaseValue } from "@unbrained/pm-cli/sdk";
import type { create, mutateItem, ItemDocument, readSettings } from "@unbrained/pm-cli/sdk";

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

/** Recognize native command clear aliases without interpreting persisted snapshot values. */
function isScopeClearAlias(value: string): boolean {
  return ["none", "null"].includes(value.trim().toLowerCase());
}

/**
 * Freeze relationship/scope intent before native mutation. Creates explicitly unset
 * absent scalars and clear absent links. Patches preserve unselected fields; an
 * explicitly present empty/undefined scalar clears it. Neither mode reads focus,
 * templates, working directories or other ambient session state. Native `none`/`null`
 * scope-clear aliases become explicit unsets; snapshot mode preserves already
 * stored strings literally instead of interpreting command-input aliases.
 */
export function buildMutationIntent(options: MutationOptions, mode: "create" | "patch" | "snapshot" = "create"): MutationOptions {
  const result = { ...options };
  const unset = new Set(options.unset);
  for (const [option, field] of SCALARS) {
    if (mode !== "create" && !Object.hasOwn(options, option)) continue;
    const value = options[option];
    const present = mode === "snapshot" ? value !== undefined : Boolean(value?.trim()) &&
      !isScopeClearAlias(value!);
    if (present) unset.delete(field);
    else { delete result[option]; unset.add(field); }
  }
  for (const [option, clear] of LINKS) {
    if (mode !== "create" && !Object.hasOwn(options, option)) continue;
    if (options[option]?.length && (mode === "snapshot" || !options[option]!.every(isScopeClearAlias))) result[clear] = false;
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
    const intent = buildMutationIntent(Object.fromEntries(SCALARS.map(([option, field]) => [option, document.metadata[field]])), "snapshot");
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

/**
 * Use the host's relationship normalizer, falling back to its local-ID normalizer
 * on older hosts whose dependency writes use local-ID normalization.
 */
export function normalizeMutationReference(reference: string, prefix: string, normalizers: {
  normalizeItemId: typeof nativeSdk.normalizeItemId;
  normalizeItemReference?: (reference: string, prefix: string) => string;
} = nativeSdk): string {
  return (normalizers.normalizeItemReference ?? normalizers.normalizeItemId)(reference, prefix);
}

/** Match parent storage on the selected host: legacy SDKs only trimmed parents. */
export function normalizeMutationParent(reference: string, prefix: string, normalizers: {
  normalizeParentReferenceValue: typeof nativeSdk.normalizeParentReferenceValue;
  normalizeItemReference?: (reference: string, prefix: string) => string;
} = nativeSdk): string {
  const parent = normalizers.normalizeParentReferenceValue(reference);
  return normalizers.normalizeItemReference?.(parent, prefix) ?? parent;
}

/**
 * Normalize command scope with the same public field normalizers used by native
 * create/update before comparing it with stored state. Document canonicalization
 * alone cannot resolve local ID prefixes or parent placeholder syntax. Provider
 * locators retain their native case; snapshots never pass through this function.
 */
export function normalizeMutationInput(options: MutationOptions, settings: Awaited<ReturnType<typeof readSettings>>, mode: "create" | "patch" = "create"): MutationOptions {
  const intent = buildMutationIntent(options, mode);
  if (intent.parent !== undefined) intent.parent = normalizeMutationParent(intent.parent, settings.id_prefix);
  for (const field of ["sprint", "release"] as const) {
    if (intent[field] !== undefined) intent[field] = validateSprintOrReleaseValue(field, intent[field], settings.validation.sprint_release_format).value;
  }
  return intent;
}

/** Compare reviewed scope with current native state using SDK canonicalization, never session defaults. */
export function matchesMutationScope(document: ItemDocument, options: MutationOptions, settings: Awaited<ReturnType<typeof readSettings>>, edges?: readonly { id: string; kind: string }[], mode: "create" | "patch" = "create"): boolean {
  const intent = normalizeMutationInput(options, settings, mode);
  const expected = canonicalDocument({ metadata: { ...document.metadata,
    ...Object.fromEntries(SCALARS.map(([option, field]) => [field, mode === "patch" && !Object.hasOwn(options, option) ? document.metadata[field] : intent[option]])),
  }, body: document.body }, { schema: settings.schema });
  if (SCALARS.some(([, field]) => document.metadata[field] !== expected.metadata[field])) return false;
  if ((intent.clearFiles && document.metadata.files?.length) || (intent.clearDocs && document.metadata.docs?.length) ||
      (intent.clearTests && document.metadata.tests?.length)) return false;
  const actualEdges = (document.metadata.dependencies ?? []).map(e => JSON.stringify([e.id, e.kind])).sort();
  const expectedEdges = edges === undefined && mode === "patch" && !intent.clearDeps ? actualEdges
    : (edges ?? []).map(e => JSON.stringify([normalizeMutationReference(e.id, settings.id_prefix), e.kind])).sort();
  return JSON.stringify(actualEdges) === JSON.stringify(expectedEdges);
}

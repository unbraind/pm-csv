import { PmCliError } from "@unbrained/pm-cli/sdk";

/** Compact diagnostics never echo potentially large/private cell contents. */
export interface EditConflict {
  id: string;
  fields: string[];
}
/** Stable refusal taxonomy shared by SDK callers and command errors. */
export type EditRefusalCode = "csv_session_invalid" | "csv_edit_invalid" | "csv_edit_conflict" | "csv_edit_apply_failed" | "csv_lease_expired" | "csv_edit_settings_changed";
/** Typed refusal with an actionable remedy and at most twenty conflict keys. */
export class EditRefusal extends PmCliError {
  /** Stable machine-readable refusal category. */
  readonly code: EditRefusalCode;
  /** Next action needed before retrying. */
  readonly remedy: string;
  /** First twenty item/field conflicts, without cell contents. */
  readonly conflicts: EditConflict[];
  /** Full conflict count before the diagnostic ceiling. */
  readonly conflictCount: number;
  constructor(code: EditRefusalCode, remedy: string, conflicts: EditConflict[] = []) {
    const bounded = conflicts.slice(0, 20);
    super(`${code}: ${remedy}${bounded.length ? `; conflicts=${JSON.stringify(bounded)}; total=${conflicts.length}` : ""}`, 2,
      { code, required: remedy, nextSteps: [remedy] });
    this.code = code;
    this.remedy = remedy;
    this.conflicts = bounded;
    this.conflictCount = conflicts.length;
  }
}

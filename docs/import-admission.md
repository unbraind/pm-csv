# Bounded import admission

Admission answers whether a source fits a declared import resource budget before
an agent builds a mutation plan. It reuses the package's streaming parser,
header mapping, aliases and strict row validator. The SDK supplies configured
type/status registries and status normalization. It introduces no dialect or
transaction journal. Commands work in a plain non-git tracker.

```sh
pm csv admit incoming.csv --initial-rows 1000 --json
pm csv admit incoming.csv --json
pm csv import incoming.csv --atomic --admission --json
# The configured importer uses the same guarded path:
pm csv-import import incoming.csv --atomic --admission --json
```

The first command is an initial observation and always has `admitted: false`.
A full scan reaches EOF, including the final row, before deciding admission.
`--admission` on import repeats that full scan immediately before bounded
materialization; it never trusts an earlier CLI receipt. It requires `--atomic`
and refuses `--stream`. `--strict` is redundant with admission and does not run
an additional in-memory validation pass. Existing imports remain compatible
unless admission is explicitly selected.

## Receipt and limits

Receipts contain counts, widths, source digest, limits and at most eight issue
coordinates. They contain no titles, cell values, source paths or row previews.
The host renders native TOON or JSON; the full invalid-row count is retained
when diagnostic coordinates are truncated. Issue rows are one-based logical
CSV records, including headers and blank records. Blank records are ignored by
the import, consistently with existing import behavior.

- `rows.kind: exact` means all nonempty data rows were scanned. An initial scan
  reports `lower_bound` when its record budget stops parsing, even if that record
  happened to be the last row. Reaching EOF before the budget permits exact
  counts, but `mode: initial` still never authorizes application.
- `mutationWork.kind: upper_bound` is always conservative: a full scan uses the
  data row count; an initial scan uses total source bytes, since each remaining
  nonempty record needs at least one byte. It estimates row operations, not SDK
  calls, journal bytes, runtime or an exact create/update split. Key matches,
  filters, policies and lifecycle effects are resolved by the import path.
- `fieldWidths` gives maximum decoded UTF-16 code units by column index,
  including normalized headers. Full widths are exact; initial widths are
  observed lower bounds. No source-sized key index is built.
- `ok` means the scanned rows passed the shared strict title/priority checks,
  SDK type/status checks and row-width checks. It does not promise that native
  mutation policies, hooks or relationship targets will accept a later write.
- `complete` means EOF was validated. `admitted` additionally requires no
  invalid rows and compliance with the atomic row/byte materialization budgets.
  A valid million-row file is fully counted but refuses one bounded atomic plan.

| Limit | Default and hard ceiling |
|---|---:|
| Decoded field | 65,536 code units |
| Decoded record, across all fields | 262,144 code units |
| Columns | 128 |
| Atomic materialization | 1,000 data rows and 8 MiB source bytes |
| Regular-file source | 1 TiB |
| Initial observation budget | 1,000 logical records by default; at most 1,000,000, plus one header allowance |

The scanner reads 16 KiB chunks and retains one bounded record plus counters and
column widths. Empty records consume the initial observation budget, so blank
prefixes cannot force a full scan. Allocations are checked before appending a field or column,
including malformed unterminated fields and delimiter-only input. It refuses
invalid encodings and unterminated quoted records. All numeric options must be
positive safe integers; limits can only be lowered. CLI names are kebab case,
for example `--max-field-code-units 4096 --max-atomic-rows 100`.

The resource test generates 1,000,000 rows totaling 163,000,015 bytes, then runs
admission with Node flags `--max-old-space-size=96 --max-semi-space-size=4`.
The measured V8 heap limit is 113,246,208 bytes, below the declared **128 MiB
heap cap** and smaller than the source. This cap applies to the admission
process, not tracker export, SDK target indexing or atomic application. Native
buffers and RSS are separate measurements; no total-process memory guarantee
is inferred from the heap measurement.

## Typed SDK example

```ts
import { admitCSV, assertCSVAdmission, importCSV, AdmissionRefusal } from "pm-csv";
import { commitWorkspaceTransaction } from "@unbrained/pm-cli/sdk";

const receipt = await admitCSV(pmRoot, "incoming.csv", {
  maxAtomicRows: 100,
  maxFieldCodeUnits: 4096,
  fieldMap: { summary: "title", rank: "priority" },
});
try {
  assertCSVAdmission(receipt);
  await importCSV(pmRoot, "incoming.csv", {
    delimiter: ",", fieldMap: { summary: "title", rank: "priority" },
    dryRun: false, atomic: true, admission: { maxAtomicRows: 100 },
    commitTransaction: options => commitWorkspaceTransaction({ ...options, pmRoot }),
  });
} catch (error) {
  if (error instanceof AdmissionRefusal) {
    console.error(error.code, error.remedy);
  } else throw error;
}
```

`AdmissionOptions`, `AdmissionReceipt` and `AdmissionRefusalCode` are exported
from the package entry point. SDK callers may lower all resource limits. Import
mapping, encoding and header choices come from `CsvImportOptions`; admission
uses those same choices. Initial mode cannot weaken the import guard, which
always performs a full scan.

## Refusals and concurrency

| Code | Remedy |
|---|---|
| `csv_admission_options` | Supply supported mappings/encoding and valid positive integer limits. |
| `csv_admission_io` | Supply a readable regular file; devices and pipes are unsupported. |
| `csv_admission_limit` | Repair oversized fields or explicitly split reviewed work into bounded imports. |
| `csv_admission_invalid` | Repair the reported logical record coordinates, then rescan. |
| `csv_admission_incomplete` | Finish a full scan before deciding atomic admission. |
| `csv_admission_source_changed` | Stabilize and review the new source bytes, then rescan. |
| `csv_admission_settings_changed` | Rescan against current native schemas and status registries. |
| `csv_admission_sdk` | Upgrade the host for native semantic preview and transaction-key derivation; read-only admission remains available. |
| `csv_admission_target_changed` | Reconcile current SDK state and its retained journal, then review a fresh import. |

A full scan hashes exact source bytes from one open descriptor and checks its
size, modification and change revisions again before returning. Import captures
at most 8 MiB into a bounded buffer and verifies the digest **before parsing**.
Path replacement or growth after admission therefore refuses before writes;
changes after that capture cannot replace the captured input. Settings are
pinned across admission and atomic application with the existing settings guard.

Admission adds no writer lease and is not a transaction plan. The existing SDK
transaction coordinator serializes other workspace transactions, not ordinary
SDK/CLI writers. Admission does not turn a source digest into target isolation:
current targets must still be re-read immediately before writes, and a window
remains between the final read and an ordinary writer's commit. Existing
transaction recovery/compensation rules and reconciliation receipts still
apply; do not interpret an admission receipt as a saved target revision or a
successful application. See [atomic compensation](atomic-compensation.md).

Before application, admitted bounded plans run the SDK's semantic transaction
preview against a disposable tracker, using the same native options as apply.
This catches invalid final native fields or references before any application.
Mutation hooks, migrations and later concurrent changes remain commit-time
constraints; a preview is not approval of those effects. Read-only admission
works on the package's normal host floor; admitted application additionally
requires `previewItemMutations` and `deriveMutationTransactionId` (available in
the pinned development SDK). Use **pm 2026.10.28 or newer** for trackers with
installed package dependency links: older semantic previews can mistake those
runtime links for authoritative tracker storage. Unsupported hosts receive
`csv_admission_sdk` with an upgrade/storage inspection remedy. Links or special
files in authoritative tracker storage remain refused; admission never follows
them or bypasses native preview.

Admitted transaction keys use the SDK's derivation function over the captured
source meaning, explicit import options and pinned settings. Admitted mutation
step identities include each target's original verified native
history revision, or an explicit absent revision for a create. Recovery reads
every target through the SDK before reusing a journal, and only recognizes the
package's latest immutable create/apply/close marker as its own success. A peer
edit, including an ABA edit, refuses an older admitted input rather than
reporting stale success. Pending updates re-read the full document and history
immediately before the native write. Keyed creates recheck certified SDK keys
before writing. Compensation of admitted creates also verifies current owned
history; peer edits are retained for reconciliation.

A previously completed admitted input is therefore an immutable reviewed
attempt, not a command to overwrite subsequent edits. To intentionally apply an
older input after native changes, review the current tracker and create a fresh
explicit import attempt (for example, a separately named reviewed source). A
changed mapping, filter, provenance label or settings revision binds a separate
attempt; unchanged mapping key order does not.

SDK callers may supply an intended `filter` in `AdmissionOptions`. Its shape and
status are validated through the same strict boundary and native registry as
admitted imports. Row counts, widths and mutation upper bounds conservatively
cover the entire source, including filtered rows. Mutation work counts forward
row operations; rollback writes and hook effects are separate commit-time work.
Unselected scope fields on updates retain their native values; creates explicitly
unset absent scope fields. Both paths share the existing CSV scope selection.
SDK diagnostic observers can use `onAdmissionBoundary` to inspect planning,
pre-write and compensation boundaries without weakening the subsequent guards.

Native creation IDs are deterministically derived through SDK identity functions
from the admitted source domain and row. If a peer binds that same journal while
planning, the caller adopts the SDK-recorded bindings and revalidates targets.
Receipts count writes performed by that invocation; a peer's successful commit
is reported as zero new writes. This does not extend the coordinator's lease to
ordinary SDK writers.

Repeated rows resolving to one existing native item execute in source order,
including distinct external-key aliases for that item. Preview, application and
replay use the same ordered target group. Each own row advances its verified
history checkpoint; the following row checks that checkpoint immediately before
writing. A completed later row proves the applied prefix, so replay reports zero
new updates. Reverse compensation restores each captured prior state and keeps
the full audit. Foreign edits still refuse, including between repeated rows;
SDK explicit-unset audit suffixes do not turn an own write into a foreign one.
Single-target updates use the same verified retry checkpoints. Dry-run refuses
a pending compensation journal instead of reporting restored rows as unchanged.
The existing first-row-wins rule for duplicate *new* keys is unchanged.

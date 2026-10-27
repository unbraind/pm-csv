# Edit a CSV checkout safely

Each export/apply attempt captures one native settings/schema snapshot. Changes
during apply refuse with `csv_edit_settings_changed`; earlier patches use the
existing SDK transaction compensation. Inputs are copied before asynchronous
reads, and each mutation batch revalidates the settings digest inside writer
coordination. Inspect pending cleanup before exporting a fresh session.

`csv export` and `csv import --key` remain format conversion and keyed upsert.
For a spreadsheet edit session, use the separate checkout/apply protocol:

```sh
pm csv checkout --output planning.csv --json
# Edit title, body, priority, assignee, sprint or release cells in a spreadsheet.
pm csv apply planning.csv --dry-run --json
pm csv apply planning.csv --json
# Identical retry: applied=0, with no additional item/history writes.
pm csv apply planning.csv
```

For a selection, pass `--ids item-a,item-b` to checkout. The default is a certified
complete tracker read. A checkout accepts up to 1000 distinct canonical item IDs;
split larger selections. Checkout and apply validate all IDs with the SDK prefix
before reading targets: bare, case or whitespace aliases and normalized duplicates
refuse as `csv_session_invalid`. Saved identities are never silently rewritten.
These examples use illustrative IDs; use IDs from your
tracker. Files are UTF-8 comma-separated CSV, with quoted multiline cells, and
can be saved with CRLF or a BOM. Newline-only LF/CRLF conversions in editable
cells count as unchanged and retain the exact baseline value, including when a
concurrent writer has changed that field. Genuine content edits retain their
normal conflict checks. Keep column names/order and digest cells intact.
Rows may be reordered or omitted. Omission never deletes an item. Blank optional
scalar cells unset that metadata; blank body clears it. Priority must be 0..4,
and title must be nonblank. Scalar edits must be trimmed. Body uses the host's
canonical document normalization, which removes leading blank body lines and trailing whitespace. Checkout prefixes editable values
that start with `=`, `+`, `-`, `@`, tab, carriage return or an apostrophe
with an apostrophe. Apply removes one recognized display prefix before comparison
and storage, preserving raw baseline values and digests. Keep these prefixes when
saving the CSV. For new formula-leading or apostrophe-leading values, use the
same escape convention (for example, `'=SUM(1,2)` or `''literal`). Import all
columns as text to preserve the literal CSV strings and digests; spreadsheet
applications can otherwise change values or strip the display escape.

Checkout writes `planning.csv` and `planning.csv.session.json` exclusively, with
owner-only file permissions. Existing files are never overwritten. If CSV
creation fails after the baseline is written, the refusal explains that an
incomplete baseline may remain; choose new filenames after checking the files.
Keep the JSON baseline unchanged, or specify it with `--session baseline.json`.
The baseline contains exported values, so protect it like the CSV. Digests detect
accidental alteration and bind the CSV to its baseline; they are not signatures
or authorization credentials. Tracker permissions and SDK ownership policy still
apply. Do not edit digest columns to override a conflict.

Each row has `_session`, stable `id`, `_revision` (verified history digest),
`_item_digest` (full document digest), read-only `status`, and a `_digest_<field>`
column for every editable field. Custom fields, relationships, collections, type,
and lifecycle transitions are outside this scalar protocol. Use native commands
for those operations, then export again. In particular, use `pm close` / `pm
reopen` for status changes. Editing fields on an already terminal keyed item
preserves its identity, status, completion timestamp and closure evidence.
This does not change legacy `csv import --key` retry behavior.

For each edited field, apply compares **baseline / edited CSV / current tracker**:

| Current tracker | Result |
| --- | --- |
| Equals baseline | Apply the edited value |
| Equals edited value | Already converged; no item/history write |
| Differs from both | Conflict; refuse the whole table during preflight |
| Changed only in an unedited field | Preserve that change and count the row as concurrent |

Preflight validates the complete table and all selected items before starting a
transaction. A malformed, changed or conflicting digest causes zero item/history
writes and creates no transaction journal. A successful dry run is a preview,
not a reservation: a native writer can change state immediately afterward.
The patch rechecks each item while holding the SDK item lock. Every native
mutation callback used by apply and compensation records a monotonic start time
and the effective `locks.ttl_seconds`. Before returning (including no-op returns),
it refuses with typed `csv_lease_expired` when elapsed time reaches the TTL minus
ten percent, capped at a one-second safety margin. Checkout, prior-document
capture and representation restoration also check this budget before returning
or writing. The remedy is: re-run apply; another writer may have changed the item.

Run `node --test test/repros/sdk-lease-overrun.ts` for two passing real-SDK
regressions. A disposable non-git tracker uses a real one-second lease; a newer
native SDK writer or separate CLI writer takes over while the first callback is
suspended. The package guard refuses the stale callback and preserves the newer
value. These cases also run in the normal release suite through
`test/lease-guard.test.ts`, alongside actual apply and compensation wiring cases.

The deadline is a package mitigation, not atomic persistence fencing. The SDK
reads before entering the callback and persists after its return; arbitrary host
delays in those windows can exhaust the lease despite the margin. A callback
check cannot atomically close that later write window. The root fix belongs
upstream in [pm-cli issue 1549](https://github.com/unbraind/pm-cli/issues/1549),
verified by the owner on SDK 2026.10.22; the package dependency pin is unchanged.

Ordinary failures trigger the existing SDK transaction coordinator and CSV
full-document compensation; compensation checks for intervening writers before
restoring and depends on the same host lease contract. Such a late
failure can append history or leave mutations pending reconciliation: it is not a
database rollback or a promise of zero history writes after application starts.
Respect the `csv_edit_apply_failed` remedy and inspect the named transaction.
Interrupted runs use stable session/table/row identities and can resume without
retargeting already applied rows. Reusing an old committed session after a newer
writer changes an edited value is refused; export again.

Successful command results are compact TOON by default or JSON with `--json`:

```json
{"rows":2,"changed":1,"unchanged":1,"concurrent":1,"applied":0}
```

Counts are per row. `changed` is the preflight plan and `applied` counts actual
mutations in this attempt; convergence after preflight can reduce `applied`.
`concurrent` includes unedited and convergent concurrent
changes. An applied batch also returns its transaction ID. Refusals have stable
codes (`csv_session_invalid`, `csv_edit_invalid`, `csv_edit_conflict`,
`csv_edit_apply_failed`, `csv_lease_expired`) and remedies. SDK `EditRefusal` exposes `code`, `remedy`,
`conflicts` and `conflictCount`. Transaction refusals retain nested conflict keys
and expose the original error as `cause`, including lease expiration, interruption
and compensation failures. Checkout/apply IO and snapshot read refusals also retain their causes.
Diagnostics show at most twenty item/field keys,
with the total count, and never include cell values. Command error messages carry
the same code, remedy and bounded conflicts; the host controls error rendering.

## Typed SDK example

```ts
import { exportEditSession, applyEditSession } from "pm-csv";

const { session, table } = await exportEditSession(pmRoot, itemIds);
const titleColumn = table[0].indexOf("title");
table[1][titleColumn] = "Reviewed title";
const preview = await applyEditSession(pmRoot, session, table, {
  author: "spreadsheet-editor", dryRun: true,
});
const result = await applyEditSession(pmRoot, session, table, {
  author: "spreadsheet-editor",
});
```

`parseEditSession` validates untrusted JSON before use. `EditSession`,
`EditSessionRow`, `EditField`, `EditReceipt`, `EditConflict` and `EditRefusalCode`
are exported types. SDK tables are arrays of CSV string cells; use a CSV codec
when serializing, rather than joining cells with commas. The SDK accepts an
optional transaction `onTransition` observer for durable execution diagnostics.

## Without git

Checkout, conflict checking and application work in a plain tracker initialized
with `pm init`, including with no `git` executable on PATH. This protocol neither
invokes Git nor needs branches. It uses the SDK's existing tracker storage,
ownership checks, item locks, immutable history and transaction journal. Tests
use real non-git trackers; hosted backend acceptance is separate evidence.

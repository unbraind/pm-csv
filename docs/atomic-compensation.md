# Atomic update compensation

Atomic CSV upserts save their prior item document before the update runs. A
failed later row restores the original title, body, status, priority, type,
tags, deadline, planning fields, dependencies, and lifecycle metadata. Fields
absent in the original remain absent; empty strings and empty collections remain
empty. Annotation collections are preserved. Restore appends history, so
`updated_at` advances instead of erasing evidence of the failed batch.

The SDK coordinator persists `compensationData` before starting a step. The CSV
record has version `2`, binds its item id and row marker, stores the prior
JSON document plus the original stored representation and format, and records the length and SHA-256 digest of verified immutable
history. CSV step ids include `v2`, the operation, target item id for updates, and original
row index; the stable transaction id is unchanged. Replay uses these durable
bindings even when another writer removes the CSV key or ownership tags. A
planned create keeps its original role after its item exists.
An older in-flight journal therefore fails the SDK plan identity check before
mutation. Missing or incompatible prior records refuse compensation.

Compensation calls the public SDK `mutateItem` primitive. Inside its item lock,
it verifies the current document against history, the original history prefix,
and the prior document. Every intervening entry must belong to this batch.
Independent writes, including changes to unrelated fields or removed tags,
refuse compensation and leave the journal and prior values available for
reconciliation. Reverse-order compensation permits later rows of this batch
that targeted the same item. The SDK normalizes some empty scalar and collection fields to absent values.
Compensation therefore has two durable phases: the SDK restores canonical state
and appends a `:restore` event; then an item-locked write restores original
physical values with the same canonical hash and appends a `:compensate`
completion receipt. Only that final receipt marks the step compensated. A crash
between either write and its receipt resumes with the original prior data.
The raw write uses the SDK atomic file and history primitives, preserves the
SDK's canonical derived-index values, and refuses an intervening writer before
changing the representation. JSON Markdown snapshots migrate to the SDK's
normal TOON output while preserving field values. A completed compensation is
a no-op on replay, including when another writer edits the item afterwards.

Update inspection uses immutable apply and restore messages as well as row
tags. A terminal row has separate update and close messages. A process killed
between update and close leaves an incomplete row: restart refuses forward
replay and compensates using the original journal. It never captures that
partially updated document as the new prior state. A subsequent fresh attempt
can apply the full row again.

The workspace transaction lock serializes atomic coordinators. Ordinary item
writers use item locks and can run between subprocesses. Such intervening
writes cause compensation to refuse; no forced restore overrides them. Create
compensation retains its existing best-effort close policy and reconciliation
warning. Compensation itself can be refused by ownership or workflow policy;
operators inspect the transaction and resolve that policy or writer conflict
before retrying.

Validation uses real disposable trackers and the real SDK coordinator:

- Built-package imports fail after a keyed update and recover exact prior state,
  including absent/empty fields, tags, dependencies and annotations.
- Both compensation phases and their final receipt are interrupted, including
  empty scalar and empty collection fixtures. A writer in the representation
  gap refuses restoration.
- Every coordinator transition and the before-apply, after-apply, and
  after-restore journal gaps is interrupted and restarted.
- Transparent subprocess wrappers fail before/after update and close. A real
  SIGKILL between update and close proves process restart recovery.
- An independent subprocess edits the item between update and compensation;
  restoration refuses on both the initial attempt and restart.
- Duplicate existing keys compensate in reverse order; legacy step ids,
  incompatible records, tampered history and unaudited edits refuse recovery.

Run `npm run build && node --test test/atomic-update.test.ts` for these scenarios.
The repository release gates retain their configured 100% line, branch and
function thresholds.

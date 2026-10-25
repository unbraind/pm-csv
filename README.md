# pm-csv

CSV importer and exporter for [pm-cli](https://github.com/unbraind/pm-cli).

Import pm items from a CSV file, export them back out, or wire up a programmatic `csv-import` importer.

The extension requires the pm CLI compatibility floor declared in
`package.json` and `manifest.json`. Development and release gates use the exact
pm CLI/SDK, pm-ops and pm-changelog versions in `package.json`, verified against
`package-lock.json` and installed package metadata so host behavior stays reproducible.

---

## Installation

```bash
pm install npm:pm-csv --global
```

> The `npm:` prefix is required. A bare `pm install pm-csv` resolves only a local
> directory or a bundled alias, never the registry, and a
> `github.com/unbraind/pm-csv` source cannot work either — pm copies a GitHub
> source as-is without building it, and this repository does not commit `dist/`.

Or install per-project:

```bash
pm install npm:pm-csv --project
```

---

## Without git

CSV validation, import, export, and configured importers work in a plain pm
tracker without a Git repository. None of these commands requires Git.

## Commands

| Command | Input and behavior |
|---|---|
| `pm csv import <file>` | Import a required CSV file; `--dry-run` previews without writes. |
| `pm csv-import import <file>` | Same required file, flags, implementation and results as `csv import`. |
| `pm csv validate <file>` | Validate a CSV file without writes. |
| `pm csv export` / `pm csv-export export` | Export tracker items as CSV. |
| `pm csv schema describe <file>` | Propose a reusable versioned table schema with `--output schema.json`. |
| `pm csv schema preview <file> --schema schema.json` | Refuse changed dialect, columns, domains or target contracts without writes. |
| `pm csv schema import <file> --schema schema.json` | Negotiate before importing through the existing mutation core; `--dry-run` is read-only. |

### Versioned table schema negotiation

Save a reviewed mapping once and reuse it without silently reinterpreting a
changed spreadsheet. Renamed/reordered columns, dialect changes and widened
value domains refuse with typed remedies. Quoting, BOM and delimiter information
is retained in a version 1 JSON artifact; agent receipts contain compact counts
and a revision hash, with native TOON/JSON output.

```bash
pm csv schema describe backlog.csv --delimiter semicolon --auto-map --output backlog.schema.json
pm csv schema preview backlog.csv --schema backlog.schema.json --json
pm csv schema import backlog.csv --schema backlog.schema.json --key title --json
```

These commands work without git. See the [protocol and typed SDK example](docs/table-schema.md)
for domain rules, artifact review, size limits, refusals and partial-write boundaries.

### `pm csv import <file>`

Read a CSV file and create or update pm items.

If any row mutation fails, the command exits nonzero and reports the error
count, imported/updated/skipped counts, and row errors. Non-atomic imports
continue with later rows; successful writes remain in the tracker. This also
applies to `csv-import import` and configured importers.

```
pm csv import tasks.csv
pm csv import backlog.csv --delimiter ';'
pm csv import data.tsv --delimiter tab
pm csv import jira.csv --auto-map              # infer common aliases (summary->title, owner->assignee)
pm csv import jira.csv --map 'Summary=title,Owner=assignee'
pm csv import items.csv --key title         # idempotent re-import (no duplicates)
pm csv import legacy.csv --encoding latin1  # non-UTF-8 source
pm csv import sprint12.csv --source 'jira-export-2026-06'
pm csv import vendor.csv --strict       # fail before writing on bad row data
pm csv import items.csv --dry-run
pm csv import tasks.csv --atomic   # writer-locked, crash-recoverable import
```

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--delimiter <char>` | string | `,` | Field delimiter, or alias `tab` / `comma` / `semicolon` / `pipe` |
| `--map <col=field>` | string | — | Remap a CSV header to a pm field (repeatable, comma-joined), e.g. `--map 'Summary=title'` |
| `--auto-map` | boolean | false | Auto-map common third-party headers when unambiguous (e.g. `summary -> title`, `owner -> assignee`) |
| `--key <field>` | string | — | Dedup key column: a re-import **updates** the matching item instead of creating a duplicate |
| `--encoding <enc>` | string | `utf-8` | Source file encoding: `utf-8` \| `utf16le` \| `latin1` |
| `--source <label>` | string | — | Record an import-provenance label in the `csv_source` field of created/updated items |
| `--status <filter>` | string | — | Import **only** rows whose (normalized) status matches; non-matching rows are skipped |
| `--type <type>` | string | — | Import **only** rows whose type matches (case-insensitive) |
| `--priority <n>` | integer | — | Import **only** rows whose integer priority equals this value |
| `--strict` | boolean | false | Abort before writing if validation finds missing titles, unknown statuses, invalid/out-of-range priorities, or duplicate mapped columns |
| `--dry-run` | boolean | false | Preview what would be imported without writing any data |
| `--atomic` | boolean | false | Use one writer-locked, crash-recoverable transaction. On failure, attempt best-effort create compensation; pre-existing updates restore captured prior values unless a conflict prevents safe compensation. Inspect and reconcile any marked orphan before retrying. Incompatible with `--stream` |

#### Strict import gate

Default imports remain lenient for messy spreadsheets: empty titles are skipped,
unknown statuses fall back to `open`, and non-numeric priorities are ignored. Add
`--strict` when the CSV is expected to be a production source of truth. In
strict mode the importer runs the same parser as `pm csv validate` before any
write, then aborts on row-level data issues or duplicate mapped columns so a bad
file cannot partially mutate the pm store.

#### Atomic, crash-recoverable import (`--atomic`)

By default, `csv import` creates items one row at a time. If a row fails
mid-import, the rows already written stay in the tracker — a partial,
non-atomic state — and concurrent agents can interleave writes. `--atomic`
(requires pm-cli **>= 2026.7.19**) wraps the whole row set in a single
`commitWorkspaceTransaction` primitive: mutations are serialized under one
workspace writer lock and recorded in a crash-recoverable journal.

- **Failure compensation:** if any row fails, the coordinator attempts
  reverse-order, best-effort compensation for creates by closing them with
  reason `atomic csv import rolled back`, rolls back the transaction journal,
  and exits non-zero with a reconciliation warning. A failed close deliberately
  retains both transaction markers so an operator can inspect and reconcile the
  open orphan by transaction id before retrying. Before each update, a version 2
  compensation record stores the complete prior item document and verified
  history boundary. On failure, an append-only restore recovers prior values,
  including absent versus empty metadata, tags, dependencies, body, and lifecycle
  side effects. A second guarded phase preserves stored empty fields that the
  SDK canonicalizes away; its completion receipt makes that phase resumable.
  Only `updated_at` advances to record the compensation. See
  [the compensation design and validation](docs/atomic-compensation.md).
- **Concurrent writer safety:** compensation checks the history boundary and
  current state while holding the SDK item lock. Any intervening mutation
  outside this batch refuses restoration, including edits to unrelated fields.
  The journal remains compensating with its prior values intact; inspect and
  reconcile the conflict before retrying. The workspace transaction lock
  serializes atomic imports; ordinary item writers use their item locks.
- **Crash-recoverable / resumable:** the transaction id is stable and derivable
  from the resolved file path and parsed content fingerprint, so re-running the
  same unchanged `--atomic` import resumes from the durable journal while edited
  content receives a fresh transaction id.
  Resume/compensation matching is **per-row-precise**: every item this
  transaction writes is stamped with a per-row ownership marker
  `csv-txrow:<transactionId>#<rowIndex>` (plus a batch-level
  `csv-tx:<transactionId>` marker for scanning). Creates resume from these
  markers; updates also inspect immutable history. Versioned journal step ids
  preserve the original operation and update target even if another writer
  removes the CSV tags. This means a
  CSV with **duplicate titles or duplicate keys** is handled correctly — a row
  is only skipped when its exact rowIndex was already applied, never because a
  same-titled/same-keyed sibling happens to match.
- **In-batch duplicate `--key` guard:** when `--key` is set, two rows in the same
  file that share a key which does NOT already exist in the tracker would both
  plan as a create (the key index is not updated during planning). The atomic
  planner tracks keys claimed by earlier planned creates in the same run and
  **skips a later duplicate with a clear per-row warning** (counted in
  `skipped`), so only one item is created per new key. Rows whose key already
  exists in the tracker still update normally.
- **Parity:** `--atomic` shells out to the same `pm create` the non-atomic path
  uses; without `--atomic`, import output and exit codes are unchanged.
- **Incompatible with `--stream`:** an unbounded stream cannot be committed as
  one bounded transaction, so `--atomic --stream` fails fast with a usage
  error.
- **Create compensation uses `close`, not `delete`**, to avoid the known history-
  resurrection issue, so compensated items remain in the tracker as closed
  items rather than being erased. Update compensation restores the pre-update
  document through the SDK mutation primitive, retaining immutable history.
  Versioned step ids refuse legacy in-flight journals before mutation instead
  of guessing missing prior values. Replaying a restore after a crash is a
  no-op, and reverse-order compensation supports multiple rows for one item.
  A terminal row interrupted between update and close is compensated on restart
  before a fresh attempt; it is never treated as a completed row.
  A failed compensation reports remaining work for operator reconciliation.

```bash
pm csv import tasks.csv --atomic            # resumes an unchanged interrupted import
pm csv import tasks.csv --atomic --source q2 # provenance still recorded
```

#### Row filtering on import

`--status`, `--type` and `--priority` filter the CSV rows **before** any items
are created — non-matching rows are skipped, never written. They mirror the
`csv export` filter semantics exactly (status is normalized through the same
alias table, so `--status open` matches a row whose status cell is `todo`).
Multiple criteria are ANDed. The result reports how many rows were filtered out:

```
pm csv import tasks.csv --status open               # import open rows only
pm csv import tasks.csv --type Feature --priority 1 # AND: Feature *and* priority 1
# → Imported 1, updated 0, skipped 5 (5 filtered out).
```

**Required column:** `title`

**Optional columns:** `type`, `status`, `priority`, `tags`, `deadline`, `body`, `parent`, `assignee`, `sprint`, `release`, `blocked_by`

---

### `pm csv validate <file>`

Parse a CSV and report data-quality issues **without importing**. Exits non-zero
(usage error) when there is a structural problem (no `title` column after `--map`
or an empty file); otherwise exits `0` even when it reports row-level warnings.

```
pm csv validate tasks.csv
pm csv validate jira.csv --map 'Summary=title'
pm csv validate jira.csv --auto-map
pm csv validate data.tsv --delimiter tab --json
```

The report includes: row count, detected columns, mapped columns (after `--map`),
whether the required `title` column is present, duplicate mapped columns, and
counts of rows missing a title, rows with an unrecognized status, rows with a
non-integer priority, and rows with a priority outside pm's `0..4` range.

`--auto-map` applies the same alias vocabulary as import, then validates against
the effective mapped headers.

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--delimiter <char>` | string | `,` | Field delimiter, or alias `tab` / `comma` / `semicolon` / `pipe` |
| `--map <col=field>` | string | — | Remap a CSV header to a pm field before validating |
| `--auto-map` | boolean | false | Auto-map common third-party headers when unambiguous before validating |
| `--encoding <enc>` | string | `utf-8` | Source file encoding: `utf-8` \| `utf16le` \| `latin1` |
| `--json` | boolean | false | Emit the report as JSON |

---

### `pm csv export`

Export all pm items (or a filtered subset) to CSV. Without `--output` the CSV is returned in the command result object.

Every export, upsert index, and atomic-resume scan reads the whole tracker with
canonical `pm list --all`, strict source reads, full metadata, and explicitly
unbounded row and token controls. The public pm SDK certifies source status,
filter scope, pagination, projection, counts, and item identity before pm-csv
uses a row. pm-csv additionally rejects missing or contradictory omission,
read-output, and unreadable-item receipts tracked in pm-cli issue 1078. A
partial or unverifiable workspace therefore fails closed instead of exporting
missing rows, creating duplicate upserts, or reapplying an atomic import.

```
pm csv export
pm csv export --output items.csv
pm csv export --output backlog.csv --delimiter ';'
pm csv export --status open --output todos.csv
pm csv export --type Feature --output features.csv
pm csv export --excel --output for-excel.csv
```

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--output <file>` | string | — | Write CSV to this file path instead of returning it |
| `--delimiter <char>` | string | `,` | Field delimiter, or alias `tab` / `comma` / `semicolon` / `pipe` |
| `--status <status>` | string | — | Filter: `open` \| `in_progress` \| `blocked` \| `closed` \| `canceled` \| `draft` |
| `--type <type>` | string | — | Filter by item type |
| `--columns <list>` | string | all | Comma-separated columns to export, in order (custom fields selectable when `--all-fields` is set) |
| `--all-fields` | boolean | false | Discover custom item fields registered in the workspace schema and append them as columns |
| `--discover-fields` | boolean | false | Alias for `--all-fields` |
| `--no-header` | boolean | false | Omit the CSV header row |
| `--crlf` | boolean | false | Use CRLF line endings (RFC-4180 / Excel) |
| `--excel` | boolean | false | Excel-friendly output: CRLF line endings **and** a UTF-8 BOM prefix |

**Export columns (fixed order):**
`id, title, type, status, priority, tags, deadline, body, parent, assignee, sprint, release, blocked_by, csv_source, created_at, updated_at`

#### Custom-field discovery (`--all-fields`)

By default only the built-in columns above are exported. `--all-fields` (alias
`--discover-fields`) discovers any **custom item fields** registered in the
workspace runtime schema and appends them as extra columns — the default column
set is otherwise unchanged, so the flag is strictly additive.

Discovery uses the pm SDK's `readSettingsWithMetadata` and
`resolveRuntimeFieldRegistry`, including configured schema files, array and
`definitions` file shapes, and legacy metadata aliases. The host's canonical
registry rules apply: custom columns sort by normalized key, names normalize to
lowercase, and file-backed definitions override inline definitions of the same
key. These replace the old insertion order, literal names and first-definition
precedence. Explicit `--columns` order remains unchanged. Invalid inline settings
follow the SDK defaults instead of partially salvaging their inline fields;
missing or malformed optional files follow the SDK's fallback rules. The SDK
initializes missing runtime schema files as it does for host commands; complete
schema files stay unchanged.
Both discovery APIs are available at the declared host floor.

```bash
pm csv export --all-fields --output full.csv
# header gains your custom columns, e.g. …,updated_at,story_points,team
```

---

## Programmatic importer: `csv-import`

The CLI spelling `pm csv-import import <file>` accepts every `csv import` flag.
Missing input and import failures exit nonzero. Programmatic callers can still
supply `options.file`.

Register the importer in your pm-cli config to automatically pull from a CSV file on every sync:

```jsonc
{
  "importers": [
    {
      "name": "csv-import",
      "config": {
        "file": "./data/items.csv",
        "delimiter": ","
      }
    }
  ]
}
```

**Config options**

| Key | Type | Required | Description |
|---|---|---|---|
| `file` | string | yes | Path to the CSV file to import |
| `delimiter` | string | no (default `,`) | CSV field delimiter (or alias `tab`/`comma`/`semicolon`/`pipe`) |
| `map` | string | no | Header remap, e.g. `Summary=title` |
| `auto-map` / `autoMap` | boolean | no (default `false`) | Auto-map common third-party headers when unambiguous |
| `key` | string | no | Dedup key column for idempotent re-import |
| `encoding` | string | no (default `utf-8`) | `utf-8` \| `utf16le` \| `latin1` |
| `source` | string | no | Provenance label recorded in `csv_source` |

---

## CSV Format

### Import format

The first row must be a header row. Column names are **case-insensitive**. Column order does not matter. Only `title` is required.

```csv
title,type,status,priority,tags,deadline,body,parent,assignee,sprint,release,blocked_by
"Add login page",Feature,open,2,"auth,ui",2026-05-30,"Landing page with email+password login",,alice,Sprint-12,v1.0,
"Fix navbar bug",Issue,in_progress,1,"bug,ui",,"Navbar collapses on mobile Safari",,bob,Sprint-12,v1.0,
"Write API docs",Task,open,3,docs,,,,,Sprint-13,v1.1,Fix navbar bug
```

### Column reference

| Column | Description | Notes |
|---|---|---|
| `title` | Item title | **Required** |
| `type` | Item type | Any string, e.g. `Feature`, `Issue`, `Task` |
| `status` | Item status | See status mapping below |
| `priority` | Numeric priority | Integer |
| `tags` | Comma-separated tags | Quote the field if tags contain commas |
| `deadline` | Deadline | ISO 8601, e.g. `2026-05-30` (legacy `due_date` header accepted) |
| `body` | Description / body text | Supports multiline when quoted |
| `parent` | Parent item id | Maps to `pm create --parent` |
| `assignee` | Assignee | Maps to `pm create --assignee` |
| `sprint` | Sprint identifier | Maps to `pm create --sprint` |
| `release` | Release identifier | Maps to `pm create --release` |
| `blocked_by` | Blocked-by item id or reason | Maps to `pm create --blocked-by` (legacy `blocked-by` header accepted) |

All columns except `title` are optional. Round-tripping (`export` then `import --key`) is lossless for these fields.

### Status mapping

The importer accepts common status strings and maps them to pm-cli statuses:

| Input values | pm-cli status |
|---|---|
| `open`, `todo`, `new` | `open` |
| `in_progress`, `wip`, `in progress`, `doing` | `in_progress` |
| `blocked`, `on_hold`, `on hold` | `blocked` |
| `closed`, `done`, `complete`, `completed` | `closed` |
| `canceled`, `cancelled` | `canceled` |
| `draft` | `draft` |

Unrecognized values default to `open`.

### Export format

Exports use the same CSV format and can be re-imported. An extra read-only
`csv_source` column surfaces the import-provenance label (see `--source`); it is
ignored on import.

```csv
id,title,type,status,priority,tags,deadline,body,parent,assignee,sprint,release,blocked_by,csv_source,created_at,updated_at
pm-abc123,Add login page,Feature,open,2,"auth,ui",2026-05-30,Landing page,,alice,Sprint-12,v1.0,,jira-export,2026-05-01T10:00:00Z,2026-05-09T12:00:00Z
```

---

## Idempotent re-import (`--key`)

`--key <field>` makes re-imports update existing items instead of creating
duplicates. The first import tags each created item with an internal
`csv-key:<value>` provenance tag; a later import keyed on the same column finds
and updates the matching item. Key matching is case-insensitive (pm folds tag
case on storage). The internal `csv-key:` and `csv-source:` tags are stripped
from exports so round-trips stay clean.

## Provenance & the `csv_source` schema field (`--source`)

The extension registers an optional `csv_source` schema item field (via the
`schema` capability). When you import with `--source <label>`, the label is
recorded on each created/updated item and is surfaced back in the `csv_source`
export column. Note: as of pm 2026.5.31 the CLI does not expose a scalar setter
for extension-registered fields, so the value is persisted as an internal
`csv-source:<label>` tag (stripped from the normal `tags` export column). On
hosts whose SDK lacks `registerItemFields`, schema registration degrades to a
no-op without breaking any other behavior.

---

## CSV parsing rules

- Fields containing the delimiter, double-quotes, or newlines must be wrapped in double-quotes.
- Embedded double-quotes inside a quoted field are escaped by doubling them: `""`.
- Multiline field values (newlines inside quotes) are fully supported.
- Both `\n` (LF) and `\r\n` (CRLF) line endings are accepted on import.

---

## Building

`npm run accept:packed` packs the real artifact and exercises strict CSV import
plus complete CSV export in fresh npm/npx and Bun/bunx projects on the pinned
development host, and in npm/npx on the declared minimum host. It is mandatory
inside `npm run release:check`.

```bash
npm install
npm run build   # runs tsc → dist/
```

TypeScript version pinned in `package.json`, ES2022 target, NodeNext module resolution, strict mode. The runtime dependency is `@toon-format/toon`.

---


## Exporter & column selection (added)

`pm csv export` and the native `pm csv-export export` both accept `--columns` to pick and order columns:

```bash
pm csv export --columns id,title,status --output todos.csv
pm csv-export export --columns title,priority      # native export pipeline
```

Valid columns: id, title, type, status, priority, tags, deadline, body, parent, assignee, sprint, release, blocked_by, csv_source, created_at, updated_at.

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script, `scripts/prepare-merge-driver.ts`: a launcher delegating to the installed pm-ops public installer entry. Tests verify the installer behavior rather than comparing version-specific template bytes. It runs pm-ops's installer, which calls `pm merge install` when the `pm` CLI is on `PATH` and skips with a notice when it is not. A production install of a clone (`npm ci --omit=dev`) has no `pm-ops`, so the launcher skips with one notice, while a stale or broken `pm-ops` fails the install. Registry installs of this package never run `prepare`. Being Node-based, it behaves identically on POSIX shells and Windows `cmd.exe`. To (re)run manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.

## Conflict-aware spreadsheet round trips

Use `pm csv checkout --output planning.csv` to export an editable table with
explicit item/revision/field digests and a baseline JSON file. Edit scalar cells,
then run `pm csv apply planning.csv --dry-run --json` followed by
`pm csv apply planning.csv --json`. Apply compares baseline, spreadsheet and
current tracker values, refuses conflicting changes before application, and
preserves changes to unedited fields. Identical retries write no item/history
records, including for terminal keyed items.

See the [protocol and CLI/typed SDK example](docs/spreadsheet-roundtrip.md) for
editable fields, read-only status, bounded refusals, concurrency and recovery
boundaries. This edit-session protocol reuses the existing SDK coordinator and
CSV compensation; legacy keyed import remains a separate command.

Apply and compensation callbacks refuse with `csv_lease_expired` when their
monotonic elapsed time reaches the effective item TTL minus a safety margin
(ten percent, capped at one second). Re-run apply; another writer may have
changed the item. Checkout and compensation snapshot reads use the same budget.
The real SDK/CLI takeover regressions now pass in the release suite.

This callback deadline is a mitigation. The host must still atomically fence
persistence after callback return; arbitrary delays there can exhaust the
remaining lease. That root fix belongs upstream in
[pm-cli issue 1549](https://github.com/unbraind/pm-cli/issues/1549).

## Without git

CSV import, export, validation, lineage bundles, checkout and three-way application work in a plain
tracker initialized with `pm init`. None requires a Git repository. GitHub sync
and Git-derived changelog provenance are separate host/tooling features.

## Cell lineage and rejected-row bundles

Use `pm csv bundle input.csv --columns title,priority --output import-bundle`
to import with a portable cell manifest and a minimal correction/retry CSV.
Only explicitly permitted fields leave the source. Correct the rejected file
and import it into a fresh bundle: successful rows are excluded, and stable
keys make unchanged retries idempotent. The compact TOON/JSON receipt reports
counts; artifacts include SHA-256 checksums. See the [protocol and worked
example](docs/row-lineage.md) for the typed SDK, mapping revisions, refusals,
privacy policy and recovery behavior.

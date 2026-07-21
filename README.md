# pm-csv

CSV importer and exporter for [pm-cli](https://github.com/unbraind/pm-cli).

Import pm items from a CSV file, export them back out, or wire up a programmatic `csv-import` importer — all with zero external runtime dependencies.

---

## Installation

```bash
pm install github.com/unbraind/pm-csv --global
```

Or install per-project:

```bash
pm install github.com/unbraind/pm-csv --project
```

---

## Commands

### `pm csv import <file>`

Read a CSV file and create or update pm items.

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
pm csv import tasks.csv --atomic   # all-or-nothing import (pm-cli >= 2026.7.19)
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
| `--atomic` | boolean | false | Import all creates atomically under one workspace writer-locked, crash-recoverable transaction (pm-cli >= 2026.7.19). On failure every applied create is compensated (closed); interrupted runs resume. Incompatible with `--stream` |

#### Strict import gate

Default imports remain lenient for messy spreadsheets: empty titles are skipped,
unknown statuses fall back to `open`, and invalid priorities are ignored. Add
`--strict` when the CSV is expected to be a production source of truth. In
strict mode the importer runs the same parser as `pm csv validate` before any
write, then aborts on row-level data issues or duplicate mapped columns so a bad
file cannot partially mutate the pm store.

#### Atomic, all-or-nothing import (`--atomic`)

By default, `csv import` creates items one row at a time. If a row fails
mid-import, the rows already written stay in the tracker — a partial,
non-atomic state — and concurrent agents can interleave writes. `--atomic`
(requires pm-cli **>= 2026.7.19**) wraps the whole row set in a single
`commitWorkspaceTransaction` primitive: all creates are committed under one
workspace writer-locked, crash-recoverable journal, or none are.

- **All-or-nothing:** if any row's `pm create` fails, every already-applied
  create is compensated (closed with `reason "atomic csv import rolled back"`),
  the transaction is rolled back, and the command exits non-zero with a clear
  message. No committed (open) items from the import remain in the tracker.
- **Crash-recoverable / resumable:** the transaction id is stable and derivable
  from the absolute file path (`csv-import-<sha1(absPath)>`), so re-running the
  same `--atomic` import against the same file resumes from the durable journal.
  Resume/compensation matching is **per-row-precise**: every item this
  transaction writes is stamped with a per-row ownership marker
  `csv-txrow:<transactionId>#<rowIndex>` (plus a batch-level
  `csv-tx:<transactionId>` marker for scanning), and a resumed run detects
  already-applied rows by parsing the rowIndex out of that marker. This means a
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
  one all-or-nothing transaction, so `--atomic --stream` fails fast with a usage
  error.
- **Compensation uses `close`, not `delete`**, to avoid the known history-
  resurrection issue, so compensated items remain in the tracker as closed
  items rather than being erased. For `--key` upsert rows that update
  pre-existing items, the update is applied within the transaction but is not
  reverted on failure (an arbitrary update cannot be safely undone without
  capturing prior state); all-or-nothing compensation applies to creates.

```bash
pm csv import tasks.csv --atomic            # all-or-nothing; resumes if interrupted
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

Discovery reads the same inputs the SDK's `resolveRuntimeFieldRegistry` consumes
(the workspace `settings.json` `schema.fields` plus the file it points at via
`schema.files.fields`, default `schema/fields.json`). A standalone-installed
extension only loads its own `dist/`, so the SDK function isn't importable at
runtime; reading its inputs directly is the runtime-safe equivalent.

```bash
pm csv export --all-fields --output full.csv
# header gains your custom columns, e.g. …,updated_at,story_points,team
```

---

## Programmatic importer: `csv-import`

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

```bash
npm install
npm run build   # runs tsc → dist/
```

TypeScript 5, ES2022 target, NodeNext module resolution, strict mode. Zero runtime dependencies.

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
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script
(`pm merge install`). To (re)run manually: `npm run merge:install`. After merging a branch that
touched `.agents/pm/`, run `pm history-repair --all` to reconcile history verification.

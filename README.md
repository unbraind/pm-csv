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
pm csv import items.csv --dry-run
```

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--delimiter <char>` | string | `,` | CSV field delimiter |
| `--dry-run` | boolean | false | Preview what would be imported without writing any data |

**Required column:** `title`

**Optional columns:** `type`, `status`, `priority`, `tags`, `milestone`, `due_date`, `body`

---

### `pm csv export`

Export all pm items (or a filtered subset) to CSV. Without `--output` the CSV is returned in the command result object.

```
pm csv export
pm csv export --output items.csv
pm csv export --output backlog.csv --delimiter ';'
pm csv export --status todo --output todos.csv
pm csv export --type Feature --output features.csv
```

**Flags**

| Flag | Type | Default | Description |
|---|---|---|---|
| `--output <file>` | string | — | Write CSV to this file path instead of returning it |
| `--delimiter <char>` | string | `,` | CSV field delimiter |
| `--status <status>` | string | — | Filter: `todo`, `wip`, `done`, `blocked` |
| `--type <type>` | string | — | Filter by item type |

**Export columns (fixed order):**
`id, title, type, status, priority, tags, milestone, due_date, body, created_at, updated_at`

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
| `delimiter` | string | no (default `,`) | CSV field delimiter |

---

## CSV Format

### Import format

The first row must be a header row. Column names are **case-insensitive**. Column order does not matter. Only `title` is required.

```csv
title,type,status,priority,tags,milestone,due_date,body
"Add login page",Feature,open,2,"auth,ui",v1.0,2026-05-30,"Landing page with email+password login"
"Fix navbar bug",Issue,in_progress,1,"bug,ui",,,"Navbar collapses on mobile Safari"
"Write API docs",Task,todo,3,docs,,,
```

### Column reference

| Column | Description | Notes |
|---|---|---|
| `title` | Item title | **Required** |
| `type` | Item type | Any string, e.g. `Feature`, `Bug`, `Task` |
| `status` | Item status | See status mapping below |
| `priority` | Numeric priority | Integer |
| `tags` | Comma-separated tags | Quote the field if tags contain commas |
| `milestone` | Milestone name | Any string |
| `due_date` | Due date | ISO 8601 format recommended, e.g. `2026-05-30` |
| `body` | Description / body text | Supports multiline when quoted |

### Status mapping

The importer accepts common status strings and maps them to pm-cli statuses:

| Input values | pm-cli status |
|---|---|
| `todo`, `open`, `new` | `todo` |
| `done`, `closed`, `complete`, `completed` | `done` |
| `wip`, `in_progress`, `in progress`, `doing` | `wip` |
| `blocked`, `on_hold`, `on hold` | `blocked` |

Unrecognized values default to `todo`.

### Export format

Exports use the same CSV format and can be re-imported:

```csv
id,title,type,status,priority,tags,milestone,due_date,body,created_at,updated_at
item-abc123,Add login page,Feature,todo,2,"auth,ui",v1.0,2026-05-30,Landing page with email+password login,2026-05-01T10:00:00Z,2026-05-09T12:00:00Z
```

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

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

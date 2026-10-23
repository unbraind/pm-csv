# Versioned table schema negotiation

A saved version 1 schema binds a UTF-8 table's delimiter, doubled-double-quote
escaping, BOM presence, record separator, exact ordered headers, full-column
value domains and proposed pm mappings. It also binds the target types and
statuses resolved by the native pm SDK. A renamed, reordered, added or removed
column cannot reuse that mapping. Describe the changed input into a **new**
artifact and review the mapping before using it.

```csv
Summary;priority;body
"Document; negotiation";2;"Quote ""safely"""
```

```bash
pm csv schema describe backlog.csv --delimiter semicolon --auto-map --output backlog.schema.json --json
pm csv schema preview backlog.csv --schema backlog.schema.json --json
pm csv schema import backlog.csv --schema backlog.schema.json --dry-run --json
pm csv schema import backlog.csv --schema backlog.schema.json --key title --json
```

`describe` proposes the existing import aliases only when `--auto-map` is
explicit. Alternatively use `--map Summary=title,Rank=priority`. Input map keys
follow the existing lowercase/trimmed header convention. The saved artifact
preserves the original exact header spelling, whitespace and order. A field
outside the supported CSV import surface has `field: null` and is excluded
from import. Renaming an ignored column still requires review.

Without `--output`, describe returns a compact count/revision receipt. With
`--output`, it exclusively creates a private JSON artifact (mode 0600), never
overwriting an existing file. Review its `columns[].field` proposals in that
file; cell values and input paths are absent. The host renders receipts in
TOON by default and JSON with global `--json`. Receipts stay constant in size
as row counts grow: version, revision, row/column/mapped/ignored counts, plus
save or import counts. No row previews are returned.

## Typed SDK

```ts
import { readFileSync } from "node:fs";
import {
  describeTable, previewTable, importNegotiatedTable, TableSchemaRefusal,
} from "pm-csv";
import type { TableSchema, TableReceipt } from "pm-csv";

const tracker = ".agents/pm";
const text = readFileSync("backlog.csv", "utf8");
const { schema } = await describeTable(tracker, text, {
  delimiter: ";", fieldMap: { summary: "title" },
});
const saved: TableSchema = schema;
const preview: TableReceipt = await previewTable(tracker, text, saved);
try {
  await importNegotiatedTable(tracker, text, saved, { keyField: "title" });
} catch (error) {
  if (error instanceof TableSchemaRefusal) {
    console.error(error.code, error.remedy);
  } else throw error;
}
```

Use `parseTableSchema(unknown)` to validate an artifact before reuse. Unsupported
versions, malformed shapes and changed revisions refuse. The SHA-256 revision
hashes canonical JSON in the order `version,dialect,columns,target`, with
dialect keys `delimiter,quote,bom,eol`, column keys `name,domain,field`, domain
keys `kind,nullable` and target keys `types,statuses`. Top-level JSON key order
does not matter. This checksum detects accidental edits; it is not an
authentication signature. Only use reviewed artifacts from trusted sources.

## Domains and refusals

Domains inspect **all** cells, never a sample. After trimming, nonempty values
are classified as integer, decimal, boolean (`true`/`false`, case insensitive),
text or empty. `nullable` records whether empty cells were observed. Text allows
arbitrary new strings; decimal permits an integer subset. New empty cells in a
nonnullable column and other domain widening require a new schema. An all-empty
column cannot silently become populated. Domains describe lexical input and
do not promise preservation of whitespace or numerical formatting: negotiated
import retains existing CSV coercion and trimming semantics.

| Code | Remedy |
|---|---|
| `csv_table_invalid` | Correct quoting, row widths, mappings, title, priority, type or status. |
| `csv_schema_invalid` | Restore a valid unchanged version 1 artifact or describe a new one. |
| `csv_schema_changed` | Review dialect/header/order changes and explicitly adopt a new schema. |
| `csv_domain_changed` | Review changed domains/nullability and describe again. |
| `csv_target_changed` | Review changed target types/statuses and describe again. |
| `csv_schema_io` | Supply readable UTF-8 inputs or a new writable output filename. |
| `csv_table_import_failed` | Inspect reported counts and tracker policies before retrying. |

All package refusals extend the SDK's `PmCliError`, expose `code` and `remedy`,
and exit 2 with structured context/next steps. Normal SDK tracker-read errors
retain their native SDK error contract. Schema refusal messages never echo raw
cell values; mutation diagnostics retain the existing importer's behavior.

## Boundaries

The negotiated protocol accepts at most 8 MiB, 128 columns (distinct normalized
headers of at most 128 characters) and 10000 data rows. It rejects malformed
quotes, mixed LF/CRLF record separators, bare CR, blank records, ragged rows,
unknown statuses and invalid priorities. Embedded line endings inside quoted
cells are preserved by parsing/serialization and do not define record dialect.
The shared import parser retains an explicit final `""` record even without a
trailing newline. Quoted and unquoted empty records are validated and refused;
a single terminating LF or CRLF does not invent an additional record.
Delimiter aliases are comma, semicolon, tab and pipe. Quoting style may change
between equivalent valid encodings; escaping rules remain fixed.

Describe, preview and import dry-run do not mutate tracker documents, history
or settings and need no git. Preview checks the table contract and pm field
values; it does not plan dedup outcomes or execute per-item mutation hooks.
Import negotiates the complete captured text before calling the existing CSV
create/update core, so changing the source file afterward cannot change that
operation's input. The SDK also captures caller-owned schemas and options before
asynchronous tracker reads. Native history, locking, schema validation, key semantics and
mutation policies remain authoritative. Negotiation is not a target-schema
lock: a concurrent policy change can still refuse a row during import.

Negotiated import retains legacy partial-write semantics on mutation failures;
its refusal reports counts. It does not offer atomic resume or compensation.
The separate `csv import --atomic` command remains available for that workflow.
Core schema evolution changes tracker contracts; this protocol describes input
tables. Spreadsheet edit sessions and cell lineage remain separate protocols.

# Row lineage and rejected-row retry

`pm csv bundle input.csv --columns title,priority --output first-bundle`
imports a bounded UTF-8 CSV and creates three private files:

- `manifest.json`: version 1, SHA-256 source and mapping revision, one logical
  record number per row (header is record 1), one-based source column numbers,
  permitted source headers and destination fields, source-cell and observed
  persisted-value hashes, stable row keys, outcomes and item IDs.
- `rejected.csv`: only rejected rows, the explicitly allowed fields, and an
  opaque `_csv_key` column. It never includes successful rows or other columns.
- `checksums.json`: SHA-256 of the exact bytes of the other two files.

Correct values in `rejected.csv`, keep its `_csv_key` cells unchanged, then run:

```sh
pm csv bundle first-bundle/rejected.csv --columns title,priority --output retry-bundle
```

Successful original rows are absent from the retry input. Native SDK explicit
item IDs and an import fingerprint tag make unchanged retries idempotent,
including recovery after a process interruption before artifact export. Changed
values for a previously committed key refuse with `identity_conflict`; use
`pm update` for intentional changes. Do not delete provenance tags. Different
input files without retained retry keys represent separate imports. This command
creates items; use `csv apply` for edits to existing tracker items.

Example input (the `internal` column is excluded from both import and artifacts):

```csv
Summary,priority,internal
Accepted task,2,exclude this column
,9,exclude this column too
```

```sh
pm csv bundle input.csv --map Summary=title --columns title,priority --output first-bundle
# receipt: rows=2 imported=1 replayed=0 rejected=1 manifest=<sha256>
# In rejected.csv, supply the title and change priority to an integer from 0 to 4.
```

The host renders the small receipt in its normal TOON format; `--json` returns
JSON. Large per-cell details stay in the manifest. A nonempty rejection count is
partial success, so automation must check `rejected` before continuing. Structural
and I/O refusals are typed `LineageRefusal` errors with `code`, `remedy`, exit code
2 and SDK recovery context. Per-row codes and remedies live in the manifest;
raw SDK errors and disallowed cell values are never copied into diagnostics.

Supported fields are `title`, `body`, `type`, `status`, `priority`, `tags`,
`assignee`, `sprint`, `release`. `--columns` is an explicit disclosure policy:
only those fields are imported or exported. Missing/ambiguous mappings and
unknown policy fields refuse before writes. Values are trimmed and native SDK
schema, lifecycle and governance rules apply. Terminal states needing a reason
or custom type requirements may be rejected; choose supported input values or
use the native lifecycle commands. Row width, missing titles and invalid
priorities reject the row. There are at most 1000 data rows per call.

Hash rules: `lineageDigest(value)` is SHA-256 of UTF-8 `JSON.stringify(value)`.
The source digest hashes the entire parsed table, including excluded columns,
without exporting their values or names. The mapping revision hashes
`[1, mapping]`, including ordered permitted headers/columns/fields. Each source
cell is hashed before trimming; each persisted value is hashed from the native
item document observed after import/replay (missing values use JSON null).
Hashes are integrity checks, not encryption or a signature. Preserve the
original manifest for the original observation if the tracker later changes.
The manifest digest hashes all fields except `digest`; `rejectedDigest` hashes
the parsed retry table. File checksums additionally detect byte-level changes.
Correcting retry cells intentionally changes checksums and creates a new manifest.
A retry manifest describes its own input coordinates and mapping revision; the
stable row key links back to the previous manifest.

SDK example:

```ts
import { importLineage, parseCSV } from "pm-csv";
const bundle = await importLineage(pmRoot, parseCSV(csvText), {
  columns: ["title", "priority"], fieldMap: { Summary: "title" }, author: "csv-agent",
});
console.log(bundle.receipt);
// Persist bundle.manifest and serializeCSV(bundle.rejected, ",") as private artifacts.
```

No Git command is needed: native SDK create, schema validation, locks, history
and explicit IDs own tracker behavior. Keep the output directory private. The
CLI reserves a new directory before mutation, refuses existing directories, and
never overwrites artifacts. If final writes fail, retain partial files and rerun
unchanged input into a fresh directory; stable keys recover committed rows.

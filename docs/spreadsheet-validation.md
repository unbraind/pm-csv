# Public tracker copy validation

Source: public `unbraind/pm-csv`, main commit
`1f7e523b6d5539264d3316362665506486eeea3a` (2026.10.21).
Repository visibility was checked before copying. Only the committed `.agents/pm`
subtree was archived to a newly created non-git scratch directory. The source
tracker was read-only throughout; all test mutations targeted the disposable
copy. No exported tracker content is committed as a fixture.

Procedure: `git archive origin/main .agents/pm` into a scratch directory, enumerate
items with the pinned SDK and explicit settings/type registry, exercise the built
`dist` SDK, then install the built extension into the scratch tracker's extensions
directory and invoke the pinned CLI. CLI PATH contained only Node and pm, and
`GIT_CEILING_DIRECTORIES` excluded ancestor discovery.

| Measurement | Result |
| --- | ---: |
| Public tracker items exported by SDK and actual CLI | 118 |
| SDK enumeration warnings | 0 |
| CSV columns / editable fields | 17 / 6 |
| Baseline JSON bytes / CSV bytes | 114257 / 97461 |
| Unedited full-table apply | 118 unchanged, 0 applied |
| Edited rows (open, in progress, terminal) | 3 |
| Concurrent unedited-field change | 1 preserved |
| Dry run | 3 changed, 0 applied |
| Apply | 3 applied |
| Identical retry | 3 unchanged, 0 applied |
| Second editor changing an already edited title | `csv_edit_conflict` |
| Altered revision digest | `csv_edit_invalid` |
| Whole-corpus byte/hash comparisons proving zero writes | 4 |
| Full-table preview JSON / no-op TOON receipt bytes | 89 / 61 |
| Measured validation duration (single sample) | 31.32 seconds |

The four zero-write comparisons cover unedited import, identical replay,
conflicting second editor and altered revision digest. Each comparison hashes
all 118 raw item documents and their immutable history streams, rather than
trusting command counters. Separate targeted regression tests check that stale
preflight creates no transaction journal. The original public snapshot and the
copy contain real heterogeneous lifecycle states; the three edited rows were
selected by status rather than fabricated as replacement tracker data.

The compact receipts contain counts and transaction IDs, not exported values.
This is bounded filesystem-backend validation, not hosted Postgres/MCP or a
throughput benchmark. The full npm/Bun release-gate evidence is recorded in the
PR, using CI to avoid heavy local gates on the saturated host.

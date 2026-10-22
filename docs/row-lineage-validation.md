# Public tracker validation

Source: public `unbraind/pm-csv`, main commit
`d5dbdb0a52e3e25ee79d95b98cf0b7585cd5602d`.

A Git archive of `.agents/pm` was extracted to a non-git scratch directory, then
all source files and directories were made read-only. The SDK certified all
120 items through `listAllComplete`; 24 titles/priorities were selected. Every
sixth input priority was changed to 9 to exercise deterministic rejection. The
separate destination was a disposable non-git tracker. Git was absent from
`PATH` during every import/retry.

| Measurement | Result |
| --- | ---: |
| Public items read with completeness proof | 120 |
| Selected input rows | 24 |
| Initial imported / rejected | 20 / 4 |
| Corrected rejected rows imported | 4 |
| Unchanged corrected rows replayed / newly imported | 4 / 0 |
| Original successful histories unchanged | 20 / 20 |
| Initial imported cell lineage records | 40 |
| Disallowed columns excluded | 1 / 1 |
| Exact-byte artifact checksums verified | 2 / 2 |
| Initial JSON receipt | 129 bytes |
| Import, correction, replay and integrity checks | 10,166 ms |
| Read-only source snapshot unchanged | yes |

Reproduce using a read-only public tracker copy:

```sh
node scripts/validate-row-lineage.ts "$PUBLIC_TRACKER_COPY"
```

The script hashes the entire source before and after, checks its read-only
permissions, certifies complete SDK reads, creates a fresh non-git target,
validates the import and corrected retry, verifies successful history bytes,
checks file checksums and excluded-column sentinels, and prints aggregate JSON.
It removes only its disposable target. No public source item content is included
in this report. Timing measures this run and does not establish throughput.

Behavioral revert proofs (`node --test --test-name-pattern='cell lineage excludes' test/lineage.test.ts`):

- Reverting only `importLineage`'s rejected-row filter to include successful rows
  failed the receipt/retry assertion (2 rejected instead of 1).
- Reverting only that function's allowed-column projection to copy raw rows
  failed the excluded-column sentinel assertion.

Both controls were restored. The regular targeted suite passes with the
production implementation; CI supplies the full npm and Bun release evidence.

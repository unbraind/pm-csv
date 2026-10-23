# pm-cli 2026.10.20 compatibility

Dependabot [PR 177](https://github.com/unbraind/pm-csv/pull/177) updates the
development host from 2026.10.15 to 2026.10.20. Its original Node 22 and Node 26
CI jobs failed three tests. The priority-99 row errors in those logs are
deliberately injected invalid inputs, not unexpected update failures.

| Failure | Root cause | Adaptation |
| --- | --- | --- |
| Malformed SDK journal identities | The SDK now distinguishes `transaction_journal_invalid` from a valid journal that mismatches the plan. pm-csv depended on the older combined diagnostic and decoded bindings before validating the schema and transaction identity. | Validate both identities before using bindings or entering the coordinator; throw a host-recognized `CommandError`. Keep the original plan-mismatch refusal and prove every fixture byte stays unchanged. |
| Partial create/update command and importer failures | The tests read `priority` from default brief list rows. `--all` selects statuses, independently of projection, on the new host. | Request `--full` in the verification reads. Keep the exact error counts, continuation, priority and absence assertions. Production complete-list readers already request `--output-include full` and certify completeness. |
| Legacy CLI parity without git | The same brief-row assumption in a real CLI verification read. | Request `--full`; retain both command spellings, streaming and buffered imports, a PATH without git, dry-run snapshots and nonzero failure assertions. |

## Version evidence

Read release notes for 2026.10.17 through 2026.10.20. There is no v2026.10.16
release; v2026.10.17 covers the source range starting at v2026.10.15.

- [2026.10.17](https://github.com/unbraind/pm-cli/releases/tag/v2026.10.17)
  adds SDK bulk creation. Its
  [implementation](https://github.com/unbraind/pm-cli/commit/94757af3016420bfda6b6fc1905be7814ee2ea1d)
  separates invalid journals from plan mismatches in
  `src/sdk/workspace-transaction.ts`.
- [2026.10.18](https://github.com/unbraind/pm-cli/releases/tag/v2026.10.18)
  documents GH-1489, keeping all-status selection independent of projection.
- [2026.10.19](https://github.com/unbraind/pm-cli/releases/tag/v2026.10.19)
  adds encoding aliases; [2026.10.20](https://github.com/unbraind/pm-cli/releases/tag/v2026.10.20)
  preserves JSON row facts and compacts default brief TOON envelopes. Neither
  promises priority in a brief list row.

Real installed-host probes in fresh non-git trackers confirmed:

| Host | Default `list --all --json` priority | With `--full` | Bad journal schema |
| --- | --- | --- | --- |
| 2026.10.15 | 2 | 2 | journal does not match the supplied plan |
| 2026.10.20 | omitted | 2 | journal is invalid (schema version or transaction id does not match the journal file) |

Both hosts rejected priority 99 with exit 2 and accepted priority 2. No upstream
regression was established by these failures, so no new upstream issue draft
is needed.

## Regression proof

The focused command is:

```sh
npm run build && npm run build:test && node --test --test-name-pattern="malformed SDK journal|partial create/update|legacy CSV CLI" test/atomic-update.test.ts test/commands.test.ts test/legacy-import-cli.test.ts
```

It passes 3/3 with the pinned host on PATH. The journal test covers malformed
step shapes, missing/unsupported schemas and missing/foreign transaction ids in
source and built code. It asserts refusal before coordinator entry and compares
all fixture file bytes, including item history and the journal itself.

Reverting only `loadAtomicBindings` to the PR's original implementation and
rebuilding makes the journal regression fail 0/1 at the behavioral assertion
`invalid journal identity must refuse before coordinator entry` (`true !== false`).
Restoring the function makes it pass. No refusal expectation was weakened.

## Lease fencing assessment (no pin or workaround change)

[pm-cli 2026.10.23](https://github.com/unbraind/pm-cli/releases/tag/v2026.10.23)
includes [GH-1549](https://github.com/unbraind/pm-cli/issues/1549), implemented in
[PR 1550](https://github.com/unbraind/pm-cli/pull/1550). Native item mutations
fence their commit against lease takeover and changed item bytes. The public
`acquireLockLease` primitive also lets extensions fence their own commits.

A real unguarded SDK probe with a one-second lease and a newer writer committing
after expiry overwrote the newer title on 2026.10.20. The same probe on
2026.10.23 refused the stale writer and preserved the newer title. This supports
removing the callback-only `csv_lease_expired` mitigation for native mutation
paths once the supported host floor is raised and SDK/CLI takeover regressions
are migrated to the host's typed refusal. Extension-provided lock overrides
still own their fencing contract; the upstream implementation cannot fence
those providers automatically. The current peer floor and development pin still
need the mitigation, so `lease-guard.ts` remains unchanged.

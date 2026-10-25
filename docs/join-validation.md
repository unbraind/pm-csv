# Join-plan validation

## Reproducible targeted checks

- `npm run build && npm run build:test`
- `node --test test/join-plans.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm run duplicates`
- `npm run docstring`
- `node scripts/validate-join-plans.ts <read-only-public-tracker-copy>`

The join state-model test uses seed IDs 1–500 and 4,000 operations over sixteen
persistent target/reference tracker pairs. The native reference transition is
create-once at an absent identity, preserve current state on replay, and apply
explicit native edits through the SDK. All supported mapped scalar fields, body,
parent and dependency values are read back through the SDK on both sides. No
hand-written whitespace or field normalization defines the expected state.
Random custom status registries include active, blocked, done and canceled roles.
CSV fixtures vary surrounding whitespace and quoted CRLF/LF content. Older plans,
changed source bytes, native edits and repeated inputs are included.

Interleaving tests use one real non-git tracker and native competing writers at
every emitted forward SDK transaction transition and internal inspected,
before-dependency and before-create boundary. They cover identical peer success,
foreign collisions, dependent skips, removed targets, missing durable state,
interruption and retained creates after failed compensation. No SDK mocks are used.
The built CLI is also run with only Node and pm on PATH, using real JSON and TOON
rendering. Input and output fuzz cases include sparse arrays, extra keys, wrong
primitive types, size bounds, nonfinite numbers and fractional/out-of-range values.

Behavioral revert: disable only the external-key-to-native-edge resolution in
`compile`. The three-table regression fails because its SDK-read parent is absent.
Restoring the resolver restores the pass. This checks persisted behavior rather
than a parser snapshot or an implementation mirror.

## Public-data measurement

Source: public `unbraind/pm-csv` main commit
`ec5b50f55e68a6b4be95ef50640fdfe158f8273c`, copied to an immutable
non-git directory. The source repository's public visibility was checked before
copying. The validator removes Git from PATH, checks complete-list certification,
checks read-only permissions and hashes every source file before and after.
Only aggregate results are retained here.

| Measurement | Result |
| --- | ---: |
| Public tracker items / selected rows | 127 |
| Selected tables | 3 |
| Resolved native parent target keys | 19 |
| Resolved native dependency target keys | 0 |
| CSV bytes | 40,833 |
| Compact JSON receipt bytes | 114 |
| Full source-bearing plan bytes | 46,193 |
| Coordinates for an injected duplicate | 2 |
| Tracker writes | 0 |
| Source hash changed | No |
| Git executable available | No |

For this read-only measurement, parent targets are expressed as explicit
cross-table dependency lookup columns, allowing each sparse column to name its
target table. Exact parent semantics and native dependency kinds are verified
separately by the three-table mutation fixture and native model comparisons.
This measurement is a preview/import-plan validation; it does not mutate the
public tracker or certify every older CSV workflow.

## Host boundaries

The package retains its pinned pm SDK. Its create lifecycle currently accepts
`completedAt` only for the configured close status, even when another configured
status has a terminal role. The package delegates native lifecycle validation to
that SDK and returns an actionable apply refusal on unsupported native policies.
The pre-existing item-write lease-fencing limitation is tracked by
`pm-csv-sdk-write-fence`. Local global-extension health can also report the
pre-existing pm-github host-version skew (`pm-csv-sdyz`); isolated-global health
passes. No global installation or dependency pin is changed by this feature.

Full release acceptance is supplied by the unchanged npm and Bun CI release
checks, including every coverage dimension and packed-package acceptance.

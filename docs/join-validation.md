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

## Ambient-state review regressions

The shared mutation builder is exercised through joins, lineage, standard CSV,
streaming CSV, atomic CSV, schema imports, native spreadsheet patches and
compensation. Creates explicitly suppress ambient defaults; absent or empty keyed-update cells preserve existing state. Native
patch/restore callbacks preserve unselected current scope under the item lock.

The 500-sequence model now randomizes target focus before preview, changes it
between preview and apply, and changes focus and working directory during retry.
Each of sixteen non-git tracker/model pairs uses three ambient items and two
working directories. Source assignment and planning cells alternate between
empty and explicit values. SDK readback matches the independent reference;
changing ambient state adds no parent or dependency links. Previously created
owned records containing unreviewed parent, assignment, planning or resource
links refuse replay.

Refusal regressions cover unterminated quotes, ragged rows, bare/mixed line
endings, invalid UTF-8/JSON and arbitrary lower-layer failures. Both public join
APIs always expose `JoinRefusal`, retaining lower refusal codes/remedies and causes.

Two behavioral revert proofs were run independently: removing the builder's
parent unset makes the focus-change regression fail, and removing only the
public preview refusal wrapper makes the malformed-CSV instance assertion fail.
Both tests pass when their changed functions are restored. Targeted native
recovery tests also pass, including compensation and a competing writer.

## Keyed-update column ownership re-review

Legacy keyed updates now own only nonempty supported CSV cells. Absent headers
and empty cells preserve current values, native links and dependency edges;
`none`/`null` retain native explicit-clear semantics for supported nullable scope fields.
Creates still unset absent scope through the shared builder. Body cells retain
source whitespace until the SDK applies its native normalization. README and
import command help describe this ownership contract, additive tags/blockers,
and export-only custom fields.

`test/column-ownership.test.ts` reproduces the title-only review case and tests
all twelve supported import headers as keys, plus native ID, foreign and custom
keys. Its deterministic seeds 1–500 each perform four transitions: a random
subset import, an unchanged native/custom-field export/import, explicit edits,
and replay of an older input. Standard, streaming and atomic mutations use real
non-git trackers with only Node and the pinned pm executable on PATH. Reference
state evolves independently through native SDK updates. The model reads complete
SDK documents, including custom objects and resource links; comparisons exclude
only generated mutation/edge clocks. Silent dependency records also receive a
byte-for-byte assertion, including their original provenance and timestamps.
Atomic transaction ownership tags are modeled explicitly with the public
transaction-ID API. No source-value normalization is implemented in the oracle.

The behavioral revert replaces only `appendRelationalArgs` with the clearing
implementation from the previous head. The fixed review case fails the silence
law, losing parent, assignment, planning values and the dependency edge. Restoring
the changed function makes that regression pass.

## Native clear-alias review

The intent builder recognizes both native `none` and `null` command aliases for
all eight scope scalars and dependency/file/doc/test collections, including case
and surrounding-whitespace variants. It emits explicit SDK unsets/clear flags;
stored snapshots preserve literal strings and omitted patch fields remain silent.

`test/scope-aliases.test.ts` exhaustively compares every scalar and linked
collection against an independent native SDK create/update oracle in non-git
trackers. It checks snapshots and silent patches, joins and retries, lineage
replay, standard/streaming/atomic/schema imports, and real JSON/TOON CLI receipts.
The existing 500-seed ambient-state model also varies assignment/planning clear
aliases. Packed npm-current, Bun-current and minimum-host acceptance exercise
join apply/retry and lineage clear aliases, then read scope through each installed
host's SDK. Mixed alias/concrete collection inputs retain native refusal behavior.


Native input replay uses the public SDK parent-reference and relationship-ID
normalizers, sprint/release validation and document canonicalization. Every shared
scope comparison receives the tracker settings explicitly. Raw parent aliases are
never compared directly with persisted IDs, and expected dependency IDs use the
same SDK reference normalizer. Older supported hosts that store trimmed parent
spellings use their public parent-value normalizer; dependency IDs still follow
that host's ID normalization. Packed oracles compare against native create/get
on each installed host, including the minimum version. Edit sessions canonicalize their desired stored
values with `canonicalDocument`, including leading blank body lines; they do not
interpret command clear aliases.

`test/native-replay.test.ts` covers the exact bare-parent atomic retry, all twelve
legacy import fields across atomic/standard/stream/schema paths, native remote
locators, hash/case/prefix variants, whitespace, Unicode and sentinels. Seeds
1..500 import and replay both joins and lineage (1000 successful replayed rows),
comparing full SDK documents and immutable histories with their post-import model.
The installed npm/Bun/minimum-host acceptance also repeats an atomic bare-parent
import in JSON and TOON and replays a body edit, checking native SDK reads/history.

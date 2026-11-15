# Fleet CI v2 pilot

The two required checks remain `test (22)` and `test (26)` on GitHub-hosted
runners. Only PRs and manual dispatch start this tier. Superseded PR runs cancel.
Docs/tracker-only PRs keep both checks green by running their applicable gates.
There is no standalone markdown linter in this package. The cheap path runs
the existing packaging/documentation, shipped-changelog and identity suites.
The executable `.agents/pm/verify-release-yaml.mjs` selects the code path even
though it lives under the tracker root. CodeQL runs once in
its own workflow; its table row describes triggers, not an extra matrix job.

| Check | Code PR Node 22 | Code PR Node 26 | Docs/tracker-only PR (both) | Deep Node 22 + 26 |
| --- | --- | --- | --- | --- |
| npm ci / prepare merge drivers | yes | yes | yes | yes |
| Strict tracker health / merge drivers | — | yes | yes | yes |
| Release workflow verification | — | yes | — | npm + Bun gates |
| Build + test suite | quick | quick via coverage | — | full, npm + Bun |
| Typecheck, lint, duplicates, docstrings | — | yes | — | npm + Bun gates |
| Coverage, unchanged 100% lines/branches/functions | — | quick | — | full, npm + Bun |
| Production audit, pack dry-run | — | yes | — | npm + Bun gates |
| Packed consumer acceptance | via tests | via tests + gate | — | npm + Bun gates |
| README/docs, shipped-changelog and commit identity contracts | via tests | via tests | yes | npm + Bun gates |
| Changelog consistency | — | yes | yes | npm + Bun gates |
| Publish attestation / changelog date verification | — | yes | — | npm + Bun gates |
| Bun package-graph install | — | yes | — | yes |
| CodeQL | matching paths, separate workflow | matching paths, separate workflow | path-filtered | separate weekly scan |

Deep runs on main pushes, daily at 02:47 UTC, and manual dispatch. It never
blocks PRs. Its checks are named `deep (22)` and `deep (26)` so manual branch
runs cannot match the required PR check names. Local jobs queue even when local slots are busy; the fleet controller
sets `PM_LOCAL_DEEP=off` only after no local host has been reachable for ten
minutes. The fallback is GitHub-hosted. Deep concurrency cancels older runs of
the same ref and the pilot job timeout is 240 minutes. This is a measured exception to the
120-minute fleet baseline: full coverage alone took 80m 40.58s on the shared
host, so two full gates need over 161 minutes before packing or other checks. Release remains at 03:23 UTC;
weekly CodeQL remains at 03:17 UTC on Monday, including lockfile-only changes.

`runs-on` is resolved when a job is queued, so switching `PM_LOCAL_DEEP` to `off`
affects only runs queued afterwards. Deep runs already waiting for a `pm-local`
runner would otherwise stay queued until GitHub fails them after 24 hours. The
fleet's local-runner controller recovers them in the same fallback step: it
cancels every queued `CI Deep` run of the repository, then dispatches one
`ci-deep.yml` run on `main`, which resolves to `ubuntu-latest`. One run on the
newest main covers the cancelled ones, because each deep run tests a whole
commit and the concurrency group already keeps only the latest. When a local
host answers again, the controller sets `PM_LOCAL_DEEP=on`, and later runs
queue locally. No operator step is needed. To recover by hand, cancel the queued
run and run `gh workflow run ci-deep.yml --ref main` while the variable is `off`.

`PM_TEST_DEPTH=quick` selects the first 50 of each existing 500-case deterministic
sequence. `full`, an unset variable, and any unrecognized value keep full depth.
The helper uses one tenth (rounded up), with a floor of 25 capped by the original
count. Batch sizes and seed generation stay unchanged; the last batch can be
partial. All per-case assertions remain. Plain `npm test`, `prepublishOnly` and
the release gate remain exhaustive unless their caller explicitly opts in.

The local-runner pilot (#254, run 43623045892) failed on both Node versions
because column ownership exceeded its fixed 2,400,000 ms test timeout. Individual
job logs confirmed this as the only failing test; `gh --log-failed` returned no
content. Seeded corpus tests now terminate by seed and transition counts, with
the workflow guarding total job time. Those tests do not prove a latency SLA.
The packed acceptance wrapper also drops its fixed ten-minute harness deadlines;
its host/scenario and receipt counts bound the work. No product time contract
needed scaling, so no `PM_TEST_TIME_SCALE` was added.

`accept:packed` already installs the tarball using Bun project and global
installs and the bunx ephemeral host CLI, then exercises CSV operations. It also
covers npm/npx and minimum/development host versions. The PR gate therefore needs
only `bun install --no-save` afterwards, not another Bun release gate. The packed
acceptance test and standalone gate are both retained as requested; these are a
remaining source of duplication within the existing gate. The requested Node 22
`npm test` also retains that embedded packed fixture; it has no separate coverage,
changelog or pack command. This documented exception preserves its complete test
suite without a second skip control.

## Applying this to another package

1. Create a package-owned Task tagged `ci,performance`, link the companion item,
   and work in a fresh branch/worktree. Inspect open work and reserve files owned
   by other changes before editing.
2. Read `package.json` scripts, coverage source scope/thresholds, engine floor,
   test runner, packed acceptance, and workflow contract tests. Inventory every
   check in the current release gate; use the table above as a checklist, not an
   assumption about the sibling's scripts.
3. Search tests with `rg -n 'seed|random|for .*<[=]?|length:|timeout|Date.now|performance.now' test`.
   Replace `test` with the suite directories found in package scripts. Read CI
   job timing/logs and test durations to rank expensive suites. Separate
   fixed memory/row-boundary fixtures from repetitive property corpora: do not
   shrink a million-row memory-contract test merely because its count is large.
4. Copy the tiny depth helper. Replace every large property-loop count, keeping
   seed expressions and batch sizes identical. Update expected counts and
   diagnostics. Support a partial final batch and retain all assertions. Default
   depth must be full. Remove machine-speed deadlines from finite corpora; use
   operation budgets. Scale only real product time contracts with a documented
   env factor when necessary.
5. Run quick coverage at the original thresholds. Turn late-seed-only branches
   into small explicit deterministic regression cases; never weaken thresholds
   or add exclusions. Run full coverage separately on the same host and record
   both complete command wall times and host contention caveats.
6. Copy the PR workflow's concurrency, hosted routing, Node 22/26 required job
   names, full checkout and NUL-safe base...head change detection with rename folding
   disabled (source-to-docs moves must retain the source deletion) as fixed
   template. Audit tracker roots for executable code (the pilot exempts its release verifier
   from the cheap allowlist). Adapt the embedded docs/identity test commands,
   Node floor, release gate
   and Bun smoke to the package. Inspect packed acceptance before omitting an
   extra bunx smoke. Even the engines-floor tests may require Bun setup when
   the suite runs packed acceptance internally.
7. Copy the deep workflow triggers, controller-owned runner expression,
   per-ref cancellation, explicit full depth, and npm/Bun
   matrix gates. Start with the 120-minute timeout baseline; measure both full
   gates and document any larger package-specific bound (this pilot needs 240).
   Pick a per-repository off-peak cron minute distinct from its
   release and CodeQL schedules. Never add a PR trigger or required deep check.
8. Copy CodeQL tracker/docs/lockfile path exclusions on push and PR, retain its
   weekly schedule and pinned actions, and use PR cancellation. Adapt lockfile
   names if the sibling has additional lockfiles.
9. Run typecheck, lint, touched tests, quick/full coverage, changelog check and
   the quick release gate. Run actionlint if installed, otherwise parse YAML and
   record that narrower validation. Link and execute tests through pm as well.
10. Wait for the shared dispatch hold, verify commit identity/privacy, push and
    open the PR. Measure jobs API `created_at` to `completed_at` for both required
    checks, including queueing; investigate and fix any result above 15 minutes.
    Record execution-only time separately if useful. Attempt branch dispatch of
    the deep workflow once; a new workflow absent on main may refuse dispatch.
    Report that refusal without a workaround. Release the tracker claim; leave
    the item open and let the orchestrator handle reviews and merge.

Before each push, honor the shared dispatch hold:

```sh
while [ -f ~/.cache/fleet-dispatch-hold ] && [ "$(cat ~/.cache/fleet-dispatch-hold)" -gt "$(date +%s)" ]; do
  sleep 60
done
```

For queue-inclusive measurements, read the jobs rather than only step durations:

```sh
gh api repos/OWNER/REPO/actions/runs/RUN_ID/jobs --paginate \
  --jq '.jobs[] | {name, created_at, started_at, completed_at}'
```

# Pinned Daily Release rollout

This package delegates release execution to pm-ops v2026.11.14 at
`7687a35d7522482bd8361d60dbc2589e9afbc81c`. The package uses the matching
released pm-ops validator and explicitly permits empty changelog sections in
generation, checking and release notes. Dependabot covers the SHA through its
root github-actions ecosystem.

Package-owned inputs: `{"reconcile-only":"${{ (github.event_name == 'schedule' && github.event.schedule == '41 * * * *') || inputs.retire-unpublished == true }}","retire-unpublished":"${{ github.event_name == 'workflow_dispatch' && inputs.retire-unpublished == true }}","release-enabled":"${{ github.ref == 'refs/heads/main' }}","alert-script":"release:alert"}`. Existing daily schedules
are retained, with canonical hourly reconciliation where scheduled releases exist.

Cross-repository npm OIDC was proven by the merged pm-jira pilot in
[run 43639146392](https://github.com/unbraind/pm-jira/actions/runs/43639146392),
as recorded on [pm-ops #272](https://github.com/unbraind/pm-ops/issues/272#issuecomment-6884325024).
The npm trusted publisher names this package repository and its own release.yml.
The first release run must still pass Verify npm will accept this workflow's OIDC identity.
Only the orchestrator merges, dispatches and verifies publication.

The caller contracts replace assertions about removed private release implementation.
Implementation behavior belongs to the pinned pm-ops release harness. Package-owned
approval, script and permission contracts remain checked locally.

Round 2 preserves package changelog and publication checks independently of the
shared release implementation. Obsolete copied-workflow verifiers, planners and
mutation helpers are retired where present; active package hooks remain tested.
Coverage thresholds are unchanged. Package-specific restored tests and exact gate
receipts are recorded in the rollout tracker item.

## Runtime-version preparation

The released shared stamper recognizes `defineExtension` descriptors, while this package exports a plain object. `prepare-script: release:prepare` now invokes `scripts/prepare-release-version.ts` after package/manifest stamping and before the shared build. It validates metadata parity and exactly one package-owned target before writing.

`node --test test/release-runtime-version.test.ts test/release-workflow.test.ts` proves an isolated `2099.1.2-3` build has matching package, manifest and built default-export versions. Removing only the caller preparation input makes the scratch-build test fail on the stale runtime assertion; the input is restored after the proof. The latest npm tarball inspected in this audit was `2026.11.13` and its runtime and manifest matched that version.

The fleet-wide audit and exact registry receipts are in pm-graph’s `docs/release-runtime-stamping-audit.md`; the other affected callers are pm-context, pm-csv and pm-graph.

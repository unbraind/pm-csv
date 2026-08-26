#!/usr/bin/env bash
# Open or update the single deduplicated Daily Release failure tracking issue.
#
# Invoked by the alert-on-release-failure job of .github/workflows/release.yml
# and exercised hermetically by test/alert-on-release-failure.test.ts through a
# stub `gh`, so CI asserts the same bytes the workflow executes.
set -euo pipefail
run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT
{
  echo "The \`release\` job of the Daily Release workflow failed."
  echo ""
  echo "- Failing job: \`release\`"
  echo "- Run URL: ${run_url}"
  echo "- Commit: ${GITHUB_SHA}"
  echo "- Date (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$body"
# Deduplicate by the fixed marker label and stable title. A failed lookup is
# not evidence that no issue exists, so skip alerting rather than risk opening
# a duplicate after a transient GitHub API failure.
if ! existing_number="$(gh issue list \
  --repo "${GITHUB_REPOSITORY}" \
  --state open \
  --label release-failure \
  --search "Daily Release workflow is failing in:title" \
  --json number --jq '.[0].number // empty' 2>/dev/null)"; then
  echo "::warning::Could not determine whether a release-failure tracking issue is already open; skipped alerting to avoid opening a duplicate."
  exit 0
fi
if [[ -n "$existing_number" ]]; then
  if gh issue comment "$existing_number" \
    --repo "${GITHUB_REPOSITORY}" \
    --body-file "$body"; then
    exit 0
  fi
else
  gh label create release-failure \
    --repo "${GITHUB_REPOSITORY}" \
    --description "Daily Release workflow failures" \
    --color D93F0B >/dev/null 2>&1 || true
  if gh issue create \
    --repo "${GITHUB_REPOSITORY}" \
    --title "Daily Release workflow is failing" \
    --label release-failure \
    --body-file "$body"; then
    exit 0
  fi
fi
echo "::warning::Could not open or update the release-failure tracking issue; see gh output above."

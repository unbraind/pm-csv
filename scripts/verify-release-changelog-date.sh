#!/usr/bin/env bash
# Proves an untagged release's changelog heading comes from the calendar
# version rather than from the clock, and that every generator invocation in
# this package asks for that.
#
# Why this exists separately from `npm run changelog:check`: that script only
# exercises the package.json invocation. `.github/workflows/release.yml` calls
# pm-changelog directly. If either side lost --date-from-version the two would
# disagree during a release -- one heading derived from the clock, the other
# from the version -- and the release would fail on the divergence rather than
# on the stale date the flag exists to remove.
set -euo pipefail
cd "$(dirname "$0")/.."
status=0

# 1. Static invariant: every generator invocation, in every tracked file, asks
#    for the version-derived date. Enumerated rather than assumed, because the
#    invocation lives in more places than the scripts named changelog*.
#
#    Balanced PER LINE, not across the file. Two different ways to hide an
#    unflagged invocation have to be closed at once, and each defeats the fix
#    for the other:
#      - counting matching LINES misses a single line that carries several
#        invocations where only one is flagged;
#      - counting OCCURRENCES file-wide lets an unflagged invocation hide
#        behind a mention of the flag on some other line that invokes nothing
#        at all -- a comment, a help string, a sibling script.
#    Requiring each line to carry at least as many --date-from-version as it
#    carries --release-version-from-package closes both.
#
#    Candidate files are enumerated rather than pre-filtered by grep, because a
#    workflow that delegates to `npm run changelog:*` mentions the flags only
#    in comments explaining why. Selecting such a file and then finding no
#    invocation in it is normal, not a failure; what would be a failure is
#    finding no invocation anywhere.
total_sites=0
for file in $(git ls-files -- package.json '.github/workflows/*.yml' '.github/workflows/*.yaml'); do
  sites=0
  bad=0
  while IFS= read -r line; do
    case "${line#"${line%%[![:space:]]*}"}" in "#"*) continue;; esac  # a mention in a comment invokes nothing
    # Occurrences, not matching lines: `grep -c` would score a line holding two
    # invocations as 1. `grep -o` exits 1 on no match, which `set -o pipefail`
    # would turn into an abort with no output, so that status is absorbed.
    n=$(printf '%s\n' "$line" | grep -o -- --release-version-from-package | wc -l || true)
    if [ "${n:-0}" -eq 0 ]; then continue; fi
    f=$(printf '%s\n' "$line" | grep -o -- --date-from-version | wc -l || true)
    f=${f:-0}
    sites=$((sites + n))
    if [ "$f" -lt "$n" ]; then
      bad=$((bad + 1))
      echo "FAIL: $file: $n generator invocation(s) on one line but only $f carry --date-from-version: $(printf '%s' "$line" | cut -c1-120)" >&2
    fi
  done < "$file"
  total_sites=$((total_sites + sites))
  if [ "$sites" -eq 0 ]; then
    echo "ok - $file: no generator invocation (it delegates, or mentions the flags only in comments)"
  elif [ "$bad" -gt 0 ]; then
    status=1
  else
    echo "ok - $file: $sites generator invocation(s), each individually flagged"
  fi
done
if [ "$total_sites" -eq 0 ]; then
  echo "FAIL: no generator invocation was found in any tracked file - the scan is looking in the wrong place" >&2
  status=1
fi

# Scope note: only files that EXECUTE the generator are in scope -- package.json
# scripts and the workflows. Source, docs, dist and test fixtures may mention
# the same flags while describing or exercising them, and holding those to an
# "every mention is flagged" rule would be a false positive (it is, in
# pm-changelog's own repository, which documents both spellings on purpose).

# 2. Behavioural: the flag is what makes the date version-derived. A probe
#    version deliberately unequal to today, so a clock-derived heading and a
#    version-derived heading cannot coincide and the assertion discriminates.
probe=2026.1.2
expected="## ${probe} - 2026-01-02"
today_heading="## ${probe} - $(date -u +%Y-%m-%d)"
# In pm-changelog's own repository the generator is the build output, not a
# dependency, so resolve it in that order rather than assuming node_modules.
if [ -x ./node_modules/.bin/pm-changelog ]; then bin="./node_modules/.bin/pm-changelog"
elif [ -f ./dist/cli.js ]; then bin="node ./dist/cli.js"
else bin="npx pm-changelog"; fi
# The generator refuses a truncated workspace read rather than silently
# omitting entries, so the unbounded controls the real scripts pass are
# required here too.
common=(--pm-root .agents/pm --stdout --pm-bin ./node_modules/.bin/pm
        --pm-arg=--output-budget --pm-arg=unbounded
        --pm-arg=--output-limit --pm-arg=unbounded
        --release-version "$probe")

with_status=0
with=$($bin "${common[@]}" --date-from-version 2>&1) || with_status=$?
without_status=0
without=$($bin "${common[@]}" 2>&1) || without_status=$?
with_heading=$(printf '%s\n' "$with" | grep -m1 '^## ' || true)
without_heading=$(printf '%s\n' "$without" | grep -m1 '^## ' || true)

if [ "$with_status" -ne 0 ]; then
  echo "FAIL: the flagged generator invocation exited $with_status: $(printf '%s' "$with" | head -1)" >&2; status=1
elif [ "$with_heading" != "$expected" ]; then
  echo "FAIL: with --date-from-version expected '$expected', got '$with_heading'" >&2; status=1
else
  echo "ok - with the flag the heading is version-derived: $with_heading"
fi

# The unflagged run is the control: it is what proves the flag is doing the
# work rather than the heading happening to be right for another reason. A
# control that silently failed to run would leave the comparison meaningless,
# so its exit status and its heading are both required -- previously both were
# swallowed by `|| true` and a failure downgraded to a note.
if [ "$without_status" -ne 0 ]; then
  echo "FAIL: the unflagged control invocation exited $without_status, so the comparison proves nothing: $(printf '%s' "$without" | head -1)" >&2; status=1
elif [ -z "$without_heading" ]; then
  echo "FAIL: the unflagged control invocation produced no '## ' heading, so the comparison proves nothing" >&2; status=1
elif [ "$without_heading" != "$today_heading" ]; then
  echo "FAIL: without the flag expected the clock-derived '$today_heading', got '$without_heading' - the control is not measuring the clock" >&2; status=1
else
  echo "ok - without the flag the heading is clock-derived: $without_heading (this is the defect the flag removes)"
fi
exit $status

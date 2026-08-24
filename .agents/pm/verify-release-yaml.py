"""Verify the release workflow alert job is wired correctly.

Checks that release.yml parses as YAML and that the
alert-on-release-failure job triggers on failure of the release job, checks out
the tracked alert script without credentials, and grants only read plus issue
write permissions.
"""

import yaml

with open(".github/workflows/release.yml", encoding="utf-8") as handle:
    workflow = yaml.safe_load(handle)

jobs = workflow["jobs"]
assert "alert-on-release-failure" in jobs, "missing alert-on-release-failure job"
alert = jobs["alert-on-release-failure"]
assert alert["if"] == "failure()", f"unexpected if: {alert['if']!r}"
needs = alert["needs"]
needs = [needs] if isinstance(needs, str) else list(needs)
assert needs == ["release"], f"unexpected needs: {needs!r}"
assert alert["permissions"] == {"contents": "read", "issues": "write"}, (
    f"unexpected permissions: {alert['permissions']!r}"
)

steps = alert["steps"]
assert any(
    step.get("uses", "").startswith("actions/checkout@")
    and step.get("with", {}).get("ref") == "${{ github.event.repository.default_branch }}"
    and step.get("with", {}).get("persist-credentials") is False
    for step in steps
), "alert job must check out the default branch without persisted credentials"
assert any(
    "scripts/alert-on-release-failure.sh" in (step.get("run") or "")
    for step in steps
), "alert job must execute the tracked alert script"
with open("scripts/alert-on-release-failure.sh", encoding="utf-8") as handle:
    script = handle.read()
assert "release-failure" in script, "dedup marker label missing from alert script"

print("release.yml alert job verified")

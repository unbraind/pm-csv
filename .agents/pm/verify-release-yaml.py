"""Verify the release workflow alert job is wired correctly.

Checks that release.yml parses as YAML and that the
alert-on-release-failure job triggers on failure of the release job with
only issues:write permissions.
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
assert alert["permissions"] == {"issues": "write"}, (
    f"unexpected permissions: {alert['permissions']!r}"
)

steps = alert["steps"]
assert any(
    "release-failure" in (step.get("run") or "") for step in steps
), "dedup marker label not used in the alert script"

print("release.yml alert job verified")

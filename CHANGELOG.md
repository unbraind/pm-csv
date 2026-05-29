# Changelog

## Unreleased

### Added

- Hands-on functional test pass 2026-05-29 \(real data\) ([pm-csv-z5f8](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/features/pm-csv-z5f8.toon))

### Other

- csv export drops body \(no --include-body\) and uses nonexistent due\_date/milestone create flags ([pm-csv-l4vy](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/issues/pm-csv-l4vy.toon))
- csv import/export return error object instead of throwing \(exit 0 on failure\) ([pm-csv-e9v4](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/issues/pm-csv-e9v4.toon))
- csv import --dry-run silently ignored \(still writes\) ([pm-csv-zw3a](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/issues/pm-csv-zw3a.toon))

## 2026.05.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-csv-e9k2](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-e9k2.toon))

## 2026.05.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-csv-0wj8](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-0wj8.toon))

## 2026.05.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-csv-qnmk](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-qnmk.toon))

### Other

- Release readiness hardening for pm-csv ([pm-csv-1pty](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-1pty.toon))

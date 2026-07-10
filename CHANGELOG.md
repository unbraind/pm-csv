# Changelog

## 2026.7.7 - 2026-07-07

### Added

- Deep RFC-4180 import/export + idempotent upsert (SDK 2026.5.31) ([pm-csv-xim5](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/features/pm-csv-xim5.toon))
- Add strict CSV import gate for production data ([pm-csv-z9ad](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/features/pm-csv-z9ad.toon))
- Deepen SDK surface: relational columns, validate, encoding, excel, csv_source schema field ([pm-csv-aoox](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/features/pm-csv-aoox.toon))
- New command: pm csv validate <file\> ([pm-csv-rq5q](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-rq5q.toon))
- Add native csv-export exporter + --columns selection (importer/exporter pair, full SDK importers capability) ([pm-csv-7qh3](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/features/pm-csv-7qh3.toon))
- Hands-on functional test pass 2026-05-29 (real data) ([pm-csv-z5f8](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/features/pm-csv-z5f8.toon))
- Add publish retry + provenance fallback to release workflow ([pm-csv-e9k2](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-e9k2.toon))
- Add bun-install verification to release workflow ([pm-csv-0wj8](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-0wj8.toon))

### Fixed

- Fix release CI ordering (publish-before-tag) ([pm-csv-v4b5](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-v4b5.toon))
- Fix --key dedup duplication (pm tag case-folding) ([pm-csv-bvz5](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-bvz5.toon))
- Command handlers threw plain Error (no exitCode) → runtime double-invocation ([pm-csv-017m](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/issues/pm-csv-017m.toon))
- csv export drops body (no --include-body) and uses nonexistent due_date/milestone create flags ([pm-csv-l4vy](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/issues/pm-csv-l4vy.toon))
- csv import/export return error object instead of throwing (exit 0 on failure) ([pm-csv-e9v4](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/issues/pm-csv-e9v4.toon))
- csv import --dry-run silently ignored (still writes) ([pm-csv-zw3a](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/issues/pm-csv-zw3a.toon))
- ci: fix release workflow step ordering ([pm-csv-qnmk](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-qnmk.toon))

### Other

- Align Node engine with pm CLI runtime ([pm-csv-2thu](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-2thu.toon))
- Regenerate CHANGELOG after pm close item ([pm-csv-137e](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-137e.toon))
- Harden release readiness checks ([pm-csv-wn9s](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/chores/pm-csv-wn9s.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-csv-eio7](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/chores/pm-csv-eio7.toon))
- Import row-filtering (--status/--type/--priority) and custom-field export discovery (--all-fields) ([pm-csv-dk6h](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-dk6h.toon))
- validate exit-code policy ([pm-csv-yhp9](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/decisions/pm-csv-yhp9.toon))
- csv_source persisted as tag, not scalar field ([pm-csv-vp1u](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/decisions/pm-csv-vp1u.toon))
- Which extra pm fields to round-trip ([pm-csv-ry94](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/decisions/pm-csv-ry94.toon))
- Unit tests + functional test with real data ([pm-csv-z5f5](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-z5f5.toon))
- Register csv_source schema field (schema capability) ([pm-csv-w1k3](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-w1k3.toon))
- Export --excel (CRLF + UTF-8 BOM) ([pm-csv-vxz6](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-vxz6.toon))
- Import --encoding (utf-8/utf16le/latin1) ([pm-csv-z3lo](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-z3lo.toon))
- Round-trip parent/assignee/sprint/release/blocked_by columns ([pm-csv-6kyh](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-6kyh.toon))
- Release readiness hardening for pm-csv ([pm-csv-1pty](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-1pty.toon))

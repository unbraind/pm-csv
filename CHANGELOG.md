# Changelog

## 2026.6.9 - 2026-06-09

### Added

- Deep RFC-4180 import/export + idempotent upsert \(SDK 2026.5.31\) ([pm-csv-xim5](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/features/pm-csv-xim5.toon))

## 2026.6.7 - 2026-06-07

### Added

- Add strict CSV import gate for production data ([pm-csv-z9ad](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/features/pm-csv-z9ad.toon))

### Other

- Harden release readiness checks ([pm-csv-wn9s](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/chores/pm-csv-wn9s.toon))
- Align package dependencies to pm CLI/SDK 2026.6.6 ([pm-csv-eio7](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/chores/pm-csv-eio7.toon))

## 2026.6.4 - 2026-06-04

### Other

- Import row-filtering \(--status/--type/--priority\) and custom-field export discovery \(--all-fields\) ([pm-csv-dk6h](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-dk6h.toon))

## 2026.6.2-1 - 2026-06-02

### Added

- Deepen SDK surface: relational columns, validate, encoding, excel, csv\_source schema field ([pm-csv-aoox](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/features/pm-csv-aoox.toon))
- New command: pm csv validate <file\> ([pm-csv-rq5q](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-rq5q.toon))

### Fixed

- Fix --key dedup duplication \(pm tag case-folding\) ([pm-csv-bvz5](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-bvz5.toon))

### Other

- validate exit-code policy ([pm-csv-yhp9](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/decisions/pm-csv-yhp9.toon))
- csv\_source persisted as tag, not scalar field ([pm-csv-vp1u](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/decisions/pm-csv-vp1u.toon))
- Which extra pm fields to round-trip ([pm-csv-ry94](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/decisions/pm-csv-ry94.toon))
- Unit tests + functional test with real data ([pm-csv-z5f5](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-z5f5.toon))
- Register csv\_source schema field \(schema capability\) ([pm-csv-w1k3](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-w1k3.toon))
- Export --excel \(CRLF + UTF-8 BOM\) ([pm-csv-vxz6](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-vxz6.toon))
- Import --encoding \(utf-8/utf16le/latin1\) ([pm-csv-z3lo](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-z3lo.toon))
- Round-trip parent/assignee/sprint/release/blocked\_by columns ([pm-csv-6kyh](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-6kyh.toon))

## 2026.6.2 - 2026-06-02

### Added

- Add native csv-export exporter + --columns selection \(importer/exporter pair, full SDK importers capability\) ([pm-csv-7qh3](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/features/pm-csv-7qh3.toon))

## 2026.6.1 - 2026-06-01

### Fixed

- Command handlers threw plain Error \(no exitCode\) → runtime double-invocation ([pm-csv-017m](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/issues/pm-csv-017m.toon))

## 2026.5.29 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 \(real data\) ([pm-csv-z5f8](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/features/pm-csv-z5f8.toon))

### Fixed

- csv export drops body \(no --include-body\) and uses nonexistent due\_date/milestone create flags ([pm-csv-l4vy](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/issues/pm-csv-l4vy.toon))
- csv import/export return error object instead of throwing \(exit 0 on failure\) ([pm-csv-e9v4](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/issues/pm-csv-e9v4.toon))
- csv import --dry-run silently ignored \(still writes\) ([pm-csv-zw3a](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/issues/pm-csv-zw3a.toon))

## 2026.5.28 - 2026-05-28

### Added

- Add publish retry + provenance fallback to release workflow ([pm-csv-e9k2](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-e9k2.toon))

## 2026.5.27 - 2026-05-27

### Added

- Add bun-install verification to release workflow ([pm-csv-0wj8](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-0wj8.toon))

## 2026.5.26 - 2026-05-26

### Fixed

- ci: fix release workflow step ordering ([pm-csv-qnmk](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-qnmk.toon))

### Other

- Release readiness hardening for pm-csv ([pm-csv-1pty](https://github.com/unbraind/pm-csv/blob/main/.agents/pm/tasks/pm-csv-1pty.toon))

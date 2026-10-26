# Published pm SDK capability floor

Audited main: `ec5b50f55e68a6b4be95ef50640fdfe158f8273c`. Required API floor: **2026.8.18**.

Declared host floor: `2026.8.20`. npm peer: `>=2026.8.20`.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: acquireLock` | 2026.5.14 | 2026.5.12 | [atomic-update.ts:1](../atomic-update.ts#L1), [roundtrip.ts:2](../roundtrip.ts#L2) |
| `@unbrained/pm-cli/sdk :: appendHistoryEntry` | 2026.5.14 | 2026.5.12 | [atomic-update.ts:1](../atomic-update.ts#L1) |
| `@unbrained/pm-cli/sdk :: certifyCompleteListResult` | 2026.8.18 | 2026.8.17 | [index.ts:6](../index.ts#L6) |
| `@unbrained/pm-cli/sdk :: commitWorkspaceTransaction` | 2026.7.19 | 2026.7.18 | [roundtrip.ts:2](../roundtrip.ts#L2) |
| `@unbrained/pm-cli/sdk :: create` | 2026.7.7 | 2026.7.6 | [lineage.ts:4](../lineage.ts#L4) |
| `@unbrained/pm-cli/sdk :: createHistoryEntry` | 2026.5.14 | 2026.5.12 | [atomic-update.ts:1](../atomic-update.ts#L1) |
| `@unbrained/pm-cli/sdk :: getHistoryPath` | 2026.5.14 | 2026.5.12 | [atomic-update.ts:1](../atomic-update.ts#L1), [roundtrip.ts:2](../roundtrip.ts#L2) |
| `@unbrained/pm-cli/sdk :: getWorkspaceContracts` | 2026.5.24 | 2026.5.18 | [table-schema.ts:3](../table-schema.ts#L3) |
| `@unbrained/pm-cli/sdk :: inspectCompleteListResult` | 2026.8.18 | 2026.8.17 | [index.ts:6](../index.ts#L6) |
| `@unbrained/pm-cli/sdk :: locateItem` | 2026.5.14 | 2026.5.12 | [atomic-update.ts:1](../atomic-update.ts#L1), [lineage.ts:4](../lineage.ts#L4) |
| `@unbrained/pm-cli/sdk :: mutateItem` | 2026.7.23 | 2026.7.22 | [lease-guard.ts:1](../lease-guard.ts#L1), [atomic-update.ts:1](../atomic-update.ts#L1), [roundtrip.ts:2](../roundtrip.ts#L2) |
| `@unbrained/pm-cli/sdk :: normalizeItemId` | 2026.5.14 | 2026.5.12 | [lineage.ts:4](../lineage.ts#L4) |
| `@unbrained/pm-cli/sdk :: nowIso` | 2026.5.14 | 2026.5.12 | [atomic-update.ts:1](../atomic-update.ts#L1) |
| `@unbrained/pm-cli/sdk :: parseItemDocument` | 2026.7.23 | 2026.7.22 | [atomic-update.ts:1](../atomic-update.ts#L1) |
| `@unbrained/pm-cli/sdk :: PmCliError` | 2026.5.14 | 2026.5.12 | [edit-refusal.ts:1](../edit-refusal.ts#L1), [lineage.ts:4](../lineage.ts#L4), [table-schema.ts:3](../table-schema.ts#L3) |
| `@unbrained/pm-cli/sdk :: readHistoryEntries` | 2026.7.15 | 2026.7.14 | [atomic-update.ts:1](../atomic-update.ts#L1), [roundtrip.ts:2](../roundtrip.ts#L2) |
| `@unbrained/pm-cli/sdk :: readLocatedItem` | 2026.5.14 | 2026.5.12 | [atomic-update.ts:1](../atomic-update.ts#L1) |
| `@unbrained/pm-cli/sdk :: readSettings` | 2026.5.14 | 2026.5.12 | [atomic-update.ts:1](../atomic-update.ts#L1), [lineage.ts:4](../lineage.ts#L4), [roundtrip.ts:2](../roundtrip.ts#L2) |
| `@unbrained/pm-cli/sdk :: readSettingsWithMetadata` | 2026.7.23 | 2026.7.22 | [index.ts:6](../index.ts#L6) |
| `@unbrained/pm-cli/sdk :: resolveItemTypeRegistry` | 2026.5.14 | 2026.5.12 | [atomic-update.ts:1](../atomic-update.ts#L1) |
| `@unbrained/pm-cli/sdk :: resolveRuntimeFieldRegistry` | 2026.5.14 | 2026.5.12 | [index.ts:6](../index.ts#L6) |
| `@unbrained/pm-cli/sdk :: runWorkspaceTransactionGc` | 2026.7.20 | 2026.7.19 | [index.ts:6](../index.ts#L6) |
| `@unbrained/pm-cli/sdk :: splitFrontMatter` | 2026.5.14 | 2026.5.12 | [atomic-update.ts:1](../atomic-update.ts#L1) |
| `@unbrained/pm-cli/sdk :: verifyHistoryEntries` | 2026.7.24 | 2026.7.23 | [atomic-update.ts:1](../atomic-update.ts#L1), [roundtrip.ts:2](../roundtrip.ts#L2) |
| `@unbrained/pm-cli/sdk :: writeFileAtomic` | 2026.5.14 | 2026.5.12 | [atomic-update.ts:1](../atomic-update.ts#L1) |
| `CommandHandlerContext.args` | 2026.5.1 | 2026.3.12 | [table-schema.ts:252](../table-schema.ts#L252), [table-schema.ts:279](../table-schema.ts#L279), [index.ts:2923](../index.ts#L2923), [index.ts:2926](../index.ts#L2926), [index.ts:2984](../index.ts#L2984), [index.ts:3055](../index.ts#L3055), [index.ts:3159](../index.ts#L3159) |
| `CommandHandlerContext.global` | 2026.5.1 | 2026.3.12 | [index.ts:2943](../index.ts#L2943), [index.ts:2998](../index.ts#L2998), [index.ts:3077](../index.ts#L3077), [index.ts:3174](../index.ts#L3174) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [table-schema.ts:254](../table-schema.ts#L254), [table-schema.ts:256](../table-schema.ts#L256), [table-schema.ts:257](../table-schema.ts#L257), [table-schema.ts:274](../table-schema.ts#L274), [table-schema.ts:275](../table-schema.ts#L275), [table-schema.ts:280](../table-schema.ts#L280), [index.ts:2921](../index.ts#L2921), [index.ts:2922](../index.ts#L2922), [index.ts:2933](../index.ts#L2933), [index.ts:2957](../index.ts#L2957), [index.ts:2959](../index.ts#L2959), [index.ts:2986](../index.ts#L2986), [index.ts:2999](../index.ts#L2999), [index.ts:3063](../index.ts#L3063), [index.ts:3064](../index.ts#L3064), [index.ts:3167](../index.ts#L3167), [index.ts:3168](../index.ts#L3168), [index.ts:3169](../index.ts#L3169), [index.ts:3170](../index.ts#L3170), [index.ts:3171](../index.ts#L3171), [index.ts:3251](../index.ts#L3251) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [table-schema.ts:256](../table-schema.ts#L256), [table-schema.ts:280](../table-schema.ts#L280), [index.ts:2940](../index.ts#L2940), [index.ts:2961](../index.ts#L2961), [index.ts:2962](../index.ts#L2962), [index.ts:2997](../index.ts#L2997), [index.ts:3071](../index.ts#L3071), [index.ts:3251](../index.ts#L3251) |
| `CommandHandlerContext.sdk` | 2026.7.19 | 2026.7.18 | [index.ts:3076](../index.ts#L3076) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [table-schema.ts:242](../table-schema.ts#L242), [table-schema.ts:265](../table-schema.ts#L265), [index.ts:2911](../index.ts#L2911), [index.ts:2949](../index.ts#L2949), [index.ts:2975](../index.ts#L2975), [index.ts:3130](../index.ts#L3130), [index.ts:3135](../index.ts#L3135), [index.ts:3222](../index.ts#L3222) |
| `ExtensionApi.registerExporter` | 2026.5.1 | 2026.3.12 | [index.ts:3277](../index.ts#L3277) |
| `ExtensionApi.registerImporter` | 2026.5.1 | 2026.3.12 | [index.ts:3294](../index.ts#L3294) |
| `ExtensionApi.registerItemFields` | 2026.5.1 | 2026.3.12 | [index.ts:2907](../index.ts#L2907) |
| `ExtensionCommandSdk.commitWorkspaceTransaction` | 2026.7.19 | 2026.7.18 | [index.ts:3076](../index.ts#L3076) |
| `ImportExportContext.args` | 2026.5.1 | 2026.3.12 | [index.ts:3297](../index.ts#L3297) |
| `ImportExportContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:3278](../index.ts#L3278), [index.ts:3296](../index.ts#L3296) |
| `ImportExportContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:3278](../index.ts#L3278) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.12 | `42dcaef84dc441b7792aeffa059bfe10a86ae8b12b1084472229bba03fb29910` |
| 2026.5.14 | `7f7e9131afadb891344bf2fb93b15bc157d18c532a5da4ec31677957d37b7260` |
| 2026.5.18 | `df41d0df1f499a531d6a2cba134defa369870b2fe4b414c0517ef85e7c51db0e` |
| 2026.5.24 | `9d28fff4b06405ea5691ee919ad646c86c0a416a5007ca8104b19251306262af` |
| 2026.7.6 | `0d6e446cf93a0f0660ce4e21943adf1e0c21381010ef67369f40cc9834b8d158` |
| 2026.7.7 | `c455dbda90d6f5aff55b23517683376ea6ab74d4a1540f3f8274590b1687c47e` |
| 2026.7.14 | `4a42de258a3b1cabff1112dd90ae4f3cc272e25ada229d818becae0f2845e128` |
| 2026.7.15 | `1c5d8e7427d74af157577ff58e0692a986016ee355eaf3a6b5ccebca5a9779aa` |
| 2026.7.18 | `44b48fe680cf330254a4ab8d42b55cbcee81ba5cf21e4d4550b40413265d64b9` |
| 2026.7.19 | `513e0aead42767a113a26b8b2e2cbb8a22879d0cb0500d4d3cdd16d21d9f7a39` |
| 2026.7.20 | `6fbc1d789477491e007d03396dbf1dd2f09376220059887faf6f9d50668a6b08` |
| 2026.7.22 | `d013832d6afc97c9a5c6f4a48a497f54a216643f8c7017b9c4f807ce6607532b` |
| 2026.7.23 | `caf1a21b0b587dc55c3509654466dd1e20383e30f2d17b47678887a15a5490af` |
| 2026.7.24 | `ae7757c7e4b02bf5c0908a7bcfd487926912bc2f71332c68c9e1be4017d796ab` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |

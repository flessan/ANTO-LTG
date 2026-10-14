# Curation scripts

The catalogs in `catalogs/` are the source of truth. These scripts are **not** part of the build:
they document, in runnable form, how hand-curated records were assembled from official pages
(every record cites its page and retrieval date in `sources[]`). They are idempotent (they skip ids
that already exist), so you can re-run them, or simply edit `catalogs/*.json` directly and run
`npm run format:catalogs && npm run validate`.

| Script | Adds |
| --- | --- |
| `apps-without-winget.mjs` | apps with no WinGet package: direct download, redirect, landing page only, unavailable |
| `vendors.mjs` | the vendor / OEM directory (`catalogs/vendors.json`) |
| `drivers.mjs` | driver and vendor-tool records plus one support-portal record per vendor |
| `tools-bundles-updates.mjs` | technician tool notes, starter bundles and the updates feed |
| `legacy-notes.mjs` | English text for the short Indonesian-only notes the first catalog carried (a translation, no new claims) |

Rules the scripts follow: only facts that were read on the cited official page; hashes only if the
publisher states them; no version, date or compatibility that the page does not state.

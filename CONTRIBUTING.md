# Contributing to ANTO-LTG

Thank you for helping keep a technician catalog useful **and checkable**. The project's value is its honesty:
every claim cites a source, unknown stays unknown, and a person (not a script) decides what is verified.

*Ringkasan dalam Bahasa Indonesia ada di bagian akhir.*

## Ground rules

1. **Evidence first.** Every fact needs a source you can open: the publisher, the OEM, the project site or an
   official package index. Put it in `sources[]` with the date you read it.
2. **Unknown stays unknown.** If a page does not state a version, date, size, hash, architecture, Windows version or
   package ID, leave it out. Do not infer it from a similar name or a neighbouring record.
3. **Never say "safe".** HTTPS, a checksum, a signature or a famous vendor is not proof that a file is safe, and the
   catalog never says so. Do not write "latest" or "works on Windows N" without a cited source.
4. **Official links only.** Link to the publisher / vendor page. Never add third-party mirrors, file hosts, ad-wrapped
   download sites or aggregator download links. Aggregator listings may be recorded only as clearly labelled leads
   with no download link.
5. **No binaries.** Do not commit installers, drivers, firmware, archives or ISOs. Do not add tokens, credentials or
   personal data.
6. **Hashes are copied, never computed.** Add a `sha256` only if the publisher states it, and say where in
   `sha256_source`.
7. **Leave `verification_status` as `not_reviewed`.** Publication is automatic: the merge rules publish a record when
   they pass, and you must not edit the `publication` object by hand. Only a human who opened the source may set
   `verified`, with `reviewed_at`, `review_notes` and `evidence_url`. If you are that human, say what you checked in
   the pull request.
8. **Be kind.** Disagree about the data, not about people.

## Set up

Node.js 22.12 or newer (`nvm use` reads `.nvmrc`).

```bash
npm ci
npm run serve        # http://localhost:8080 (the pages load JSON, so file:// does not work)
npm run check        # validate + tests + build, and fails if the build changed a committed file
npm run test:e2e     # browser tests; needs Chrome/Chromium (CHROME_PATH=/path/to/chrome)
```

Run `npm run check` before you open a pull request, and `npm run test:e2e` as well if you touched the interface.

## Where things live

| You want to change... | Edit | Then run |
| --- | --- | --- |
| A record (app, driver, vendor, tool, bundle) | `catalogs/*.json` | `npm run format:catalogs && npm run validate && npm run build` |
| The data model | `schemas/*.json`, `scripts/lib/semantic.mjs`, `scripts/lib/catalog-io.mjs`, **and** [`docs/data-model.md`](docs/data-model.md) | `npm run build` (regenerates `openapi.json` and `api/`) |
| A page or its behaviour | `*/index.html`, `assets/js/*.js`, `assets/js/lib/*.js`, `assets/css/*.css` | `npm run validate`, `npm test`, `npm run test:e2e` |
| UI text | `assets/js/i18n/en.js` **and** `id.js`, and the default text in the HTML | `npm test` |
| The shared header and footer | `scripts/templates/*.html`, `PAGES` in `scripts/lib/chrome.mjs` | `npm run build` |
| The crawler | `scripts/crawler/` and `tests/crawler/` | `npm test` |
| An image | `assets/manifest.json` (license and source are mandatory), then the build script below | `npm run build` |

**Never edit by hand:** `api/v1/*`, `openapi.json`, `assets/CREDITS.md`, or the blocks between
`<!--chrome:...:start-->` and `<!--chrome:...:end-->`. They are generated, and `npm run validate` fails when they are
stale.

### Adding or correcting an app

1. Find the **real** WinGet package: `winget search <name>` on Windows, or look for the folder in
   [`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs) (`manifests/<first letter>/<Publisher>/<Package>`).
   Never guess an ID. Prefer the crawler: add the ID under the right category in `scripts/crawler/seeds/winget.json` (one
   category per ID), run `npm run crawl -- winget --ids Publisher.Package`, review `catalogs/proposed/`, then
   `npm run crawl:merge`. An ID that has no manifest folder is reported as `NOT_FOUND`, never added.
2. For software with no WinGet package, add a curated record with a `source_url` on the publisher's domain and a
   `downloads[]` entry whose `kind` is honest (`direct_binary`, `redirect`, `landing_page`, `download_form`).
   A `direct_binary` needs `evidence`.
3. Fill `compatibility` only from what the source declares. Leave `windows_compatibility` as `not_reviewed`.
4. Write `description` in plain English (no HTML) and, if you can, `description_id` in Indonesian.

### Adding or correcting a driver record

* Start from the vendor's own page. The vendor must exist in `catalogs/vendors.json`, and an official link must be on
  one of its `domains` (the validator enforces this).
* Record version, date, size, OS and architecture **only if the page states them**. Say which `requires` apply
  (serial number, login, captcha, EULA, detection tool, product selection).
* Never infer that a driver fits a device from a similar name or version number. BIOS and firmware need extra care:
  describe the vendor's tool or page, and do not store a direct link unless the vendor documents a stable one.
* Aggregator sites (DriverScape and similar) can only be `third_party_aggregator` leads with `download.kind: none` and
  an `official_source`. They can never be `verified`.

### Adding a vendor, tool or bundle

Vendors need `domains` (the official ones), a support or driver-search URL you opened, and `sources[]`. Tools link to
an app through `app_id` where one exists. A bundle's `app_ids` must all exist in `apps.json`.

### Changing the interface

* Build DOM with `h()` from `assets/js/lib/html.js` and text nodes. **No `innerHTML`, `eval`, inline event handlers,
  inline `<script>` or inline `style`**: the CSP forbids them and tests scan for them. `h()` rejects
  unsafe attributes and URLs by design; do not work around it.
* Keep the generated PowerShell safe: package IDs go through `isValidWingetId`, user text only ever lands in a
  one-line comment, and the `YES` gate, the `winget install --id <ID> --exact --source winget` form and the absence of
  `-ExecutionPolicy Bypass` are asserted by tests. Change `assets/js/lib/psgen.js` only with tests.
* Add every new UI string to **both** `en.js` and `id.js` (same key, same `{placeholders}`). The English text in the
  HTML must equal the English dictionary value. Long prose uses a `data-lang-block` English/Indonesian pair.
* Legibility beats effects. Keep text contrast at WCAG AA (`tests/unit/contrast.test.mjs` measures the buttons), keep
  focus states visible, and give every control an accessible name.
* Photos need a license that allows this use and an entry in `assets/manifest.json` with the author, source page,
  license, retrieval date, modifications and alt text. Do not add wallpapers, screenshots or artwork you do not have
  the rights to, and nothing from Microsoft or other vendors.
  `scripts/assets/build-images.mjs` (needs `sharp`, which is deliberately not a dependency; see the script header)
  builds the responsive variants.

### Changing the crawler

Read [`docs/crawler.md`](docs/crawler.md) first. A new adapter must declare its host allow-list, respect robots.txt
(or explain in `robots_note` why a documented API makes it unnecessary), prefer an official API over scraping HTML,
emit `not_reviewed` proposals with provenance only (publication is decided by `scripts/lib/publication.mjs`), and be tested **without the network** (fixtures or the fake
`fetch` helpers). The crawler must never download, mirror or execute a binary, auto-promote a record, or bypass a
login, captcha or rate limit.

## Tests

| Command | Covers |
| --- | --- |
| `npm test` | `tests/unit` (generator, filters, search, storage, i18n, security, build validators, docs sync, ...) and `tests/crawler` (robots, HTTP client, adapters, merge, ...). No network, no browser. |
| `npm run test:e2e` | `tests/e2e`: real pages in headless Chrome (smoke, console and CSP errors, search and filters, selection, script generation, hostile catalog, mobile layout, accessibility basics, language switch). |
| `npm run validate` | The data and generated-file checks. |

Please add a test with every bug fix and every new rule. A test that proves the *absence* of something dangerous
(an injected command, a leaked token, a binary read) is worth more than ten that prove the page renders.

The automated tests cannot run PowerShell, so the generated script is verified structurally; if you can run it on a real Windows
machine, say so in your pull request.

## Pull requests

* Keep a pull request to one topic. Explain **what you checked and where** (URLs), not just what you changed.
* Commit regenerated files (`api/`, `openapi.json`, `assets/CREDITS.md`) together with the source change.
* A pull request may be declined if the source is doubtful, a claim is unsupported, the data is incomplete, or the
  license is unclear. A passing CI run is a format check, **not** a security audit.
* By contributing you agree that your contribution is licensed under the project's [MIT license](LICENSE). Do not
  contribute anything you do not have the right to license that way (see [LICENSING.md](LICENSING.md)).

To report a security problem, do not open a public issue: see [SECURITY.md](SECURITY.md).

---

## Ringkasan (Bahasa Indonesia)

1. **Bukti dulu**: setiap fakta harus punya sumber resmi yang bisa dibuka; catat di `sources[]`.
2. **Yang tidak diketahui tetap tidak diketahui**: jangan menebak versi, tanggal, ukuran, hash, arsitektur,
   kompatibilitas Windows, atau ID paket.
3. **Jangan menyebut "aman"**; HTTPS atau checksum bukan bukti. Tautan hanya ke halaman resmi penerbit/vendor, tanpa
   mirror pihak ketiga. Jangan commit installer, driver, firmware, token, atau data pribadi.
4. **Hash hanya disalin dari penerbit**, bukan dihitung sendiri. Biarkan `verification_status` `not_reviewed`; `verified` hanya oleh
   manusia yang sudah memeriksa sumbernya, lengkap dengan `reviewed_at`, `review_notes`, dan `evidence_url`.
5. Jalankan `npm run check` sebelum membuat pull request. Teks UI baru harus ada di `en.js` **dan** `id.js`. Jangan
   mengedit file hasil build (`api/`, `openapi.json`, `assets/CREDITS.md`) secara manual.
6. Laporan keamanan: jangan buka issue publik; baca [SECURITY.md](SECURITY.md).

## Images and icons

- Add a photo only with a license that allows reuse, and record it in `assets/manifest.json` (author, source page,
  license, retrieval date, modifications, targets). Run `scripts/assets/build-images.mjs` to make the variants, then
  `npm run build` to regenerate `assets/CREDITS.md` and `api/v1/visuals.json`.
- Brand marks come only from the icon sets pinned in `package.json` (`scripts/assets/icon-map.mjs` maps each exact
  product to its mark). Do not add marks from a website, a CDN or an image search. Do not add a mark for a product that
  is only related to the one shown.
- Icons are generated by `node scripts/assets/collect-icons.mjs`; `--check` confirms they are current.
- `npm run validate` fails if a file is not in the manifest, a target names a record that does not exist, an icon
  is not referenced by the site, or a file is over its size budget. See [docs/visual-audit.md](docs/visual-audit.md).

# Data model

ANTO-LTG is a **research index**, not a live database. The data lives in six JSON files under
[`catalogs/`](../catalogs), is checked against JSON Schemas in [`schemas/`](../schemas), and is published as
static files in [`api/v1/`](../api/v1) by `npm run build`. Current schema version: **1.2.0**. It adds the machine-checked `publication` object and separates it from human review
(migration: `scripts/migrations/002-schema-1.2.0.mjs`).

Example records that are validated by the test suite live in [`docs/examples/`](examples).

## 1. Principles

1. **Provenance first.** Every fact comes from a cited source. Each record carries `sources[]` that say which
   page was read, when, and which fields it supplied.
2. **Unknown stays unknown.** A missing version, date, size, hash, architecture or Windows version is `null`,
   absent, or `unknown`. It is never guessed, inferred from a similar name, or copied from a neighbouring record.
3. **Hashes are copied, never computed.** A `sha256` / `sha512` is stored only when the publisher states it, and
   `sha256_source` / `sha512_source` say where. The build never downloads a file to hash it.
4. **Machines publish, humans verify.** A record is *published* when the automated rules in
   `scripts/lib/publication.mjs` pass. No person approves that. A record becomes *verified* only when a maintainer
   checks it against the official source and records the review. The two facts are stored separately. See
   [`docs/crawler.md`](crawler.md).
5. **Official sources only for downloads.** A direct link must be on a domain the vendor owns. Third-party
   aggregators are *leads* only: they are never published in a catalog and carry no download link.
6. **No binaries in the repository.** Records point to official pages; nothing is mirrored.

## 2. Files

| Catalog | Schema | Published as | What it holds |
| --- | --- | --- | --- |
| `catalogs/apps.json` | `schemas/apps.schema.json` | `api/v1/apps.json` | Software for technicians (WinGet packages and curated apps) |
| `catalogs/drivers.json` | `schemas/drivers.schema.json` | `api/v1/drivers.json` | Driver, vendor-tool and support-portal records |
| `catalogs/vendors.json` | `schemas/vendors.schema.json` | `api/v1/vendors.json` | OEM / component-vendor directory with official domains |
| `catalogs/tools.json` | `schemas/tools.schema.json` | `api/v1/tools.json` | Technician tool notes (use cases, cautions) |
| `catalogs/bundles.json` | `schemas/bundles.schema.json` | `api/v1/bundles.json` | Starter selections that open in the Software Center |
| `catalogs/updates.json` | `schemas/updates.schema.json` | `api/v1/updates.json` | Project and catalog update notes (also the RSS feed) |

Also generated: `api/v1/index.json` (endpoint list with counts and SHA-256 of each file),
`api/v1/search-index.json` (build-time search index), `openapi.json` and `assets/CREDITS.md`.
Never edit generated files by hand: run `npm run build` and commit the result.
Shared building blocks are in `schemas/common.schema.json` (including the `publication` definition).
The browser export format is `schemas/bundle-manifest.schema.json`, and crawler output is
`schemas/proposals.schema.json`.

Every catalog file is a wrapper object:

| Field | Meaning |
| --- | --- |
| `schema_version` | Schema version the file conforms to (`1.2.0`). |
| `updated_at` | When the file last changed. |
| `items` | The records, **sorted by `id`** with a fixed key order. `npm run format:catalogs` writes this canonical form and `npm run validate` fails on any other. |

## 3. Shared building blocks

### Identifiers, URLs, dates

| Type | Rule |
| --- | --- |
| `id` | Lowercase kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), stable, unique per catalog. Never reuse an id for a different thing. |
| URL fields | `https://` only. The validator also rejects credentials in URLs, private or loopback hosts, and HTML-like text in text fields. |
| `date` / `dateTime` | ISO 8601 (`2026-10-13`, `2026-10-13T00:00:00.000Z`). Dates in the future are rejected. |
| `version` | A string exactly as the source states it, or `null`. A record may have a `version` only if one of its `sources[]` lists `version` in `fields`. |

### Review fields

| Field | Meaning |
| --- | --- |
| `verification_status` | **Human review only.** `not_reviewed` (default), `verified`, or `withdrawn`. |
| `reviewed_at` | When a human reviewed the record. |
| `review_notes` | What was checked and how. |
| `evidence_url` | The page that supports the review. |

`verified` requires `reviewed_at`, `review_notes` and `evidence_url` (schema rule). Automated publication never sets it.
A record that no human has reviewed is `not_reviewed`, and that is normal for published records. A record that a
human verified is never overwritten by a crawl; differences are reported as *drift* for re-review. Nothing in the
catalogs is `verified` until a maintainer does that review.

### Publication (automated)

| Field (inside `publication`) | Meaning |
| --- | --- |
| `state` | `published` or `unavailable`. `published` means every rule for the catalog passed when `checked_at` was recorded. `unavailable` means a later check found the record no longer meets the rules, and the record stays visible with a warning. |
| `method` | `automated` (produced by a crawler adapter and published by the merge rules) or `maintainer_curated` (written by a maintainer from official pages, then checked by the same rules). |
| `checked_at` | When the rules were evaluated. |
| `checks` | Rule ids that passed. |
| `problems` | Rule ids that failed. Empty for a published record. |

Rules, by catalog (each rule id is listed in `scripts/lib/publication.mjs`):

* **Apps:** `basic_fields`, `https_official_source`, `source_recorded`, `downloads_pinned`, `winget_package_proven`.
  A `winget_id` is published only when a `winget-pkgs` source proves that the package exists.
* **Drivers:** `basic_fields`, `https_official_source`, `source_recorded`, `aggregator_not_published`,
  `direct_download_official`. A `direct_binary` link must be HTTPS, must not be hosted by an aggregator, and must
  be on a vendor domain (checked by the validator).

Publication is a fact about the data and its sources. It is **not** a review and not a safety rating. Read it
together with `verification_status`: a record can be `published` and still `not_reviewed`.

### Provenance: `sources[]` and `evidence[]`

A `sources[]` entry says where facts came from:

| Field | Meaning |
| --- | --- |
| `id` | Short identifier of the source, e.g. `winget-pkgs`. |
| `kind` | One of the source kinds below. |
| `url` | The exact page (or API path) that was read. |
| `ref` | A pin such as `microsoft/winget-pkgs@<commit>`. |
| `retrieved_at` | When it was read. |
| `fields` | Which record fields this source supplied. |
| `note` | Free text (plain text only). |

An `evidence[]` entry (drivers) supports a claim: `type` (for example `aggregator_listing`), `url`,
`retrieved_at`, `note`. Evidence from an aggregator must be typed `aggregator_listing`.

Two different vocabularies are easy to confuse:

* **`source_kind`** on a record says what kind of place the record's main link is: `publisher_page`,
  `manufacturer_support_page`, `official_project_site`, `package_index`, `vendor_catalog`, `third_party_aggregator`.
* **`kind`** on a `sources[]` entry says what kind of source supplied the facts: `package_index` (for example
  winget-pkgs), `vendor_page` (a page on the publisher's or vendor's site), `vendor_catalog` (a vendor-run catalog such as
  the Microsoft Update Catalog), `release_api` (a release API), `aggregator_listing` (a third-party listing),
  `curated` (a maintainer assembled it from the cited official pages) and `documentation` (official documentation).
* **`type`** on an `evidence[]` entry: `vendor_page`, `release_notes`, `catalog_listing`, `aggregator_listing`,
  `support_article`, `package_manifest`.

### Downloads

`downloads[]` (apps, tools) and `download` (drivers) describe a link, never a file we host.

| `kind` | Meaning |
| --- | --- |
| `direct_binary` | A URL that serves the file itself, on the publisher's or vendor's domain. Needs `evidence`. |
| `redirect` | A stable vendor redirect (for example an `fwlink`) to the current file. |
| `landing_page` | An official page where a person picks or starts the download. |
| `download_form` | An official page that gates the download behind a form or agreement. |
| `signed_temporary` | A time-limited or signed URL. **Never stored**: the URL must be empty. |
| `unknown` | The kind could not be determined. |
| `none` | There is no download link (support portals, aggregator leads). |

| Field | Meaning |
| --- | --- |
| `kind`, `url` | Required. |
| `architecture` | `x86`, `x64`, `arm`, `arm64` or `neutral`. |
| `installer_type`, `scope` | Installer type and install scope, as stated by the manifest. |
| `sha256`, `sha512` | Publisher-stated hashes. Need `sha256_source` / `sha512_source`. |
| `sha256_source`, `sha512_source` | Where the publisher stated the hash. |
| `size_bytes` | Size if the publisher states it. |
| `stability` | `versioned` (URL names a version), `evergreen` (URL always serves the latest), `ephemeral` (must not be stored as a direct link), `unknown`. |
| `evidence` | Why this URL is believed to be a direct download. |
| `requires` | (drivers) What a person must do first: `serial_number`, `login`, `captcha`, `eula`, `auto_detect_tool`, `product_selection`, `email`. |
| `link_check` | Result of a header-only probe (below). `{ "status": "unchecked" }` until one has run. |

`link_check` fields: `status` (`unchecked`, `ok`, `redirect`, `blocked`, `broken`, `error`), `checked_at`,
`http_status`, `final_url` (only when it is plain https and not signed), `content_type`, `size_bytes`, `note`.
`ok` means *the server answered*; it does not mean the file is safe or the record is verified.

### Quality flags

`quality_flags` is an open vocabulary of short strings that tell a reviewer what to look at. They are produced by the
crawler, kept on the record, and are never a safety rating.

| Flag | Raised when |
| --- | --- |
| `no_https_publisher_url` | The manifest has no https publisher URL. |
| `manifest_older_than_2_years` | The WinGet manifest's release date is more than two years old. |
| `installer_url_not_https` | An installer URL is not https (it is dropped). |
| `installer_without_sha256` | An installer entry has no valid SHA-256. |
| `min_os_not_declared` | The manifest does not state a minimum Windows version. |
| `newest_version_directory_unusable` | The newest manifest directory could not be parsed, so an older one was used. |
| `no_description` | The source has no description. |
| `aggregator_listing` | The row comes from a third-party listing. |
| `download_gated_by_verification_code` | The listing's download requires a captcha / code. |
| `download_path_robots_disallowed` | The aggregator's robots.txt disallows the file path (so it is never stored). |
| `architecture_not_stated` | An OS is listed without an architecture. |
| `legacy_os_only` | No Windows 10 or 11 in the listed systems. |
| `lists_end_of_support_os` | Lists Windows XP, Vista, 7, 8 or 8.1. |
| `multi_device_row` | One row lists several devices. |
| `non_english_name` | A device name is in another language. |
| `generic_device_name` | Only a generic name such as "USB Device". |
| `vendor_device_mismatch` | The vendor and the device name disagree. |
| `filename_vendor_mismatch` | The file name suggests a different vendor. |
| `filename_version_mismatch` | The file name suggests a different version. |
| `date_inconsistent` | The date is impossible for the listed Windows versions. |

The last seven driver flags **hold a proposal back** from merging unless a person passes `--allow-flagged`.

## 4. Catalogs

### `apps.json`

Required fields: `id`, `name`, `publisher`, `category`, `description`, `source_url`, `source_kind`, `verification_status`, `publication`, `windows_compatibility`, `architectures`, `license`, `notes`, `sources`.

| Field | Notes |
| --- | --- |
| `id`, `name`, `publisher`, `category`, `description` | Required. `category` is one of `browsers`, `communication`, `office`, `media`, `utilities`, `developer-tools`, `runtimes`, `security`, `diagnostics`, `storage`, `network-remote`, `boot-media`, `system-tools`, `vendor-tools`, `gaming`. |
| `description_id`, `notes`, `notes_id` | Human-written text. `*_id` is the Indonesian translation. The crawler never touches these. |
| `source_url`, `source_kind` | The publisher page or package index the record is based on. |
| `verification_status`, `reviewed_at`, `review_notes`, `evidence_url` | Human review fields (above). |
| `publication` | Automated publication state (above). Required. |
| `windows_compatibility` | Human review state: `not_reviewed`, `supported`, `unsupported`, `partial`. Anything but `not_reviewed` needs `review_notes` and `evidence_url`. |
| `compatibility` | What the *source* declares: `windows10`, `windows11` (each `declared`, `unsupported` or `unknown`), `min_os_version`, `basis`, `note`. |
| `architectures` | Architectures the source lists. |
| `license`, `license_url` | License as stated by the source. Informational: the app is not redistributed. |
| `winget_id` | A real WinGet package identifier. Required to have a `winget-pkgs` entry in `sources[]` proving it exists. Never invented. |
| `version`, `release_date` | Only when a source states them. |
| `installer_types`, `installer_scopes`, `elevation`, `portable` | Taken from the manifest. `installer_scopes`: `user`, `machine`. `elevation`: `elevationRequired`, `elevationProhibited`, `elevatesSelf`. |
| `downloads` | Download entries (above). |
| `availability` | For discontinued software only: `status` (always `unavailable`) with `reason`, `since`, `evidence_url`. An unavailable app must not list a download or `winget_id`. |
| `tags`, `quality_flags`, `sources`, `added_at` | Tags, flags, provenance, date the record was added. |

### `drivers.json`

Required fields: `id`, `name`, `description`, `publisher`, `source_url`, `source_kind`, `verification_status`, `publication`, `manufacturer`, `model`, `component`, `kind`, `windows_versions`, `architectures`, `notes`, `download`, `sources`.

| Field | Notes |
| --- | --- |
| `id`, `name`, `description`, `publisher`, `manufacturer`, `model`, `component`, `kind` | Required. `kind` is `driver_package`, `support_page`, `vendor_tool` or `catalog_entry`. `component` is one of `graphics`, `audio`, `network-ethernet`, `network-wifi`, `bluetooth`, `chipset`, `storage`, `usb`, `input`, `camera`, `card-reader`, `firmware`, `serial-adapter`, `printer-scanner`, `system-management`, `other`. |
| `vendor_id`, `hardware_family` | Link to `vendors.json`, and the family or series when known. |
| `description_id`, `notes`, `notes_id`, `install_instructions`, `install_instructions_id` | Human-written text, with Indonesian counterparts. |
| `source_url`, `source_kind` | Where the record came from. `third_party_aggregator` records are leads and never appear in `drivers.json`. |
| `official_source` | The official place to get the driver: `url`, `vendor_id`, `type` (`download_page`, `support_portal`, `catalog`, `release_notes`), `stable`. Its host must be one of the vendor's `domains`. |
| `windows_versions`, `os_support`, `architectures` | `windows_versions` are labels: `Windows XP`, `Windows Vista`, `Windows 7`, `Windows 8`, `Windows 8.1`, `Windows 10`, `Windows 11`, `Windows Server`, `other`. Each `os_support` entry pairs an `os` key (`windows-xp`, `windows-vista`, `windows-7`, `windows-8`, `windows-8-1`, `windows-10`, `windows-11`, `windows-server`) with its `architectures`; the labels and keys must agree. A driver whose architecture is unknown never matches an architecture filter. |
| `version`, `release_date`, `file_size_text`, `file_size_bytes` | Only as the source states them. `file_size_text` is the size as listed. |
| `hardware_ids` | PCI / USB hardware IDs the source associates with the driver. |
| `download` | A download entry (above). Aggregator records must use `kind: none`. A `direct_binary` must be on an official vendor domain and not ephemeral. |
| `evidence` | Evidence entries. |
| `verification_status`, `reviewed_at`, `review_notes`, `evidence_url` | Human review fields. An aggregator listing alone can never be `verified`. |
| `publication` | Automated publication state (above). Required. Aggregator listings are never published in this catalog: they stay in the crawler's lead file. |
| `quality_flags`, `tags`, `sources`, `added_at` | As for apps. |

### `vendors.json`

Required fields: `id`, `name`, `kind`, `homepage_url`, `domains`, `source_kind`, `verification_status`, `sources`.

| Field | Notes |
| --- | --- |
| `id`, `name`, `kind`, `homepage_url`, `domains`, `source_kind`, `verification_status`, `sources` | Required. Vendors have no `publication` object: they are directory entries whose facts are checked against their own domains. Use `verification_status` for human review. `kind`: `oem`, `component_vendor`, `os_vendor`, `catalog`, `peripheral_vendor`. |
| `support_url`, `driver_search_url` | Official support and driver-search pages. |
| `detection_tool` | The vendor's own detection tool: `name`, `url`, `winget_id`. |
| `domains` | The domains the vendor owns. Official direct links are checked against this list. |
| `pci_vendor_ids`, `usb_vendor_ids` | Used by the hardware-ID analysis in the Driver finder. |
| `requires`, `instructions`, `instructions_id` | What the vendor's portal asks for, and how to use it. |
| `reviewed_at`, `review_notes`, `evidence_url`, `notes`, `notes_id` | Review fields and notes. |

### `tools.json`

Required fields: `id`, `name`, `category`, `description`, `publisher`, `source_url`, `source_kind`, `verification_status`, `requires_admin`, `notes`, `sources`.

| Field | Notes |
| --- | --- |
| `id`, `name`, `category`, `description`, `publisher`, `source_url`, `source_kind`, `verification_status`, `requires_admin`, `notes`, `sources` | Required. `requires_admin`: `yes`, `no`, `not_reviewed`. |
| `app_id` | Links to the matching app in `apps.json`, so the tool can be added to a selection. |
| `portable`, `bootable_media` | Whether it runs without installing, and whether it is used from boot media. |
| `use_cases`, `cautions` (+ `use_cases_id`, `cautions_id`) | Short lists written for technicians. |
| `downloads`, `description_id`, `notes_id`, `tags`, `reviewed_at`, `review_notes`, `evidence_url` | As for apps. |

### `bundles.json`

Required fields: `id`, `name`, `description`, `app_ids`, `status`.

| Field | Notes |
| --- | --- |
| `id`, `name`, `description`, `app_ids`, `status` | Required. `app_ids` must exist in `apps.json`. `status`: `draft`, `published`, `withdrawn`. |
| `name_id`, `description_id`, `notes`, `notes_id` | Indonesian counterparts and notes. |
| `target_windows` | `Windows 10` and/or `Windows 11`. |
| `tags` | Free tags. |

### `updates.json`

Required fields: `id`, `title`, `description`, `path` (a site path) and `published_at`. The file is published
through the API and becomes the RSS feed (`feed.xml`) when `SITE_URL` is set at build time. The site's own pages do not
show it.

## 5. Compatibility is three different things

| Where | Answers | Who writes it |
| --- | --- | --- |
| `compatibility` | "What does the **source** say about Windows versions?" (`declared`, `unsupported`, `unknown`) | The crawler, copied from `MinimumOSVersion` in the WinGet manifest. |
| `windows_compatibility` | "Did a **person** confirm it works?" | A reviewer, with `review_notes` and `evidence_url`. |
| `os_support` / `windows_versions` (drivers) | "Which systems does the **listing** name?" | The crawler or curator, as listed. |

Most apps are `unknown` because most manifests state no minimum Windows version. The script generator therefore
includes unknown apps with a note by default, and only leaves out an app that a source says is unsupported on
the chosen target.

## 6. Publication and verification workflow

**Publication (automatic).**

1. The crawler (`crawl` / `merge`) proposes records. Each record is checked against the rules for its catalog.
2. A record whose rules all pass is written with `publication.state: "published"` and `method: "automated"`.
3. A record that fails a rule is not written to the catalog (the merge reports it as skipped with the failed rule ids).
   A record that was published and later fails a check (for example a removed WinGet package) is kept with
   `publication.state: "unavailable"` so the UI can warn, instead of disappearing silently.
4. Nothing needs approval for this step. Every run prints the counts and writes a machine-readable report.

**Verification (human, optional).**

1. A maintainer opens the official page, checks each claim in `sources[]`, and writes what was checked in
   `review_notes` with an `evidence_url`.
2. Only then may `verification_status` become `verified`, with `reviewed_at`.
3. A later crawl that sees different data for a verified record does not change it; it prints `DRIFT` and a
   person decides.
4. A record that is no longer correct becomes `withdrawn`. It stays in the file, and the UI leaves it out of
   install plans.

The site shows publication and verification separately: a published, not-reviewed record is labelled as such.

## 7. Derived data

| Output | Produced by | Notes |
| --- | --- | --- |
| `api/v1/*.json` | `npm run build` | Same content as `catalogs/`, plus `index.json` with counts and SHA-256 per file. |
| `api/v1/search-index.json` | `npm run build` | Compact index over names, ids, publishers, categories, tags, descriptions (English and Indonesian), hardware IDs. The site's global search loads it. |
| `openapi.json` | `npm run build` | OpenAPI 3 description generated from the schemas, so it cannot drift. |
| `assets/CREDITS.md` | `npm run build` | Generated from `assets/manifest.json`. |
| Page header / footer blocks | `npm run build` | Between `<!--chrome:*:start/end-->` markers, from `scripts/templates/`. |

`npm run validate` recomputes every generated file in memory and fails if a committed one is stale.
These are **static snapshots**: they change when the repository changes, not in real time.

## 8. Portable bundle manifest

The Software Center exports a selection as JSON (`schemas/bundle-manifest.schema.json`, validated example in
[`docs/examples/bundle-manifest.example.json`](examples/bundle-manifest.example.json)).

| Field | Meaning |
| --- | --- |
| `format`, `format_version` | Always `anto-ltg.bundle` and `1`. |
| `name`, `created_at`, `notes` | Display name, creation time, free text. |
| `target` | An object whose `os` is `windows10` or `windows11`. |
| `method` | `winget` (script) or `download-kit` (download and verify only). |
| `options` | `accept_agreements`, `silent`, `include_unknown_compatibility` (booleans). |
| `apps` | Objects `{ "id", "name", "winget_id" }`. Only `id` is used on import. |
| `catalog` | `schema_version` and `app_count` of the catalog the file was exported from. |

On import, **only app ids that exist in the catalog are restored.** A manifest can never inject a WinGet id, a
command, a URL or HTML: `name` and `winget_id` in the file are informational, names are reduced to plain text, and
the script is regenerated from the catalog.

## 8a. Images, icons and the visual map

Catalog records carry **no image fields**. Images are kept outside the catalogs, so a record's identity and data do not
change when artwork changes.

- **`assets/manifest.json`** (schema_version `2.0.0`) lists every image and icon file. Each entry has a stable `id`, a
  `kind` (`photo`, `brand-mark`, `glyph`, `ui-glyph` or `project-glyph`), a title and alt text, the owner (`author` for
  photos, `owner` for icons), the source and license URLs, the retrieval date, the modifications made, the local `files`
  (path, format, width, height, bytes, SHA-256) and `targets`. A target is `{ "type", "id", "role?" }`, where type is
  `app`, `tool`, `vendor`, `category`, `component`, `bundle`, `page`, `site` or `ui`. An entry with no target must
  set `unused_reason`. `scripts/lib/assets-check.mjs` rejects a target that names a record that does not exist.
- **`assets/CREDITS.md`** is generated from the manifest by `scripts/assets/credits.mjs`. Do not edit it by hand.
- **`api/v1/visuals.json`** (format `anto-ltg.visuals/1`, [`schemas/visuals.schema.json`](../schemas/visuals.schema.json))
  is generated by `npm run build` from the catalogs and the manifest. For every app, tool, driver, vendor, bundle and
  category it gives the local file (`src`), the fallback level that was used (`brand`, `component`, `category`, `glyph`
  or `bundled`) and the alt text. Bundle entries name their cover photo. `photos` lists each photo's responsive
  variants. `pages` maps each page role to its photo. Every file it names exists under `assets/`.

The fallback chain is the same in the build and in the browser (`scripts/lib/visuals.mjs`,
`assets/js/lib/visuals.js`): brand mark, then component, category or glyph, then the bundled vector. A failed image
swaps once to the bundled vector, so nothing is left as a broken box.

Icons are generated, not hand-edited: `scripts/assets/collect-icons.mjs` reads `scripts/assets/icon-map.mjs` (the single
source of truth for which icon belongs to which record) and writes the SVGs and `assets/icons/sprite.svg`. Run it with
`--check` to confirm the output is current. Photos are produced from originals by `scripts/assets/build-images.mjs`.

## 9. Changing the model

1. Edit the schema in `schemas/` (additive changes keep the minor version; breaking ones need a new major and a
   migration in `scripts/migrations/`).
2. Update policy rules that JSON Schema cannot express in `scripts/lib/semantic.mjs`.
3. Update the key order in `scripts/lib/catalog-io.mjs` if you add a field.
4. Update the UI in `assets/js/lib/model.js` and the page that shows the field.
5. Run `npm run build` (regenerates `openapi.json` and the API) and `npm run format:catalogs`.
6. Document the field **in this file**: `tests/unit/docs.test.mjs` fails when a schema field or enum value is
   missing here.
7. Add or update an example in `docs/examples/` and a test.

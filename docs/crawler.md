# Crawler

`scripts/crawler/` collects **proposals** for the catalogs from official package indexes and public pages.
`merge` then publishes a record **automatically** when the machine rules in
[`scripts/lib/publication.mjs`](../scripts/lib/publication.mjs) pass; a record that fails them is skipped and
the failed rule ids are printed. The crawler never sets `verified`: human review is a separate field that stays
`not_reviewed` until a maintainer checks the official source (see [data model](data-model.md#publication-automated)).

Zero runtime dependencies: Node 22.12+ and its built-in `fetch`.

## What it guarantees

| Guarantee | Where it is enforced | Test |
| --- | --- | --- |
| Identifies itself with a descriptive User-Agent that includes a contact URL | `lib/config.mjs` (the config is rejected otherwise) | `tests/crawler/http.test.mjs` |
| HTTPS only; only hosts on the adapter's allow-list; every redirect hop re-checked | `lib/http.mjs` | `http.test.mjs` |
| SSRF guard: private, loopback, link-local and mapped addresses are refused | `lib/net-safety.mjs` | `net-safety.test.mjs` |
| robots.txt is read before every request (redirect hops included), RFC 9309 matching, `Crawl-delay` honoured; unreadable policy (5xx) means "disallow all" | `lib/robots.mjs` | `robots.test.mjs` |
| Per-host minimum interval and concurrency cap; global concurrency limit | `lib/http.mjs`, `lib/pool.mjs` | `http.test.mjs` |
| Timeouts, bounded retries with exponential backoff and jitter, `Retry-After` honoured | `lib/http.mjs` | `http.test.mjs` |
| Response bodies are size-capped; **binary responses are never read** (the stream is cancelled after the headers) | `lib/http.mjs` | `http.test.mjs` |
| Credentials go only to the exact host they were configured for, are never forwarded on a redirect, and cookies are never sent | `lib/http.mjs` | `http.test.mjs` |
| Conditional requests (ETag / Last-Modified) with an on-disk cache, so repeat runs are cheap | `lib/http.mjs` | `http.test.mjs` |
| Fetched text is treated as untrusted: parsed with a small purpose-built YAML/HTML reader, never evaluated, flattened to plain text in reports | `lib/yaml-lite.mjs`, `lib/html.mjs`, `lib/report.mjs` | `yaml-lite.test.mjs`, `html.test.mjs`, `pipeline.test.mjs` |
| Crawled records enter as `not_reviewed` and are published only when the publication rules pass; merge never touches review fields or human-written text | `lib/merge.mjs`, `scripts/lib/publication.mjs` | `merge.test.mjs`, `winget-index.test.mjs` |
| Nothing is downloaded, mirrored or executed | by construction | `http.test.mjs`, `check-links.test.mjs` |

The crawler does **not** attempt to bypass logins, captchas, rate limits or bot detection, and it will not.
If a site disallows automated access, the answer is a manual, cited entry made by a person.

## Commands

```bash
node scripts/crawler/cli.mjs <command> [options]     # or the npm shortcuts below
```

| Command | npm shortcut | What it does |
| --- | --- | --- |
| `crawl [adapter...]` | `npm run crawl`, `npm run crawl:dry` | Fetch sources and write proposals to `catalogs/proposed/`. With no adapter name, runs every enabled adapter. |
| `merge` | `npm run crawl:merge` | Show the merge plan; with `--apply`, merge proposals into `catalogs/*.json`. |
| `check-links` | `npm run crawl:links` | Probe catalog download URLs with header-only requests. |
| `suggest <PackageId>...` | | Look up real WinGet IDs close to a `Publisher.Package` ID that was `NOT_FOUND` (prints only; never edits a file). |
| `adapters` | | List adapters, whether they are enabled, their robots mode and allowed hosts. |
| `classify <url>` | | Classify a URL offline: `direct_binary`, `redirect`, `landing_page`, `download_form`, `signed_temporary` or `unknown`. |

### `crawl` options

| Option | Meaning |
| --- | --- |
| `--ids a,b` | Only these targets (for winget: package IDs). Existing proposals for other targets are kept. |
| `--retry-failed` | Only targets that failed last time with a retryable error (see [state](#state-and-retrying)). |
| `--incremental` | Skip targets whose source fingerprint (git blob SHAs of the manifest files) has not changed since the last successful run. |
| `--dry-run` | Do everything except write files. |
| `--plan` | Print what would run (hosts, robots mode, target count) and make **no network request**. |
| `--offline` | Use only the HTTP cache; never touch the network. |
| `--refresh` | Ignore cache freshness and revalidate everything. |
| `--limit N` | Process at most N targets (useful for a first try). |
| `--concurrency N` | Override the configured concurrency (the config rejects values above 16). |
| `--allow-aggregators` | Required to run an adapter that reads a third-party aggregator (`driver-listings`). Output is lead-only. |
| `--use-fixtures` | Read saved pages from `tests/fixtures/` instead of the network. Output is labelled `mode: fixture` so nobody mistakes it for a live crawl. |
| `--verbose` | Log every HTTP event. |
| `--config <file>`, `--out <dir>` | Alternative config file and output directory. |

### `merge` options

| Option | Meaning |
| --- | --- |
| `--apply` | Write the merged catalogs. Without it, `merge` only prints the plan. The merged result must pass schema validation and the policy rules, or nothing is written. |
| `--adapter <name>` | Merge only that adapter's proposals. |
| `--allow-flagged` | Also merge proposals that carry a blocking quality flag. Off by default. |

### `suggest` options

`--no-search` skips the GitHub code-search fallback (which is limited to about 10 requests a minute, so the command
waits between calls). Without it, `suggest` first looks inside the publisher's folder and only then searches.

### `check-links` options

`--catalog apps|drivers|tools`, `--hosts a.com,b.com`, `--only id,id`, `--limit N`, `--concurrency N`, `--apply`. See
[Link checking](#link-checking).

## Configuration

`scripts/crawler/crawler.config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `user_agent` | `ANTO-LTG-Crawler/0.2 (+https://github.com/flessan/ANTO-LTG; ...)` | Must contain a contact URL `(+https://...)`. |
| `product_token` | `ANTO-LTG-Crawler` | Matched against `User-agent:` lines in robots.txt. |
| `timeout_ms` | 20000 | Per-request timeout. |
| `retries` | 3 | Attempts after the first. |
| `backoff_base_ms`, `backoff_max_ms` | 1000, 30000 | Exponential backoff with jitter. |
| `max_bytes` | 2097152 | Maximum body size that will be read. |
| `max_redirects` | 5 | Redirect hops (each is re-checked). |
| `concurrency` | 4 | Targets in flight (max 16). |
| `per_host_min_interval_ms` | 2000 | Minimum gap between requests to one host (min 100). |
| `cache_dir`, `cache_ttl_hours` | `.cache/crawler/http`, 24 | HTTP cache (git-ignored; never commit raw pages). |
| `output_dir` | `catalogs/proposed` | Where proposals, state and reports go. |
| `adapters` | | One entry per adapter (below). |

Each adapter declares the settings below. `loadConfig` rejects a config that violates the politeness rules.

| Adapter setting | Meaning |
| --- | --- |
| `enabled` | Whether a bare `crawl` runs it. |
| `type` | Which adapter implementation to load (`winget`, `winget-index` or `driver-listing`). |
| `description` | Human-readable summary (shown by `adapters`; not used by the code). |
| `hosts` | A bare host-name allow-list. Requests (and redirects) to anything else are refused. |
| `robots` | `required`, or `not_applicable`, which must come with a written `robots_note` (for example "uses a documented API"). |
| `host_rules` | Optional per-host `min_interval_ms` and `concurrency` that override the global values. |
| `requires_flag` | A command-line flag that must be passed to run the adapter (`--allow-aggregators`). |
| `repo`, `branch` | (winget) The package index repository and branch to read. |
| `repo_url` | (winget-index) The public git remote to clone. Only `https://github.com/<owner>/<repo>.git` is accepted. |
| `work_dir` | (winget-index) Where the blob-less clone lives (`.cache/crawler`, git-ignored). |
| `discovery` | (winget-index) `enabled`; `max_per_category` (how many discovered IDs each category may add); `exclude` (case-sensitive regular expressions on package IDs: pre-release channels, locale and MSIX variants, vendor families that are out of scope); `rules` (`category` plus a case-insensitive `match` regular expression on the ID). |
| `seed_file` | (winget) The curated list of package IDs to look up (`seeds/winget.json`). |
| `default_locale` | (winget) Locale to read when a manifest does not name its default one (`en-US`). |
| `targets_file` | (driver-listings) The listing pages to read, with their fixtures (`seeds/driver-listings.json`). |
| `limit` | Process at most this many targets; `null` means all. `--limit` overrides it for one run. |
| `policy` | Informational (`lead_only`). The lead-only behaviour of the driver-listing adapter is fixed in its code. |

### Adapters

| Adapter | Source | Status |
| --- | --- | --- |
| `winget` | The documented GitHub REST API for `microsoft/winget-pkgs` (package metadata and hash-pinned installer URLs). No HTML is scraped. Kept for single-package lookups and as a fallback. | Disabled for full crawls (superseded by `winget-index`). Uses `GITHUB_TOKEN` / `GH_TOKEN` when set, sent only to `api.github.com`; without a token GitHub allows 60 requests an hour. |
| `winget-index` | The public git repository `microsoft/winget-pkgs`, read as a blob-less clone with a sparse checkout. One tree listing gives the whole index of package IDs (about 15,000 at the time of writing). Targets are the seeds (`seeds/winget.json`, each proven to exist, otherwise `NOT_FOUND`) plus the discovery rules. Only the manifests of the selected packages are fetched. No HTML and no API quota. | Enabled. Used for the scheduled and full crawls. |
| `driver-listings` | Third-party driver listing pages (currently one DriverScape page), robots-checked, parsed by label. Output is **lead-only**: records are `third_party_aggregator`, carry quality flags, never include a download link, and map to the vendor's official portal. Leads are never published: they stay in `catalogs/proposed/driver-listings.proposals.json` and `drivers.json` never contains one. | Disabled by default; needs `--allow-aggregators`. |

**Why `winget-index` says `robots: not_applicable`.** robots.txt governs web pages. `winget-index` fetches no web
page: it reads a public git repository over git's smart HTTPS protocol, the same way `git clone` does, and it
accepts only `github.com` remotes. The decision is recorded in the adapter's `robots_note` and enforced by
`tests/crawler/pipeline.test.mjs`, which allows `not_applicable` only for GitHub hosts with a written note. Any
adapter that reads an HTML page must use `robots: required`.

**Discovery policy (winget-index).** Seeds are curated and always included. Discovery adds IDs that match a category
rule and no exclusion, with at most `max_per_category` IDs per category. Within a category the IDs are taken in
alphabetical order. That is deterministic and reproducible, but it is **not** a popularity ranking, and a category
with more matches than its cap will not contain all of them. Raise the cap, or add an ID to the seeds, to change
that. Excluded: pre-release channels (beta, preview, nightly, insider, canary, RC, alpha, and their lower-case
forms), locale and MSIX variants, version-pinned IDs, Chinese-market consumer apps, OEM utilities, and NirSoft
(opt-in: add an ID to the seeds to include one).

Official vendor sites (Intel, NVIDIA, AMD, Dell, HP, Lenovo, ASUS, MSI, Acer, GIGABYTE, Realtek, ...) are **not**
crawled by an adapter. Their pages are template-rendered, script-driven or captcha-gated, and their records in
`catalogs/` were entered by hand from the cited pages (`scripts/curation/`). Each such record says where and when.

## Output

Everything is written to `catalogs/proposed/` (see its [README](../catalogs/proposed/README.md)):

| File | Contents |
| --- | --- |
| `<adapter>.proposals.json` | Proposals not yet merged, plus errors. `schemas/proposals.schema.json`, schema id `anto-ltg.proposals/1`. |
| `state.json` | Per-target outcome, attempts, last success and fingerprint (`anto-ltg.crawl-state/1`). |
| `report.json`, `report.md` | The last run: arguments, per-adapter stats, quality-flag histogram, HTTP counters, errors. Error text from remote servers is flattened to one line and stripped of markup. |
| `link-check.report.json` | Written by `check-links` (not committed unless you choose to). |

A proposal looks like this (full example: [`docs/examples/proposal.example.json`](examples/proposal.example.json)):

```json
{
  "target": "Git.Git",
  "key": "winget:git.git",
  "catalog": "apps",
  "record": { "id": "git", "name": "Git", "verification_status": "not_reviewed", "publication": { "state": "published", "method": "automated", "checked_at": "...", "checks": ["..."] }, "...": "..." },
  "meta": { "adapter": "winget", "crawled_at": "...", "quality_flags": [], "fingerprint": "..." }
}
```

`key` is the stable identity used for de-duplication (WinGet ID, canonical URL or id), never the display name.
Every field of `record` is backed by a `sources[]` entry with the pinned commit (`microsoft/winget-pkgs@<sha>`)
and the time it was read.

## State and retrying

`state.json` remembers each target's outcome:

* `--retry-failed` retries only targets whose last error is **retryable** (timeouts, network errors, 5xx, rate
  limits such as `RATE_LIMIT_EXHAUSTED`).
* Permanent errors are never retried: `ROBOTS_DISALLOWED`, `BLOCKED_PROTOCOL`, `BLOCKED_URL`, `BLOCKED_HOST`,
  `BLOCKED_PRIVATE`, `BAD_URL`, `TLS_ERROR`, `TOO_LARGE`, `TOO_MANY_REDIRECTS`, and `NOT_FOUND` for a package
  directory that does not exist. A person has to change something first.
* `--incremental` compares the manifest file fingerprints and skips unchanged packages (about two API calls per
  package instead of five).

If GitHub's primary rate limit is exhausted, the client waits when the reset is within two minutes; otherwise it
records `RATE_LIMIT_EXHAUSTED` for the remaining targets and `--retry-failed` picks them up later. The built-in
`GITHUB_TOKEN` of GitHub Actions is limited to about 1,000 requests an hour per repository, so a scheduled run should
use `--incremental`.

## Merging

`merge` compares proposals with the catalog. Rules (all tested in `tests/crawler/merge.test.mjs`):

* A proposal can never change `id`, `verification_status`, `reviewed_at`, `review_notes`, `evidence_url`,
  `windows_compatibility`, `notes`, `notes_id`, `description_id` or `added_at`.
* New records enter as `not_reviewed`. Each one is checked against the publication rules for its catalog: a record
  that passes is written as `publication.state: "published"`; a record that fails is skipped and the rule ids that
  failed are shown in the plan.
* On an unverified record the crawler may refresh data fields (version, release date, compatibility, architectures,
  installer details, downloads, license, quality flags) and fill empty descriptive fields. Anything else a person
  wrote stays.
* A **verified** record is never overwritten: differences are printed as `DRIFT` for a person to re-review.
* Duplicates are found by stable key (WinGet ID, canonical URL, id), never by name alone, so merging twice changes
  nothing (idempotent).
* Aggregator (`third_party_aggregator`) records are never merged into `drivers.json`, whatever their flags.
* Driver proposals with a blocking quality flag (`vendor_device_mismatch`, `filename_vendor_mismatch`,
  `filename_version_mismatch`, `non_english_name`, `multi_device_row`, `generic_device_name`, `date_inconsistent`)
  are held back; `--allow-flagged` overrides that deliberately.
* The merged result is validated (schemas and policy rules) before anything is written.
* After `--apply`, merged proposals are removed from the proposals file; held-back ones stay.

Typical review loop:

```bash
npm run crawl -- winget --incremental     # fetch and write proposals
git diff catalogs/proposed                # read what changed
npm run crawl:merge                       # show the merge plan (dry run)
node scripts/crawler/cli.mjs merge --apply
npm run format:catalogs && npm run validate && npm run build
git diff catalogs api                     # review the data, then commit
```

## URL classification

`lib/classify-url.mjs` decides what a link is, so a "download" button is only offered when the evidence supports
it. It uses the file extension, known release-asset hosts, signed-URL patterns (for example `X-Amz-Signature`,
`sig=`, `token=`, SAS tokens), redirector hosts such as `aka.ms`, and, when a probe is available, the content type
and `Content-Disposition`. A signed or temporary URL is never stored as a direct link; `stability` records whether
the URL pins a version (`versioned`), always serves the latest (`evergreen`), or is session-bound (`ephemeral`).

## Link checking

`check-links` probes the download URLs already in the catalogs with a `HEAD` request, falling back to a
one-byte ranged `GET` whose body is cancelled. It records `link_check` objects and nothing else.

* It never downloads a file and never follows a redirect to another host (it records the target **host** only, so
  signed CDN URLs are not stored).
* It honours robots.txt for every host. A URL that robots.txt disallows is recorded as `blocked`, not fetched.
* `401`, `403`, `429` and `451` are recorded as `blocked` ("the server refused an automated request"), because that
  is not proof that the link is broken.
* `ok` means *the server answered*. It does not mean the file is safe, current or verified.
* Without `--apply` it only writes `link-check.report.json`. With `--apply` the results are written to the
  catalogs only if the result still validates.

**Known limitation.** `github.com/robots.txt` contains `Disallow: /*/download`, which matches every
`/releases/download/` asset URL. A polite crawler must not probe those, so the crawler records them as `blocked`
by robots.txt, and in this repository **those links are left `unchecked`**: the GitHub-hosted installer links (the
largest single host in the catalogs) cannot be link-checked by this tool. Other hosts can be checked by anyone who
can reach them (`npm run crawl:links -- --hosts example.com`). When this document was written, every catalog link was
still `unchecked`: the environment the crawler was developed in could reach only `github.com` and `api.github.com`,
so the other hosts could not be probed there.

## Environment notes

* `GITHUB_TOKEN` / `GH_TOKEN`: optional, raises the GitHub API limit, sent only to `api.github.com`.
* **TLS-inspecting proxies.** If Node reports `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, the crawler stops with a
  non-retryable `TLS_ERROR` and a hint. Point Node at your CA bundle, for example
  `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt`. The crawler never disables certificate verification.
* The cache lives in `.cache/` (git-ignored).

## Writing an adapter

1. Add `adapters/<name>.mjs` that default-exports `{ async run({ cfg, ctx }) }`. `ctx` provides the polite
   `client`, the vendors list, `now()`, `targets`, `incremental`, `previous` (state) and `fixtures`.
   Return `{ source, proposals, errors, stats, attempted, unchanged }`.
2. Map the new `type` in `loadAdapter` (`lib/config.mjs`) and the adapter name to a catalog in
   `commands/merge.mjs`.
3. Add it to `crawler.config.json` with its **host allow-list** and `robots` mode. Prefer a documented API over
   scraping HTML. Leave it `enabled: false` until it has been reviewed.
4. Produce `not_reviewed` records only, with `sources[]` for every field, and quality flags for anything doubtful. Publication is decided by the shared rules in `scripts/lib/publication.mjs`, never by the adapter.
   If a value cannot be parsed with confidence, return `null`.
5. Test it without the network: save a fixture, or use the fake `fetch` helpers in `tests/helpers/`
   (`fake-github.mjs`, `net.mjs`). Tests must never reach the internet.
6. Document it here.

## Tests

`npm test` runs `tests/unit` and `tests/crawler` (no network, no browser). The crawler suite covers robots.txt,
the HTTP client (rate limit, retry, `Retry-After`, size cap, binary responses not read, redirect allow-list, SSRF,
token not leaked across hosts, ETag 304), the YAML reader (including tabs inside block scalars), URL
classification, normalisation, the WinGet adapter through a fake GitHub, the driver-listing adapter against a
fixture, merge (protected fields, drift, idempotency), state and retrying, and link checking.

**About the DriverScape fixture.** `tests/fixtures/driverscape-online-125322.html` is a *reconstruction* of
`https://www.driverscape.com/manufacturers/online/laptops-desktops/online/125322`, rebuilt from the page's text as
returned by a text-extraction fetch, because the sandbox could not `curl` the site directly. It is not byte-exact.
It exists to test the parser and the quality flags; the proposals it produced are labelled `mode: fixture`, and
the file download links on that site (disallowed by its robots.txt and gated by a verification code) are never
stored.

## Scheduled refresh (GitHub Actions)

`.github/workflows/catalog-refresh.yml` is the active scheduled refresh workflow. It runs every Monday at 03:17 UTC and can also be started manually (`workflow_dispatch`):

1. `npm ci`, then an incremental `winget-index` crawl. The blob-less clone is cached between runs under `.cache/crawler`
   (git-ignored and never committed). `catalogs/proposed/state.json` keeps the per-package fingerprints, so an unchanged
   manifest is not re-read.
2. `merge --apply`, so the publication rules decide what is published. Nothing is marked `verified`.
3. `format:catalogs`, `validate`, `npm test` and `build`. If any of these fails, nothing is proposed.
4. If the catalogs or API changed, the job pushes `automated/catalog-refresh` and opens or updates one pull request.
   A person reads the diff before it is merged.

Limitations of the workflow: a push made with the default `GITHUB_TOKEN` does not start other workflows, so the checks
that run on pull requests do not run automatically on this one. The job runs the same checks itself before it pushes.
The repository must allow Actions to create pull requests (Settings → Actions → General).

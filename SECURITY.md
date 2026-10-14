# Security policy

ANTO-LTG is a volunteer project. Reports are handled on a best-effort basis: there is no service-level agreement and
no bug bounty.

*Ringkasan dalam Bahasa Indonesia ada di bagian akhir.*

## Reporting a vulnerability

Please **do not** describe a vulnerability, exploit or malicious file in a public issue, pull request or discussion.

1. **Preferred: GitHub private vulnerability reporting.** Open
   <https://github.com/flessan/ANTO-LTG/security/advisories/new>. This only works once the repository owner has
   switched on *Settings → Code security → Private vulnerability reporting*. If that link shows a 404, it has not
   been enabled yet; use option 2.
2. **Fallback.** Open a public issue titled "Security contact request" with **no technical details**, or use the
   contact options on the maintainer's GitHub profile (<https://github.com/flessan>), and ask for a private channel.

Please include: what you found, where (page, file, record id), how to reproduce it, and the impact you expect.
Give a reasonable time to fix before you publish.

**Supported version:** the `main` branch and the site built from it.

### In scope

* Script or markup injection in the site, or a bypass of its Content-Security-Policy.
* **Generated-script flaws:** any catalog record, share link, imported manifest or bundle name that makes the
  PowerShell script run something other than `winget install --id <ID> --exact --source winget` for a known catalog
  package.
* **Crawler flaws:** requests to private or non-allow-listed hosts (SSRF), ignoring robots.txt, reading or storing a
  binary, leaking `GITHUB_TOKEN` to another host, writing outside the output folder, or promoting a record to
  `verified`.
* **Supply chain:** a tampered vendored file (`assets/vendor/7.css` hashes are checked by `npm run validate`), a
  malicious dev dependency, or a CI workflow weakness.
* **Data integrity:** a catalog link that points to a malicious or wrong destination, a wrong hash, or a non-official
  host presented as official.

### Out of scope

Vulnerabilities in the third-party software that the catalog describes, or on vendor and aggregator websites; headers
that a static host controls (HSTS, `frame-ancestors`; the CSP here is delivered with a `<meta>` tag); attacks that
need a compromised browser or PC; social engineering; denial of service by volume; scanner output without a
reproducible impact.

## How the project protects users

| Area | What is done | Where it is tested |
| --- | --- | --- |
| Page security | A strict CSP on every page: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`. No inline script, style or event handler. | `tests/unit/security.test.mjs`, `tests/e2e` (an injected inline script does not run) |
| Rendering | The UI builds DOM with `h()` and text nodes; there is no `innerHTML`, `eval` or `document.write`. `h()` rejects event-handler and `style` attributes and any URL that is not `https:` or a same-site path. Catalog text is plain text. | `security.test.mjs`, the hostile-catalog browser test |
| Generated script | Package IDs must match a strict pattern; every string is an ASCII single-quoted literal; user text appears only in a one-line comment; arguments go through an array, so the shell does no parsing; explicit `YES` (case-sensitive) before anything is installed; Windows and WinGet checks; a failed-package report; no `-ExecutionPolicy Bypass`; no self-elevation; `-DryRun`. | `tests/unit/psgen.test.mjs` (skeleton invariance under hostile input), `tests/e2e` |
| Imports and links | A manifest or share link restores only app ids that exist in the catalog; it can never carry a package ID, command or URL. | `tests/unit/bundle-storage.test.mjs`, `tests/e2e` |
| Catalog | Official direct links must sit on the vendor's own domains; aggregator records cannot carry a download link or be `verified`; signed or temporary URLs are rejected; URLs with credentials or private hosts are rejected. | `npm run validate`, `tests/unit/catalog.test.mjs` |
| Crawler | robots.txt, rate limits, host allow-list, SSRF guard, size cap, binaries never read, credentials only to the exact host and never across redirects, untrusted text sanitised in reports. | `tests/crawler/*` |
| Secrets | No secret is needed by the site. `GITHUB_TOKEN` / `GH_TOKEN` are read only from the environment, sent only to `api.github.com`, and never written out. A test scans source, data, docs and workflows for token-shaped strings. | `security.test.mjs` |
| Dependencies | The site has **no runtime dependencies**. Development dependencies are `ajv`, `ajv-formats` and `puppeteer-core`, installed from a committed lockfile (`npm ci`). | `npm audit` |

## What this does not give you

* **A passing CI run is a format check, not a security audit.** The validators do not download or scan binaries, do
  not judge a domain's reputation, and do not prove a compatibility claim.
* HTTPS, a checksum or a signature does **not** prove a file is free of malware. A checksum only detects a change from
  a value you already trust. Hashes in the catalog are copied from the publisher, not computed by this project.
* **Nothing is marked `verified`** at the time of writing, and catalog links are `unchecked`.
* The generated PowerShell is verified structurally; the automated tests have no PowerShell to run it with.
* Installing a driver or firmware with administrator rights is a risky act. Prefer your PC maker's page over a generic
  chip driver, read what a script does before you run it, and keep a restore point.

## Catalog principles

* HTTPS links to the publisher or vendor only; prefer official project pages.
* Do not mirror or repack binaries unless the license explicitly allows redistribution.
* Do not store installers, firmware, credentials, tokens or personal data in the repository.
* `not_reviewed` is the default; publication is automatic and is not a review. `verified` needs a human check and referable evidence
  (`reviewed_at`, `review_notes`, `evidence_url`).

## Ringkasan (Bahasa Indonesia)

Jangan laporkan celah keamanan di issue publik. Gunakan *private vulnerability reporting* GitHub
(<https://github.com/flessan/ANTO-LTG/security/advisories/new>, aktif setelah pemilik repositori menyalakannya di
*Settings → Code security*) atau, jika belum tersedia, buka issue "Security contact request" **tanpa detail teknis**
dan minta saluran privat. Proyek ini dikelola relawan: tanpa SLA dan tanpa bug bounty. CI yang lulus bukan audit
keamanan; HTTPS atau checksum bukan bukti file bebas malware; belum ada entri yang `verified`; skrip PowerShell
diuji secara struktural, tidak dijalankan di CI.

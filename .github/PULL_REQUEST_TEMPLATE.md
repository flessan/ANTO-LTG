## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## What kind of change is it?

- [ ] Catalog data (apps, drivers, vendors, tools, bundles)
- [ ] Site (HTML, CSS, JavaScript, translations)
- [ ] Crawler or build scripts
- [ ] Docs, CI or tooling

## Evidence (required for catalog data)

<!--
List the official pages you opened and what each one shows. "Unknown" is a valid answer; a guess is not.
Example: https://example.com/downloads (publisher page, read 2026-10-13): states version 1.2.3 and the SHA-256.
-->

## Checklist

- [ ] `npm run check` passes (validate, tests, build, and no uncommitted change to generated files).
- [ ] I did **not** invent a version, date, hash, package ID or compatibility claim. Hashes come from the publisher.
- [ ] Publication is automatic: `npm run crawl:merge -- --apply` and `npm run build` publish a record only when the machine rules pass; I did not edit `publication` by hand. I left `verification_status` as `not_reviewed` unless I opened the source myself and filled `reviewed_at`, `review_notes` and `evidence_url`.
- [ ] Links go to official publisher or vendor pages. No mirrors, file hosts or aggregator download links.
- [ ] I added no installer, driver, firmware, archive, token or personal data.
- [ ] New UI text exists in both `assets/js/i18n/en.js` and `id.js`, and the HTML default text equals the English entry.
- [ ] New browser code builds DOM with `h()` (no `innerHTML`, inline handlers, inline `style` or inline `<script>`).
- [ ] New images have a license that allows this use and an entry in `assets/manifest.json`.
- [ ] I added or updated a test (and, for a changed field, `docs/data-model.md`).

## Not covered by CI

<!-- For example: "I ran the generated script on Windows 11 23H2 with WinGet 1.x and it worked" - say so if you did. -->

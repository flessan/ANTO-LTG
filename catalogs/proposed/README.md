# `catalogs/proposed/` - crawler output awaiting review

Everything in this folder is **proposed data**. It was produced by `scripts/crawler/` and has not been reviewed by a
person. Nothing here is verified, nothing was downloaded or executed, and no binary was mirrored. The site and the
public API read `catalogs/*.json`, never this folder.

| File | What it is |
| --- | --- |
| `winget.proposals.json` | Proposals from the `microsoft/winget-pkgs` index that have not been merged yet. After `merge --apply` it keeps only the source commit the last crawl used. |
| `driver-listings.proposals.json` | Third-party driver listing rows that were **held back** by quality flags, plus the rows that could not be mapped to an official vendor. They are leads, never download links. |
| `state.json` | Per-target outcome (ok / failed, attempts, fingerprint). Lets `--retry-failed` and `--incremental` work. |
| `report.json`, `report.md` | The last crawl: arguments, statistics, quality-flag histogram, errors. |
| `link-check.report.json` | Created by `check-links` when you run it. |

## Reviewing a proposal

Publication is automatic. `merge` publishes a record when the machine rules in `scripts/lib/publication.mjs` pass,
and a proposal that fails them stays out of the catalog with its reasons recorded. Review is a separate step.

1. Read the proposal's `record`, its `sources[]` (page, pinned commit, time, fields) and `meta.quality_flags`.
2. Open the cited official page yourself. A proposal is a pointer to where to look, not evidence.
3. `npm run crawl:merge` shows what would change. `node scripts/crawler/cli.mjs merge --apply` writes it. New records
   are published when the rules pass and keep `verification_status: not_reviewed`. A record a human verified is never
   overwritten (differences print as `DRIFT`).
4. Only a person who has checked the source may set `verification_status` to `verified`, and only with `reviewed_at`,
   `review_notes` and `evidence_url`.

## Rules

* Do not hand-edit a proposal to get past a quality flag. Fix the source data, or write a curated record with its own
  citations.
* Never commit raw crawled pages, installers or other binaries. The HTTP cache lives in `.cache/` (git-ignored).
* The driver-listing proposals come from a third-party aggregator and were produced from a *reconstructed fixture*
  (`tests/fixtures/`), not a live crawl; their `source.targets[].mode` says `fixture`.

Full documentation: [`docs/crawler.md`](../../docs/crawler.md). Data model: [`docs/data-model.md`](../../docs/data-model.md).

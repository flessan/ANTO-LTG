// Automated publication rules.
//
// A record is PUBLISHED when the machine rules below pass. No human approval is needed for that.
// Publication is a fact about the record's data and its sources; it is NOT a review. Human review
// is the separate `verification_status` field, which only a maintainer can set to "verified".
//
// The same functions are used by the crawler merge (to decide what enters the catalog), by the
// validator (to prove that every published record still meets the rules) and by the tests.
// Keep them pure: no network, no clock except the `now` argument.
import { AGGREGATOR_HOSTS, isAggregatorHost } from './semantic.mjs';

const isHttps = (value) => typeof value === 'string' && /^https:\/\/[^\s\\]+$/.test(value);
const hostOf = (value) => { try { return new URL(value).hostname; } catch { return ''; } };
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

// Every rule has a stable id (written to publication.checks / publication.problems) and a
// human-readable description used in reports.
export const APP_RULES = [
  { id: 'basic_fields', description: 'name, publisher and description are present' },
  { id: 'https_official_source', description: 'source_url is HTTPS and not a third-party aggregator' },
  { id: 'source_recorded', description: 'at least one source records where each fact came from' },
  { id: 'downloads_pinned', description: 'every listed download is HTTPS, not an aggregator, and has a published SHA-256 or evidence' },
  { id: 'winget_package_proven', description: 'a winget_id is only present when a winget-pkgs source proves the package exists' },
];

export const DRIVER_RULES = [
  { id: 'basic_fields', description: 'name, publisher, description and component are present' },
  { id: 'https_official_source', description: 'source_url is HTTPS and not a third-party aggregator' },
  { id: 'source_recorded', description: 'at least one source records where each fact came from' },
  { id: 'aggregator_not_published', description: 'aggregator listings are leads and are never published in the catalog' },
  { id: 'direct_download_official', description: 'a direct_binary download is HTTPS and not hosted by an aggregator (the vendor-domain ownership rule is enforced by the validator); a published SHA-256 is recorded when the vendor states one' },
];

function appChecks(app) {
  const out = {};
  out.basic_fields = nonEmpty(app.name) && nonEmpty(app.publisher) && nonEmpty(app.description);
  out.https_official_source = isHttps(app.source_url) && !isAggregatorHost(hostOf(app.source_url));
  out.source_recorded = Array.isArray(app.sources) && app.sources.length > 0 && app.sources.every((s) => nonEmpty(s.id) && (s.url === undefined || isHttps(s.url) || s.url === null));
  out.downloads_pinned = (app.downloads ?? []).every((d) => isHttps(d.url) && !isAggregatorHost(hostOf(d.url)) && (Boolean(d.sha256) || Boolean(d.evidence)));
  out.winget_package_proven = !app.winget_id || (app.sources ?? []).some((s) => s.id === 'winget-pkgs');
  return out;
}

function driverChecks(d) {
  const out = {};
  out.basic_fields = nonEmpty(d.name) && nonEmpty(d.publisher) && nonEmpty(d.description) && nonEmpty(d.component);
  out.https_official_source = isHttps(d.source_url) && !isAggregatorHost(hostOf(d.source_url));
  out.source_recorded = Array.isArray(d.sources) && d.sources.length > 0;
  out.aggregator_not_published = d.source_kind !== 'third_party_aggregator' && !isAggregatorHost(hostOf(d.source_url));
  out.direct_download_official = d.download?.kind !== 'direct_binary' || (isHttps(d.download.url) && !isAggregatorHost(hostOf(d.download.url)));
  return out;
}

// Which catalog method the record belongs to: crawled from WinGet metadata, or written by a maintainer.
export function appMethod(app) {
  return (app.sources ?? []).some((s) => s.id === 'winget-pkgs') ? 'automated' : 'maintainer_curated';
}

// Pure evaluation: { eligible, checks: [ids that passed], problems: [ids that failed] }.
export function evaluate(catalog, record) {
  const results = catalog === 'apps' ? appChecks(record) : driverChecks(record);
  const rules = catalog === 'apps' ? APP_RULES : DRIVER_RULES;
  const checks = rules.map((r) => r.id).filter((id) => results[id]);
  const problems = rules.map((r) => r.id).filter((id) => !results[id]);
  return { eligible: problems.length === 0, checks, problems };
}

// Build the `publication` object for a record. state is 'published' only when every rule passes.
export function publicationFor(catalog, record, { now, method = catalog === 'apps' ? appMethod(record) : 'maintainer_curated' }) {
  const { eligible, checks, problems } = evaluate(catalog, record);
  return {
    state: eligible ? 'published' : 'unavailable',
    method,
    checked_at: now,
    checks,
    ...(problems.length ? { problems } : {}),
  };
}

// Used by the validator: every item must carry a publication object that matches the rules.
export function checkPublication(catalogs) {
  const problems = [];
  for (const catalog of ['apps', 'drivers']) {
    for (const item of catalogs[catalog]?.items ?? []) {
      const where = `${catalog}.json "${item.id}"`;
      const pub = item.publication;
      if (!pub) { problems.push(`${where}: has no publication object`); continue; }
      if (Number.isNaN(Date.parse(pub.checked_at))) problems.push(`${where}: publication.checked_at is not a date-time`);
      const ev = evaluate(catalog, item);
      if (pub.state === 'published') {
        if (!ev.eligible) problems.push(`${where}: publication.state is "published" but fails ${ev.problems.join(', ')}`);
        if (pub.problems?.length) problems.push(`${where}: a published record cannot list problems`);
      } else if (pub.state === 'unavailable') {
        if (!pub.problems?.length && ev.eligible) problems.push(`${where}: publication.state is "unavailable" but every rule passes; re-run the merge`);
      } else {
        problems.push(`${where}: unknown publication.state "${pub.state}"`);
      }
      if (catalog === 'apps' && pub.method === 'automated' && appMethod(item) !== 'automated') problems.push(`${where}: method "automated" needs a winget-pkgs source`);
      if (catalog === 'apps' && pub.method === 'maintainer_curated' && appMethod(item) === 'automated') problems.push(`${where}: a record with a winget-pkgs source must be method "automated"`);
    }
  }
  return problems;
}

export const PUBLICATION_HOSTS = AGGREGATOR_HOSTS;

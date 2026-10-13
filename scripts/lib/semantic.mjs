// Cross-file and policy checks that JSON Schema cannot express.
import { checkPublicHttpsUrl, hostMatches } from '../crawler/lib/net-safety.mjs';

// Third-party sites that republish driver/installer files. Records pointing at them may only be
// labelled third_party_aggregator and may never carry a download link.
export const AGGREGATOR_HOSTS = ['driverscape.com', 'driverguide.com', 'driveridentifier.com', 'drivers.softpedia.com', 'driverpack.io', 'drp.su', 'driverscloud.com', 'mydrivers.com', 'station-drivers.com', 'softpedia.com', 'cnet.com', 'download.cnet.com', 'filehippo.com', 'uptodown.com', 'majorgeeks.com'];

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const MARKUP = /<\/?[a-z!][^>]*>/i;
const TEXT_FIELDS = new Set(['name', 'name_id', 'publisher', 'manufacturer', 'model', 'hardware_family', 'description', 'description_id', 'notes', 'notes_id', 'review_notes', 'title', 'license', 'file_size_text', 'reason', 'note', 'basis']);
const URL_KEYS = /(^|_)url$/;

function* walk(value, pathParts = []) {
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) yield* walk(value[i], [...pathParts, i]); }
  else if (value && typeof value === 'object') { for (const [k, v] of Object.entries(value)) yield* walk(v, [...pathParts, k]); }
  else yield { path: pathParts, value };
}

export const isAggregatorHost = (host) => AGGREGATOR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

export function checkSemantics(catalogs, { now = new Date() } = {}) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  const today = now.toISOString().slice(0, 10);

  const idSets = {};
  for (const [name, doc] of Object.entries(catalogs)) {
    const seen = new Set();
    for (const [i, item] of doc.items.entries()) {
      if (seen.has(item.id)) err(`${name}.json items[${i}]: duplicate id "${item.id}"`);
      seen.add(item.id);
    }
    idSets[name] = seen;
  }

  // Generic hygiene for every string in every record.
  for (const [name, doc] of Object.entries(catalogs)) {
    for (const [i, item] of doc.items.entries()) {
      const where = `${name}.json "${item.id}"`;
      for (const { path: p, value } of walk(item)) {
        if (typeof value !== 'string') continue;
        const key = String(p[p.length - 1]);
        if (CONTROL.test(value) && !(key === 'review_notes')) err(`${where}: ${p.join('.')} contains control characters`);
        if (TEXT_FIELDS.has(key) && MARKUP.test(value)) err(`${where}: ${p.join('.')} contains HTML-like markup; catalog text must be plain text`);
        if (URL_KEYS.test(key) || /^(url|final_url)$/.test(key)) {
          const check = checkPublicHttpsUrl(value);
          if (!check.ok) err(`${where}: ${p.join('.')} is not a safe public https URL (${check.reason})`);
        }
        if (/_at$|^release_date$|^since$/.test(key) && /^\d{4}-\d{2}-\d{2}/.test(value) && value.slice(0, 10) > today) err(`${where}: ${p.join('.')} is in the future (${value})`);
      }
    }
  }

  // apps
  const apps = catalogs.apps?.items ?? [];
  const wingetIds = new Map();
  for (const app of apps) {
    const where = `apps.json "${app.id}"`;
    if (app.winget_id) {
      const k = app.winget_id.toLowerCase();
      if (wingetIds.has(k)) err(`${where}: winget_id "${app.winget_id}" is also used by "${wingetIds.get(k)}"`);
      wingetIds.set(k, app.id);
      if (!app.sources.some((s) => s.id === 'winget-pkgs' && s.fields?.includes('downloads')) && !app.sources.some((s) => s.id === 'winget-pkgs')) err(`${where}: has a winget_id but no winget-pkgs source proving it exists`);
    }
    if (['supported', 'partial', 'unsupported'].includes(app.windows_compatibility) && !(app.review_notes && app.evidence_url)) err(`${where}: windows_compatibility "${app.windows_compatibility}" is a human conclusion and needs review_notes and evidence_url`);
    if (app.version && !app.sources.some((s) => s.fields?.includes('version'))) err(`${where}: has a version but no source lists "version" among its fields`);
    for (const d of app.downloads ?? []) {
      const host = new URL(d.url).hostname;
      if (isAggregatorHost(host)) err(`${where}: download URL host ${host} is a third-party aggregator`);
      if (d.kind === 'direct_binary' && !d.evidence) err(`${where}: direct_binary download ${d.url} has no evidence`);
    }
    if (app.availability?.status === 'unavailable' && (app.downloads?.length || app.winget_id)) err(`${where}: marked unavailable but still lists a download or winget_id`);
  }

  // vendors
  const vendors = new Map((catalogs.vendors?.items ?? []).map((v) => [v.id, v]));
  const vendorOwnsHost = (vendorId, host) => vendors.has(vendorId) && hostMatches(host, vendors.get(vendorId).domains);

  // drivers
  for (const d of catalogs.drivers?.items ?? []) {
    const where = `drivers.json "${d.id}"`;
    if (d.vendor_id && !vendors.has(d.vendor_id)) err(`${where}: unknown vendor_id "${d.vendor_id}"`);
    const srcHost = new URL(d.source_url).hostname;
    const aggregator = isAggregatorHost(srcHost);
    if (aggregator && d.source_kind !== 'third_party_aggregator') err(`${where}: source_url is on aggregator host ${srcHost} but source_kind is "${d.source_kind}"`);
    if (d.source_kind === 'third_party_aggregator') {
      if (d.download?.url) err(`${where}: aggregator-sourced records must not carry a download URL`);
      if (d.verification_status === 'verified') err(`${where}: an aggregator listing alone can never be verified`);
    }
    if (d.official_source) {
      const host = new URL(d.official_source.url).hostname;
      if (d.official_source.vendor_id && !vendors.has(d.official_source.vendor_id)) err(`${where}: official_source.vendor_id "${d.official_source.vendor_id}" is unknown`);
      if (d.official_source.vendor_id && !vendorOwnsHost(d.official_source.vendor_id, host)) err(`${where}: official_source host ${host} is not among the domains of vendor "${d.official_source.vendor_id}"`);
      if (isAggregatorHost(host)) err(`${where}: official_source must not be an aggregator (${host})`);
    }
    if (['manufacturer_support_page', 'vendor_catalog'].includes(d.source_kind) && d.vendor_id && !vendorOwnsHost(d.vendor_id, srcHost)) err(`${where}: source_kind ${d.source_kind} but ${srcHost} is not a domain of vendor "${d.vendor_id}"`);
    if (d.download?.kind === 'direct_binary') {
      const host = new URL(d.download.url).hostname;
      const owner = d.official_source?.vendor_id ?? d.vendor_id;
      if (!owner || !vendorOwnsHost(owner, host)) err(`${where}: direct_binary download host ${host} is not an official domain of the vendor; use a landing page instead`);
      if (d.download.stability === 'ephemeral') err(`${where}: an ephemeral URL must not be stored as a direct link`);
    }
    if (d.download?.kind === 'signed_temporary' && d.download.url) err(`${where}: signed/temporary URLs must not be stored`);
    if (d.download?.sha256 && !d.download.sha256_source) err(`${where}: download.sha256 needs sha256_source (where the hash was published)`);
    if (d.download?.sha512 && !d.download.sha512_source) err(`${where}: download.sha512 needs sha512_source (where the hash was published)`);
    const osFromSupport = new Set((d.os_support ?? []).map((o) => o.os));
    if (d.os_support?.length) {
      const labels = { 'windows-xp': 'Windows XP', 'windows-vista': 'Windows Vista', 'windows-7': 'Windows 7', 'windows-8': 'Windows 8', 'windows-8-1': 'Windows 8.1', 'windows-10': 'Windows 10', 'windows-11': 'Windows 11', 'windows-server': 'Windows Server' };
      for (const key of osFromSupport) if (!d.windows_versions.includes(labels[key])) err(`${where}: os_support lists ${key} but windows_versions lacks "${labels[key]}"`);
    }
    if (d.version && !d.sources.some((s) => s.fields?.includes('version'))) err(`${where}: has a version but no source lists "version" among its fields`);
    for (const e of d.evidence ?? []) if (isAggregatorHost(new URL(e.url).hostname) && !['aggregator_listing'].includes(e.type)) err(`${where}: evidence from an aggregator must be typed aggregator_listing`);
  }

  // bundles / tools references
  for (const b of catalogs.bundles?.items ?? []) for (const id of b.app_ids) if (!idSets.apps?.has(id)) err(`bundles.json "${b.id}": unknown app id "${id}"`);
  for (const t of catalogs.tools?.items ?? []) if (t.app_id && !idSets.apps?.has(t.app_id)) err(`tools.json "${t.id}": unknown app_id "${t.app_id}"`);

  // verified records must never carry crawler-only warnings that were not resolved
  for (const name of ['apps', 'drivers', 'tools', 'vendors']) {
    for (const item of catalogs[name]?.items ?? []) {
      if (item.verification_status === 'verified' && item.reviewed_at && item.reviewed_at.slice(0, 10) > today) err(`${name}.json "${item.id}": reviewed_at is in the future`);
    }
  }
  return errors;
}

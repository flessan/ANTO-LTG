// Merging crawler proposals into a catalog document.
//
// Hard rules (tests/crawler/merge.test.mjs):
//  * publication is computed by the rules in scripts/lib/publication.mjs, never copied from a proposal;
//  * a proposal can never change verification_status, reviewed_at, review_notes, evidence_url,
//    windows_compatibility, human-written text (notes, *_id fields) or a record's id;
//  * new records enter as not_reviewed (no human has checked them) and are published only when the
//    automated rules pass; an ineligible new record is skipped and listed with its failing rules;
//  * an existing record that stops passing the rules is marked publication.state "unavailable";
//  * a record that a human has verified is never overwritten - differences are reported as
//    "drift" so a person can re-review;
//  * proposals carrying blocking quality flags are skipped unless explicitly allowed;
//  * duplicates are detected by stable key (winget id / canonical URL / id), never by name alone.
import { slugify, canonicalUrl } from './normalize.mjs';
import { evaluate, publicationFor } from '../../lib/publication.mjs';

export const BLOCKING_FLAGS = {
  apps: [],
  drivers: ['vendor_device_mismatch', 'filename_vendor_mismatch', 'filename_version_mismatch', 'non_english_name', 'multi_device_row', 'generic_device_name', 'date_inconsistent'],
};

// Data fields a crawler is allowed to refresh on an unverified record.
const OVERWRITE = {
  apps: ['version', 'release_date', 'compatibility', 'architectures', 'installer_types', 'installer_scopes', 'elevation', 'portable', 'downloads', 'license', 'license_url', 'quality_flags', 'publication'],
  drivers: ['version', 'release_date', 'file_size_text', 'file_size_bytes', 'os_support', 'windows_versions', 'architectures', 'hardware_ids', 'download', 'quality_flags', 'publication'],
};
const FILL_IF_MISSING = {
  apps: ['name', 'publisher', 'description', 'category', 'source_url', 'source_kind', 'winget_id'],
  drivers: ['name', 'publisher', 'manufacturer', 'model', 'component', 'kind', 'description', 'source_url', 'source_kind', 'official_source', 'vendor_id', 'hardware_family'],
};
const NEVER = new Set(['id', 'verification_status', 'reviewed_at', 'review_notes', 'evidence_url', 'windows_compatibility', 'notes', 'notes_id', 'description_id', 'added_at']);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function findExisting(catalog, items, record) {
  if (catalog === 'apps' && record.winget_id) {
    const hit = items.find((i) => i.winget_id && i.winget_id.toLowerCase() === record.winget_id.toLowerCase());
    if (hit) return hit;
  }
  const byId = items.find((i) => i.id === record.id);
  if (byId && (catalog !== 'apps' || !byId.winget_id || !record.winget_id || byId.winget_id.toLowerCase() === record.winget_id.toLowerCase())) return byId;
  const canon = canonicalUrl(record.source_url);
  if (catalog === 'apps' && canon) {
    const byUrl = items.find((i) => canonicalUrl(i.source_url) === canon && (!i.winget_id || !record.winget_id));
    if (byUrl) return byUrl;
  }
  return null;
}

export function uniqueId(items, record) {
  const taken = new Set(items.map((i) => i.id));
  const candidates = [record.id, slugify(`${record.publisher} ${record.name}`), slugify(`${record.publisher} ${record.name} ${record.winget_id ?? ''}`)].filter(Boolean);
  for (const c of candidates) if (!taken.has(c)) return c;
  for (let n = 2; n < 100; n++) { const c = `${candidates[0]}-${n}`.slice(0, 80); if (!taken.has(c)) return c; }
  throw new Error(`Cannot find a unique id for ${record.name}`);
}

function mergeSources(existing = [], incoming = []) {
  const out = existing.filter((s) => !incoming.some((n) => n.id === s.id));
  return [...out, ...incoming];
}

export function planMerge({ catalog, doc, proposals, today, allowFlagged = false }) {
  const items = doc.items.map((i) => structuredClone(i));
  const actions = [];
  for (const p of proposals) {
    const record = structuredClone(p.record);
    const flags = p.meta?.quality_flags ?? [];
    const blocking = flags.filter((f) => (BLOCKING_FLAGS[catalog] ?? []).includes(f));
    if (blocking.length && !allowFlagged) { actions.push({ type: 'skip', reason: 'blocking_quality_flags', flags: blocking, target: p.target }); continue; }
    if (record.verification_status !== 'not_reviewed') { actions.push({ type: 'skip', reason: 'proposal_claims_review', target: p.target }); continue; }

    const now = `${today}T00:00:00.000Z`;
    const verdict = evaluate(catalog, record);
    const existing = findExisting(catalog, items, record);
    if (!verdict.eligible) {
      if (existing && existing.verification_status !== 'verified' && existing.publication?.state !== 'unavailable') {
        existing.publication = { ...existing.publication, state: 'unavailable', checked_at: now, checks: verdict.checks, problems: verdict.problems };
        actions.push({ type: 'unavailable', id: existing.id, target: p.target, problems: verdict.problems });
      } else {
        actions.push({ type: 'skip', reason: 'ineligible', problems: verdict.problems, target: p.target });
      }
      continue;
    }
    record.publication = publicationFor(catalog, record, { now });

    if (!existing) {
      record.id = uniqueId(items, record);
      record.added_at = today;
      items.push(record);
      actions.push({ type: 'add', id: record.id, target: p.target });
      continue;
    }
    if (existing.verification_status === 'verified') {
      const drift = OVERWRITE[catalog].filter((f) => f in record && f !== 'publication' && !same(record[f], existing[f]));
      actions.push(drift.length ? { type: 'drift', id: existing.id, target: p.target, fields: drift } : { type: 'unchanged', id: existing.id, target: p.target });
      continue;
    }
    const changed = [];
    for (const f of OVERWRITE[catalog]) {
      if (NEVER.has(f)) continue;
      if (f === 'publication') {
        // checked_at moves every run; only a real change in state, method or rule results counts.
        const { checked_at: _a, ...nextPub } = record.publication ?? {};
        const { checked_at: _b, ...prevPub } = existing.publication ?? {};
        if (!same(nextPub, prevPub)) { existing.publication = record.publication; changed.push(f); }
        continue;
      }
      if (f in record) { if (!same(record[f], existing[f])) { existing[f] = record[f]; changed.push(f); } }
      else if (f in existing && ['quality_flags'].includes(f)) { delete existing[f]; changed.push(f); }
    }
    for (const f of FILL_IF_MISSING[catalog]) {
      if (NEVER.has(f)) continue;
      if ((existing[f] === undefined || existing[f] === null || existing[f] === '') && record[f] !== undefined) { existing[f] = record[f]; changed.push(f); }
    }
    if (record.tags?.length) {
      const merged = [...new Set([...(existing.tags ?? []), ...record.tags])].slice(0, 12);
      if (!same(merged, existing.tags ?? [])) { existing.tags = merged; changed.push('tags'); }
    }
    const sources = mergeSources(existing.sources, record.sources);
    if (!same(sources, existing.sources)) { existing.sources = sources; changed.push('sources'); }
    actions.push(changed.length ? { type: 'update', id: existing.id, target: p.target, fields: [...new Set(changed)] } : { type: 'unchanged', id: existing.id, target: p.target });
  }
  const changedAnything = actions.some((a) => a.type === 'add' || a.type === 'update');
  return { doc: { ...doc, items, updated_at: changedAnything ? `${today}T00:00:00.000Z` : doc.updated_at ?? null }, actions };
}

export function summarize(actions) {
  const counts = {};
  for (const a of actions) counts[a.type] = (counts[a.type] ?? 0) + 1;
  return counts;
}

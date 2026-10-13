// Filtering and sorting of the driver source finder. Unknown stays unknown: a record with no stated OS or
// architecture never matches an active OS / architecture filter.
export const DEFAULT_DRIVER_FILTERS = Object.freeze({ q: '', vendor: '', component: '', os: '', arch: '', source: '', review: '', directOnly: false, sort: 'relevance' });

export function filterDrivers(drivers, f, { searcher = null } = {}) {
  const filters = { ...DEFAULT_DRIVER_FILTERS, ...f };
  let scored = null;
  if (filters.q.trim()) {
    if (!searcher) throw new Error('A searcher is required for text queries');
    scored = new Map(searcher.search(filters.q, { types: ['driver'], limit: 5000 }).map((r) => [r.doc.id, r.score]));
  }
  const out = drivers.filter((d) => {
    if (scored && !scored.has(d.id)) return false;
    if (filters.vendor && d.vendor_id !== filters.vendor) return false;
    if (filters.component && d.component !== filters.component) return false;
    if (filters.review && d.verification_status !== filters.review) return false;
    if (filters.source === 'official' && d.source_kind === 'third_party_aggregator') return false;
    if (filters.source === 'lead' && d.source_kind !== 'third_party_aggregator') return false;
    if (filters.directOnly && d.download?.kind !== 'direct_binary') return false;
    if (filters.os && !(d.os_support ?? []).some((o) => o.os === filters.os)) return false;
    if (filters.arch && !(d.architectures ?? []).includes(filters.arch)) return false;
    return true;
  });
  const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  const date = (d) => d.release_date ?? '';
  if (filters.sort === 'newest') out.sort((a, b) => (date(b) > date(a) ? 1 : date(b) < date(a) ? -1 : byName(a, b)));
  else if (filters.sort === 'name') out.sort(byName);
  else if (filters.sort === 'manufacturer') out.sort((a, b) => a.manufacturer.localeCompare(b.manufacturer, 'en') || byName(a, b));
  else if (scored) out.sort((a, b) => scored.get(b.id) - scored.get(a.id) || (date(b) > date(a) ? 1 : date(b) < date(a) ? -1 : 0) || byName(a, b));
  else out.sort((a, b) => Number(a.source_kind === 'third_party_aggregator') - Number(b.source_kind === 'third_party_aggregator') || a.manufacturer.localeCompare(b.manufacturer, 'en') || byName(a, b));
  return out;
}

// Which of the evidence-based statements can the card make about a driver record?
export function describeTrust(d) {
  const lead = d.source_kind === 'third_party_aggregator';
  const hasHash = Boolean(d.download?.sha256 || d.download?.sha512);
  const direct = d.download?.kind === 'direct_binary';
  return { lead, official: !lead, hasHash, direct, flags: d.quality_flags ?? [] };
}

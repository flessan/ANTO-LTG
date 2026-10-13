// Filtering and sorting of the Software Center catalog. Pure functions, unit-tested.
import { installMethods, compatFor, displayRank } from './model.js';

export const DEFAULT_FILTERS = Object.freeze({ q: '', category: '', os: '', arch: '', method: '', review: '', declaredOnly: false, sort: 'name' });

// Rules that matter for trust:
//  * "unknown" never matches an active architecture filter (we do not guess);
//  * an OS filter hides apps whose source says they need a newer Windows, but keeps unknown ones
//    unless "declared only" is ticked - each card shows its own compatibility state.
export function filterApps(apps, f, { searcher = null } = {}) {
  const filters = { ...DEFAULT_FILTERS, ...f };
  let scored = null;
  if (filters.q.trim()) {
    if (!searcher) throw new Error('A searcher is required for text queries');
    scored = new Map(searcher.search(filters.q, { types: ['app'], limit: 5000 }).map((r) => [r.doc.id, r.score]));
  }
  const out = apps.filter((a) => {
    if (scored && !scored.has(a.id)) return false;
    if (filters.category && a.category !== filters.category) return false;
    if (filters.review && a.verification_status !== filters.review) return false;
    if (filters.os) {
      const c = compatFor(a, filters.os);
      if (c === 'unsupported') return false;
      if (filters.declaredOnly && c !== 'declared') return false;
    }
    if (filters.arch) {
      const archs = a.architectures ?? [];
      if (!archs.includes(filters.arch) && !archs.includes('neutral')) return false;
    }
    if (filters.method) {
      const m = installMethods(a);
      if (filters.method === 'winget' && !m.winget) return false;
      if (filters.method === 'direct' && !m.direct) return false;
      if (filters.method === 'page' && m.primary !== 'page') return false;
      if (filters.method === 'unavailable' && !m.unavailable) return false;
    }
    return true;
  });
  const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  if (scored && filters.sort === 'relevance') out.sort((a, b) => scored.get(b.id) - scored.get(a.id) || byName(a, b));
  else if (filters.sort === 'category') out.sort((a, b) => displayRank(a.category) - displayRank(b.category) || byName(a, b));
  else out.sort(byName);
  return out;
}

export function groupByCategory(apps) {
  const groups = new Map();
  for (const a of apps) { if (!groups.has(a.category)) groups.set(a.category, []); groups.get(a.category).push(a); }
  return [...groups.entries()].sort(([x], [y]) => displayRank(x) - displayRank(y));
}

// A stable hue in the blue-to-green range, so generated icon tiles never drift into purple or pink.
export function iconHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 150 + (h % 66);
}
export function iconLetters(name) {
  const words = name.replace(/[^A-Za-z0-9+ ]/g, ' ').split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

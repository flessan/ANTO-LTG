// Inverted-index search. buildIndex() runs at build time (scripts/build.mjs);
// createSearcher() runs in the browser against api/v1/search-index.json.
import { tokenize, normalizeText, editDistanceAtMostOne } from './text.js';

export const INDEX_FORMAT = 'anto-ltg.search-index/1';

// Field weights: an exact name or identifier match must outrank a mention in a description.
export const FIELD_WEIGHTS = {
  name: 8, ids: 7, hardware_ids: 6, publisher: 4, model: 4, tags: 3, category: 3, component: 3, description: 1, extra: 1,
};

// docs: [{ type, id, title, subtitle, url, fields: { name: string|string[], ... } }]
export function buildIndex(docs) {
  const postings = new Map();
  const outDocs = docs.map((doc, docIdx) => {
    const perToken = new Map();
    for (const [field, raw] of Object.entries(doc.fields)) {
      const weight = FIELD_WEIGHTS[field] ?? 1;
      for (const text of Array.isArray(raw) ? raw : [raw]) {
        for (const tok of tokenize(text)) perToken.set(tok, Math.max(perToken.get(tok) ?? 0, weight));
      }
    }
    for (const [tok, w] of perToken) {
      if (!postings.has(tok)) postings.set(tok, []);
      postings.get(tok).push(docIdx, w);
    }
    return { type: doc.type, id: doc.id, title: doc.title, subtitle: doc.subtitle ?? '', url: doc.url, norm: normalizeText(doc.title) };
  });
  const tokens = [...postings.keys()].sort();
  return {
    format: INDEX_FORMAT,
    docs: outDocs,
    tokens,
    postings: tokens.map((t) => postings.get(t)),
  };
}

function lowerBound(arr, prefix) {
  let lo = 0; let hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < prefix) lo = mid + 1; else hi = mid; }
  return lo;
}

export function createSearcher(index) {
  if (!index || index.format !== INDEX_FORMAT) throw new Error('Unsupported search index format');
  const { docs, tokens, postings } = index;

  function matchToken(tok) {
    const hits = new Map(); // docIdx -> score
    const add = (postingIdx, factor) => {
      const list = postings[postingIdx];
      for (let i = 0; i < list.length; i += 2) {
        const d = list[i]; const s = list[i + 1] * factor;
        if (s > (hits.get(d) ?? 0)) hits.set(d, s);
      }
    };
    const exact = lowerBound(tokens, tok);
    if (tokens[exact] === tok) add(exact, 1);
    if (tok.length >= 2) {
      for (let i = lowerBound(tokens, tok); i < tokens.length && tokens[i].startsWith(tok); i++) if (tokens[i] !== tok) add(i, 0.6);
    }
    if (!hits.size && tok.length >= 4) {
      for (let i = 0; i < tokens.length; i++) if (tokens[i][0] === tok[0] && editDistanceAtMostOne(tok, tokens[i])) add(i, 0.3);
    }
    return hits;
  }

  function search(query, { types = null, limit = 50, allow = null } = {}) {
    const qTokens = tokenize(query).filter((t) => t.length >= 1);
    const qNorm = normalizeText(query);
    if (!qTokens.length) return [];
    // Query tokens come from tokenize(), which also adds a joined form ("7 zip" -> "7zip");
    // treat the joined form as an alternative, not as an extra required word.
    const words = normalizeText(query).split(' ').filter(Boolean);
    const required = words.length ? words : qTokens;
    const perWord = required.map((w) => matchToken(w));
    const joined = words.length > 1 && words.length <= 5 ? matchToken(words.join('')) : null;
    let candidates = null;
    for (const hits of perWord) {
      const keys = new Set(hits.keys());
      candidates = candidates === null ? keys : new Set([...candidates].filter((d) => keys.has(d)));
    }
    const scores = new Map();
    for (const d of candidates ?? []) scores.set(d, perWord.reduce((n, hits) => n + (hits.get(d) ?? 0), 0));
    if (joined) for (const [d, s] of joined) scores.set(d, Math.max(scores.get(d) ?? 0, s * required.length));
    if (!scores.size && required.length > 1) {
      // Fall back to "any word" ranking so a long query still gives suggestions.
      for (const hits of perWord) for (const [d, s] of hits) scores.set(d, (scores.get(d) ?? 0) + s * 0.5);
    }
    const out = [];
    for (const [d, score] of scores) {
      const doc = docs[d];
      if (types && !types.includes(doc.type)) continue;
      if (allow && !allow.has(`${doc.type}:${doc.id}`)) continue;
      let bonus = 0;
      if (doc.norm === qNorm) bonus += 50;
      else if (doc.norm.startsWith(qNorm)) bonus += 20;
      else if (doc.norm.includes(qNorm)) bonus += 8;
      out.push({ doc, score: score + bonus });
    }
    out.sort((a, b) => b.score - a.score || (a.doc.title < b.doc.title ? -1 : a.doc.title > b.doc.title ? 1 : 0));
    return out.slice(0, limit);
  }

  return { search, size: docs.length };
}

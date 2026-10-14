// `crawl suggest <PackageId>...` - helps a maintainer FIX a seed entry whose WinGet ID was not
// found. It never changes any file: it only lists IDs that really exist in winget-pkgs, found
// by (1) a case-insensitive look at the publisher directory and (2) GitHub path search.
import path from 'node:path';
import { createHttpClient } from '../lib/http.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { githubAuth } from './crawl.mjs';

export async function suggest({ positional, flags, log = console.log }) {
  const cfg = await loadConfig();
  const a = cfg.adapters.winget;
  const auth = githubAuth();
  const client = createHttpClient({
    userAgent: cfg.user_agent, allowedHosts: a.hosts, perHostMinIntervalMs: 150,
    hostRules: { 'api.github.com': { minIntervalMs: 150, concurrency: 2 } },
    auth: auth ? { 'api.github.com': auth } : {}, cacheDir: path.resolve(repoRoot, cfg.cache_dir),
  });
  const api = 'https://api.github.com';
  const getJson = async (url) => {
    const res = await client.fetch(url, { accept: 'application/vnd.github+json', robots: false });
    return res.status === 200 ? res.json() : null;
  };
  const letterCache = new Map();
  const publishers = async (letter) => {
    if (!letterCache.has(letter)) {
      const doc = await getJson(`${api}/repos/${a.repo}/git/trees/${a.branch}:manifests/${encodeURIComponent(letter)}`);
      letterCache.set(letter, doc ? doc.tree.filter((t) => t.type === 'tree').map((t) => t.path) : []);
    }
    return letterCache.get(letter);
  };
  const results = {};
  for (const id of positional) {
    const [first, ...rest] = id.split('.');
    const needle = rest.join('.').toLowerCase().replace(/[^a-z0-9]/g, '');
    const found = new Set();
    const pubs = (await publishers(first[0].toLowerCase())).filter((p) => p.toLowerCase() === first.toLowerCase() || p.toLowerCase().includes(first.toLowerCase()) || (p.length >= 4 && first.toLowerCase().includes(p.toLowerCase())));
    for (const pub of pubs.slice(0, 3)) {
      const doc = await getJson(`${api}/repos/${a.repo}/git/trees/${a.branch}:manifests/${first[0].toLowerCase()}/${encodeURIComponent(pub)}`);
      for (const t of doc?.tree ?? []) if (t.type === 'tree') found.add(`${pub}.${t.path}`);
    }
    let list = [...found];
    const score = (cand) => { const c = cand.toLowerCase().replace(/[^a-z0-9]/g, ''); return c.includes(needle) || needle.includes(c.split(first.toLowerCase())[1] ?? '#') ? 0 : 1; };
    list.sort((x, y) => score(x) - score(y) || x.localeCompare(y));
    if (!list.some((c) => score(c) === 0) && !flags['no-search']) {
      // Fall back to a path search for the package name (GitHub code search: ~10 requests/minute).
      await new Promise((r) => setTimeout(r, 6500));
      const q = encodeURIComponent(`${rest.join(' ') || first} in:path repo:${a.repo} path:manifests`);
      const doc = await getJson(`${api}/search/code?q=${q}&per_page=10`);
      for (const item of doc?.items ?? []) {
        const m = item.path.match(/^manifests\/[^/]+\/(.+)\/[^/]+\/([^/]+)$/);
        if (m) found.add(m[2].replace(/\.(installer|locale\.[^.]+(\.[^.]+)?)?\.yaml$/, '').replace(/\.yaml$/, ''));
      }
      list = [...found].filter((c) => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(c)).sort((x, y) => score(x) - score(y) || x.localeCompare(y));
    }
    results[id] = list.slice(0, 6);
    log(`${id.padEnd(40)} -> ${results[id].join(', ') || '(no suggestion)'}`);
  }
  return results;
}

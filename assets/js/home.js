import { t, tn, fetchJson, h, clear, icon, sitePath } from './site.js';
import { createSearcher } from './lib/search.js';
import { loadVisuals, visualImg } from './lib/visuals.js';

const form = document.getElementById('home-form'); const input = document.getElementById('home-q'); const list = document.getElementById('home-results'); const stats = document.getElementById('home-stats');
let searcher = null; let loading = null;

const ICON = { app: 'software', driver: 'chip', vendor: 'globe', tool: 'wrench', bundle: 'bundle', page: 'home' };
// Result type -> visual group. Records show their own logo or glyph; pages keep a vector icon.
const GROUP = { app: 'apps', driver: 'drivers', vendor: 'vendors', tool: 'tools', bundle: 'bundles' };
const resultVisual = (doc) => (GROUP[doc.type] ? h('span', { class: 'app-icon sm' }, visualImg(GROUP[doc.type], doc.id, { size: 24 })) : h('span', { class: 'orb sm' }, icon(ICON[doc.type] ?? 'info')));
const TYPE_KEY = { app: 'type.app', driver: 'type.driver', vendor: 'type.vendor', tool: 'type.tool', bundle: 'type.bundle', page: 'type.page' };

async function ensureSearcher() {
  loading ??= fetchJson('api/v1/search-index.json').then((idx) => { searcher = createSearcher(idx); return searcher; });
  return loading;
}

async function run() {
  const q = input.value.trim();
  clear(list);
  if (!q) return;
  try {
    const s = await ensureSearcher();
    await loadVisuals();
    const hits = s.search(q, { limit: 8 });
    if (!hits.length) { list.append(h('li', { class: 'notice' }, icon('info'), h('div', {}, t('home.no_results', { q })))); return; }
    for (const { doc } of hits) {
      const url = new URL(doc.url, new URL(sitePath(''), location.origin));
      list.append(h('li', {}, h('a', { href: `${url.pathname}${url.hash}` }, resultVisual(doc), h('span', {}, h('span', { class: 'sr-title' }, doc.title), h('br'), h('span', { class: 'sr-sub' }, doc.subtitle)), h('span', { class: 'chip info' }, t(TYPE_KEY[doc.type] ?? 'type.page')))));
    }
  } catch { list.append(h('li', { class: 'notice error', role: 'alert' }, icon('warn'), h('div', {}, t('common.load_error')))); }
}

let timer = 0;
input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 160); });
form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
document.addEventListener('anto:lang', run);

async function loadStats() {
  try {
    const idx = await fetchJson('api/v1/index.json');
    const s = idx.stats;
    clear(stats);
    const item = (n, key) => h('span', {}, h('strong', {}, String(n)), ' ', tn(key, n));
    stats.append(item(s.apps.total, 'home.stat.apps'), item(s.drivers.total, 'home.stat.drivers'), item(s.vendors.total, 'home.stat.vendors'), h('span', {}, h('strong', {}, String(s.publication.published)), ' ', t('home.stat.published')), h('span', {}, h('strong', {}, String(s.review.verified)), ' ', t('home.stat.verified')));
  } catch { /* the stats strip is optional */ }
}
loadStats();
document.addEventListener('anto:lang', loadStats);

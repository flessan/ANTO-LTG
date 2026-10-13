import { t, tn, getLang, loadCatalog, fetchJson, icon, h, clear, sitePath } from './site.js';
import { CATEGORIES, displayRank, categoryLabel, localized, installMethods } from './lib/model.js';
import { createSearcher } from './lib/search.js';
import { safeHttpUrl } from './lib/html.js';
import { loadVisuals, visualImg } from './lib/visuals.js';

const $ = (id) => document.getElementById(id);
let tools = []; let apps = new Map(); let searcher = null;

const chip = (kind, ic, label) => h('span', { class: `chip ${kind}` }, icon(ic), h('span', {}, label));
const extLink = (href, text) => { const s = safeHttpUrl(href); return s ? h('a', { href: s, target: '_blank' }, text, ' ', icon('external')) : null; };

function card(tool) {
  const lang = getLang(); const app = tool.app_id ? apps.get(tool.app_id) : null; const m = app ? installMethods(app) : null;
  const pick = (f) => (lang === 'id' && tool[`${f}_id`]?.length ? tool[`${f}_id`] : tool[f] ?? []);
  return h('article', { class: 'card', id: tool.id },
    h('header', {}, h('span', { class: 'app-icon lg' }, visualImg('tools', tool.id, { size: 36 })), h('div', {}, h('h2', {}, tool.name), h('div', { class: 'small muted' }, `${tool.publisher} - ${categoryLabel(tool.category, lang)}`))),
    h('p', {}, localized(tool, 'description', lang)),
    h('div', { class: 'chip-list' }, tool.bootable_media ? chip('info', 'disc', t('tools.chip.boot')) : null, tool.portable ? chip('info', 'folder', t('sw.portable')) : null, tool.requires_admin === 'yes' ? chip('pending', 'lock', t('tools.chip.admin')) : null,
      tool.verification_status === 'verified' ? chip('verified', 'shield', t('review.verified')) : chip('unknown', 'clock', t('review.not_reviewed')), m ? chip(m.primary === 'unavailable' ? 'unavailable' : m.primary === 'winget' ? 'winget' : m.primary === 'direct' ? 'direct' : 'page', m.primary === 'winget' ? 'box' : m.primary === 'direct' ? 'download' : 'globe', t(`chip.${m.primary}`)) : null),
    pick('use_cases').length ? h('div', {}, h('h3', {}, t('tools.use')), h('ul', {}, pick('use_cases').map((x) => h('li', {}, x)))) : null,
    pick('cautions').length ? h('div', { class: 'notice warn' }, icon('warn'), h('div', {}, h('strong', {}, t('tools.caution')), h('ul', {}, pick('cautions').map((x) => h('li', {}, x))))) : null,
    h('div', { class: 'row' }, app ? h('a', { class: 'btn-aero green sm', href: `${sitePath('software/')}#apps=${encodeURIComponent(app.id)}` }, icon('plus'), t('tools.add')) : null, app ? h('a', { class: 'btn-aero ghost sm', href: `${sitePath('software/')}#app=${encodeURIComponent(app.id)}` }, icon('info'), t('sw.details')) : null, extLink(tool.source_url, t('sw.publisher_page'))));
}

function render() {
  const q = $('t-q').value.trim(); const cat = $('t-cat').value;
  let items = tools;
  if (q) { const ids = new Set(searcher.search(q, { types: ['tool'], limit: 500 }).map((r) => r.doc.id)); items = items.filter((x) => ids.has(x.id)); }
  if (cat) items = items.filter((x) => x.category === cat);
  if ($('t-boot').checked) items = items.filter((x) => x.bootable_media);
  if ($('t-portable').checked) items = items.filter((x) => x.portable);
  const list = $('t-list'); list.setAttribute('aria-busy', 'false'); clear(list);
  $('t-count').textContent = tn('tools.count', items.length, { total: tools.length });
  if (!items.length) { list.append(h('div', { class: 'empty' }, h('span', { class: 'orb aqua' }, icon('search')), h('h2', {}, t('sw.empty.title')), h('p', {}, t('sw.empty.text')))); return; }
  for (const x of items) list.append(card(x));
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

function fillCats() {
  const sel = $('t-cat'); const keep = sel.value; clear(sel); sel.append(h('option', { value: '' }, t('common.all')));
  const used = new Set(tools.map((x) => x.category));
  for (const c of [...CATEGORIES].sort((a, b) => displayRank(a.id) - displayRank(b.id))) if (used.has(c.id)) sel.append(h('option', { value: c.id }, c.label[getLang()]));
  sel.value = keep;
}

(async () => {
  try {
    const [tl, ap, idx] = await Promise.all([loadCatalog('tools'), loadCatalog('apps'), fetchJson('api/v1/search-index.json'), loadVisuals()]);
    tools = tl.items.sort((a, b) => a.name.localeCompare(b.name)); apps = new Map(ap.items.map((a) => [a.id, a])); searcher = createSearcher(idx);
    fillCats(); render();
    const f = $('t-filters'); let timer = 0;
    f.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 140); });
    f.addEventListener('submit', (e) => e.preventDefault());
    f.addEventListener('reset', () => setTimeout(render, 0));
    document.addEventListener('anto:lang', () => { fillCats(); render(); });
  } catch (err) { const l = $('t-list'); l.setAttribute('aria-busy', 'false'); clear(l); l.append(h('div', { class: 'notice error', role: 'alert' }, icon('warn'), h('div', {}, h('strong', {}, t('common.load_error')), h('p', { class: 'small mono' }, String(err.message))))); }
})();

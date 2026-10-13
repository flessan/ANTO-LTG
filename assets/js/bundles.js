import { t, tn, getLang, loadCatalog, toast, downloadText, copyText, icon, h, clear, sitePath } from './site.js';
import { installMethods, localized } from './lib/model.js';
import { planInstall, buildWingetScript } from './lib/psgen.js';
import { encodeShare } from './lib/bundle.js';
import { iconHue, iconLetters } from './lib/apps-filter.js';
import { safeHttpUrl } from './lib/html.js';

const list = document.getElementById('b-list');
let apps = new Map(); let bundles = []; let meta = {};

function tile(app) {
  const el = h('span', { class: 'app-icon', 'aria-hidden': 'true' }, iconLetters(app.name));
  el.style.setProperty('--h', String(iconHue(app.id)));
  return el;
}
function bundleCard(b) {
  const members = b.app_ids.map((id) => apps.get(id)).filter(Boolean);
  const plan = planInstall({ apps: members, os: 'windows11', method: 'winget' });
  const openUrl = `${sitePath('software/')}#${encodeShare({ ids: b.app_ids, os: 'windows11', method: 'winget', name: b.name })}`;
  const lang = getLang();
  return h('article', { class: 'card', id: b.id },
    h('header', {}, h('span', { class: 'orb green' }, icon('bundle')), h('div', {}, h('h2', {}, lang === 'id' && b.name_id ? b.name_id : b.name), h('div', { class: 'small muted' }, tn('bundles.count', members.length, { wg: plan.included.length, manual: plan.manual.length })))),
    h('p', {}, localized(b, 'description', lang)),
    h('div', { class: 'chip-list' }, members.map((a) => h('span', { class: 'chip', title: a.name }, tile(a), a.name))),
    plan.manual.length ? h('div', { class: 'notice warn' }, icon('info'), h('div', {}, h('strong', {}, tn('bundles.manual', plan.manual.length)), h('ul', {}, plan.manual.map((m) => h('li', {}, m.app.name, ' ', safeHttpUrl(m.link) ? h('a', { href: safeHttpUrl(m.link), target: '_blank' }, t('sw.publisher_page'), ' ', icon('external')) : null))))) : null,
    (b.notes || b.notes_id) ? h('p', { class: 'small muted' }, localized(b, 'notes', lang)) : null,
    h('div', { class: 'row' },
      h('a', { class: 'btn-aero green sm', href: openUrl }, icon('software'), t('bundles.open')),
      h('button', { type: 'button', class: 'btn-aero ghost sm', disabled: !plan.included.length, onclick: () => { try { downloadText('anto-ltg-install.ps1', buildWingetScript({ plan, meta: { bundleName: b.name, generatedAt: new Date().toISOString(), schemaVersion: meta.schema_version, catalogUpdated: meta.updated_at } }), 'text/plain', { bom: true }); toast(t('sw.toast.downloaded'), { ms: 8000 }); } catch { toast(t('sw.toast.nothing'), { type: 'error' }); } } }, icon('download'), t('bundles.script')),
      h('button', { type: 'button', class: 'btn-aero ghost sm', onclick: async () => toast(t((await copyText(`${location.origin}${openUrl}`)) ? 'sw.toast.share' : 'common.copy_failed')) }, icon('share'), t('sw.in.share'))));
}
function render() {
  list.setAttribute('aria-busy', 'false'); clear(list);
  const published = bundles.filter((b) => b.status === 'published');
  if (!published.length) { list.append(h('div', { class: 'empty' }, h('span', { class: 'orb aqua' }, icon('bundle')), h('h2', {}, t('bundles.empty')))); return; }
  for (const b of published) list.append(bundleCard(b));
}
(async () => {
  try {
    const [a, b] = await Promise.all([loadCatalog('apps'), loadCatalog('bundles')]);
    apps = new Map(a.items.map((x) => [x.id, x])); bundles = b.items; meta = { schema_version: a.schema_version, updated_at: a.updated_at };
    render(); document.addEventListener('anto:lang', render);
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  } catch (err) { list.setAttribute('aria-busy', 'false'); clear(list); list.append(h('div', { class: 'notice error', role: 'alert' }, icon('warn'), h('div', {}, h('strong', {}, t('common.load_error')), h('p', { class: 'small mono' }, String(err.message))))); }
})();

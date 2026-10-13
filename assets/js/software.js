// Software Center: sourced catalog, persistent Ninite-style selection and WinGet script generator.
// The browser NEVER installs or runs anything: it only builds text that the person reviews and runs.
import { t, tn, getLang, loadCatalog, fetchJson, toast, confirmDialog, openDialog, downloadText, copyText, icon, h, clear, applyI18n } from './site.js';
import { createSearcher } from './lib/search.js';
import { filterApps, groupByCategory, DEFAULT_FILTERS } from './lib/apps-filter.js';
import { loadVisuals, visualImg, photoPicture, pagePhotoId } from './lib/visuals.js';
import { CATEGORIES, displayRank, categoryLabel, installMethods, compatFor, versionInfo, daysSince, localized, OS_TARGETS } from './lib/model.js';
import { planInstall, buildWingetScript, buildDownloadKitScript, buildWingetImport, commandLine } from './lib/psgen.js';
import { createManifest, manifestToJson, parseManifest, encodeShare, decodeShare, cleanName, MAX_MANIFEST_BYTES } from './lib/bundle.js';
import { createStorage, loadSelection, saveSelection, loadBundles, saveBundle, deleteBundle } from './lib/storage.js';
import { safeHttpUrl } from './lib/html.js';
import { publicationState, provenanceOf, isVerified } from './lib/status.js';

const $ = (id) => document.getElementById(id);
const storage = createStorage();
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

const state = {
  apps: [], byId: new Map(), searcher: null, meta: {}, filters: { ...DEFAULT_FILTERS }, view: 'quick', visible: [],
  selection: new Set(), os: 'windows11', method: 'winget', name: '', options: { silent: true, acceptAgreements: true, includeUnknown: true },
};
let ui = null;

// ---- small view helpers ---------------------------------------------------------------------------------
const METHOD_CHIP = {
  winget: ['winget', 'box', 'chip.winget'], direct: ['direct', 'download', 'chip.direct'], redirect: ['redirect', 'external', 'chip.redirect'],
  page: ['page', 'globe', 'chip.page'], unavailable: ['unavailable', 'close', 'chip.unavailable'],
};
function chip(kind, iconName, label, title) {
  return h('span', { class: `chip ${kind}`, title: title || undefined }, icon(iconName), h('span', {}, label));
}
function methodChips(app, primaryOnly = false) {
  const m = installMethods(app);
  const keys = primaryOnly ? [m.primary] : (m.unavailable ? ['unavailable'] : m.list);
  return keys.map((k) => { const [cls, ic, key] = METHOD_CHIP[k]; return chip(cls, ic, t(key), t(`${key}.hint`)); });
}
function compatChip(app, os) {
  const c = compatFor(app, os);
  return chip(c === 'declared' ? 'declared' : c === 'unsupported' ? 'bad' : 'unknown', c === 'declared' ? 'check' : c === 'unsupported' ? 'close' : 'info', `${OS_TARGETS[os]}: ${t(`compat.${c}`)}`, t(`compat.${c}.hint`));
}
// Publication (the automated rules) and human review are two different facts, so they get two chips.
function statusChips(item) {
  const pub = publicationState(item) === 'unavailable'
    ? chip('unavailable', 'circle-x', t('pub.unavailable'), t('pub.unavailable.hint'))
    : chip('published', 'circle-check', t('pub.published'), t('pub.published.hint'));
  const review = isVerified(item)
    ? chip('verified', 'shield', t('review.verified'), t('review.verified.hint'))
    : chip('unknown', 'clock', t('review.not_reviewed'), t('review.not_reviewed.hint'));
  return [pub, review];
}
// Every software card shows the app's own logo (or, where no exact mark exists, its category glyph). See lib/visuals.js.
function iconTile(app, large = false) {
  return h('span', { class: `app-icon${large ? ' lg' : ''}` }, visualImg('apps', app.id, { size: large ? 48 : 28 }));
}
const extLink = (href, text) => { const safe = safeHttpUrl(href); return safe ? h('a', { href: safe, target: '_blank' }, text, ' ', icon('external')) : h('span', { class: 'unknown-text' }, text); };

// ---- selection ----------------------------------------------------------------------------------------------
const selectedApps = () => [...state.selection].map((id) => state.byId.get(id)).filter(Boolean);
function persist() { saveSelection(storage, { ids: [...state.selection], os: state.os, method: state.method }); }
function setSelection(ids, mode = 'replace') {
  const valid = ids.filter((id) => state.byId.has(id));
  if (mode === 'replace') state.selection = new Set(valid); else for (const id of valid) state.selection.add(id);
  persist(); render();
}
function toggle(id, on) {
  const app = state.byId.get(id);
  if (!app || installMethods(app).unavailable) return;
  if (on) state.selection.add(id); else state.selection.delete(id);
  persist(); render();
}

// ---- catalog results -----------------------------------------------------------------------------------------------
function readFilters() {
  const f = {
    q: $('sw-q').value, category: $('sw-cat').value, os: $('sw-os').value, arch: $('sw-arch').value, method: $('sw-method').value,
    status: $('sw-publication').value, sort: $('sw-sort').value, declaredOnly: $('sw-declared').checked,
  };
  if (f.q.trim() && f.sort === 'name' && !state.sortTouched) f.sort = 'relevance';
  return f;
}

function renderResults() {
  const box = $('sw-results');
  state.filters = readFilters();
  state.visible = filterApps(state.apps, state.filters, { searcher: state.searcher });
  const total = state.apps.length;
  $('sw-count').textContent = state.visible.length === total ? tn('sw.count_all', total) : t('sw.count_filtered', { n: state.visible.length, total });
  $('sw-status').textContent = t('sw.status', { date: String(state.meta.updated_at ?? '').slice(0, 10) || '-', schema: state.meta.schema_version ?? '-' });
  box.setAttribute('aria-busy', 'false');
  clear(box);
  if (!state.visible.length) {
    box.append(h('div', { class: 'empty' }, h('span', { class: 'orb aqua' }, icon('search')), h('h2', {}, t('sw.empty.title')), h('p', {}, t('sw.empty.text')), h('button', { type: 'button', class: 'btn-aero ghost', onclick: resetFilters }, t('common.reset'))));
    return;
  }
  if (state.view === 'quick') {
    for (const [cat, items] of groupByCategory(state.visible)) {
      const ul = h('ul', { class: 'qp-grid' }, items.map(quickItem));
      box.append(h('section', { class: 'qp-group', 'aria-labelledby': `qp-h-${cat}` }, h('h3', { class: 'qp-title', id: `qp-h-${cat}` }, categoryLabel(cat, getLang()), h('span', { class: 'count' }, `(${items.length})`)), ul));
    }
  } else {
    box.append(h('div', { class: 'app-list' }, state.visible.map(listCard)));
  }
}

function quickItem(app) {
  const m = installMethods(app); const sel = state.selection.has(app.id);
  const input = h('input', { type: 'checkbox', id: `qp-${app.id}`, dataset: { id: app.id }, checked: sel, disabled: m.unavailable });
  return h('li', { class: `qp-item${sel ? ' selected' : ''}${m.unavailable ? ' disabled' : ''}` },
    h('label', { for: `qp-${app.id}`, title: m.unavailable ? t('sw.unavailable_cannot_select') : undefined }, input, iconTile(app), h('span', { class: 'qp-name', title: app.name }, app.name)),
    h('span', { class: 'method' }, methodChips(app, true)),
    h('button', { type: 'button', class: 'info-btn', dataset: { info: app.id }, 'aria-label': t('sw.details_for', { name: app.name }), title: t('sw.details') }, icon('info')));
}

function listCard(app) {
  const m = installMethods(app); const sel = state.selection.has(app.id); const v = versionInfo(app);
  const os = state.filters.os || state.os;
  return h('article', { class: `app-card${sel ? ' selected' : ''}` },
    h('header', {},
      h('input', { type: 'checkbox', id: `ls-${app.id}`, dataset: { id: app.id }, checked: sel, disabled: m.unavailable, 'aria-label': t('sw.select_app', { name: app.name }) }),
      iconTile(app, true),
      h('div', { class: 'grow' }, h('h3', {}, app.name), h('div', { class: 'small muted' }, `${app.publisher} - ${categoryLabel(app.category, getLang())}`))),
    h('p', { class: 'desc' }, localized(app, 'description', getLang())),
    h('div', { class: 'meta' }, ...methodChips(app), compatChip(app, os), ...statusChips(app),
      v ? chip('info', 'clock', `v${v.value}`, t('sw.version_from', { source: v.source, date: v.retrieved_at })) : null,
      app.portable ? chip('info', 'folder', t('sw.portable')) : null),
    h('div', { class: 'links' }, extLink(app.source_url, t('sw.publisher_page')), h('button', { type: 'button', class: 'btn-aero ghost sm', dataset: { info: app.id } }, icon('info'), t('sw.details'))));
}

function resetFilters() {
  $('sw-filters').reset();
  state.sortTouched = false;
  renderResults();
}

// ---- details dialog (every fact with its source; unknown stays unknown) --------------------------------------------------
function kvRow(label, value) {
  const isEmpty = value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length);
  return [h('dt', {}, label), h('dd', {}, isEmpty ? h('span', { class: 'unknown-text' }, t('common.unknown')) : value)];
}
function showDetails(id) {
  const app = state.byId.get(id); if (!app) return;
  const m = installMethods(app); const v = versionInfo(app); const lang = getLang();
  const age = v ? daysSince(v.retrieved_at) : null;
  const body = h('div', { class: 'stack' });
  body.append(h('div', { class: 'row' }, iconTile(app, true), h('div', { class: 'grow' }, h('h2', {}, app.name), h('div', { class: 'muted' }, `${app.publisher} - ${categoryLabel(app.category, lang)}`))));
  body.append(h('p', {}, localized(app, 'description', lang)));
  body.append(h('div', { class: 'meta row' }, ...methodChips(app), ...statusChips(app), compatChip(app, 'windows11'), compatChip(app, 'windows10')));
  if (m.unavailable) body.append(h('div', { class: 'notice error' }, icon('warn'), h('div', {}, h('strong', {}, t('sw.unavailable_title')), h('p', {}, app.availability.reason), extLink(app.availability.evidence_url, t('sw.evidence')))));
  if (v && age !== null && age > 30) body.append(h('div', { class: 'notice warn' }, icon('warn'), h('div', {}, t('sw.version_stale', { days: age }))));

  const dl = h('dl', { class: 'kv' },
    ...kvRow(t('sw.d.version'), v ? h('span', {}, `${v.value}`, h('span', { class: 'muted small' }, ` - ${t('sw.version_from', { source: v.source, date: v.retrieved_at })}`)) : null),
    ...kvRow(t('sw.d.released'), app.release_date),
    ...kvRow(t('sw.d.arch'), (app.architectures ?? []).join(', ')),
    ...kvRow(t('sw.d.types'), (app.installer_types ?? []).join(', ')),
    ...kvRow(t('sw.d.elevation'), (app.elevation ?? []).join(', ')),
    ...kvRow(t('sw.d.license'), app.license ? (app.license_url ? extLink(app.license_url, app.license) : app.license) : null),
    ...kvRow(t('sw.d.compat'), app.compatibility?.min_os_version ? t('sw.d.compat_min', { version: app.compatibility.min_os_version, basis: app.compatibility.basis ?? '' }) : t('sw.d.compat_none')),
    ...kvRow(t('sw.d.page'), extLink(app.source_url, app.source_url)),
    ...kvRow(t('sw.d.tags'), (app.tags ?? []).join(', ')),
  );
  body.append(dl);
  if (app.notes || app.notes_id) body.append(h('p', {}, localized(app, 'notes', lang)));

  if (m.winget) {
    const cmd = commandLine(app.winget_id);
    body.append(h('section', {}, h('h3', {}, t('sw.d.winget')), h('div', { class: 'row' }, h('code', {}, cmd), h('button', { type: 'button', class: 'btn-aero ghost sm', onclick: async () => toast(t((await copyText(cmd)) ? 'common.copied' : 'common.copy_failed')) }, icon('copy'), t('common.copy')))));
  }
  const downloads = (app.downloads ?? []);
  if (downloads.length) {
    const rows = downloads.map((d) => h('tr', {},
      h('td', {}, [d.architecture, d.installer_type, d.scope].filter(Boolean).join(' / ') || '-'),
      h('td', {}, chip(d.kind === 'direct_binary' ? 'direct' : d.kind === 'redirect' ? 'redirect' : 'page', d.kind === 'direct_binary' ? 'download' : 'external', t(`dl.${d.kind}`)), ' ', extLink(d.url, t('sw.open_link'))),
      h('td', {}, d.sha256 ? h('span', { class: 'hash' }, d.sha256) : h('span', { class: 'unknown-text' }, t('sw.no_hash')), d.sha256_source ? h('div', { class: 'small muted' }, d.sha256_source) : null),
      h('td', {}, t(`link.${d.link_check?.status ?? 'unchecked'}`))));
    body.append(h('section', {}, h('h3', {}, t('sw.d.downloads')), h('p', { class: 'small muted' }, t('sw.d.downloads_note')),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['sw.d.dl_for', 'sw.d.dl_link', 'sw.d.dl_sha', 'sw.d.dl_check'].map((k) => h('th', { scope: 'col' }, t(k))))), h('tbody', {}, ...rows)))));
  }
  body.append(h('section', {}, h('h3', {}, t('sw.d.sources')), h('ul', {}, (app.sources ?? []).map((s) => h('li', {}, extLink(s.url, s.id), h('span', { class: 'muted small' }, ` - ${t('sw.d.source_line', { kind: s.kind.replace(/_/g, ' '), date: String(s.retrieved_at).slice(0, 10), fields: (s.fields ?? []).join(', ') || '-' })}`))))));
  if ((app.quality_flags ?? []).length) body.append(h('div', { class: 'notice warn' }, icon('warn'), h('div', {}, t('sw.d.flags'), ' ', app.quality_flags.map((f) => t(`flag.${f}`)).join(' '))));
  body.append(h('p', { class: 'small muted' }, t(publicationState(app) === 'unavailable' ? 'pub.unavailable.long' : 'pub.published.long')));
  body.append(h('p', { class: 'small muted' }, t(provenanceOf(app) === 'maintainer_curated' ? 'prov.curated.long' : 'prov.automated.long')));
  if (isVerified(app)) body.append(h('p', { class: 'small' }, `${t('sw.d.reviewed')}: ${String(app.reviewed_at).slice(0, 10)} - ${app.review_notes}`, ' ', extLink(app.evidence_url, t('sw.evidence'))));
  else body.append(h('p', { class: 'small muted' }, t('review.not_reviewed.long')));

  const sel = state.selection.has(id);
  const actions = [h('button', { type: 'button', class: 'btn-aero ghost', onclick: (e) => e.target.closest('dialog').close() }, t('common.close'))];
  if (!m.unavailable) actions.push(h('button', { type: 'button', class: 'btn-aero green', onclick: (e) => { toggle(id, !state.selection.has(id)); e.target.closest('dialog').close(); } }, icon(sel ? 'minus' : 'plus'), t(sel ? 'sw.remove_from_selection' : 'sw.add_to_selection')));
  openDialog({ title: app.name, icon: 'software', body, actions });
}

// ---- installer panel ------------------------------------------------------------------------------------------------------
function buildInstallerShell() {
  const content = $('in-content');
  const name = h('input', { type: 'text', id: 'in-name', maxlength: '80', autocomplete: 'off' });
  const os = h('select', { id: 'in-os' }, h('option', { value: 'windows11' }, 'Windows 11'), h('option', { value: 'windows10' }, 'Windows 10'));
  const method = h('select', { id: 'in-method' }, h('option', { value: 'winget' }, t('sw.in.m_winget')), h('option', { value: 'download-kit' }, t('sw.in.m_kit')));
  const opt = (id, labelKey, checked) => h('label', { class: 'check', for: id }, h('input', { type: 'checkbox', id, checked }), h('span', {}, t(labelKey)));
  const refs = {
    name, os, method,
    silent: opt('in-silent', 'sw.in.o_silent', state.options.silent), agree: opt('in-agree', 'sw.in.o_agree', state.options.acceptAgreements), unknown: opt('in-unknown', 'sw.in.o_unknown', state.options.includeUnknown),
    selected: h('ul', { class: 'sel-list', id: 'in-selected' }), notices: h('div', { class: 'stack', id: 'in-notices' }), planBody: h('tbody', {}), planNote: h('p', { class: 'small muted' }),
    script: h('code', { id: 'in-script' }), scriptBox: h('div', { class: 'script-box' }), warnBox: h('div', { class: 'notice warn', id: 'in-warn' }),
    saved: h('select', { id: 'in-saved', 'aria-label': t('sw.in.saved') }),
  };
  refs.scriptBox.append(h('pre', { tabindex: '0', 'aria-label': t('sw.in.script_label') }, refs.script));
  const btn = (id, ic, labelKey, cls = 'ghost') => h('button', { type: 'button', class: `btn-aero ${cls} sm`, id }, icon(ic), h('span', {}, t(labelKey)));
  refs.btn = {
    download: btn('in-download', 'download', 'sw.in.download', 'green'), copy: btn('in-copy', 'copy', 'sw.in.copy'), manifest: btn('in-manifest', 'file-down', 'sw.in.manifest'),
    importJson: btn('in-wingetjson', 'file-up', 'sw.in.wingetjson'), share: btn('in-share', 'link', 'sw.in.share'), save: btn('in-save', 'save', 'sw.in.save'),
    expand: btn('in-expand', 'maximize', 'sw.in.expand'), clear: btn('in-clear', 'trash', 'sw.in.clear', 'danger'),
    open: btn('in-open', 'folder', 'sw.in.open'), del: btn('in-del', 'trash', 'sw.in.delete'),
  };
  content.append(
    h('div', { class: 'field' }, h('label', { for: 'in-name' }, t('sw.in.name')), name),
    h('div', { class: 'opt-grid' }, h('div', { class: 'field' }, h('label', { for: 'in-os' }, t('sw.in.target')), os), h('div', { class: 'field' }, h('label', { for: 'in-method' }, t('sw.in.method')), method)),
    h('fieldset', { class: 'opt-list' }, h('legend', { class: 'small muted' }, t('sw.in.options')), refs.silent, refs.agree, refs.unknown),
    h('div', {}, h('h3', {}, t('sw.in.selected')), refs.selected),
    refs.notices,
    h('details', { class: 'fold', open: true }, h('summary', {}, t('sw.in.plan')), h('div', {}, refs.planNote, h('div', { class: 'plan-scroll' }, h('table', { class: 'plan-table' }, h('thead', {}, h('tr', {}, ['#', t('sw.in.col_app'), t('sw.in.col_command'), t('sw.in.col_notes')].map((c) => h('th', { scope: 'col' }, c)))), refs.planBody)))),
    h('details', { class: 'fold', open: true }, h('summary', {}, t('sw.in.preview')), h('div', {}, refs.warnBox, refs.scriptBox, h('div', { class: 'row' }, refs.btn.expand))),
    h('div', { class: 'btn-grid' }, refs.btn.download, refs.btn.copy, refs.btn.manifest, refs.btn.importJson, refs.btn.share, refs.btn.save),
    h('div', { class: 'field' }, h('label', { for: 'in-saved' }, t('sw.in.saved')), h('div', { class: 'row' }, refs.saved, refs.btn.open, refs.btn.del)),
    h('details', { class: 'fold' }, h('summary', {}, t('sw.in.howto')), h('div', { class: 'stack' }, h('ol', {}, ['sw.in.how1', 'sw.in.how2', 'sw.in.how3', 'sw.in.how4'].map((k) => h('li', {}, t(k)))), h('p', { class: 'small muted' }, t('sw.in.how_note')))),
    h('div', { class: 'row' }, refs.btn.clear),
  );
  ui = refs;
  name.addEventListener('input', () => { state.name = name.value; updateInstaller(); });
  os.addEventListener('change', () => { state.os = os.value; persist(); render(); });
  method.addEventListener('change', () => { state.method = method.value; persist(); updateInstaller(); });
  for (const [key, el] of [['silent', refs.silent], ['acceptAgreements', refs.agree], ['includeUnknown', refs.unknown]]) el.querySelector('input').addEventListener('change', (e) => { state.options[key] = e.target.checked; updateInstaller(); });
  refs.btn.download.addEventListener('click', onDownload);
  refs.btn.copy.addEventListener('click', onCopy);
  refs.btn.manifest.addEventListener('click', () => { downloadText('anto-ltg-bundle.json', manifestToJson(currentManifest()), 'application/json'); toast(t('sw.toast.manifest')); });
  refs.btn.importJson.addEventListener('click', () => { const plan = currentPlan(); try { downloadText('anto-ltg-winget-import.json', `${JSON.stringify(buildWingetImport(plan, { now: new Date().toISOString() }), null, 2)}\n`, 'application/json'); toast(t('sw.toast.wingetjson')); } catch { toast(t('sw.toast.nothing'), { type: 'error' }); } });
  refs.btn.share.addEventListener('click', onShare);
  refs.btn.save.addEventListener('click', onSaveBundle);
  refs.btn.expand.addEventListener('click', () => { const on = refs.scriptBox.classList.toggle('expanded'); refs.btn.expand.querySelector('span').textContent = t(on ? 'sw.in.collapse' : 'sw.in.expand'); });
  refs.btn.clear.addEventListener('click', onClear);
  refs.btn.open.addEventListener('click', onOpenSaved);
  refs.btn.del.addEventListener('click', onDeleteSaved);
}

const currentPlan = () => planInstall({ apps: selectedApps(), os: state.os, method: state.method, includeUnknown: state.options.includeUnknown });
function currentScript(plan, { forDownload = false } = {}) {
  const meta = { bundleName: cleanName(state.name), generatedAt: forDownload ? new Date().toISOString() : stamp, schemaVersion: state.meta.schema_version, catalogUpdated: state.meta.updated_at };
  return state.method === 'winget' ? buildWingetScript({ plan, options: state.options, meta }) : buildDownloadKitScript({ plan, meta });
}
const currentManifest = () => createManifest({ name: state.name, apps: selectedApps(), os: state.os, method: state.method, options: state.options, catalog: { schema_version: state.meta.schema_version, app_count: state.apps.length } });

const REASON_KEY = { unavailable: 'sw.ex.unavailable', withdrawn: 'sw.ex.withdrawn', unsupported_on_target: 'sw.ex.unsupported', compatibility_unknown: 'sw.ex.unknown', no_winget_package: 'sw.ex.no_winget', no_direct_download_with_published_hash: 'sw.ex.no_direct' };

function updateInstaller() {
  const n = state.selection.size;
  $('in-count').textContent = String(n);
  $('in-count-label').textContent = tn('sw.in.count_label', n);
  $('mb-count').textContent = String(n);
  $('mobile-bar').hidden = n === 0;
  $('in-empty').hidden = n > 0;
  $('in-content').hidden = n === 0;
  if (n === 0) return;
  if (!ui) buildInstallerShell();
  if (ui.name.value !== state.name) ui.name.value = state.name;
  ui.os.value = state.os; ui.method.value = state.method;
  clear(ui.selected);
  for (const a of selectedApps()) ui.selected.append(h('li', {}, iconTile(a), h('span', { class: 'name', title: a.name }, a.name), h('span', {}, methodChips(a, true)), h('button', { type: 'button', class: 'rm', dataset: { remove: a.id }, 'aria-label': t('sw.remove_app', { name: a.name }), title: t('sw.remove') }, icon('close'))));

  const plan = currentPlan();
  clear(ui.notices);
  const addNotice = (cls, ic, title, items) => ui.notices.append(h('div', { class: `notice ${cls}` }, icon(ic), h('div', {}, h('strong', {}, title), h('ul', { class: 'warn-list' }, items.map((x) => h('li', {}, x))))));
  if (plan.excluded.length) addNotice('error', 'warn', tn('sw.in.excluded', plan.excluded.length), plan.excluded.map((x) => `${x.app.name}: ${t(REASON_KEY[x.reason])}${x.detail ? ` (${x.detail})` : ''}`));
  if (plan.manual.length) addNotice('warn', 'info', tn('sw.in.manual', plan.manual.length), plan.manual.map((x) => h('span', {}, `${x.app.name}: ${t(REASON_KEY[x.reason])} `, extLink(x.link, t('sw.publisher_page')))));
  const unknown = plan.included.filter((x) => x.flags.includes('compatibility_not_declared'));
  if (unknown.length) addNotice('', 'info', tn('sw.in.unknown_compat', unknown.length, { os: OS_TARGETS[state.os] }), [t('sw.in.unknown_compat_note')]);

  clear(ui.planBody);
  plan.included.forEach(({ app, flags }, i) => ui.planBody.append(h('tr', {},
    h('td', {}, String(i + 1)), h('td', {}, app.name),
    h('td', {}, state.method === 'winget' ? h('code', {}, commandLine(app.winget_id, state.options)) : h('span', { class: 'small' }, t('sw.in.kit_row'))),
    h('td', {}, flags.length ? chip('unknown', 'info', t('compat.unknown')) : chip('declared', 'check', t('compat.declared'))))));
  ui.planNote.textContent = plan.included.length ? tn('sw.in.plan_note', plan.included.length) : t('sw.in.plan_empty');

  const enabled = plan.included.length > 0;
  for (const k of ['download', 'copy', 'importJson']) { ui.btn[k].disabled = !enabled; ui.btn[k].setAttribute('aria-disabled', String(!enabled)); }
  ui.btn.importJson.hidden = state.method !== 'winget';
  clear(ui.warnBox);
  ui.warnBox.hidden = false;
  ui.warnBox.className = 'notice warn';
  ui.warnBox.append(icon('warn'), h('div', {}, t('sw.in.review_first'), state.options.acceptAgreements ? ` ${t('sw.in.agree_warning')}` : ''));
  if (enabled) { try { ui.script.textContent = currentScript(plan); } catch (e) { ui.script.textContent = String(e.message); } } else ui.script.textContent = t('sw.in.plan_empty');
  renderSaved();
}

function renderSaved() {
  const all = loadBundles(storage); const names = Object.keys(all).sort();
  clear(ui.saved);
  ui.saved.append(h('option', { value: '' }, names.length ? t('sw.in.choose_saved') : t('sw.in.no_saved')));
  for (const nm of names) ui.saved.append(h('option', { value: nm }, `${nm} (${all[nm].ids.length})`));
  ui.btn.open.disabled = ui.btn.del.disabled = !names.length;
}

async function onDownload() {
  const plan = currentPlan();
  try {
    const text = currentScript(plan, { forDownload: true });
    downloadText(state.method === 'winget' ? 'anto-ltg-install.ps1' : 'anto-ltg-download-kit.ps1', text, 'text/plain', { bom: true });
    toast(t('sw.toast.downloaded'), { ms: 8000 });
  } catch { toast(t('sw.toast.nothing'), { type: 'error' }); }
}
async function onCopy() {
  try { const ok = await copyText(currentScript(currentPlan(), { forDownload: true })); toast(t(ok ? 'sw.toast.copied' : 'common.copy_failed'), { type: ok ? 'ok' : 'error' }); } catch { toast(t('sw.toast.nothing'), { type: 'error' }); }
}
async function onShare() {
  const url = `${location.origin}${location.pathname}#${encodeShare({ ids: [...state.selection], os: state.os, method: state.method, name: state.name })}`;
  const ok = await copyText(url);
  toast(`${t(ok ? 'sw.toast.share' : 'common.copy_failed')}${url.length > 1800 ? ` ${t('sw.toast.share_long')}` : ''}`, { type: ok ? 'ok' : 'error' });
}
function onSaveBundle() {
  const r = saveBundle(storage, state.name || t('sw.in.default_name'), { ids: [...state.selection], os: state.os, method: state.method });
  if (r.ok) { toast(t('sw.toast.saved', { name: r.name }), { type: 'ok' }); renderSaved(); ui.saved.value = r.name; } else toast(t(r.reason === 'limit' ? 'sw.toast.save_limit' : 'sw.toast.save_failed'), { type: 'error' });
}
async function onClear() {
  const ok = await confirmDialog({ title: t('sw.confirm.clear_title'), message: tn('sw.confirm.clear', state.selection.size), confirmLabel: t('sw.in.clear'), danger: true });
  if (!ok) return;
  setSelection([], 'replace'); toast(t('sw.toast.cleared'));
}
async function onOpenSaved() {
  const name = ui.saved.value; if (!name) return;
  const b = loadBundles(storage)[name]; if (!b) return;
  await applyImported({ name, ids: b.ids, os: b.os, method: b.method, options: state.options }, []);
}
async function onDeleteSaved() {
  const name = ui.saved.value; if (!name) return;
  const ok = await confirmDialog({ title: t('sw.confirm.delete_title'), message: t('sw.confirm.delete', { name }), confirmLabel: t('sw.in.delete'), danger: true });
  if (ok) { deleteBundle(storage, name); renderSaved(); toast(t('sw.toast.deleted', { name })); }
}

// Replace / merge / cancel chooser used by manifest import, saved bundles and share links.
function applyImported(manifest, warnings) {
  return new Promise((resolve) => {
    const have = state.selection.size;
    const body = h('div', { class: 'stack' }, h('p', {}, tn('sw.import.found', manifest.ids.length, { name: manifest.name })), have ? h('p', {}, tn('sw.import.have', have)) : null,
      warnings.length ? h('div', { class: 'notice warn' }, icon('warn'), h('ul', { class: 'warn-list' }, warnings.map((w) => h('li', {}, w)))) : null);
    const finish = (mode) => (e) => {
      e.target.closest('dialog').close();
      if (mode) {
        state.name = manifest.name; state.os = manifest.os; state.method = manifest.method; state.options = { ...state.options, ...manifest.options };
        if (ui) { ui.silent.querySelector('input').checked = state.options.silent; ui.agree.querySelector('input').checked = state.options.acceptAgreements; ui.unknown.querySelector('input').checked = state.options.includeUnknown; }
        setSelection(manifest.ids, mode);
        toast(tn('sw.toast.imported', manifest.ids.length), { type: 'ok' });
      }
      resolve(mode);
    };
    const actions = [h('button', { type: 'button', class: 'btn-aero ghost', onclick: finish(null) }, t('common.cancel'))];
    if (have) actions.push(h('button', { type: 'button', class: 'btn-aero', onclick: finish('merge') }, t('sw.import.merge')));
    actions.push(h('button', { type: 'button', class: `btn-aero ${have ? 'danger' : 'green'}`, onclick: finish('replace') }, t(have ? 'sw.import.replace' : 'sw.import.load')));
    openDialog({ title: t('sw.import.title'), icon: 'upload', body, actions, narrow: true });
  });
}

async function onImportFile(e) {
  const file = e.target.files?.[0]; e.target.value = '';
  if (!file) return;
  if (file.size > MAX_MANIFEST_BYTES) { toast(t('sw.import.too_large'), { type: 'error' }); return; }
  const parsed = parseManifest(await file.text(), { knownIds: new Set(state.byId.keys()) });
  if (!parsed.ok) { toast(parsed.errors[0], { type: 'error', ms: 8000 }); return; }
  await applyImported(parsed.manifest, parsed.warnings);
}

async function handleHash() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return;
  const p = new URLSearchParams(hash);
  if (p.has('apps')) {
    const shared = decodeShare(hash, { knownIds: new Set(state.byId.keys()) });
    history.replaceState(null, '', location.pathname + location.search);
    if (shared?.ids.length) await applyImported({ name: shared.name || t('sw.in.shared_name'), ids: shared.ids, os: shared.os, method: shared.method, options: state.options }, shared.unknownIds.length ? [t('sw.import.unknown', { n: shared.unknownIds.length })] : []);
    else toast(t('sw.import.empty_link'), { type: 'error' });
  } else if (p.has('app')) showDetails(p.get('app'));
}

// ---- wiring --------------------------------------------------------------------------------------------------------------------
function fillCategories() {
  const sel = $('sw-cat'); const keep = sel.value;
  clear(sel);
  sel.append(h('option', { value: '' }, t('common.all')));
  const counts = state.apps.reduce((m, a) => { m[a.category] = (m[a.category] ?? 0) + 1; return m; }, {});
  for (const c of [...CATEGORIES].sort((a, b) => displayRank(a.id) - displayRank(b.id))) if (counts[c.id]) sel.append(h('option', { value: c.id }, `${c.label[getLang()]} (${counts[c.id]})`));
  sel.value = keep;
}

function render() { renderResults(); updateInstaller(); }

async function init() {
  const results = $('sw-results');
  try {
    const [doc, index] = await Promise.all([loadCatalog('apps'), fetchJson('api/v1/search-index.json'), loadVisuals()]);
    state.apps = doc.items; state.byId = new Map(doc.items.map((a) => [a.id, a])); state.meta = { schema_version: doc.schema_version, updated_at: doc.updated_at };
    state.searcher = createSearcher(index);
  } catch (err) {
    results.setAttribute('aria-busy', 'false');
    clear(results);
    results.append(h('div', { class: 'notice error', role: 'alert' }, icon('warn'), h('div', {}, h('strong', {}, t('common.load_error')), h('p', {}, t('sw.load_error_hint')), h('p', { class: 'small mono' }, String(err.message)), h('button', { type: 'button', class: 'btn-aero ghost sm', onclick: () => location.reload() }, t('common.retry')))));
    return;
  }
  const saved = loadSelection(storage);
  state.selection = new Set(saved.ids.filter((id) => state.byId.has(id))); state.os = saved.os; state.method = saved.method;
  fillCategories();
  const form = $('sw-filters');
  let timer = 0;
  form.addEventListener('input', (e) => { if (e.target.id === 'sw-sort') state.sortTouched = true; clearTimeout(timer); timer = setTimeout(renderResults, e.target.id === 'sw-q' ? 140 : 0); });
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('reset', () => setTimeout(() => { state.sortTouched = false; renderResults(); }, 0));
  $('sw-view-quick').addEventListener('click', () => setView('quick'));
  $('sw-view-list').addEventListener('click', () => setView('list'));
  $('sw-select-visible').addEventListener('click', () => { const ids = state.visible.filter((a) => !installMethods(a).unavailable).map((a) => a.id); setSelection(ids, 'merge'); toast(tn('sw.toast.selected_visible', ids.length), { type: 'ok' }); });
  $('sw-deselect-visible').addEventListener('click', () => { const ids = new Set(state.visible.map((a) => a.id)); state.selection = new Set([...state.selection].filter((id) => !ids.has(id))); persist(); render(); toast(tn('sw.toast.deselected_visible', ids.size)); });
  results.addEventListener('change', (e) => { const id = e.target?.dataset?.id; if (id) toggle(id, e.target.checked); });
  results.addEventListener('click', (e) => { const b = e.target.closest('[data-info]'); if (b) showDetails(b.dataset.info); });
  $('installer-body').addEventListener('click', (e) => { const b = e.target.closest('[data-remove]'); if (b) toggle(b.dataset.remove, false); });
  $('in-import').addEventListener('change', onImportFile);
  document.addEventListener('keydown', (e) => { if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) { e.preventDefault(); $('sw-q').focus(); } });
  document.addEventListener('anto:lang', () => { fillCategories(); if (ui) { clear($('in-content')); ui = null; } render(); });
  window.addEventListener('hashchange', handleHash);
  render();
  await handleHash();
}

function setView(v) {
  state.view = v;
  $('sw-view-quick').setAttribute('aria-pressed', String(v === 'quick'));
  $('sw-view-list').setAttribute('aria-pressed', String(v === 'list'));
  renderResults();
}

init();

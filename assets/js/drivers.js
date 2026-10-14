// Driver source finder. Unknown stays unknown; third-party leads are labelled as leads; a direct link is
// shown only when the record says it is official and stable. Nothing here downloads or runs a driver.
import { t, tn, getLang, loadCatalog, fetchJson, toast, openDialog, copyText, icon, h, clear } from './site.js';
import { createSearcher } from './lib/search.js';
import { filterDrivers, DEFAULT_DRIVER_FILTERS, describeTrust } from './lib/drivers-filter.js';
import { COMPONENTS, componentLabel, localized } from './lib/model.js';
import { parseHardwareIds, lookupVendor, matchDriversByHardwareId, parseHardwareReport, osKeyFromBuild, archFromReport } from './lib/hwid.js';
import { safeHttpUrl } from './lib/html.js';
import { loadVisuals, visualImg } from './lib/visuals.js';
import { publicationState, provenanceOf, isVerified } from './lib/status.js';

const $ = (id) => document.getElementById(id);
const state = { drivers: [], vendors: [], byId: new Map(), vendorsById: new Map(), searcher: null, meta: {}, visible: [] };

const OS_OPTIONS = [['windows-11', 'Windows 11'], ['windows-10', 'Windows 10'], ['windows-8-1', 'Windows 8.1'], ['windows-8', 'Windows 8'], ['windows-7', 'Windows 7'], ['windows-vista', 'Windows Vista'], ['windows-xp', 'Windows XP'], ['windows-server', 'Windows Server']];
const OS_NAME = Object.fromEntries(OS_OPTIONS);
const COMPONENT_ICON = { graphics: 'monitor', audio: 'speaker', 'network-ethernet': 'network', 'network-wifi': 'wifi', bluetooth: 'bluetooth', chipset: 'chip', storage: 'drive', usb: 'usb', input: 'mouse', camera: 'camera', 'card-reader': 'card', firmware: 'chip', 'serial-adapter': 'plug', 'printer-scanner': 'printer', 'system-management': 'gear', other: 'globe' };
const KIND_CHIP = { driver_package: ['direct', 'download', 'drv.kind.driver_package'], vendor_tool: ['winget', 'gear', 'drv.kind.vendor_tool'], support_page: ['page', 'globe', 'drv.kind.support_page'], catalog_entry: ['redirect', 'folder', 'drv.kind.catalog_entry'] };

const chip = (kind, ic, label, title) => h('span', { class: 'status-bar-field', title: title || undefined }, icon(ic), h('span', {}, label));
const extLink = (href, text) => { const safe = safeHttpUrl(href); return safe ? h('a', { href: safe, target: '_blank' }, text, ' ', icon('external')) : h('span', { class: 'unknown-text' }, text); };
const unknown = () => h('span', { class: 'unknown-text' }, t('common.unknown'));
const val = (v) => (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) ? unknown() : v);

function osArchSummary(d) {
  if (!(d.os_support ?? []).length) return unknown();
  return d.os_support.map((o) => `${OS_NAME[o.os] ?? o.os}${o.architectures.length ? ` (${o.architectures.join('/')})` : ` (${t('drv.arch_not_stated')})`}`).join(', ');
}

function typeChips(d) {
  const lead = d.source_kind === 'third_party_aggregator';
  const [cls, ic, key] = KIND_CHIP[d.kind] ?? KIND_CHIP.support_page;
  const chips = [lead ? chip('lead', 'warn', t('drv.lead'), t('drv.lead.hint')) : chip(cls, ic, t(key))];
  chips.push(publicationState(d) === 'unavailable' ? chip('unavailable', 'warn', t('pub.unavailable'), t('pub.unavailable.hint')) : chip('published', 'check', t('pub.published'), t('pub.published.hint')));
  chips.push(isVerified(d) ? chip('verified', 'shield', t('review.verified'), t('review.verified.hint')) : chip('unknown', 'clock', t('review.not_reviewed'), t('review.not_reviewed.hint')));
  if (d.download?.sha256 || d.download?.sha512) chips.push(chip('info', 'check', t('drv.has_hash'), t('drv.has_hash.hint')));
  if (d.download?.kind === 'direct_binary') chips.push(chip('direct', 'download', t('drv.direct'), t('drv.direct.hint')));
  if ((d.download?.requires ?? []).length) chips.push(chip('unknown', 'lock', d.download.requires.map((r) => t(`req.${r}`)).join(', '), t('drv.requires.hint')));
  if ((d.quality_flags ?? []).filter((f) => !f.startsWith('download_') && f !== 'lists_end_of_support_os' && f !== 'architecture_not_stated' && f !== 'legacy_os_only').length) chips.push(chip('bad', 'warn', t('drv.flags'), d.quality_flags.map((f) => t(`flag.${f}`)).join(' ')));
  return chips;
}

function card(d) {
  const lead = d.source_kind === 'third_party_aggregator';
  const meta = h('dl', { class: 'dc-meta' },
    ...[[t('drv.d.manufacturer'), d.manufacturer], [t('drv.d.model'), d.model], [t('drv.d.component'), componentLabel(d.component, getLang())], [t('drv.d.os'), osArchSummary(d)], [t('drv.d.version'), d.version], [t('drv.d.date'), d.release_date], [t('drv.d.size'), d.file_size_text ? `${d.file_size_text}${d.file_size_text && !/[A-Za-z]{2}/.test(d.file_size_text) ? '' : ''}` : null]]
      .map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, val(v)))));
  const actions = h('div', { class: 'dc-actions' });
  if (d.official_source?.url) actions.append(h('a', { class: '', href: safeHttpUrl(d.official_source.url) ?? undefined, target: '_blank' }, icon('external'), t(lead ? 'drv.open_official_instead' : 'drv.open_official')));
  if (d.download?.kind === 'direct_binary' && d.download.url) actions.append(h('a', { class: 'default', href: safeHttpUrl(d.download.url) ?? undefined, target: '_blank' }, icon('download'), t('drv.direct_download')));
  const hash = d.download?.sha256 ?? d.download?.sha512;
  if (hash) actions.append(h('button', { type: 'button', class: '', onclick: async () => toast(t((await copyText(hash)) ? 'drv.hash_copied' : 'common.copy_failed')) }, icon('copy'), d.download.sha256 ? 'SHA-256' : 'SHA-512'));
  actions.append(h('button', { type: 'button', class: '', dataset: { detail: d.id } }, icon('info'), t('sw.details')));
  return h('article', { class: `driver-card${lead ? ' lead' : ''}`, id: `d-${d.id}` },
    h('header', {}, h('span', { class: 'driver-visual' }, visualImg('drivers', d.id, { size: 40 })), h('div', { class: 'grow' }, h('h3', {}, d.name), h('div', { class: 'chips' }, ...typeChips(d)))),
    lead ? h('div', { class: 'notice warn' }, icon('warn'), h('div', {}, t('drv.lead.notice'))) : null,
    h('p', { class: 'small' }, localized(d, 'description', getLang())),
    meta, actions);
}

function detail(id) {
  const d = state.byId.get(id); if (!d) return;
  const lang = getLang(); const lead = d.source_kind === 'third_party_aggregator'; const v = state.vendorsById.get(d.vendor_id);
  const body = h('div', { class: 'stack' });
  body.append(h('div', { class: 'chips row' }, ...typeChips(d)));
  if (lead) body.append(h('div', { class: 'notice warn' }, icon('warn'), h('div', {}, t('drv.lead.notice'))));
  body.append(h('p', {}, localized(d, 'description', lang)));
  const rows = [
    [t('drv.d.manufacturer'), v ? h('span', {}, d.manufacturer, ' ', h('span', { class: 'muted small' }, `(${t(`vkind.${v.kind}`)})`)) : d.manufacturer], [t('drv.d.model'), d.model], [t('drv.d.family'), d.hardware_family], [t('drv.d.component'), componentLabel(d.component, lang)],
    [t('drv.d.os'), osArchSummary(d)], [t('drv.d.version'), d.version], [t('drv.d.date'), d.release_date], [t('drv.d.size'), d.file_size_text],
    [t('drv.d.hwids'), (d.hardware_ids ?? []).length ? h('span', {}, d.hardware_ids.map((x) => h('code', {}, x)).flatMap((c) => [c, ' '])) : null],
    [t('drv.d.official'), d.official_source ? extLink(d.official_source.url, d.official_source.url) : null],
    [t('drv.d.source'), extLink(d.source_url, d.source_url)],
    [t('drv.d.download'), d.download ? h('span', {}, t(`dl.${d.download.kind}`), (d.download.requires ?? []).length ? ` - ${t('drv.d.requires')}: ${d.download.requires.map((r) => t(`req.${r}`)).join(', ')}` : '', d.download.url && d.download.kind !== 'none' ? h('span', {}, ' ', extLink(d.download.url, t('sw.open_link'))) : '') : null],
    [t('drv.d.sha256'), d.download?.sha256 ? h('span', { class: 'hash' }, d.download.sha256) : null], [t('drv.d.sha512'), d.download?.sha512 ? h('span', { class: 'hash' }, d.download.sha512) : null],
    [t('drv.d.hash_source'), d.download?.sha256_source ?? d.download?.sha512_source],
  ];
  body.append(h('dl', { class: 'kv' }, ...rows.flatMap(([k, x]) => [h('dt', {}, k), h('dd', {}, val(x))])));
  if ((d.install_instructions ?? d.install_instructions_id ?? []).length) body.append(h('section', {}, h('h3', {}, t('drv.d.install')), h('ol', {}, (lang === 'id' && d.install_instructions_id?.length ? d.install_instructions_id : d.install_instructions).map((s) => h('li', {}, s)))));
  if (d.notes || d.notes_id) body.append(h('p', {}, localized(d, 'notes', lang)));
  body.append(h('section', {}, h('h3', {}, t('drv.d.evidence')), h('ul', {}, (d.evidence ?? []).map((e) => h('li', {}, extLink(e.url, t(`ev.${e.type}`)), h('span', { class: 'muted small' }, ` - ${e.retrieved_at}: ${e.note ?? ''}`))))));
  body.append(h('section', {}, h('h3', {}, t('sw.d.sources')), h('ul', {}, (d.sources ?? []).map((s) => h('li', {}, extLink(s.url, s.id), h('span', { class: 'muted small' }, ` - ${t('sw.d.source_line', { kind: s.kind.replace(/_/g, ' '), date: String(s.retrieved_at).slice(0, 10), fields: (s.fields ?? []).join(', ') || '-' })}`))))));
  body.append(h('p', { class: 'small muted' }, t(publicationState(d) === 'unavailable' ? 'pub.unavailable.long' : 'pub.published.long')));
  body.append(h('p', { class: 'small muted' }, t(provenanceOf(d) === 'maintainer_curated' ? 'prov.curated.long' : 'prov.automated.long')));
  body.append(h('p', { class: 'small muted' }, t(isVerified(d) ? 'review.verified.long' : 'review.not_reviewed.long')));
  openDialog({ title: d.name, icon: COMPONENT_ICON[d.component] ?? 'chip', body, actions: [h('button', { type: 'button', class: '', onclick: (e) => e.target.closest('dialog').close() }, t('common.close'))] });
}

function renderResults() {
  const f = {
    q: $('drv-q').value, vendor: $('drv-vendor').value, component: $('drv-component').value, os: $('drv-os').value, arch: $('drv-arch').value,
    source: $('drv-source').value, status: $('drv-publication').value, sort: $('drv-sort').value, directOnly: $('drv-direct').checked,
  };
  state.visible = filterDrivers(state.drivers, f, { searcher: state.searcher });
  const box = $('drv-results'); clear(box); box.setAttribute('aria-busy', 'false');
  $('drv-count').textContent = state.visible.length === state.drivers.length ? tn('drv.count_all', state.drivers.length) : t('drv.count_filtered', { n: state.visible.length, total: state.drivers.length });
  $('drv-status').textContent = t('sw.status', { date: String(state.meta.updated_at ?? '').slice(0, 10) || '-', schema: state.meta.schema_version ?? '-' });
  if (!state.visible.length) {
    box.append(h('div', { class: 'empty' }, h('span', { class: 'orb aqua' }, icon('search')), h('h2', {}, t('drv.empty.title')), h('p', {}, t('drv.empty.text')), h('div', { class: 'row', style: undefined }, h('button', { type: 'button', class: '', onclick: resetFilters }, t('common.reset')))));
    return;
  }
  box.append(h('div', { class: 'driver-list' }, state.visible.map(card)));
}
function resetFilters() { $('drv-filters').reset(); renderResults(); }

function fillSelects() {
  const keep = { vendor: $('drv-vendor').value, component: $('drv-component').value, os: $('drv-os').value };
  const fill = (sel, first, items) => { clear(sel); sel.append(h('option', { value: '' }, first)); for (const [value, label] of items) sel.append(h('option', { value }, label)); };
  const countBy = (field) => state.drivers.reduce((m, d) => { m[d[field]] = (m[d[field]] ?? 0) + 1; return m; }, {});
  const vc = countBy('vendor_id');
  fill($('drv-vendor'), t('common.all'), state.vendors.filter((v) => vc[v.id]).map((v) => [v.id, `${v.name} (${vc[v.id]})`]));
  const cc = countBy('component');
  fill($('drv-component'), t('common.all'), Object.keys(COMPONENTS).filter((c) => cc[c]).map((c) => [c, `${componentLabel(c, getLang())} (${cc[c]})`]));
  fill($('drv-os'), t('common.any'), OS_OPTIONS);
  $('drv-vendor').value = keep.vendor; $('drv-component').value = keep.component; $('drv-os').value = keep.os;
}

// ---- vendor directory ---------------------------------------------------------------------------------------------------
function renderVendors() {
  const grid = $('vendor-grid'); clear(grid);
  const lang = getLang();
  for (const v of state.vendors) {
    const count = state.drivers.filter((d) => d.vendor_id === v.id).length;
    const steps = lang === 'id' && v.instructions_id?.length ? v.instructions_id : v.instructions ?? [];
    grid.append(h('article', { class: 'vendor-card', id: `vendor-${v.id}` },
      h('header', {}, h('span', { class: 'vendor-logo' }, visualImg('vendors', v.id, { size: 44 })), h('div', {}, h('h3', {}, v.name), h('span', { class: 'chip info' }, t(`vkind.${v.kind}`)))),
      steps.length ? h('ul', { class: 'small' }, steps.map((s) => h('li', {}, s))) : null,
      (v.requires ?? []).length ? h('div', { class: 'chips row' }, h('span', { class: 'small muted' }, `${t('drv.d.requires')}:`), ...v.requires.map((r) => chip('unknown', 'lock', t(`req.${r}`)))) : null,
      h('p', { class: 'small muted' }, `${t('drv.official_domains')}: ${v.domains.join(', ')}`),
      (v.pci_vendor_ids?.length || v.usb_vendor_ids?.length) ? h('p', { class: 'small muted' }, `${t('drv.hw_vendor_ids')}: ${[...(v.pci_vendor_ids ?? []).map((i) => `PCI ${i}`), ...(v.usb_vendor_ids ?? []).map((i) => `USB ${i}`)].join(', ')}`) : null,
      h('div', { class: 'row' }, v.driver_search_url ? h('a', { class: '', href: safeHttpUrl(v.driver_search_url) ?? undefined, target: '_blank' }, icon('external'), t('drv.open_portal')) : extLink(v.homepage_url, t('drv.homepage')),
        count ? h('button', { type: 'button', class: '', dataset: { vendor: v.id } }, icon('filter'), tn('drv.show_records', count)) : null)));
  }
}

// ---- hardware IDs ------------------------------------------------------------------------------------------------------------
function analyze() {
  const text = $('hw-input').value; const out = $('hw-results'); clear(out);
  if (!text.trim()) { out.append(h('div', { class: 'notice' }, icon('info'), h('div', {}, t('drv.hw.empty')))); return; }
  let devices = []; let report = null;
  if (text.trim().startsWith('{')) {
    const parsed = parseHardwareReport(text);
    if (!parsed.ok) { out.append(h('div', { class: 'notice error', role: 'alert' }, icon('warn'), h('div', {}, parsed.error))); return; }
    report = parsed.report; devices = report.devices;
  } else devices = parseHardwareIds(text).map((id) => ({ name: '', problem: false, ids: [id] }));
  if (!devices.length) { out.append(h('div', { class: 'notice warn' }, icon('warn'), h('div', {}, t('drv.hw.none_found')))); return; }
  if (report) {
    out.append(h('div', { class: 'notice ok' }, icon('check'), h('div', {}, `${report.manufacturer || t('common.unknown')} ${report.model}`.trim(), ' - ', `${report.os.caption || 'Windows'} (build ${report.os.build ?? '?'}, ${report.os.arch || '?'})`)));
    const os = osKeyFromBuild(report.os.build); const arch = archFromReport(report.os.arch);
    if (os) $('drv-os').value = os; if (arch) $('drv-arch').value = arch;
  }
  const groups = new Map();
  for (const d of devices) for (const id of d.ids.slice(0, 1)) {
    const key = `${id.bus}|${id.vendor}`;
    if (!groups.has(key)) groups.set(key, { id, devices: [] });
    groups.get(key).devices.push({ ...d, id });
  }
  for (const { id, devices: list } of [...groups.values()].sort((a, b) => b.devices.filter((x) => x.problem).length - a.devices.filter((x) => x.problem).length).slice(0, 40)) {
    const vendor = lookupVendor(state.vendors, id);
    const matches = list.map((x) => matchDriversByHardwareId(state.drivers, x.id));
    const exact = [...new Map(matches.flatMap((m) => m.exact).map((d) => [d.id, d])).values()];
    const vendorRecords = state.drivers.filter((d) => vendor && d.vendor_id === vendor.id && d.source_kind !== 'third_party_aggregator').slice(0, 4);
    out.append(h('article', { class: 'panel stack' },
      h('div', { class: 'row' }, h('span', { class: 'orb sm aqua' }, icon('chip')), h('strong', {}, vendor ? vendor.name : t('drv.hw.unknown_vendor', { id: id.vendor })), h('span', { class: 'chip info' }, `${id.bus} ${id.bus === 'USB' ? 'VID' : 'VEN'}_${id.vendor}`), list.some((x) => x.problem) ? chip('bad', 'warn', t('drv.hw.problem')) : null),
      h('ul', { class: 'small' }, list.slice(0, 6).map((x) => h('li', {}, x.name ? `${x.name} ` : '', h('code', {}, x.id.normalized)))),
      exact.length ? h('div', {}, h('strong', { class: 'small' }, t('drv.hw.exact')), h('ul', { class: 'small' }, exact.map((d) => h('li', {}, h('button', { type: 'button', class: 'btn-reset', dataset: { detail: d.id } }, h('a', { href: `#d-${d.id}` }, d.name)))))) : null,
      vendor ? h('div', { class: 'small' }, t('drv.hw.vendor_hint', { vendor: vendor.name }), ' ', vendor.driver_search_url ? extLink(vendor.driver_search_url, t('drv.open_portal')) : null, vendorRecords.length ? h('ul', {}, vendorRecords.map((d) => h('li', {}, h('button', { type: 'button', class: '', dataset: { detail: d.id } }, d.name)))) : null)
        : h('p', { class: 'small muted' }, t('drv.hw.no_vendor_entry'))));
  }
  out.append(h('p', { class: 'small muted' }, t('drv.hw.disclaimer')));
  renderResults();
}

// ---- boot -----------------------------------------------------------------------------------------------------------------------
async function init() {
  try {
    const [drivers, vendors, index] = await Promise.all([loadCatalog('drivers'), loadCatalog('vendors'), fetchJson('api/v1/search-index.json'), loadVisuals()]);
    state.drivers = drivers.items; state.vendors = vendors.items; state.byId = new Map(drivers.items.map((d) => [d.id, d])); state.vendorsById = new Map(vendors.items.map((v) => [v.id, v]));
    state.meta = { schema_version: drivers.schema_version, updated_at: drivers.updated_at }; state.searcher = createSearcher(index);
  } catch (err) {
    const box = $('drv-results'); box.setAttribute('aria-busy', 'false'); clear(box);
    box.append(h('div', { class: 'notice error', role: 'alert' }, icon('warn'), h('div', {}, h('strong', {}, t('common.load_error')), h('p', { class: 'small mono' }, String(err.message)), h('button', { type: 'button', class: '', onclick: () => location.reload() }, t('common.retry')))));
    return;
  }
  fillSelects(); renderVendors();
  let timer = 0;
  const form = $('drv-filters');
  form.addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(renderResults, e.target.id === 'drv-q' ? 140 : 0); });
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('reset', () => setTimeout(renderResults, 0));
  document.addEventListener('click', (e) => {
    const d = e.target.closest('[data-detail]'); if (d) { e.preventDefault(); detail(d.dataset.detail); return; }
    const v = e.target.closest('[data-vendor]'); if (v) { $('drv-vendor').value = v.dataset.vendor; renderResults(); $('win-finder').scrollIntoView({ behavior: 'smooth' }); }
  });
  $('hw-run').addEventListener('click', analyze);
  $('hw-clear').addEventListener('click', () => { $('hw-input').value = ''; clear($('hw-results')); });
  document.addEventListener('anto:lang', () => { fillSelects(); renderVendors(); renderResults(); });
  renderResults();
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (p.get('d')) detail(p.get('d'));
  if (p.get('vendor') && state.vendorsById.has(p.get('vendor'))) { $('drv-vendor').value = p.get('vendor'); renderResults(); }
}
init();

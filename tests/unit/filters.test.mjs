// Software and driver filtering, the data-model helpers and hardware-ID matching.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, CATEGORY_BY_ID, DISPLAY_ORDER, displayRank, categoryLabel, COMPONENTS, componentLabel, isUnavailable, installMethods, compatFor, OS_TARGETS,
  pickDownload, sortForInstall, versionInfo, daysSince, localized,
} from '../../assets/js/lib/model.js';
import { DEFAULT_FILTERS, filterApps, groupByCategory, iconHue, iconLetters } from '../../assets/js/lib/apps-filter.js';
import { DEFAULT_DRIVER_FILTERS, filterDrivers, describeTrust } from '../../assets/js/lib/drivers-filter.js';
import { parseHardwareIds, lookupVendor, matchDriversByHardwareId, parseHardwareReport, osKeyFromBuild, archFromReport } from '../../assets/js/lib/hwid.js';
import { buildIndex, createSearcher } from '../../assets/js/lib/search.js';
import { buildSearchDocs } from '../../scripts/lib/search-docs.mjs';
import { loadCatalogs } from '../helpers/repo.mjs';

const mkApp = (o) => ({ category: 'utilities', architectures: ['x64'], compatibility: { windows10: 'unknown', windows11: 'unknown' }, downloads: [], verification_status: 'not_reviewed', source_url: 'https://example.com/', publication: { state: 'published', method: 'automated', checked_at: '2026-10-13T00:00:00.000Z', checks: ['basic_fields'] }, ...o });
const APPS = [
  mkApp({ id: 'firefox', name: 'Firefox', publisher: 'Mozilla', category: 'browsers', winget_id: 'Mozilla.Firefox', architectures: ['x64', 'x86', 'arm64'], compatibility: { windows10: 'declared', windows11: 'declared' } }),
  mkApp({ id: 'chrome', name: 'Chrome', publisher: 'Google', category: 'browsers', winget_id: 'Google.Chrome', architectures: ['x64'], compatibility: { windows10: 'declared', windows11: 'declared' } }),
  mkApp({ id: 'newonly', name: 'Brand New', publisher: 'Acme', category: 'developer-tools', winget_id: 'Acme.New', compatibility: { windows10: 'unsupported', windows11: 'declared' } }),
  mkApp({ id: 'unknownarch', name: 'Mystery', publisher: 'Acme', category: 'developer-tools', winget_id: 'Acme.Mystery', architectures: [] }),
  mkApp({ id: 'neutral', name: 'Portable Thing', publisher: 'Acme', category: 'utilities', architectures: ['neutral'], downloads: [{ kind: 'direct_binary', url: 'https://example.com/a.zip' }], source_url: 'https://example.com/a' }),
  mkApp({ id: 'pageonly', name: 'Page Only', publisher: 'Acme', category: 'media', architectures: ['x64'], downloads: [{ kind: 'landing_page', url: 'https://example.com/dl' }] }),
  mkApp({ id: 'flash', name: 'Flash', publisher: 'Adobe', category: 'media', architectures: [], availability: { status: 'unavailable', reason: 'EOL' }, source_url: 'https://example.com/eol' }),
  mkApp({ id: 'runtime', name: 'Runtime', publisher: 'Microsoft', category: 'runtimes', winget_id: 'Microsoft.Runtime', verification_status: 'verified' }),
];
const appSearcher = createSearcher(buildIndex(APPS.map((a) => ({ type: 'app', id: a.id, title: a.name, fields: { name: a.name, publisher: a.publisher, ids: [a.id, a.winget_id].filter(Boolean) } }))));
const ids = (list) => list.map((a) => a.id);

describe('model helpers', () => {
  it('installMethods distinguishes WinGet, direct, redirect, page and unavailable', () => {
    const m = (a) => installMethods(a);
    assert.deepEqual(m(APPS[0]), { unavailable: false, winget: true, direct: false, redirect: false, page: true, primary: 'winget', list: ['winget', 'page'] });
    assert.equal(m(APPS[4]).primary, 'direct');
    assert.equal(m(mkApp({ downloads: [{ kind: 'redirect', url: 'https://aka.ms/x' }] })).primary, 'redirect');
    assert.equal(m(APPS[5]).primary, 'page');
    assert.equal(m(mkApp({ source_url: undefined })).primary, 'unavailable');
    assert.deepEqual(m(APPS[6]), { unavailable: true, winget: false, direct: false, redirect: false, page: false, primary: 'unavailable', list: [] });
    assert.equal(isUnavailable(APPS[6]), true);
  });
  it('compatFor reports only what the source declared', () => {
    assert.equal(compatFor(APPS[0], 'windows11'), 'declared');
    assert.equal(compatFor(APPS[2], 'windows10'), 'unsupported');
    assert.equal(compatFor({}, 'windows11'), 'unknown');
    assert.deepEqual(OS_TARGETS, { windows11: 'Windows 11', windows10: 'Windows 10', windows81: 'Windows 8.1', windows8: 'Windows 8', windows7: 'Windows 7' });
  });
  it('pickDownload prefers the exact architecture, then neutral, then unlabelled', () => {
    const app = { downloads: [{ kind: 'direct_binary', url: 'u1', architecture: 'x86' }, { kind: 'direct_binary', url: 'u2', architecture: 'neutral' }, { kind: 'direct_binary', url: 'u3', architecture: 'x64' }, { kind: 'landing_page', url: 'u4', architecture: 'x64' }] };
    assert.equal(pickDownload(app, 'x64').url, 'u3');
    assert.equal(pickDownload(app, 'arm64').url, 'u2');
    assert.equal(pickDownload({ downloads: [{ kind: 'direct_binary', url: 'u5' }] }, 'x64').url, 'u5');
    assert.equal(pickDownload({ downloads: [{ kind: 'landing_page', url: 'u6' }] }, 'x64'), null);
    assert.equal(pickDownload({}, 'x64'), null);
  });
  it('sortForInstall puts runtimes first and games last without mutating the input', () => {
    const input = [{ name: 'Z game', category: 'gaming' }, { name: 'B', category: 'browsers' }, { name: 'A', category: 'browsers' }, { name: 'Runtime', category: 'runtimes' }, { name: 'Unknown cat', category: 'nope' }];
    const copy = structuredClone(input);
    assert.deepEqual(sortForInstall(input).map((a) => a.name), ['Runtime', 'A', 'B', 'Z game', 'Unknown cat']);
    assert.deepEqual(input, copy);
  });
  it('versionInfo is null unless a recorded source lists the version field', () => {
    assert.equal(versionInfo({ version: '1.0' }), null);
    assert.equal(versionInfo({}), null);
    assert.equal(versionInfo({ version: '1.0', sources: [{ id: 'x', fields: ['name'], retrieved_at: '2026-01-01T00:00:00Z', url: 'https://example.com' }] }), null);
    assert.deepEqual(versionInfo({ version: '2.5', release_date: '2026-09-01', sources: [{ id: 'winget-pkgs', fields: ['version'], retrieved_at: '2026-10-13T03:04:05Z', url: 'https://github.com/microsoft/winget-pkgs' }] }),
      { value: '2.5', released: '2026-09-01', source: 'winget-pkgs', retrieved_at: '2026-10-13', url: 'https://github.com/microsoft/winget-pkgs' });
  });
  it('daysSince and localized behave on bad input', () => {
    assert.equal(daysSince('2026-10-10', Date.parse('2026-10-13')), 3);
    assert.equal(daysSince('garbage'), null);
    assert.equal(localized({ description: 'EN', description_id: 'ID' }, 'description', 'id'), 'ID');
    assert.equal(localized({ description: 'EN' }, 'description', 'id'), 'EN');
    assert.equal(localized({}, 'description', 'en'), '');
  });
  it('labels fall back to the id for unknown categories and components', () => {
    assert.equal(categoryLabel('browsers'), 'Browsers');
    assert.equal(categoryLabel('browsers', 'id'), 'Peramban');
    assert.equal(categoryLabel('mystery'), 'mystery');
    assert.equal(componentLabel('network-wifi'), 'Wi-Fi');
    assert.equal(componentLabel('mystery'), 'mystery');
    assert.equal(displayRank('browsers'), 0);
    assert.equal(displayRank('mystery'), 99);
  });
  it('display order covers every category exactly once and install ranks are unique', () => {
    assert.deepEqual([...DISPLAY_ORDER].sort(), CATEGORIES.map((c) => c.id).sort());
    assert.equal(new Set(CATEGORIES.map((c) => c.rank)).size, CATEGORIES.length);
    assert.ok(CATEGORY_BY_ID.runtimes.rank < CATEGORY_BY_ID.browsers.rank && CATEGORY_BY_ID.browsers.rank < CATEGORY_BY_ID.gaming.rank);
    for (const c of CATEGORIES) assert.ok(c.label.en && c.label.id, c.id);
    for (const [k, v] of Object.entries(COMPONENTS)) assert.ok(v.en && v.id, k);
  });
});

describe('filterApps', () => {
  it('has frozen defaults that match everything', () => {
    assert.ok(Object.isFrozen(DEFAULT_FILTERS));
    assert.equal(filterApps(APPS, {}).length, APPS.length);
  });
  it('filters by category and by publication or review status', () => {
    assert.deepEqual(ids(filterApps(APPS, { category: 'browsers' })), ['chrome', 'firefox']);
    assert.deepEqual(ids(filterApps(APPS, { status: 'verified' })), ['runtime']);
    assert.equal(filterApps(APPS, { status: 'published' }).length, APPS.length, 'every fixture is published');
    const withOneUnavailable = APPS.map((a, i) => (i === 0 ? { ...a, publication: { ...a.publication, state: 'unavailable', problems: ['downloads_pinned'] } } : a));
    assert.deepEqual(ids(filterApps(withOneUnavailable, { status: 'unavailable' })), [APPS[0].id]);
    assert.equal(filterApps(withOneUnavailable, { status: 'published' }).length, APPS.length - 1);
    assert.equal(filterApps(APPS, { status: '' }).length, APPS.length, 'an empty status filter matches everything');
  });
  it('OS filter hides apps declared unsupported but keeps unknown ones', () => {
    const w10 = ids(filterApps(APPS, { os: 'windows10' }));
    assert.ok(!w10.includes('newonly'));
    assert.ok(w10.includes('unknownarch'), 'unknown compatibility stays visible (each card shows its own state)');
    assert.ok(ids(filterApps(APPS, { os: 'windows11' })).includes('newonly'));
  });
  it('"declared only" keeps just the apps whose source states support for that OS', () => {
    assert.deepEqual(ids(filterApps(APPS, { os: 'windows11', declaredOnly: true })).sort(), ['chrome', 'firefox', 'newonly']);
    assert.deepEqual(ids(filterApps(APPS, { os: 'windows10', declaredOnly: true })).sort(), ['chrome', 'firefox']);
  });
  it('unknown architecture NEVER matches an active architecture filter; neutral matches all', () => {
    const arm = ids(filterApps(APPS, { arch: 'arm64' }));
    assert.deepEqual([...arm].sort(), ['firefox', 'neutral']);
    assert.ok(!ids(filterApps(APPS, { arch: 'x64' })).includes('unknownarch'));
    assert.ok(!ids(filterApps(APPS, { arch: 'x64' })).includes('flash'));
  });
  it('filters by install method', () => {
    assert.deepEqual(ids(filterApps(APPS, { method: 'winget' })).sort(), ['chrome', 'firefox', 'newonly', 'runtime', 'unknownarch']);
    assert.deepEqual(ids(filterApps(APPS, { method: 'direct' })), ['neutral']);
    assert.deepEqual(ids(filterApps(APPS, { method: 'unavailable' })), ['flash']);
    assert.ok(ids(filterApps(APPS, { method: 'page' })).includes('pageonly'));
    assert.ok(!ids(filterApps(APPS, { method: 'page' })).includes('firefox'), 'WinGet apps are not "page only"');
  });
  it('text search needs a searcher and honours the other filters', () => {
    assert.throws(() => filterApps(APPS, { q: 'fire' }), /searcher is required/);
    assert.deepEqual(ids(filterApps(APPS, { q: 'mozilla' }, { searcher: appSearcher })), ['firefox']);
    assert.deepEqual(ids(filterApps(APPS, { q: 'acme', category: 'developer-tools' }, { searcher: appSearcher })).sort(), ['newonly', 'unknownarch']);
    assert.deepEqual(ids(filterApps(APPS, { q: 'Mozilla.Firefox' }, { searcher: appSearcher })), ['firefox']);
    assert.deepEqual(filterApps(APPS, { q: 'zzzzqqq' }, { searcher: appSearcher }), []);
  });
  it('sorts by name, category or relevance', () => {
    assert.deepEqual(ids(filterApps(APPS, { sort: 'name' })).slice(0, 3), ['newonly', 'chrome', 'firefox']);
    const byCat = filterApps(APPS, { sort: 'category' }).map((a) => a.category);
    assert.deepEqual(byCat, [...byCat].sort((a, b) => displayRank(a) - displayRank(b)));
    assert.equal(filterApps(APPS, { q: 'firefox', sort: 'relevance' }, { searcher: appSearcher })[0].id, 'firefox');
  });
  it('does not mutate its input', () => {
    const copy = structuredClone(APPS);
    filterApps(APPS, { sort: 'category', category: 'media' });
    assert.deepEqual(APPS, copy);
  });
  it('groupByCategory follows the display order', () => {
    const groups = groupByCategory(APPS);
    assert.deepEqual(groups.map(([c]) => c), ['browsers', 'media', 'utilities', 'developer-tools', 'runtimes']);
    assert.equal(groups.flatMap(([, list]) => list).length, APPS.length);
  });
  it('icon tiles stay in the blue-to-green range and use stable initials', () => {
    for (const a of APPS) { const h = iconHue(a.id); assert.ok(h >= 150 && h < 216, `${a.id}: ${h}`); }
    assert.equal(iconHue('git'), iconHue('git'));
    assert.equal(iconLetters('Mozilla Firefox'), 'MF');
    assert.equal(iconLetters('7-Zip'), '7Z');
    assert.equal(iconLetters('Git'), 'GI');
    assert.equal(iconLetters(''), '?');
  });
});

describe('filterDrivers', () => {
  const D = [
    { id: 'intel-wifi', name: 'Intel Wi-Fi', manufacturer: 'Intel', vendor_id: 'intel', component: 'network-wifi', source_kind: 'manufacturer_download', verification_status: 'not_reviewed', os_support: [{ os: 'windows-11' }, { os: 'windows-10' }], architectures: ['x64'], release_date: '2026-09-01', download: { kind: 'landing_page', sha256: 'a'.repeat(64) } },
    { id: 'realtek-audio', name: 'Realtek Audio', manufacturer: 'Realtek', vendor_id: 'realtek', component: 'audio', source_kind: 'vendor_catalog', verification_status: 'not_reviewed', os_support: [{ os: 'windows-7' }], architectures: ['x86', 'x64'], release_date: '2020-01-01', download: { kind: 'none' } },
    { id: 'acer-portal', name: 'Acer portal', manufacturer: 'Acer', vendor_id: 'acer', component: 'other', source_kind: 'manufacturer_support_page', verification_status: 'not_reviewed', os_support: [], architectures: [], download: { kind: 'none' } },
    { id: 'lead-x', name: 'Lead X', manufacturer: 'Intel', vendor_id: 'intel', component: 'chipset', source_kind: 'third_party_aggregator', verification_status: 'not_reviewed', os_support: [{ os: 'windows-10' }], architectures: ['x64'], release_date: '2015-05-05', download: { kind: 'none' } },
    { id: 'direct', name: 'Direct tool', manufacturer: 'FTDI', vendor_id: 'ftdi', component: 'serial-adapter', source_kind: 'manufacturer_download', verification_status: 'verified', os_support: [{ os: 'windows-11' }], architectures: ['x64'], release_date: '2026-06-01', download: { kind: 'direct_binary', url: 'https://ftdichip.com/a.exe' } },
  ];
  const dids = (l) => l.map((d) => d.id);
  const searcher = createSearcher(buildIndex(D.map((d) => ({ type: 'driver', id: d.id, title: d.name, fields: { name: d.name, publisher: d.manufacturer, component: d.component } }))));

  it('filters by vendor, component and publication or review status', () => {
    assert.deepEqual(dids(filterDrivers(D, { vendor: 'intel', sort: 'name' })), ['intel-wifi', 'lead-x']);
    assert.deepEqual(dids(filterDrivers(D, { component: 'audio' })), ['realtek-audio']);
    assert.deepEqual(dids(filterDrivers(D, { status: 'verified' })), ['direct']);
    assert.deepEqual(dids(filterDrivers(D, { status: 'unavailable' })), []);
  });
  it('unknown OS or architecture never matches an active filter', () => {
    assert.ok(!dids(filterDrivers(D, { os: 'windows-11' })).includes('acer-portal'));
    assert.deepEqual(dids(filterDrivers(D, { os: 'windows-7' })), ['realtek-audio']);
    assert.ok(!dids(filterDrivers(D, { arch: 'x64' })).includes('acer-portal'));
    assert.deepEqual(dids(filterDrivers(D, { arch: 'x86' })), ['realtek-audio']);
  });
  it('separates official records from third-party leads', () => {
    assert.ok(!dids(filterDrivers(D, { source: 'official' })).includes('lead-x'));
    assert.deepEqual(dids(filterDrivers(D, { source: 'lead' })), ['lead-x']);
  });
  it('"direct only" keeps just stable direct links', () => assert.deepEqual(dids(filterDrivers(D, { directOnly: true })), ['direct']));
  it('official records are listed before leads by default', () => {
    const order = dids(filterDrivers(D, {}));
    assert.equal(order[order.length - 1], 'lead-x');
  });
  it('sorts by newest (unknown dates last), name and manufacturer', () => {
    assert.deepEqual(dids(filterDrivers(D, { sort: 'newest' })), ['intel-wifi', 'direct', 'realtek-audio', 'lead-x', 'acer-portal']);
    assert.deepEqual(dids(filterDrivers(D, { sort: 'name' })), ['acer-portal', 'direct', 'intel-wifi', 'lead-x', 'realtek-audio']);
    assert.deepEqual(dids(filterDrivers(D, { sort: 'manufacturer' })), ['acer-portal', 'direct', 'intel-wifi', 'lead-x', 'realtek-audio']);
  });
  it('text queries need a searcher', () => {
    assert.throws(() => filterDrivers(D, { q: 'intel' }), /searcher is required/);
    assert.deepEqual(dids(filterDrivers(D, { q: 'intel', source: 'official' }, { searcher })), ['intel-wifi']);
    assert.ok(Object.isFrozen(DEFAULT_DRIVER_FILTERS));
  });
  it('describeTrust never calls a lead official or invents a hash', () => {
    assert.deepEqual(describeTrust(D[0]), { lead: false, official: true, hasHash: true, direct: false, flags: [] });
    assert.deepEqual(describeTrust(D[3]), { lead: true, official: false, hasHash: false, direct: false, flags: [] });
    assert.equal(describeTrust(D[4]).direct, true);
    assert.deepEqual(describeTrust({ source_kind: 'third_party_aggregator', quality_flags: ['non_english_name'] }).flags, ['non_english_name']);
  });
});

describe('hardware ids', () => {
  it('parses PCI, USB and HDAUDIO ids from Device Manager text', () => {
    const text = 'PCI\\VEN_8086&DEV_15F3&SUBSYS_00008086&REV_03\nPCI\\VEN_8086&DEV_15F3&CC_020000\nUSB\\VID_0403&PID_6001\\A50285BI\nHDAUDIO\\FUNC_01&VEN_10EC&DEV_0256&SUBSYS_103C8736\nusb\\vid_1a86&pid_7523';
    assert.deepEqual(parseHardwareIds(text).map((p) => p.normalized), ['PCI\\VEN_8086&DEV_15F3', 'USB\\VID_0403&PID_6001', 'HDAUDIO\\VEN_10EC&DEV_0256', 'USB\\VID_1A86&PID_7523']);
  });
  it('keeps vendor-only ids and ignores text that is not a hardware id', () => {
    assert.deepEqual(parseHardwareIds('PCI\\VEN_10DE').map((p) => [p.vendor, p.device]), [['10DE', null]]);
    assert.deepEqual(parseHardwareIds('hello world VEN_ZZZZ PCI\\NOTHING'), []);
    assert.deepEqual(parseHardwareIds(null), []);
  });
  it('is bounded for huge input', () => {
    const big = `${'x'.repeat(500_000)} PCI\\VEN_8086&DEV_1111`;
    assert.deepEqual(parseHardwareIds(big), [], 'only the first 400 000 characters are read');
  });
  it('maps vendor ids to vendors, never a device id to a model', async () => {
    const { vendors } = await loadCatalogs();
    const v = (id) => lookupVendor(vendors.items, parseHardwareIds(id)[0])?.id ?? null;
    assert.equal(v('PCI\\VEN_8086&DEV_15F3'), 'intel');
    assert.equal(v('PCI\\VEN_10DE&DEV_2204'), 'nvidia');
    assert.equal(v('PCI\\VEN_10EC&DEV_8168'), 'realtek');
    assert.equal(v('PCI\\VEN_1002&DEV_73BF'), 'amd');
    assert.equal(v('USB\\VID_0403&PID_6001'), 'ftdi');
    assert.equal(v('USB\\VID_1A86&PID_7523'), 'wch');
    assert.equal(v('USB\\VID_0BDA&PID_8153'), 'realtek');
    assert.equal(v('PCI\\VEN_FFFF&DEV_0001'), null);
    assert.equal(v('USB\\VID_8086&PID_0001'), null, 'the USB and PCI vendor id spaces are separate');
  });
  it('matches drivers exactly only when the record itself states that hardware id', () => {
    const drivers = [{ id: 'exact', hardware_ids: ['PCI\\VEN_8086&DEV_1C3A'] }, { id: 'other-dev', hardware_ids: ['PCI\\VEN_8086&DEV_1111'] }, { id: 'none' }, { id: 'usb', hardware_ids: ['USB\\VID_8086&PID_1C3A'] }];
    const m = matchDriversByHardwareId(drivers, parseHardwareIds('PCI\\VEN_8086&DEV_1C3A&SUBSYS_1')[0]);
    assert.deepEqual(m.exact.map((d) => d.id), ['exact']);
    assert.deepEqual(m.sameVendor.map((d) => d.id), ['other-dev']);
  });
  describe('hardware report file', () => {
    const good = JSON.stringify({ format: 'anto-ltg.hardware-report', format_version: 1, manufacturer: 'ACME\u0000 Corp', model: 'Laptop 1', baseboard: 'BB', os: { caption: 'Windows 11 Pro', build: 26100, arch: 'AMD64' },
      devices: [{ name: 'Network adapter', problem_code: 28, hardware_ids: ['PCI\\VEN_8086&DEV_15F3&SUBSYS_1', 5, null] }, { name: 'No ids', hardware_ids: [] }, { name: 'Fine', problem_code: 0, hardware_ids: ['USB\\VID_0403&PID_6001'] }] });
    it('parses a well-formed report and drops control characters and devices without ids', () => {
      const r = parseHardwareReport(good);
      assert.equal(r.ok, true);
      assert.equal(r.report.manufacturer, 'ACME  Corp', 'the control character became a space');
      assert.deepEqual(r.report.devices.map((d) => [d.name, d.problem, d.problemCode, d.ids.length]), [['Network adapter', true, 28, 1], ['Fine', false, 0, 1]]);
      assert.deepEqual(r.report.os, { caption: 'Windows 11 Pro', build: 26100, arch: 'AMD64' });
    });
    it('rejects anything else with a readable message', () => {
      for (const [input, re] of [['', /not valid JSON/], ['{', /not valid JSON/], ['{}', /not an ANTO-LTG hardware report/], [JSON.stringify({ format: 'anto-ltg.hardware-report', format_version: 2 }), /not an ANTO-LTG/], ['x'.repeat(400_001), /too large/], [42, /empty or too large/]]) {
        const r = parseHardwareReport(input);
        assert.equal(r.ok, false);
        assert.match(r.error, re);
      }
    });
    it('limits the number of devices and the length of strings', () => {
      const many = JSON.stringify({ format: 'anto-ltg.hardware-report', format_version: 1, model: 'm'.repeat(500), devices: Array.from({ length: 900 }, (_, i) => ({ name: `d${i}`, hardware_ids: ['PCI\\VEN_8086&DEV_0001'] })) });
      const r = parseHardwareReport(many);
      assert.equal(r.report.devices.length, 600);
      assert.equal(r.report.model.length, 120);
    });
    it('maps Windows builds and processor names', () => {
      assert.equal(osKeyFromBuild(26100), 'windows-11');
      assert.equal(osKeyFromBuild(22000), 'windows-11');
      assert.equal(osKeyFromBuild(19045), 'windows-10');
      assert.equal(osKeyFromBuild(9600), '');
      assert.equal(osKeyFromBuild(null), '');
      assert.deepEqual(['AMD64', 'x64', 'ARM64', 'x86', 'IA64', ''].map(archFromReport), ['x64', 'x64', 'arm64', 'x86', '', '']);
    });
  });
});

describe('the real catalog works with these helpers', () => {
  it('every app category and driver component is defined in the model', async () => {
    const { apps, drivers, tools } = await loadCatalogs();
    for (const a of apps.items) assert.ok(CATEGORY_BY_ID[a.category], `${a.id}: unknown category ${a.category}`);
    for (const t of tools.items) assert.ok(CATEGORY_BY_ID[t.category], `${t.id}: unknown category ${t.category}`);
    for (const d of drivers.items) assert.ok(COMPONENTS[d.component], `${d.id}: unknown component ${d.component}`);
  });
  it('full-catalog filtering is consistent with the search index', async () => {
    const catalogs = await loadCatalogs();
    const searcher = createSearcher(buildIndex(buildSearchDocs(catalogs)));
    const all = catalogs.apps.items;
    const hits = filterApps(all, { q: 'browser', category: 'browsers' }, { searcher });
    assert.ok(hits.length >= 5 && hits.every((a) => a.category === 'browsers'));
    assert.ok(filterApps(all, { os: 'windows11', declaredOnly: true }).length >= 30, 'some apps declare Windows 11 support through MinimumOSVersion');
    assert.equal(filterApps(all, { arch: 'arm64' }).every((a) => a.architectures.includes('arm64') || a.architectures.includes('neutral')), true);
    const drivers = filterDrivers(catalogs.drivers.items, { q: 'intel', source: 'official' }, { searcher });
    assert.ok(drivers.length >= 3 && drivers.every((d) => d.source_kind !== 'third_party_aggregator'));
  });
});

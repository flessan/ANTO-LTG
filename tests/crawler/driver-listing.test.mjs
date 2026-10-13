// The driver-listing adapter: third-party aggregator pages become clearly labelled LEADS and nothing else.
// Tested against the reconstructed DriverScape fixture, hand-written pages, and a scripted live path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import adapter, { inferComponent, qualityFlags, parseListing } from '../../scripts/crawler/adapters/driver-listing.mjs';
import { parseRobots, isAllowed } from '../../scripts/crawler/lib/robots.mjs';
import { createHttpClient } from '../../scripts/crawler/lib/http.mjs';
import { RobotsChecker } from '../../scripts/crawler/lib/robots.mjs';
import { planMerge } from '../../scripts/crawler/lib/merge.mjs';
import { checkSemantics, isAggregatorHost } from '../../scripts/lib/semantic.mjs';
import { loadSchemas, createValidators } from '../../scripts/lib/schema.mjs';
import { scriptedFetch, virtualClock, ok } from '../helpers/net.mjs';
import { fromRoot, loadCatalogs, readText } from '../helpers/repo.mjs';
import { pathToFileURL } from 'node:url';

const URL_ = 'https://www.driverscape.com/manufacturers/online/laptops-desktops/online/125322';
const html = await readText('tests', 'fixtures', 'driverscape-online-125322.html');
const robotsText = await readText('tests', 'fixtures', 'driverscape-robots.txt');
const robots = parseRobots(robotsText);
const robotsFor = async (abs) => isAllowed(robots, 'ANTO-LTG-Crawler', abs.pathname + abs.search).allowed;
const { vendors } = await loadCatalogs();

const row = ({ device = 'Video Controller (VGA Compatible)', date = '2013-02-04', size = '23.09M', version = '6.14.10.5437', vendor = 'Intel', os = 'Windows XP 32bit', file = 'https://www.driverscape.com/files/display/intel_HD_Graphics_winxp_145111.zip', deviceHtml } = {}) => `
<table><tr><td>Device Name:</td><td>${deviceHtml ?? `<a href="https://www.driverscape.com/download/x">${device}</a>`}</td></tr>
<tr><td>Driver Date</td><td>${date}</td><td>File Size:</td><td>${size}</td></tr>
<tr><td>Driver Version:</td><td>${version}</td><td>Vendor:</td><td>${vendor}</td></tr>
<tr><td>Supported OS:</td><td>${os}</td></tr></table><p>Please enter verification code, then click the download button.</p>${file ? `<a href="${file}">Download</a>` : ''}`;
const parse = (page) => parseListing(page, { url: URL_, observedAt: '2026-10-13', vendors: vendors.items, robotsFor });

describe('inferComponent', () => {
  it('maps device names to components', () => {
    const cases = { 'Realtek High Definition Audio': 'audio', 'Intel(R) HD Graphics 4000': 'graphics', 'Video Controller (VGA Compatible)': 'graphics', 'Intel(R) 82579LM Gigabit Network Connection': 'network-ethernet',
      'Intel(R) Centrino(R) Wireless-N 2230': 'network-wifi', 'Intel Wi-Fi 6 AX201': 'network-wifi', 'Bluetooth Adapter': 'bluetooth', 'Intel(R) 6 Series/C200 Series Chipset Family 4 port Serial ATA Storage Controller': 'storage',
      'USB Root Hub': 'usb', 'Synaptics Touchpad': 'input', 'Intel(R) Management Engine Interface': 'chipset', 'Something else entirely': 'other' };
    for (const [device, component] of Object.entries(cases)) assert.equal(inferComponent(device), component, device);
  });
});

describe('qualityFlags (inconsistencies in a third-party listing are surfaced, never smoothed over)', () => {
  const base = { devices: ['Intel(R) HD Graphics 4000'], vendor: 'Intel', version: '10.18.10.3304', date: '2013-05-01', osText: 'Windows 10 64bit', osParsed: [{ os: 'windows-10', architectures: ['x64'] }], fileName: 'intel_graphics_10.18.10.3304.zip' };
  const flags = (o) => qualityFlags({ ...base, ...o });
  it('a clean row has no flags', () => assert.deepEqual(flags({}), []));
  it('multi_device_row', () => assert.ok(flags({ devices: ['A - 1C00', 'B - 1C01'] }).includes('multi_device_row')));
  it('non_english_name (localised names and non-Latin scripts)', () => {
    for (const d of ['Dispositivo de audio', 'Contr\u00f4leur graphique', 'Ger\u00e4t', '\u0423\u0441\u0442\u0440\u043e\u0439\u0441\u0442\u0432\u043e', '\u663e\u793a\u9002\u914d\u5668']) assert.ok(flags({ devices: [d] }).includes('non_english_name'), d);
  });
  it('generic_device_name', () => { for (const d of ['PCI standard host CPU bridge', 'Standard SATA AHCI Controller', 'Generic USB Hub', 'Unknown device']) assert.ok(flags({ devices: [d] }).includes('generic_device_name'), d); });
  it('vendor_device_mismatch (the listed vendor is not the device vendor)', () => assert.ok(flags({ devices: ['Realtek PCIe GBE Family Controller'], vendor: 'Intel' }).includes('vendor_device_mismatch')));
  it('filename_vendor_mismatch', () => assert.ok(flags({ fileName: 'realtek_audio_6.0.1.zip' }).includes('filename_vendor_mismatch')));
  it('filename_version_mismatch (dotted and underscore versions)', () => {
    assert.ok(flags({ fileName: 'intel_graphics_9.9.9.9.zip' }).includes('filename_version_mismatch'));
    assert.ok(!flags({ fileName: 'intel_graphics_10.18.10.3304.zip' }).includes('filename_version_mismatch'));
    assert.ok(flags({ version: '10.0.1.2', fileName: 'intel_10_0_9_9.zip' }).includes('filename_version_mismatch'));
    assert.ok(!flags({ version: '10.0.1.2', fileName: 'intel_10_0_1_2.zip' }).includes('filename_version_mismatch'));
    assert.ok(!flags({ fileName: 'intel_win8_8.1_05202015.zip' }).includes('filename_version_mismatch'), 'OS words and build stamps are not versions');
  });
  it('date_inconsistent (a pre-2006 date for a modern OS)', () => assert.ok(flags({ date: '2001-01-01', osParsed: [{ os: 'windows-10', architectures: ['x64'] }] }).includes('date_inconsistent')));
  it('legacy_os_only and lists_end_of_support_os', () => {
    const f = flags({ osParsed: [{ os: 'windows-xp', architectures: [] }, { os: 'windows-7', architectures: ['x64'] }] });
    assert.ok(f.includes('legacy_os_only') && f.includes('lists_end_of_support_os'));
    assert.ok(!flags({ osParsed: [{ os: 'windows-10', architectures: ['x64'] }, { os: 'windows-7', architectures: ['x64'] }] }).includes('legacy_os_only'));
  });
  it('architecture_not_stated', () => assert.ok(flags({ osParsed: [{ os: 'windows-10', architectures: [] }] }).includes('architecture_not_stated')));
  it('flags come back sorted and unique', () => { const f = flags({ devices: ['A', 'B'], osParsed: [{ os: 'windows-xp', architectures: [] }] }); assert.deepEqual(f, [...new Set(f)].sort()); });
});

describe('parseListing on hand-written pages', () => {
  it('turns a driver table into a lead with the official portal as its source of truth', async () => {
    const { proposals, errors, rows } = await parse(row({ version: '6.14.10.5437', file: 'https://www.driverscape.com/files/display/intel_HD_Graphics_winxp_6.14.10.5437.zip' }));
    assert.deepEqual([rows, errors.length, proposals.length], [1, 0, 1]);
    const r = proposals[0].record;
    assert.deepEqual([r.source_kind, r.verification_status, r.kind, r.vendor_id, r.manufacturer, r.version, r.release_date, r.file_size_text, r.component], ['third_party_aggregator', 'pending_review', 'catalog_entry', 'intel', 'Intel', '6.14.10.5437', '2013-02-04', '23.09M', 'graphics']);
    assert.deepEqual(r.os_support, [{ os: 'windows-xp', architectures: ['x86'] }]);
    assert.deepEqual(r.download, { kind: 'none', requires: ['captcha'] });
    assert.equal(r.official_source.vendor_id, 'intel');
    assert.match(r.official_source.url, /^https:\/\/www\.intel\.com\//);
    assert.match(r.description, /lead to check on the vendor's official page, not a verified package/);
    assert.match(r.name, /\(aggregator listing\)$/);
    assert.equal(r.evidence[0].type, 'aggregator_listing');
    assert.equal(r.sources[0].kind, 'aggregator_listing');
  });
  it('NEVER stores the file link, and records that the download path is robots-disallowed and gated', async () => {
    const { proposals } = await parse(row({ file: 'https://www.driverscape.com/files/display/secret_driver.zip' }));
    assert.doesNotMatch(JSON.stringify(proposals), /\/files\/|files\/display/, 'no file URL or path appears anywhere in the proposal');
    assert.doesNotMatch(JSON.stringify(proposals.map((p) => p.record)), /secret_driver/, 'the file name never reaches the catalog record');
    assert.equal(proposals[0].meta.listing.file_name, 'secret_driver.zip', 'it is kept only in crawl metadata, for the filename-vs-version consistency check');
    assert.ok(proposals[0].meta.quality_flags.includes('download_path_robots_disallowed'));
    assert.ok(proposals[0].meta.quality_flags.includes('download_gated_by_verification_code'));
    assert.equal(proposals[0].record.download.url, undefined);
  });
  it('skips tables that are not driver rows (no guessing)', async () => {
    const r = await parse('<table><tr><td>Menu</td><td>Home</td></tr></table><table><tr><td>Device Name:</td><td>X</td></tr></table>');
    assert.deepEqual([r.proposals.length, r.errors.length, r.rows], [0, 0, 0]);
  });
  it('a lead for a vendor with no official portal in the catalog is an error, not a record', async () => {
    const r = await parse(row({ device: 'Matrox Graphics Millennium', vendor: 'Matrox' }));
    assert.equal(r.proposals.length, 0);
    assert.deepEqual(r.errors.map((e) => [e.code, e.retryable]), [['NO_OFFICIAL_MAPPING', false]]);
  });
  it('hostile cell content is reduced to plain text', async () => {
    const { proposals } = await parse(row({ deviceHtml: '<a href="x">Intel <script>alert(1)</script><b>HD</b> Graphics \u202e</a>', vendor: 'Intel <img src=x onerror=alert(1)>', os: 'Windows 10 64bit' }));
    const r = proposals[0].record;
    assert.doesNotMatch(JSON.stringify(r), /<script|<img|<b>|\u202e|onerror=alert/);
  });
  it('a file link that is javascript: or malformed does not break parsing or leak into the record', async () => {
    for (const file of ['javascript:alert(1)', 'https://', '//evil.example/x.exe', 'data:text/html,hi']) {
      const r = await parse(row({ file }));
      assert.equal(r.errors.length, 0, file);
      assert.doesNotMatch(JSON.stringify(r.proposals), /evil\.example|javascript:|data:text/, file);
    }
  });
  it('a missing date stays null; a missing size stays null; nothing is made up', async () => {
    const page = `<table><tr><td>Device Name:</td><td><a href="x">Intel(R) HD Graphics</a></td></tr><tr><td>Driver Version:</td><td>1.2.3.4</td><td>Vendor:</td><td>Intel</td></tr><tr><td>Supported OS:</td><td>Windows 10</td></tr></table>`;
    const r = (await parse(page)).proposals[0].record;
    assert.deepEqual([r.release_date, r.file_size_text], [null, null]);
    assert.deepEqual(r.os_support, [{ os: 'windows-10', architectures: [] }], 'no stated bitness means unknown, not "all"');
    assert.deepEqual(r.architectures, []);
  });
  it('ids are stable and unique for the same input, and differ for different rows', async () => {
    const a = await parse(row() + row({ os: 'Windows XP 64bit' }) + row());
    const ids = a.proposals.map((p) => p.record.id);
    assert.equal(ids[0], ids[2], 'identical rows get identical ids (so merges de-duplicate them)');
    assert.notEqual(ids[0], ids[1]);
    assert.deepEqual((await parse(row())).proposals[0].record.id, ids[0]);
  });
  it('derives PCI hardware ids for Intel rows only when the listing shows a four-digit device code', async () => {
    const p = (await parse(row({ device: 'Intel(R) 6 Series/C200 Series Chipset Family USB Enhanced Host Controller - 1C26', os: 'Windows 7 64bit' }))).proposals[0];
    assert.deepEqual(p.record.hardware_ids, ['PCI\\VEN_8086&DEV_1C26']);
    assert.equal((await parse(row({ device: 'Intel(R) HD Graphics' }))).proposals[0].record.hardware_ids, undefined);
  });
});

describe('the DriverScape fixture', () => {
  it('is a reconstruction of the page text, and says so', async () => {
    const note = await readText('tests', 'fixtures', 'make-driverscape-fixture.mjs');
    assert.match(note, /reconstruct|not byte-exact|fetch_page/i);
  });
  it('parses to 34 leads and one NO_OFFICIAL_MAPPING error', async () => {
    const r = await parse(html);
    assert.deepEqual([r.rows, r.proposals.length, r.errors.length], [35, 34, 1]);
    assert.equal(r.errors[0].code, 'NO_OFFICIAL_MAPPING');
  });
  it('every lead is an aggregator lead with no download link, an official source and a quality-flag list', async () => {
    const { proposals } = await parse(html);
    for (const { record: r, meta } of proposals) {
      assert.equal(r.source_kind, 'third_party_aggregator', r.id);
      assert.equal(r.verification_status, 'pending_review', r.id);
      assert.deepEqual(r.download, { kind: 'none', requires: ['captcha'] }, r.id);
      assert.ok(r.official_source?.url && r.official_source.vendor_id, r.id);
      assert.ok(isAggregatorHost(new URL(r.source_url).hostname), r.id);
      assert.ok(meta.quality_flags.includes('download_gated_by_verification_code'), r.id);
      assert.deepEqual(meta.quality_flags, [...meta.quality_flags].sort(), r.id);
    }
    assert.doesNotMatch(JSON.stringify(proposals), /\/files\//, 'no file path from the robots-disallowed /files/ area is stored');
  });
  it('the inconsistencies in the page are caught by quality flags (some rows are held back)', async () => {
    const { proposals } = await parse(html);
    const blocking = new Set(['vendor_device_mismatch', 'filename_vendor_mismatch', 'filename_version_mismatch', 'non_english_name', 'multi_device_row', 'generic_device_name', 'date_inconsistent']);
    const held = proposals.filter((p) => p.meta.quality_flags.some((f) => blocking.has(f)));
    assert.equal(held.length, 18);
    assert.equal(proposals.length - held.length, 16);
  });
  it('merging the unflagged leads into the real catalog keeps every policy rule', async () => {
    const catalogs = await loadCatalogs();
    const { proposals } = await parse(html);
    const { doc, actions } = planMerge({ catalog: 'drivers', doc: catalogs.drivers, proposals, today: '2026-10-13' });
    assert.ok(actions.every((a) => ['unchanged', 'skip', 'update'].includes(a.type)), 'the leads are already in the catalog');
    const v = createValidators(await loadSchemas(fromRoot('schemas')));
    assert.deepEqual(v.validate('drivers', doc).errors, []);
    assert.deepEqual(checkSemantics({ ...catalogs, drivers: doc }), []);
  });
  it('the leads in the catalog are exactly the 16 unflagged proposals', async () => {
    const { drivers } = await loadCatalogs();
    const leads = drivers.items.filter((d) => d.source_kind === 'third_party_aggregator');
    assert.equal(leads.length, 16);
    const { proposals } = await parse(html);
    const unflagged = new Set(proposals.filter((p) => !p.meta.quality_flags.some((f) => ['vendor_device_mismatch', 'filename_vendor_mismatch', 'filename_version_mismatch', 'non_english_name', 'multi_device_row', 'generic_device_name', 'date_inconsistent'].includes(f))).map((p) => p.record.id));
    assert.deepEqual(leads.map((d) => d.id).sort(), [...unflagged].sort());
  });
});

describe('the adapter run()', () => {
  const targetsFile = { targets: [{ id: 'driverscape-online-125322', url: URL_, observed_at: '2026-10-13', fixture: { html: 'tests/fixtures/driverscape-online-125322.html', robots: 'tests/fixtures/driverscape-robots.txt' } }] };
  const cfg = { targets_file: 'seeds/driver-listings.json' };
  const rootUrl = pathToFileURL(`${fromRoot('scripts', 'crawler')}/`);

  it('fixture mode reads files from disk, never the network, and says "fixture" in its output', async () => {
    const r = await adapter.run({ cfg, ctx: { fixtures: { 'driverscape-online-125322': { html: fromRoot('tests', 'fixtures', 'driverscape-online-125322.html'), robots: fromRoot('tests', 'fixtures', 'driverscape-robots.txt'), label: 'fixture' } }, vendors: vendors.items, now: () => '2026-10-13T00:00:00.000Z', rootUrl, productToken: 'ANTO-LTG-Crawler' } });
    assert.deepEqual([r.proposals.length, r.errors.length, r.attempted], [34, 1, ['driverscape-online-125322']]);
    assert.equal(r.source.targets[0].mode, 'fixture');
    assert.equal(r.source.targets[0].observed_at, '2026-10-13');
  });
  it('live mode fetches ONLY the listing page (honouring robots.txt) and never a file link', async () => {
    const net = scriptedFetch((req) => (req.url.endsWith('/robots.txt') ? ok(robotsText, { 'content-type': 'text/plain' }) : ok(html)));
    const clock = virtualClock();
    const client = createHttpClient({ fetchImpl: net.fetchImpl, sleep: clock.sleep, now: clock.now, checkDns: false, allowedHosts: ['www.driverscape.com'], perHostMinIntervalMs: 0, retries: 0 });
    client.setRobots(new RobotsChecker({ client, productToken: 'ANTO-LTG-Crawler', now: clock.now }));
    const r = await adapter.run({ cfg, ctx: { client, vendors: vendors.items, now: () => '2026-10-13T00:00:00.000Z', rootUrl, productToken: 'ANTO-LTG-Crawler' } });
    assert.equal(r.proposals.length, 34);
    assert.equal(r.source.targets[0].mode, 'live');
    assert.deepEqual(net.calls.map((c) => new URL(c.url).pathname), ['/robots.txt', '/manufacturers/online/laptops-desktops/online/125322']);
  });
  it('a listing that robots.txt disallows is a permanent, recorded error, not a retry loop', async () => {
    const net = scriptedFetch((req) => (req.url.endsWith('/robots.txt') ? ok('User-agent: *\nDisallow: /manufacturers/', { 'content-type': 'text/plain' }) : ok(html)));
    const clock = virtualClock();
    const client = createHttpClient({ fetchImpl: net.fetchImpl, sleep: clock.sleep, now: clock.now, checkDns: false, allowedHosts: ['www.driverscape.com'], perHostMinIntervalMs: 0, retries: 0 });
    client.setRobots(new RobotsChecker({ client, productToken: 'ANTO-LTG-Crawler', now: clock.now }));
    const r = await adapter.run({ cfg, ctx: { client, vendors: vendors.items, now: () => '2026-10-13T00:00:00.000Z', rootUrl, productToken: 'ANTO-LTG-Crawler' } });
    assert.equal(r.proposals.length, 0);
    assert.deepEqual(r.errors.map((e) => [e.code, e.retryable]), [['ROBOTS_DISALLOWED', false]]);
    assert.ok(!net.calls.some((c) => c.url.includes('/manufacturers/')), 'the disallowed page was never requested');
  });
  it('a page whose layout changed (no rows recognised) is reported as NO_ROWS instead of producing nothing silently', async () => {
    const net = scriptedFetch((req) => (req.url.endsWith('/robots.txt') ? ok('', { 'content-type': 'text/plain' }) : ok('<html><body><p>Redesigned page</p></body></html>')));
    const clock = virtualClock();
    const client = createHttpClient({ fetchImpl: net.fetchImpl, sleep: clock.sleep, now: clock.now, checkDns: false, allowedHosts: ['www.driverscape.com'], perHostMinIntervalMs: 0, retries: 0 });
    const r = await adapter.run({ cfg, ctx: { client, vendors: vendors.items, now: () => '2026-10-13T00:00:00.000Z', rootUrl } });
    assert.deepEqual(r.errors.map((e) => [e.code, e.retryable]), [['NO_ROWS', false]]);
  });
  it('an HTTP error on the listing is recorded against the target', async () => {
    const net = scriptedFetch((req) => (req.url.endsWith('/robots.txt') ? ok('', { 'content-type': 'text/plain' }) : { status: 503, headers: {}, body: 'busy' }));
    const clock = virtualClock();
    const client = createHttpClient({ fetchImpl: net.fetchImpl, sleep: clock.sleep, now: clock.now, checkDns: false, allowedHosts: ['www.driverscape.com'], perHostMinIntervalMs: 0, retries: 0 });
    const r = await adapter.run({ cfg, ctx: { client, vendors: vendors.items, now: () => '2026-10-13T00:00:00.000Z', rootUrl } });
    assert.deepEqual(r.errors.map((e) => [e.target, e.code, e.retryable]), [['driverscape-online-125322', 'HTTP_503', true]]);
  });
  it('--ids selects targets and ignores unknown ones', async () => {
    const r = await adapter.run({ cfg, ctx: { targets: ['nope'], vendors: vendors.items, now: () => '2026-10-13T00:00:00.000Z', rootUrl } });
    assert.deepEqual([r.proposals.length, r.attempted], [0, []]);
  });
  it('the seed file points at a fixture that exists and an https listing on an allowed host', async () => {
    const seeds = JSON.parse(await readFile(fromRoot('scripts', 'crawler', 'seeds', 'driver-listings.json'), 'utf8'));
    assert.deepEqual(seeds.targets.map((t) => [t.id, t.url, t.fixture]), targetsFile.targets.map((t) => [t.id, t.url, t.fixture]));
    for (const t of seeds.targets) { assert.equal(new URL(t.url).protocol, 'https:'); await readFile(fromRoot(t.fixture.html)); await readFile(fromRoot(t.fixture.robots)); }
  });
});

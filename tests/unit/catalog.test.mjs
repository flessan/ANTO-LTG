// Catalog-wide data checks: schemas, canonical form, policy rules (positive AND negative), honesty
// invariants, example records, and the generated artifacts (API files, OpenAPI) staying in sync.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CATALOGS, SCHEMA_VERSION, canonicalizeDoc, serialize } from '../../scripts/lib/catalog-io.mjs';
import { loadSchemas, createValidators } from '../../scripts/lib/schema.mjs';
import { checkSemantics, isAggregatorHost, AGGREGATOR_HOSTS } from '../../scripts/lib/semantic.mjs';
import { buildOpenApi } from '../../scripts/lib/openapi.mjs';
import { buildSearchDocs } from '../../scripts/lib/search-docs.mjs';
import { buildIndex } from '../../assets/js/lib/search.js';
import { WINGET_ID_RE } from '../../assets/js/lib/psgen.js';
import { fromRoot, readText, readJson, loadCatalogs } from '../helpers/repo.mjs';

const base = await loadCatalogs();
const schemas = await loadSchemas(fromRoot('schemas'));
const validators = createValidators(schemas);
const clone = () => structuredClone(base);
const TODAY = new Date().toISOString().slice(0, 10);
// Aggregator leads are never published, so they live only in the crawler's lead file. Tests that need one insert a copy into a mutated catalog.
const LEADS = (await readJson('catalogs', 'proposed', 'driver-listings.proposals.json')).proposals.map((p) => p.record);
assert.ok(LEADS.length >= 10, 'test fixture: expected aggregator leads in the proposal file');
const first = (list, pred) => { const x = list.find(pred); assert.ok(x, 'test fixture: expected the catalog to contain a matching record'); return x; };

describe('real catalogs', () => {
  for (const name of CATALOGS) {
    it(`${name}.json matches its JSON Schema`, () => {
      const r = validators.validate(name, base[name]);
      assert.deepEqual(r.errors.slice(0, 5), []);
    });
    it(`${name}.json is in canonical form (sorted ids, stable key order)`, async () => {
      assert.equal(await readText('catalogs', `${name}.json`), serialize(canonicalizeDoc(name, base[name])));
    });
  }
  it('every catalog declares the current schema version and a valid update time', () => {
    for (const name of CATALOGS) {
      assert.equal(base[name].schema_version, SCHEMA_VERSION, name);
      assert.match(base[name].updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/, name);
    }
  });
  it('passes every policy rule (references, official domains, aggregators, URLs, dates)', () => assert.deepEqual(checkSemantics(base), []));
  it('has the expected size (apps crawled from winget-pkgs plus curated records)', () => {
    assert.ok(base.apps.items.length >= 250, `apps: ${base.apps.items.length}`);
    assert.ok(base.drivers.items.length >= 40);
    assert.ok(base.vendors.items.length >= 18);
    assert.ok(base.tools.items.length >= 15);
    assert.ok(base.bundles.items.length >= 5);
  });
  it('ids are unique slugs and sorted', () => {
    for (const name of ['apps', 'drivers', 'vendors', 'tools', 'bundles', 'updates']) {
      const ids = base[name].items.map((i) => i.id);
      assert.equal(new Set(ids).size, ids.length, `${name}: duplicate ids`);
      assert.deepEqual(ids, [...ids].sort(), `${name}: ids are sorted`);
      if (name !== 'updates') for (const id of ids) assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${name}:${id}`);
    }
  });
});

describe('honesty invariants of the data', () => {
  const reviewable = ['apps', 'drivers', 'tools', 'vendors'];
  it('nothing is "verified" without a reviewer, a date, notes and an evidence URL', () => {
    for (const name of reviewable) {
      for (const i of base[name].items.filter((x) => x.verification_status === 'verified')) {
        assert.ok(i.reviewed_at && i.review_notes && i.evidence_url, `${name}:${i.id} is verified without review evidence`);
      }
    }
  });
  it('crawled records are never promoted: every winget-pkgs-sourced record that nobody reviewed is pending', () => {
    for (const a of base.apps.items.filter((x) => x.sources.some((s) => s.id === 'winget-pkgs'))) {
      if (!a.reviewed_at) assert.equal(a.verification_status, 'not_reviewed', a.id);
    }
  });
  it('windows_compatibility (a human conclusion) stays not_reviewed unless notes and evidence exist', () => {
    for (const a of base.apps.items) {
      if (a.windows_compatibility !== 'not_reviewed') assert.ok(a.review_notes && a.evidence_url, a.id);
    }
    assert.ok(base.apps.items.filter((a) => a.windows_compatibility === 'not_reviewed').length > 250);
  });
  it('declared Windows compatibility only appears where a source lists the compatibility field', () => {
    for (const a of base.apps.items) {
      const declared = ['windows10', 'windows11'].some((k) => a.compatibility?.[k] === 'declared' || a.compatibility?.[k] === 'unsupported');
      if (declared) assert.ok(a.sources.some((s) => s.fields?.includes('compatibility')), `${a.id}: compatibility has no source`);
    }
  });
  it('every version, date and download is backed by a source that lists that field', () => {
    for (const name of ['apps', 'drivers']) {
      for (const i of base[name].items) {
        const fieldsFromSources = new Set(i.sources.flatMap((s) => s.fields ?? []));
        if (i.version) assert.ok(fieldsFromSources.has('version'), `${name}:${i.id} version has no source`);
        if (i.release_date) assert.ok(fieldsFromSources.has('release_date'), `${name}:${i.id} release_date has no source`);
        if (name === 'apps' && i.downloads?.length) assert.ok(fieldsFromSources.has('downloads'), `${name}:${i.id} downloads have no source`);
        if (name === 'drivers' && i.download?.url) assert.ok(fieldsFromSources.has('download'), `${name}:${i.id} download has no source`);
      }
    }
  });
  it('every checksum is a lower-case hex digest of the right length with a stated origin; nothing is computed locally', () => {
    let count = 0;
    const check = (where, d) => {
      for (const [field, len] of [['sha256', 64], ['sha512', 128]]) {
        if (!d[field]) continue;
        count++;
        assert.match(d[field], new RegExp(`^[a-f0-9]{${len}}$`), `${where}: ${field}`);
        assert.ok(d[`${field}_source`], `${where}: ${field} has no ${field}_source`);
        assert.doesNotMatch(d[`${field}_source`], /computed|calculated|generated by anto/i, `${where}: hashes are copied from the publisher, never computed here`);
      }
    };
    for (const a of base.apps.items) for (const d of a.downloads ?? []) check(`apps:${a.id}`, d);
    for (const t of base.tools.items) for (const d of t.downloads ?? []) check(`tools:${t.id}`, d);
    for (const d of base.drivers.items) if (d.download) check(`drivers:${d.id}`, d.download);
    assert.ok(count > 200, `expected hundreds of published hashes, saw ${count}`);
  });
  it('no checksum is invented for a record whose source did not publish one', () => {
    for (const d of base.drivers.items.filter((x) => x.download && !x.download.sha256 && !x.download.sha512)) assert.ok(!('sha256_source' in d.download) || d.download.sha256_source === null, d.id);
    const fake = /^(0{64}|1{64}|a{64}|f{64}|(0123456789abcdef)+)$/;
    for (const a of base.apps.items) for (const d of a.downloads ?? []) if (d.sha256) assert.doesNotMatch(d.sha256, fake, `${a.id}: placeholder hash`);
  });
  it('drivers.json holds no aggregator lead (the semantic rule forbids them in the catalog)', () => {
    assert.equal(base.drivers.items.filter((d) => d.source_kind === 'third_party_aggregator').length, 0);
  });
  it('driver leads (crawler lead file): labelled leads, carry no download, and point at an official source', () => {
    for (const d of LEADS) {
      assert.equal(d.download.kind, 'none', d.id);
      assert.ok(!d.download.url, d.id);
      assert.equal(d.verification_status, 'not_reviewed', d.id);
      assert.ok(d.official_source?.url, `${d.id}: a lead must name the official place to check it`);
      assert.ok(isAggregatorHost(new URL(d.source_url).hostname), d.id);
      assert.match(d.description, /lead/i, `${d.id}: description says it is a lead`);
    }
  });
  it('only official vendor domains carry direct driver links, and no aggregator is ever a download host', () => {
    const vendors = new Map(base.vendors.items.map((v) => [v.id, v]));
    for (const d of base.drivers.items.filter((x) => x.download?.kind === 'direct_binary')) {
      const host = new URL(d.download.url).hostname;
      const v = vendors.get(d.official_source?.vendor_id ?? d.vendor_id);
      assert.ok(v && v.domains.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) || host === p.slice(2) : host === p)), `${d.id}: ${host}`);
    }
    for (const a of base.apps.items) for (const dl of a.downloads ?? []) assert.ok(!isAggregatorHost(new URL(dl.url).hostname), `${a.id}: ${dl.url}`);
  });
  it('every URL in every catalog is https without credentials', () => {
    const urls = [];
    const walk = (value, key = '') => {
      if (Array.isArray(value)) value.forEach((v) => walk(v, key));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k));
      else if (typeof value === 'string' && /(^|_)url$/.test(key)) urls.push(value);
    };
    for (const name of CATALOGS) walk(base[name]);
    assert.ok(urls.length > 1000);
    for (const u of urls) { const p = new URL(u); assert.equal(p.protocol, 'https:', u); assert.equal(p.username + p.password, '', u); }
  });
  it('WinGet ids are valid and unique (case-insensitively); every one is proven by a winget-pkgs source', () => {
    const seen = new Map();
    for (const a of base.apps.items.filter((x) => x.winget_id)) {
      assert.match(a.winget_id, WINGET_ID_RE, a.id);
      assert.ok(!seen.has(a.winget_id.toLowerCase()), `${a.id} duplicates ${seen.get(a.winget_id.toLowerCase())}`);
      seen.set(a.winget_id.toLowerCase(), a.id);
      assert.ok(a.sources.some((s) => s.id === 'winget-pkgs'), `${a.id} has no winget-pkgs source`);
    }
    assert.ok(seen.size >= 250);
  });
  it('unavailable apps list no download and no package', () => {
    const gone = base.apps.items.filter((a) => a.availability?.status === 'unavailable');
    assert.ok(gone.length >= 2);
    for (const a of gone) { assert.ok(!a.winget_id && !(a.downloads ?? []).length, a.id); assert.ok(a.availability.evidence_url && a.availability.reason, a.id); }
  });
  it('no date is in the future', () => {
    const walk = (value, key, where) => {
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, key, `${where}[${i}]`));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k, `${where}.${k}`));
      else if (typeof value === 'string' && (/_at$/.test(key) || key === 'release_date' || key === 'since') && /^\d{4}-\d{2}-\d{2}/.test(value)) assert.ok(value.slice(0, 10) <= TODAY, `${where} = ${value}`);
    };
    for (const name of CATALOGS) walk(base[name], '', name);
  });
  it('catalog text is plain text: no markup, no control characters', () => {
    for (const name of CATALOGS) {
      for (const i of base[name].items) for (const [k, v] of Object.entries(i)) {
        if (typeof v === 'string') { assert.doesNotMatch(v, /<\/?[a-z!][^>]*>/i, `${name}:${i.id}.${k}`); assert.doesNotMatch(v, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/, `${name}:${i.id}.${k}`); }
      }
    }
  });
  it('every Indonesian text has an English original (English is the default language)', () => {
    for (const name of ['apps', 'drivers', 'tools', 'bundles', 'vendors']) {
      for (const i of base[name].items) for (const k of Object.keys(i).filter((x) => x.endsWith('_id') && typeof i[x] === 'string' && !['vendor_id', 'winget_id', 'app_id'].includes(x))) {
        assert.ok(i[k.replace(/_id$/, '')], `${name}:${i.id}: ${k} exists without its English field`);
      }
    }
  });
  it('nothing in the data claims to be a SQL database, a live API or a real-time driver database', () => {
    const text = JSON.stringify(base);
    assert.doesNotMatch(text, /(?<!not a )real-?time (driver|api|database)|(?<!not a )live driver database|sql database/i);
  });
});

describe('policy rules reject bad data (negative tests)', () => {
  const crawled = (c) => first(c.apps.items, (a) => a.winget_id && a.sources.some((s) => s.id === 'winget-pkgs') && a.downloads?.some((d) => d.kind === 'direct_binary'));
  const lead = (c) => { c.drivers.items.push(structuredClone(LEADS[0])); return c.drivers.items[c.drivers.items.length - 1]; };
  const official = (c) => first(c.drivers.items, (d) => d.source_kind !== 'third_party_aggregator' && d.official_source && d.vendor_id === 'intel' && d.version);
  const cases = [
    ['duplicate id', (c) => c.apps.items.push(structuredClone(c.apps.items[0])), /duplicate id/],
    ['HTML markup in a text field', (c) => { c.apps.items[0].description = 'Nice <script>alert(1)</script>'; }, /HTML-like markup/],
    ['control characters', (c) => { c.apps.items[0].name = 'bad\u0007name'; }, /control characters/],
    ['javascript: URL', (c) => { c.apps.items[0].source_url = 'javascript:alert(1)'; }, /not a safe public https URL/],
    ['plain http URL', (c) => { c.apps.items[0].source_url = 'http://example.com/'; }, /protocol "http:" is not allowed/],
    ['credentials in a URL', (c) => { c.apps.items[0].source_url = 'https://user:secret@example.com/'; }, /credentials/],
    ['localhost URL', (c) => { c.apps.items[0].source_url = 'https://localhost/x'; }, /private, local/],
    ['IP-literal URL', (c) => { c.apps.items[0].source_url = 'https://192.168.1.10/x'; }, /private, local|IP-literal/],
    ['a release date in the future', (c) => { crawled(c).release_date = '2099-01-01'; }, /in the future/],
    ['a retrieval time in the future', (c) => { c.apps.items[0].sources[0].retrieved_at = '2099-01-01T00:00:00.000Z'; }, /in the future/],
    ['the same WinGet id twice (different case)', (c) => { const [a, b] = c.apps.items.filter((x) => x.winget_id); b.winget_id = a.winget_id.toUpperCase(); }, /is also used by/],
    ['a winget_id nothing proves', (c) => { crawled(c).sources = [{ id: 'my-guess', kind: 'curated', url: 'https://example.com/', retrieved_at: '2026-10-13', fields: ['name'] }]; }, /no winget-pkgs source proving it exists/],
    ['a human compatibility verdict without evidence', (c) => { c.apps.items[0].windows_compatibility = 'supported'; delete c.apps.items[0].review_notes; delete c.apps.items[0].evidence_url; }, /human conclusion/],
    ['a version no source states', (c) => { const a = crawled(c); a.sources.forEach((s) => { s.fields = (s.fields ?? []).filter((f) => f !== 'version'); }); }, /has a version but no source lists "version"/],
    ['an aggregator as a download host', (c) => { crawled(c).downloads.push({ kind: 'direct_binary', url: 'https://www.driverscape.com/files/x.exe', evidence: 'x' }); }, /third-party aggregator/],
    ['a direct download without evidence', (c) => { delete crawled(c).downloads.find((d) => d.kind === 'direct_binary').evidence; }, /has no evidence/],
    ['an app that is unavailable but still installable', (c) => { crawled(c).availability = { status: 'unavailable', reason: 'x', evidence_url: 'https://example.com/' }; }, /marked unavailable but still lists/],
    ['a driver with an unknown vendor', (c) => { official(c).vendor_id = 'no-such-vendor'; }, /unknown vendor_id/],
    ['an aggregator lead that carries a download URL', (c) => { lead(c).download = { kind: 'direct_binary', url: 'https://www.driverscape.com/files/x.exe' }; }, /must not carry a download URL/],
    ['an aggregator lead marked verified', (c) => { lead(c).verification_status = 'verified'; }, /can never be verified/],
    ['an aggregator source that is not labelled as one', (c) => { lead(c).source_kind = 'manufacturer_support_page'; }, /aggregator host .* but source_kind/],
    ['an official source on the wrong domain', (c) => { official(c).official_source.url = 'https://evil.example.com/'; }, /not among the domains of vendor/],
    ['an official source on an aggregator', (c) => { official(c).official_source.url = 'https://www.driverscape.com/x'; }, /must not be an aggregator/],
    ['a direct driver download outside the vendor domains', (c) => { official(c).download = { kind: 'direct_binary', url: 'https://evil.example.com/driver.exe', stability: 'versioned' }; }, /not an official domain of the vendor/],
    ['an ephemeral URL stored as a direct link', (c) => { official(c).download = { kind: 'direct_binary', url: 'https://downloadmirror.intel.com/x/driver.exe', stability: 'ephemeral' }; }, /ephemeral URL must not be stored/],
    ['a signed temporary URL', (c) => { official(c).download = { kind: 'signed_temporary', url: 'https://downloadmirror.intel.com/x?sig=abc' }; }, /signed\/temporary URLs must not be stored/],
    ['a sha256 with no stated origin', (c) => { official(c).download = { kind: 'landing_page', url: official(c).source_url, sha256: 'e'.repeat(64) }; }, /needs sha256_source/],
    ['a sha512 with no stated origin', (c) => { official(c).download = { kind: 'landing_page', url: official(c).source_url, sha512: 'e'.repeat(128) }; }, /needs sha512_source/],
    ['an OS in os_support that windows_versions does not list', (c) => { const d = official(c); d.windows_versions = []; }, /os_support lists .* but windows_versions lacks/],
    ['a driver version no source states', (c) => { const d = official(c); d.sources.forEach((s) => { s.fields = (s.fields ?? []).filter((f) => f !== 'version'); }); }, /has a version but no source lists "version"/],
    ['aggregator evidence typed as vendor evidence', (c) => { official(c).evidence = [{ type: 'vendor_page', url: 'https://www.driverscape.com/x', retrieved_at: '2026-10-13' }]; }, /must be typed aggregator_listing/],
    ['a bundle that references a missing app', (c) => { c.bundles.items[0].app_ids.push('no-such-app'); }, /unknown app id/],
    ['a tool that references a missing app', (c) => { first(c.tools.items, (t) => t.app_id).app_id = 'no-such-app'; }, /unknown app_id/],
    ['a verified record reviewed in the future', (c) => { const a = c.apps.items[0]; a.verification_status = 'verified'; a.reviewed_at = '2099-01-01T00:00:00.000Z'; }, /in the future/],
  ];
  for (const [name, mutate, expected] of cases) {
    it(`flags ${name}`, () => {
      const c = clone();
      mutate(c);
      const errors = checkSemantics(c);
      assert.ok(errors.some((e) => expected.test(e)), `expected ${expected}; got:\n${errors.slice(0, 6).join('\n') || '(no errors)'}`);
    });
  }
  it('every mutation really changed the verdict: the unmodified catalog is clean', () => assert.deepEqual(checkSemantics(clone()), []));

  it('recognises aggregator hosts and their subdomains but not look-alikes', () => {
    assert.ok(AGGREGATOR_HOSTS.includes('driverscape.com'));
    for (const h of ['driverscape.com', 'www.driverscape.com', 'files.driverscape.com', 'download.cnet.com', 'drp.su']) assert.equal(isAggregatorHost(h), true, h);
    for (const h of ['notdriverscape.com', 'driverscape.com.evil.example', 'intel.com', 'sourceforge.net', 'github.com']) assert.equal(isAggregatorHost(h), false, h);
  });
});

describe('schemas reject bad records (negative tests)', () => {
  const mutate = (catalog, fn) => { const c = clone(); fn(c[catalog].items); return validators.validate(catalog, c[catalog]); };
  const rejects = (name, catalog, fn, re) => it(name, () => {
    const r = mutate(catalog, fn);
    assert.equal(r.ok, false, 'expected the schema to reject this');
    if (re) assert.ok(r.errors.some((e) => re.test(e)), r.errors.slice(0, 4).join('\n'));
  });
  rejects('an unknown property on an app', 'apps', (i) => { i[0].surprise = 1; }, /additional|surprise/);
  rejects('a missing required property', 'apps', (i) => { delete i[0].publisher; }, /publisher/);
  rejects('an id that is not a slug', 'apps', (i) => { i[0].id = 'Not A Slug'; }, /pattern/);
  rejects('an invalid verification status', 'apps', (i) => { i[0].verification_status = 'trusted'; }, /allowed/);
  rejects('a "verified" app with no review evidence', 'apps', (i) => { i[0].verification_status = 'verified'; }, /reviewed_at|review_notes|evidence_url/);
  rejects('a "verified" driver with no review evidence', 'drivers', (i) => { i[0].verification_status = 'verified'; delete i[0].reviewed_at; }, /reviewed_at|review_notes|evidence_url/);
  rejects('an http URL', 'apps', (i) => { i[0].source_url = 'http://example.com/'; }, /pattern|format/);
  rejects('a malformed sha256', 'apps', (i) => { first(i, (a) => a.downloads?.some((d) => d.sha256)).downloads.find((d) => d.sha256).sha256 = 'XYZ'; }, /pattern/);
  rejects('an unknown download kind', 'apps', (i) => { first(i, (a) => a.downloads?.length).downloads[0].kind = 'magic'; }, /allowed/);
  rejects('an unknown compatibility state', 'apps', (i) => { i[0].compatibility.windows11 = 'works'; }, /allowed/);
  rejects('an unknown driver component', 'drivers', (i) => { i[0].component = 'toaster'; }, /allowed/);
  rejects('an aggregator source kind with a direct download kind', 'drivers', (i) => { i.push(structuredClone(LEADS[0])); const d = i[i.length - 1]; d.download = { kind: 'direct_binary', url: 'https://www.driverscape.com/x.exe' }; }, /.*/);
  rejects('a bundle with an invalid status', 'bundles', (i) => { i[0].status = 'live'; }, /allowed/);
  rejects('a vendor without domains', 'vendors', (i) => { delete i[0].domains; }, /domains/);
  rejects('an update with a malformed time', 'updates', (i) => { i[0].published_at = 'yesterday'; }, /format|pattern/);
  it('rejects a catalog file that is not an object with items', () => {
    assert.equal(validators.validate('apps', []).ok, false);
    assert.equal(validators.validate('apps', { schema_version: '1.1.0' }).ok, false);
  });
});

describe('example records stay valid (docs/examples)', () => {
  const wrap = (item) => ({ schema_version: SCHEMA_VERSION, updated_at: '2026-10-13T00:00:00.000Z', items: [item] });
  const files = { apps: 'app', drivers: 'driver', vendors: 'vendor', tools: 'tool', bundles: 'bundle', updates: 'update' };
  for (const [catalog, file] of Object.entries(files)) {
    it(`${file}.example.json validates against the ${catalog} schema`, async () => {
      const example = await readJson('docs', 'examples', `${file}.example.json`);
      assert.deepEqual(validators.validate(catalog, wrap(example)).errors, []);
    });
  }
  it('the example records also pass the policy rules when added to the catalog', async () => {
    const c = clone();
    for (const [catalog, file] of Object.entries(files)) {
      const ex = await readJson('docs', 'examples', `${file}.example.json`);
      c[catalog].items.push(ex);
    }
    assert.deepEqual(checkSemantics(c), []);
  });
  it('the proposal example validates against the proposals schema', async () => {
    assert.deepEqual(validators.validate('proposals', await readJson('docs', 'examples', 'proposal.example.json')).errors, []);
  });
  it('the bundle manifest example validates against the manifest schema', async () => {
    assert.deepEqual(validators.validate('bundle-manifest', await readJson('docs', 'examples', 'bundle-manifest.example.json')).errors, []);
  });
  it('no example is ever marked verified', async () => {
    for (const file of Object.values(files)) assert.notEqual((await readJson('docs', 'examples', `${file}.example.json`)).verification_status, 'verified');
  });
});

describe('generated API files and OpenAPI are in sync with the catalogs', () => {
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  for (const name of CATALOGS) {
    it(`api/v1/${name}.json is the canonical catalog`, async () => assert.equal(await readText('api', 'v1', `${name}.json`), serialize(canonicalizeDoc(name, base[name]))));
  }
  it('api/v1/index.json lists every file with its count and SHA-256', async () => {
    const index = await readJson('api', 'v1', 'index.json');
    assert.equal(index.api_version, 'v1');
    assert.equal(index.schema_version, SCHEMA_VERSION);
    assert.match(index.note, /not a live driver database and not a real-time API/);
    for (const e of index.endpoints) {
      const file = await readText(...e.path.replace(/^\//, '').split('/'));
      assert.equal(sha(file), e.sha256, e.path);
      const doc = JSON.parse(file);
      assert.equal(e.count, doc.items ? doc.items.length : doc.docs.length, e.path);
    }
    assert.deepEqual(index.endpoints.map((e) => e.name), [...CATALOGS, 'search-index']);
  });
  it('the search index file is the one the build would write', async () => {
    assert.equal(await readText('api', 'v1', 'search-index.json'), `${JSON.stringify(buildIndex(buildSearchDocs(base)))}\n`);
  });
  it('openapi.json is exactly what the generator produces from the schemas', async () => {
    const counts = Object.fromEntries(CATALOGS.map((n) => [n, base[n].items.length]));
    assert.equal(await readText('openapi.json'), `${JSON.stringify(buildOpenApi({ schemas, version: SCHEMA_VERSION, counts }), null, 2)}\n`);
  });
  it('every $ref in openapi.json resolves, and every catalog path has a component schema', async () => {
    const doc = await readJson('openapi.json');
    const components = new Set(Object.keys(doc.components.schemas));
    const refs = JSON.stringify(doc).match(/#\/components\/schemas\/[A-Za-z0-9_]+/g) ?? [];
    assert.ok(refs.length > 20);
    for (const r of refs) assert.ok(components.has(r.split('/').pop()), `dangling ${r}`);
    assert.equal(doc.openapi, '3.1.0');
    assert.equal(doc.info.version, SCHEMA_VERSION);
    assert.deepEqual(Object.keys(doc.paths).sort(), [...CATALOGS.map((n) => `/api/v1/${n}.json`), '/api/v1/index.json', '/api/v1/search-index.json'].sort());
    for (const key of ['Apps_app', 'Drivers_driver', 'Vendors_vendor', 'Tools_tool', 'Bundles_bundle', 'Updates_update', 'BundleManifest', 'Proposals']) assert.ok(components.has(key), key);
  });
  it('the OpenAPI text does not oversell the project', async () => {
    const text = await readText('openapi.json');
    assert.match(text, /not a live driver database and not a real-time API/i);
    assert.doesNotMatch(text, /(?<!not a )real-?time (driver|api)/i, 'never claims to be real-time');
  });
});

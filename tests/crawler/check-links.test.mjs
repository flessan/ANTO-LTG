// check-links: header-only probes of catalog download links. It must never download a file, never store a
// signed URL, never touch anything except `link_check`, and it must respect robots.txt.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { collectLinks, toLinkCheck, runLinkChecks, applyResults, buildReport, summarizeResults, checkLinks, LINK_CATALOGS, REPORT_SCHEMA } from '../../scripts/crawler/commands/check-links.mjs';
import { createHttpClient, CrawlerError } from '../../scripts/crawler/lib/http.mjs';
import { RobotsChecker } from '../../scripts/crawler/lib/robots.mjs';
import { main } from '../../scripts/crawler/cli.mjs';
import { loadSchemas, createValidators } from '../../scripts/lib/schema.mjs';
import { checkSemantics } from '../../scripts/lib/semantic.mjs';
// Download count of the real sysinternals-suite entry, so the expectations track the catalog instead of a literal.
const SYS_ENTRY = JSON.parse(readFileSync(new URL('../../catalogs/apps.json', import.meta.url), 'utf8')).items.find((a) => a.id === 'sysinternals-suite');
const SYS_DOWNLOADS = SYS_ENTRY.downloads.length;
const SYS_URLS = new Set(SYS_ENTRY.downloads.map((d) => d.url)).size; // a dry run probes each distinct URL once
import { CATALOGS } from '../../scripts/lib/catalog-io.mjs';
import { scriptedFetch, virtualClock, trackedBody, ok, redirect } from '../helpers/net.mjs';
import { makeSandbox } from '../helpers/sandbox.mjs';
import { fromRoot, loadCatalogs } from '../helpers/repo.mjs';

const NOW = '2026-10-13T12:00:00.000Z';
const schemas = createValidators(await loadSchemas(fromRoot('schemas')));
const validLinkCheck = (lc) => schemas.validateRef('urn:anto-ltg:schema:common#/$defs/linkCheck', lc);
const link = (o = {}) => ({ catalog: 'apps', id: 'x', index: 0, url: 'https://dl.example.com/app-1.0.exe', kind: 'direct_binary', host: 'dl.example.com', ...o });
const probe = (o = {}) => ({ url: 'u', finalUrl: 'https://dl.example.com/app-1.0.exe', status: 200, redirects: [], redirectBlocked: null, contentType: 'application/octet-stream', contentLength: 1234, contentDisposition: null, acceptRanges: null, etag: null, lastModified: null, binary: false, ...o });

describe('collectLinks', () => {
  const catalogs = {
    apps: { items: [
      { id: 'a1', downloads: [{ kind: 'direct_binary', url: 'https://github.com/o/r/releases/download/v1/a.exe' }, { kind: 'landing_page', url: 'https://www.Example.com/get' }, { kind: 'none' }] },
      { id: 'a2', downloads: [{ kind: 'direct_binary', url: 'not a url' }, { kind: 'redirect', url: 'https://aka.ms/x' }] }, { id: 'a3' },
    ] },
    drivers: { items: [{ id: 'd1', download: { kind: 'landing_page', url: 'https://www.intel.com/page' } }, { id: 'd2', download: { kind: 'none' } }, { id: 'd3' }] },
    tools: { items: [{ id: 't1', downloads: [{ kind: 'direct_binary', url: 'https://learn.microsoft.com/a.zip' }] }] },
  };
  it('collects app and tool downloads and the single driver download, skipping entries without a usable URL', () => {
    const all = collectLinks(catalogs);
    assert.deepEqual(all.map((l) => `${l.catalog}/${l.id}#${l.index}`), ['apps/a1#0', 'apps/a1#1', 'apps/a2#1', 'drivers/d1#0', 'tools/t1#0']);
    assert.equal(all[1].host, 'www.example.com', 'hosts are lower-cased');
  });
  it('filters by catalog, host (including subdomains) and record id', () => {
    assert.deepEqual(collectLinks(catalogs, { catalog: 'drivers' }).map((l) => l.id), ['d1']);
    assert.deepEqual(collectLinks(catalogs, { hosts: ['github.com'] }).map((l) => l.id), ['a1']);
    assert.deepEqual(collectLinks(catalogs, { hosts: ['example.com'] }).map((l) => l.id), ['a1'], 'www.example.com matches example.com');
    assert.deepEqual(collectLinks(catalogs, { hosts: ['ample.com'] }), [], 'not a suffix match on partial labels');
    assert.deepEqual(collectLinks(catalogs, { only: ['t1', 'd1'] }).map((l) => l.id), ['d1', 't1']);
  });
  it('covers exactly the catalogs that carry download links', () => assert.deepEqual(LINK_CATALOGS, ['apps', 'drivers', 'tools']));
  it('finds links in the real catalogs on hundreds of hosts', async () => {
    const real = collectLinks(await loadCatalogs());
    assert.ok(real.length > 300, `only ${real.length} links`);
    assert.ok(new Set(real.map((l) => l.host)).size > 20);
    for (const l of real) assert.equal(new URL(l.url).protocol, 'https:');
  });
});

describe('toLinkCheck: what each server answer means', () => {
  const lc = (p, l) => toLinkCheck({ link: l ?? link(), probe: probe(p), now: NOW });
  const expectValid = (x) => assert.deepEqual(validLinkCheck(x).errors, [], JSON.stringify(x));

  it('200 with a file type is "ok" and records type and size (and nothing about safety)', () => {
    const r = lc({});
    assert.deepEqual([r.status, r.http_status, r.content_type, r.size_bytes, r.checked_at], ['ok', 200, 'application/octet-stream', 1234, NOW]);
    assert.ok(!('note' in r) && !('final_url' in r));
    expectValid(r);
  });
  it('a followed redirect is "redirect" and the final URL is kept only when it is plain', () => {
    const r = lc({ redirects: [{ from: 'a', to: 'b', status: 302 }], finalUrl: 'https://dl.example.com/files/app-1.0.exe' });
    assert.deepEqual([r.status, r.final_url], ['redirect', 'https://dl.example.com/files/app-1.0.exe']);
    expectValid(r);
  });
  it('a final URL with a query string or a signature is NEVER stored', () => {
    for (const finalUrl of ['https://dl.example.com/app.exe?token=SECRET', 'https://dl.example.com/app.exe?X-Amz-Signature=SECRET&X-Amz-Expires=300', 'https://dl.example.com/app.exe?sig=SECRET']) {
      const r = lc({ redirects: [{ from: 'a', to: 'b', status: 302 }], finalUrl });
      assert.equal(r.status, 'redirect');
      assert.ok(!('final_url' in r), finalUrl);
      assert.doesNotMatch(JSON.stringify(r), /SECRET|X-Amz/, finalUrl);
      assert.match(r.note, /not stored/);
      expectValid(r);
    }
  });
  it('a redirect to another host is recorded as a redirect that names only the HOST, never the (possibly signed) URL', () => {
    const r = toLinkCheck({ link: link({ url: 'https://github.com/o/r/releases/download/v1/a.exe', host: 'github.com' }), probe: probe({ status: 302, redirectBlocked: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r&sig=TOPSECRET&se=2026-10-13', code: 'BLOCKED_HOST' } }), now: NOW });
    assert.equal(r.status, 'redirect');
    assert.match(r.note, /release-assets\.githubusercontent\.com/);
    assert.doesNotMatch(JSON.stringify(r), /TOPSECRET|sig=|github-production/);
    expectValid(r);
  });
  it('a direct download that answers with an HTML page is "broken": it is not a file', () => {
    const r = lc({ contentType: 'text/html; charset=utf-8', finalUrl: 'https://dl.example.com/app-1.0.exe' });
    assert.deepEqual([r.status, r.http_status], ['broken', 200]);
    assert.match(r.note, /HTML page instead of a file/);
    assert.equal(lc({ contentType: 'text/html' }, link({ kind: 'landing_page', url: 'https://dl.example.com/get' })).status, 'ok', 'an HTML page is what a landing page should return');
  });
  it('HTTP status classes: 404/410 and other 4xx are broken; 401/403/429/451 are "blocked" (not proof of a dead link); 5xx is a transient error; 3xx not followed is redirect', () => {
    const table = { 404: 'broken', 410: 'broken', 400: 'broken', 418: 'broken', 401: 'blocked', 403: 'blocked', 429: 'blocked', 451: 'blocked', 500: 'error', 502: 'error', 503: 'error', 301: 'redirect', 307: 'redirect' };
    for (const [code, status] of Object.entries(table)) { const r = lc({ status: Number(code), contentType: null, contentLength: null }); assert.equal(r.status, status, code); assert.equal(r.http_status, Number(code)); expectValid(r); }
    assert.match(lc({ status: 403 }).note, /does not prove the link is broken/);
  });
  it('errors from the HTTP client map to blocked (policy) or error (transient), with sanitised, bounded notes', () => {
    const e = (code, message, extra = {}) => toLinkCheck({ link: link(), error: Object.assign(new CrawlerError(code, message), extra), now: NOW });
    const robots = e('ROBOTS_DISALLOWED', 'robots.txt disallows https://x/', { reason: 'matched robots.txt rule "disallow: /*/download"' });
    assert.deepEqual([robots.status, robots.http_status], ['blocked', null]);
    assert.match(robots.note, /matched robots\.txt rule "disallow: \/\*\/download".*not probed/);
    for (const code of ['BLOCKED_HOST', 'BLOCKED_PRIVATE', 'BLOCKED_PROTOCOL', 'BLOCKED_URL', 'BAD_URL']) assert.equal(e(code, 'nope').status, 'blocked', code);
    for (const code of ['TIMEOUT', 'NETWORK', 'TLS_ERROR', 'RATE_LIMIT_EXHAUSTED', 'TOO_LARGE', 'EXCEPTION']) assert.equal(e(code, 'x').status, 'error', code);
    const long = e('NETWORK', `bad\u0000\n\u202e${'x'.repeat(1000)}`);
    assert.ok(long.note.length <= 300);
    assert.doesNotMatch(long.note, /[\u0000-\u001f\u202e]/);
    for (const r of [robots, long, e('TIMEOUT', 'slow')]) expectValid(r);
  });
  it('a plain exception without a code still yields a valid record', () => expectValid(toLinkCheck({ link: link(), error: new Error('boom'), now: NOW })));
  it('never claims anything beyond what the server said: no "safe", "verified" or "trusted" wording', () => {
    const outputs = [lc({}), lc({ status: 404 }), lc({ status: 403 }), lc({ contentType: 'text/html' }), lc({ redirects: [{}], finalUrl: 'https://dl.example.com/x?sig=1' })];
    for (const o of outputs) assert.doesNotMatch(JSON.stringify(o), /\bsafe\b|verified|trusted|malware|clean/i);
  });
  it('omits size when the server did not say, and keeps content_type null rather than inventing one', () => {
    const r = lc({ contentLength: null, contentType: null });
    assert.ok(!('size_bytes' in r));
    assert.equal(r.content_type, null);
    expectValid(r);
  });
});

describe('runLinkChecks (against a scripted server)', () => {
  const makeClient = (handler, { robots = null, hosts = ['dl.example.com', 'files.example.com'] } = {}) => {
    const net = scriptedFetch(handler); const clock = virtualClock();
    const client = createHttpClient({ fetchImpl: net.fetchImpl, sleep: clock.sleep, now: clock.now, checkDns: false, allowedHosts: hosts, perHostMinIntervalMs: 0, retries: 0 });
    if (robots) client.setRobots(new RobotsChecker({ client, productToken: 'ANTO-LTG-Crawler', now: clock.now }));
    return { client, net };
  };

  it('sends one HEAD per unique URL and maps the answer back to every link that uses it', async () => {
    const { client, net } = makeClient(() => ({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '10' }, body: null }));
    const links = [link({ id: 'a' }), link({ id: 'b' }), link({ id: 'c', url: 'https://dl.example.com/other.exe' })];
    const results = await runLinkChecks({ client, links, now: () => NOW });
    assert.equal(net.calls.length, 2);
    assert.ok(net.calls.every((c) => c.method === 'HEAD'));
    assert.deepEqual(results.map((r) => [r.id, r.link_check.status]), [['a', 'ok'], ['b', 'ok'], ['c', 'ok']]);
  });
  it('never downloads a file: if HEAD is refused, the ranged GET body is cancelled unread', async () => {
    const body = trackedBody(['MZ'.repeat(50_000)]);
    const { client, net } = makeClient((req) => (req.method === 'HEAD' ? { status: 405, headers: {}, body: null } : { status: 206, headers: { 'content-type': 'application/x-msdownload', 'content-length': '1' }, body }));
    const [r] = await runLinkChecks({ client, links: [link()], now: () => NOW });
    assert.deepEqual(net.calls.map((c) => [c.method, c.headers.range ?? null]), [['HEAD', null], ['GET', 'bytes=0-0']]);
    assert.equal(r.link_check.status, 'ok');
    assert.equal(body.state.cancelled, true);
    assert.ok(body.state.pulled <= 1);
  });
  it('a failing URL does not stop the others, and each failure is recorded', async () => {
    const { client } = makeClient((req) => (req.url.includes('boom') ? { status: 503, headers: {}, body: null } : req.url.includes('gone') ? { status: 404, headers: {}, body: null } : { status: 200, headers: { 'content-type': 'application/zip' }, body: null }));
    const results = await runLinkChecks({ client, links: ['fine', 'boom', 'gone'].map((n) => link({ id: n, url: `https://dl.example.com/${n}.zip` })), now: () => NOW });
    assert.deepEqual(results.map((r) => r.link_check.status), ['ok', 'error', 'broken']);
  });
  it('a cross-host redirect is not followed and is recorded as a redirect (only the allowed hosts are ever contacted)', async () => {
    const { client, net } = makeClient(() => redirect('https://evil.example/steal?sig=SECRET'));
    const [r] = await runLinkChecks({ client, links: [link()], now: () => NOW });
    assert.equal(r.link_check.status, 'redirect');
    assert.ok(!net.calls.some((c) => c.url.includes('evil.example')));
    assert.doesNotMatch(JSON.stringify(r.link_check), /SECRET/);
  });
  it('honours robots.txt: a disallowed URL is recorded as blocked and never requested', async () => {
    const { client, net } = makeClient((req) => (req.url.endsWith('/robots.txt') ? ok('User-agent: *\nDisallow: /private/', { 'content-type': 'text/plain' }) : { status: 200, headers: { 'content-type': 'application/zip' }, body: null }), { robots: true });
    const results = await runLinkChecks({ client, links: [link({ id: 'p', url: 'https://dl.example.com/private/a.zip' }), link({ id: 'q', url: 'https://dl.example.com/public/b.zip' })], now: () => NOW });
    assert.deepEqual(results.map((r) => r.link_check.status), ['blocked', 'ok']);
    assert.match(results[0].link_check.note, /robots\.txt/);
    assert.ok(!net.calls.some((c) => c.url.includes('/private/a.zip')));
  });
  it('reports progress and keeps result order', async () => {
    const { client } = makeClient(() => ({ status: 200, headers: { 'content-type': 'application/zip' }, body: null }));
    const seen = [];
    const links = Array.from({ length: 5 }, (_, i) => link({ id: `l${i}`, url: `https://dl.example.com/${i}.zip` }));
    const results = await runLinkChecks({ client, links, now: () => NOW, onProgress: (n, total) => seen.push([n, total]) });
    assert.deepEqual(results.map((r) => r.id), links.map((l) => l.id));
    assert.deepEqual(seen.at(-1), [5, 5]);
  });
  it('summarises and builds a report that says nothing was downloaded or verified', async () => {
    const { client } = makeClient((req) => (req.url.includes('gone') ? { status: 404, headers: {}, body: null } : { status: 200, headers: { 'content-type': 'application/zip' }, body: null }));
    const results = await runLinkChecks({ client, links: [link({ url: 'https://dl.example.com/a.zip' }), link({ id: 'g', url: 'https://dl.example.com/gone.zip' })], now: () => NOW });
    assert.deepEqual(summarizeResults(results), { ok: 1, broken: 1 });
    const report = buildReport({ results, startedAt: NOW, finishedAt: NOW, args: {} });
    assert.equal(report.schema, REPORT_SCHEMA);
    assert.match(report.note, /does not mean the file is safe or the record is verified/);
    assert.match(report.note, /No file was downloaded or executed/);
    assert.equal(report.results.length, 2);
  });
});

describe('applyResults changes link_check and nothing else', () => {
  const doc = () => ({
    apps: { schema_version: '1.1.0', updated_at: '2026-01-01T00:00:00.000Z', items: [{ id: 'a', verification_status: 'not_reviewed', downloads: [{ kind: 'direct_binary', url: 'https://dl.example.com/a.exe', sha256: 'a'.repeat(64), link_check: { status: 'unchecked' } }] }, { id: 'b', verification_status: 'verified', downloads: [{ kind: 'landing_page', url: 'https://dl.example.com/b', link_check: { status: 'unchecked' } }] }] },
    drivers: { schema_version: '1.1.0', updated_at: '2026-01-01T00:00:00.000Z', items: [{ id: 'd', download: { kind: 'landing_page', url: 'https://dl.example.com/d' } }] },
    tools: { schema_version: '1.1.0', updated_at: '2026-01-01T00:00:00.000Z', items: [] },
  });
  const result = (catalog, id, index, url, lc) => ({ catalog, id, index, url, kind: 'x', host: 'dl.example.com', link_check: lc });
  const OKC = { status: 'ok', checked_at: NOW, http_status: 200, content_type: 'application/octet-stream' };

  it('writes the probe result, leaves every other field, hash and review status untouched', () => {
    const before = doc();
    const { catalogs, changed } = applyResults(before, [result('apps', 'a', 0, 'https://dl.example.com/a.exe', OKC)], '2026-10-13');
    assert.equal(changed, 1);
    assert.deepEqual(catalogs.apps.items[0].downloads[0].link_check, OKC);
    const strip = (c) => { const x = structuredClone(c); for (const i of x.apps.items) for (const d of i.downloads ?? []) delete d.link_check; delete x.apps.updated_at; return x; };
    assert.deepEqual(strip(catalogs), strip(before));
    assert.equal(catalogs.apps.items[0].verification_status, 'not_reviewed');
    assert.equal(catalogs.apps.items[0].downloads[0].sha256, 'a'.repeat(64), 'a hash is never recomputed or changed');
  });
  it('a link check can never promote or demote a record', () => {
    const { catalogs } = applyResults(doc(), [result('apps', 'a', 0, 'https://dl.example.com/a.exe', { status: 'broken', checked_at: NOW, http_status: 404 }), result('apps', 'b', 0, 'https://dl.example.com/b', { status: 'ok', checked_at: NOW, http_status: 200 })], '2026-10-13');
    assert.deepEqual(catalogs.apps.items.map((i) => i.verification_status), ['not_reviewed', 'verified']);
    assert.equal(catalogs.apps.items.length, 2, 'a broken link does not remove the record or the link');
    assert.equal(catalogs.apps.items[0].downloads.length, 1);
  });
  it('drivers keep a single download object; the right entry is updated by index and URL', () => {
    const { catalogs } = applyResults(doc(), [result('drivers', 'd', 0, 'https://dl.example.com/d', OKC)], '2026-10-13');
    assert.deepEqual(catalogs.drivers.items[0].download.link_check, OKC);
  });
  it('bumps updated_at only for catalogs that changed', () => {
    const { catalogs, changedCatalogs } = applyResults(doc(), [result('apps', 'a', 0, 'https://dl.example.com/a.exe', OKC)], '2026-10-13');
    assert.deepEqual([...changedCatalogs], ['apps']);
    assert.equal(catalogs.apps.updated_at, '2026-10-13T00:00:00.000Z');
    assert.equal(catalogs.drivers.updated_at, '2026-01-01T00:00:00.000Z');
  });
  it('is idempotent: applying the same results again changes nothing', () => {
    const results = [result('apps', 'a', 0, 'https://dl.example.com/a.exe', OKC)];
    const once = applyResults(doc(), results, '2026-10-13');
    const twice = applyResults(once.catalogs, results, '2026-11-30');
    assert.equal(twice.changed, 0);
    assert.deepEqual(twice.catalogs, once.catalogs);
  });
  it('skips a result whose URL no longer matches (the catalog moved on) and does not mutate its input', () => {
    const before = doc(); const copy = structuredClone(before);
    const { changed } = applyResults(before, [result('apps', 'a', 0, 'https://dl.example.com/OLD.exe', OKC), result('apps', 'ghost', 0, 'https://x/', OKC), result('apps', 'a', 9, 'https://dl.example.com/a.exe', OKC)], '2026-10-13');
    assert.equal(changed, 0);
    assert.deepEqual(before, copy);
  });
});

describe('the check-links command', () => {
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  // The scripted fetch never touches the network, so the allow-list is left open here; the SSRF guard still applies.
  const clientFor = (handler) => {
    const net = scriptedFetch(handler); const clock = virtualClock();
    return { net, client: createHttpClient({ fetchImpl: net.fetchImpl, sleep: clock.sleep, now: clock.now, checkDns: false, allowedHosts: [], perHostMinIntervalMs: 0, retries: 0 }) };
  };
  const ONLY = { catalog: 'apps', only: 'sysinternals-suite' }; // two direct downloads on download.sysinternals.com
  const answer = (req) => ({ status: 200, headers: { 'content-type': req.url.endsWith('.zip') || req.url.endsWith('.exe') ? 'application/octet-stream' : 'text/html', 'content-length': '4096' }, body: null });

  it('a dry run writes only its report; catalogs stay byte-identical', async () => {
    const sb = await makeSandbox();
    try {
      const before = await Promise.all(CATALOGS.map((n) => sb.read('catalogs', `${n}.json`)));
      const logs = [];
      const { client, net } = clientFor(answer);
      const code = await checkLinks({ flags: ONLY, log: (m) => logs.push(m), root: sb.dir, client, now: () => NOW });
      assert.equal(code, 0);
      assert.deepEqual(net.calls.map((c) => c.method), Array(SYS_URLS).fill('HEAD'));
      assert.deepEqual(await Promise.all(CATALOGS.map((n) => sb.read('catalogs', `${n}.json`))), before);
      const report = JSON.parse(await sb.read('catalogs', 'proposed', 'link-check.report.json'));
      assert.equal(report.schema, REPORT_SCHEMA);
      assert.deepEqual(report.results.map((r) => [r.catalog, r.id, r.status]), Array.from({ length: SYS_DOWNLOADS }, () => ['apps', 'sysinternals-suite', 'ok']));
      assert.match(logs.join('\n'), /Dry run for the catalogs/);
    } finally { await sb.destroy(); }
  });

  it('--apply records link_check on the probed links only, keeps the catalogs valid and never changes a review status', async () => {
    const sb = await makeSandbox();
    try {
      const read = async (n) => JSON.parse(await sb.read('catalogs', `${n}.json`));
      const before = Object.fromEntries(await Promise.all(CATALOGS.map(async (n) => [n, await read(n)])));
      const rawBefore = { drivers: await sb.read('catalogs', 'drivers.json'), tools: await sb.read('catalogs', 'tools.json') };
      const { client } = clientFor(answer);
      const code = await checkLinks({ flags: { ...ONLY, apply: true }, log: () => {}, root: sb.dir, client, now: () => NOW });
      assert.equal(code, 0);
      const apps = await read('apps');
      const probed = apps.items.find((a) => a.id === 'sysinternals-suite').downloads;
      assert.ok(probed.length === SYS_DOWNLOADS && probed.every((d) => d.link_check.status === 'ok' && d.link_check.checked_at === NOW && d.link_check.http_status === 200));
      for (const d of probed) assert.deepEqual(validLinkCheck(d.link_check).errors, []);
      const others = apps.items.filter((a) => a.id !== 'sysinternals-suite').flatMap((a) => a.downloads ?? []);
      assert.ok(others.length > 100 && others.every((d) => d.link_check?.status === 'unchecked'), 'links that were not probed stay "unchecked"');
      assert.equal(apps.updated_at, '2026-10-13T00:00:00.000Z');
      assert.equal(await sb.read('catalogs', 'drivers.json'), rawBefore.drivers, 'catalogs with no changed link are not rewritten');
      assert.equal(await sb.read('catalogs', 'tools.json'), rawBefore.tools);
      // nothing but link_check (and the timestamp) differs, review statuses included
      const strip = (doc) => { const x = structuredClone(doc); delete x.updated_at; for (const i of x.items) for (const d of i.downloads ?? []) delete d.link_check; return x; };
      assert.deepEqual(strip(apps), strip(before.apps));
      assert.deepEqual(apps.items.map((i) => i.verification_status), before.apps.items.map((i) => i.verification_status));
      const catalogs = Object.fromEntries(await Promise.all(CATALOGS.map(async (n) => [n, await read(n)])));
      assert.deepEqual(checkSemantics(catalogs), []);
      for (const n of CATALOGS) assert.deepEqual(schemas.validate(n, catalogs[n]).errors, [], n);
    } finally { await sb.destroy(); }
  });

  it('drivers are checked through their single download object', async () => {
    const sb = await makeSandbox();
    try {
      const { client, net } = clientFor(answer);
      assert.equal(await checkLinks({ flags: { catalog: 'drivers', apply: true, limit: 4 }, log: () => {}, root: sb.dir, client, now: () => NOW }), 0);
      assert.ok(net.calls.length >= 1);
      const drivers = JSON.parse(await sb.read('catalogs', 'drivers.json'));
      const checked = drivers.items.filter((d) => d.download?.link_check?.status === 'ok');
      assert.ok(checked.length >= 1);
      assert.ok(checked.every((d) => d.verification_status === 'not_reviewed'));
    } finally { await sb.destroy(); }
  });

  it('a run whose probes all fail records the failures and deletes nothing', async () => {
    const sb = await makeSandbox();
    try {
      const { client } = clientFor(() => ({ status: 404, headers: {}, body: null }));
      assert.equal(await checkLinks({ flags: { ...ONLY, apply: true }, log: () => {}, root: sb.dir, client, now: () => NOW }), 0);
      const apps = JSON.parse(await sb.read('catalogs', 'apps.json'));
      const sys = apps.items.find((a) => a.id === 'sysinternals-suite');
      assert.deepEqual(sys.downloads.map((d) => d.link_check.status), Array(SYS_DOWNLOADS).fill('broken'));
      assert.ok(sys.downloads.length === SYS_DOWNLOADS && sys.downloads.every((d) => d.url && d.kind), 'a broken link is reported, never deleted');
      assert.equal(sys.verification_status, 'not_reviewed');
    } finally { await sb.destroy(); }
  });

  it('rejects an unknown --catalog and reports when there is nothing to check', async () => {
    const sb = await makeSandbox();
    try {
      const logs = [];
      assert.equal(await checkLinks({ flags: { catalog: 'vendors' }, log: (m) => logs.push(m), root: sb.dir, client: clientFor(answer).client }), 2);
      assert.match(logs.join(), /--catalog must be one of/);
      logs.length = 0;
      assert.equal(await checkLinks({ flags: { hosts: 'no-such-host.example' }, log: (m) => logs.push(m), root: sb.dir, client: clientFor(answer).client }), 0);
      assert.match(logs.join(), /No links to check/);
    } finally { await sb.destroy(); }
  });

  it('--only and --hosts restrict what is probed', async () => {
    const sb = await makeSandbox();
    try {
      const only = clientFor(answer);
      await checkLinks({ flags: { ...ONLY }, log: () => {}, root: sb.dir, client: only.client, now: () => NOW });
      assert.deepEqual([...new Set(only.net.calls.map((c) => new URL(c.url).hostname))], ['download.sysinternals.com']);
      const hosts = clientFor(answer);
      await checkLinks({ flags: { catalog: 'apps', hosts: 'sysinternals.com' }, log: () => {}, root: sb.dir, client: hosts.client, now: () => NOW });
      assert.ok(hosts.net.calls.length >= 2);
      assert.ok(hosts.net.calls.every((c) => new URL(c.url).hostname.endsWith('sysinternals.com')));
    } finally { await sb.destroy(); }
  });

  it('is wired into the CLI and refuses a bad flag with exit code 2', async () => {
    const original = console.log; const lines = [];
    console.log = (...a) => lines.push(a.join(' '));
    try { assert.equal(await main(['check-links', '--catalog', 'vendors']), 2); } finally { console.log = original; }
    assert.match(lines.join('\n'), /--catalog must be one of/);
    const pkg = JSON.parse(await readFile(fromRoot('package.json'), 'utf8'));
    assert.equal(pkg.scripts['crawl:links'], 'node scripts/crawler/cli.mjs check-links');
    assert.ok(sha('x'));
  });

  it('never executes or stores anything but header information (static checks on the source)', async () => {
    const src = await readFile(fromRoot('scripts', 'crawler', 'commands', 'check-links.mjs'), 'utf8');
    assert.doesNotMatch(src, /child_process|\bexec(Sync|File)?\s*\(|\bspawn\b|writeFile\([^)]*\.exe|createWriteStream/);
    assert.match(src, /client\.probe\(/);
    assert.doesNotMatch(src, /allowBinary:\s*true/, 'the command never asks the client to read binaries');
  });
});

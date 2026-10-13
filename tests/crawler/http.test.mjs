// The crawler's HTTP client is the one place that touches the network, so every politeness and safety
// promise it makes is tested here against a scripted fetch and a virtual clock (no real network, no real waiting).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHttpClient, CrawlerError, DEFAULT_USER_AGENT, DEFAULTS } from '../../scripts/crawler/lib/http.mjs';
import { RobotsChecker } from '../../scripts/crawler/lib/robots.mjs';
import { testClient, trackedBody, ok, json, redirect, scriptedFetch, virtualClock } from '../helpers/net.mjs';
import { listFiles, root } from '../helpers/repo.mjs';
import { readFile as read } from 'node:fs/promises';

const rejectsWith = async (promise, code) => {
  await assert.rejects(promise, (err) => { assert.ok(err instanceof CrawlerError, `expected CrawlerError, got ${err}`); assert.equal(err.code, code, err.message); return true; });
};

describe('identification', () => {
  it('sends a descriptive User-Agent with a contact URL on every request', async () => {
    const { client, calls } = testClient(() => ok());
    await client.fetch('https://example.test/a');
    assert.equal(calls[0].headers['user-agent'], DEFAULT_USER_AGENT);
    assert.match(DEFAULT_USER_AGENT, /^ANTO-LTG-Crawler\/[\d.]+ \(\+https:\/\/github\.com\/flessan\/ANTO-LTG;/);
    assert.match(DEFAULT_USER_AGENT, /honours robots\.txt/);
  });
  it('lets a configuration replace the User-Agent', async () => {
    const { client, calls } = testClient(() => ok(), { userAgent: 'Custom/1.0 (+https://example.test/about)' });
    await client.fetch('https://example.test/a');
    assert.equal(calls[0].headers['user-agent'], 'Custom/1.0 (+https://example.test/about)');
  });
  it('never sends cookies, follows no redirect on its own, and omits credentials', async () => {
    const { client, calls } = testClient(() => ok());
    await client.fetch('https://example.test/a');
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.ok(!('cookie' in calls[0].headers));
  });
  it('has conservative defaults', () => {
    assert.ok(DEFAULTS.timeoutMs <= 30_000);
    assert.ok(DEFAULTS.perHostMinIntervalMs >= 1000);
    assert.ok(DEFAULTS.maxPerHostConcurrency <= 2);
    assert.ok(DEFAULTS.maxBytes <= 5 * 1024 * 1024);
    assert.equal(DEFAULTS.allowHttp, false);
    assert.equal(DEFAULTS.allowPrivateHosts, false);
    assert.equal(DEFAULTS.checkDns, true);
    assert.ok(DEFAULTS.retries <= 3);
  });
});

describe('what the client is willing to contact', () => {
  const blocked = async (url, code, opts) => {
    const { client, calls } = testClient(() => ok(), opts);
    await rejectsWith(client.fetch(url), code);
    assert.equal(calls.length, 0, `${url}: no request may be sent`);
    return client;
  };
  it('refuses protocols other than https', async () => {
    for (const url of ['http://example.test/', 'ftp://example.test/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi', 'gopher://example.test/']) await blocked(url, 'BLOCKED_PROTOCOL');
  });
  it('allows plain http only when explicitly enabled (local test servers)', async () => {
    const { client } = testClient(() => ok(), { allowHttp: true });
    assert.equal((await client.fetch('http://example.test/')).status, 200);
  });
  it('refuses embedded credentials', async () => { await blocked('https://user:pass@example.test/', 'BLOCKED_URL'); await blocked('https://user@example.test/', 'BLOCKED_URL'); });
  it('refuses a URL that cannot be parsed', async () => { for (const u of ['not a url', '', '//example.test/x', 'https://']) await blocked(u, 'BAD_URL'); });
  it('only contacts hosts on the allow-list (exact names and *.wildcards)', async () => {
    await blocked('https://evil.example/', 'BLOCKED_HOST');
    await blocked('https://example.test.evil.example/', 'BLOCKED_HOST');
    await blocked('https://notexample.test/', 'BLOCKED_HOST');
    const { client } = testClient(() => ok());
    assert.equal((await client.fetch('https://sub.example.test/')).status, 200);
    assert.equal((await client.fetch('https://example.test/')).status, 200);
  });
  it('refuses private, loopback and link-local destinations, including disguised IPv4 spellings', async () => {
    const hostile = ['https://localhost/', 'https://app.localhost/', 'https://printer.local/', 'https://svc.internal/', 'https://127.0.0.1/', 'https://127.1/', 'https://10.0.0.8/', 'https://172.16.5.4/', 'https://192.168.1.1/',
      'https://169.254.169.254/latest/meta-data/', 'https://0.0.0.0/', 'https://2130706433/', 'https://0x7f000001/', 'https://0x7f.0.0.1/', 'https://017700000001/', 'https://[::1]/', 'https://[fe80::1]/', 'https://[fd00::1]/', 'https://[::ffff:127.0.0.1]/', 'https://100.64.0.1/'];
    for (const url of hostile) await blocked(url, 'BLOCKED_PRIVATE', { allowedHosts: [] });
  });
  it('refuses a public-looking name that RESOLVES to a private address (DNS rebinding guard)', async () => {
    const original = dns.lookup;
    dns.lookup = async () => [{ address: '10.1.2.3', family: 4 }];
    try {
      const { client, calls } = testClient(() => ok(), { checkDns: true, allowedHosts: [] });
      await rejectsWith(client.fetch('https://looks-public.example/'), 'BLOCKED_PRIVATE');
      assert.equal(calls.length, 0);
      dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '192.168.0.9', family: 4 }];
      await rejectsWith(client.fetch('https://mixed-answers.example/'), 'BLOCKED_PRIVATE');
      dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
      assert.equal((await client.fetch('https://really-public.example/')).status, 200);
    } finally { dns.lookup = original; }
  });
  it('counts blocked requests in its statistics', async () => {
    const client = await blocked('http://example.test/', 'BLOCKED_PROTOCOL');
    assert.equal(client.stats.blocked, 1);
    assert.equal(client.stats.requests, 0);
  });
});

describe('redirects', () => {
  it('follows redirects hop by hop, resolving relative Location headers, and records them', async () => {
    const { client, calls } = testClient((req) => (req.url.endsWith('/a') ? redirect('/b', 301) : req.url.endsWith('/b') ? redirect('https://sub.example.test/c') : ok('arrived')));
    const res = await client.fetch('https://example.test/a');
    assert.equal(res.text(), 'arrived');
    assert.equal(res.finalUrl, 'https://sub.example.test/c');
    assert.deepEqual(res.redirects.map((r) => [r.from, r.to, r.status]), [['https://example.test/a', 'https://example.test/b', 301], ['https://example.test/b', 'https://sub.example.test/c', 302]]);
    assert.equal(calls.length, 3);
  });
  it('does NOT follow a redirect to a host outside the allow-list, and never sends a request there', async () => {
    const { client, calls } = testClient(() => redirect('https://evil.example/steal'));
    const res = await client.fetch('https://example.test/a');
    assert.equal(res.status, 302);
    assert.equal(res.redirectBlocked.code, 'BLOCKED_HOST');
    assert.equal(res.redirectBlocked.location, 'https://evil.example/steal');
    assert.equal(calls.length, 1);
  });
  it('does NOT follow a redirect to a private address or a plain-http downgrade', async () => {
    for (const [target, code] of [['https://127.0.0.1/admin', 'BLOCKED_PRIVATE'], ['https://169.254.169.254/', 'BLOCKED_PRIVATE'], ['http://example.test/insecure', 'BLOCKED_PROTOCOL'], ['https://[::1]/', 'BLOCKED_PRIVATE']]) {
      const { client, calls } = testClient(() => redirect(target), { allowedHosts: ['example.test', '127.0.0.1', '169.254.169.254', '[::1]', '::1'] });
      const res = await client.fetch('https://example.test/a');
      assert.equal(res.redirectBlocked?.code, code, target);
      assert.equal(calls.length, 1, target);
    }
  });
  it('reports a malformed Location header instead of following it', async () => {
    const { client } = testClient(() => redirect('https://[bad'));
    const res = await client.fetch('https://example.test/a');
    assert.match(res.redirectBlocked.reason, /invalid Location/);
  });
  it('gives up on redirect loops', async () => {
    const { client, calls } = testClient((req) => redirect(req.url.endsWith('/a') ? '/b' : '/a'), { maxRedirects: 3 });
    await rejectsWith(client.fetch('https://example.test/a'), 'TOO_MANY_REDIRECTS');
    assert.ok(calls.length <= 4);
  });
  it('can be told not to follow at all', async () => {
    const { client, calls } = testClient(() => redirect('/b'));
    const res = await client.fetch('https://example.test/a', { followRedirects: false });
    assert.equal(res.status, 302);
    assert.equal(calls.length, 1);
  });
});

describe('credentials stay on the host they were configured for', () => {
  // built at run time so that no token-shaped literal is ever committed (tests/unit/security.test.mjs scans for them)
  const token = ['ghp', 'SECRET'.repeat(6)].join('_');
  const auth = { 'api.github.com': () => ({ authorization: `Bearer ${token}` }) };
  it('attaches the token to api.github.com only', async () => {
    const { client, calls } = testClient(() => ok(), { auth });
    await client.fetch('https://api.github.com/repos/x/y');
    await client.fetch('https://example.test/page');
    assert.equal(calls[0].headers.authorization, `Bearer ${token}`);
    assert.ok(!('authorization' in calls[1].headers));
  });
  it('does not forward the token across a redirect to another host', async () => {
    const { client, calls } = testClient((req) => (req.url.startsWith('https://api.github.com') ? redirect('https://sub.example.test/object') : ok()), { auth });
    await client.fetch('https://api.github.com/repos/x/y/zipball');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.authorization, `Bearer ${token}`);
    assert.ok(!('authorization' in calls[1].headers), 'the second hop must not carry the token');
  });
  it('does not match look-alike host names', async () => {
    const { client, calls } = testClient(() => ok(), { auth, allowedHosts: ['api.github.com.evil.test', 'xapi.github.com'] });
    await client.fetch('https://api.github.com.evil.test/');
    await client.fetch('https://xapi.github.com/');
    assert.ok(calls.every((c) => !('authorization' in c.headers)));
  });
  it('never writes the token, or any request header, to the on-disk cache', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'anto-ltg-cache-'));
    try {
      const { client } = testClient(() => ok('hello', { etag: '"v1"' }), { auth, cacheDir: dir });
      await client.fetch('https://api.github.com/repos/x/y');
      const files = await listFiles(dir);
      assert.equal(files.length, 1);
      assert.doesNotMatch(await read(files[0], 'utf8'), /ghp_|authorization|Bearer/i);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('does not write the token to the event log', async () => {
    const events = [];
    const { client } = testClient(() => ok(), { auth, onEvent: (e) => events.push(JSON.stringify(e)) });
    await client.fetch('https://api.github.com/x');
    assert.ok(events.length > 0);
    assert.ok(!events.join('\n').includes(token));
  });
});

describe('timeouts, retries and back-off', () => {
  it('times out a request that never answers (TIMEOUT)', async () => {
    // AbortSignal.timeout() uses an unref'd timer; a real socket keeps the event loop alive, so the fake must too.
    const { client } = testClient((req) => new Promise((_, reject) => {
      const keepAlive = setTimeout(() => {}, 10_000);
      req.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(req.signal.reason); });
    }), { timeoutMs: 25, retries: 0 });
    await rejectsWith(client.fetch('https://example.test/slow'), 'TIMEOUT');
  });
  it('retries a transient 503 with exponential back-off and then succeeds', async () => {
    let n = 0;
    const { client, clock } = testClient(() => (++n < 3 ? { status: 503, headers: {}, body: 'busy' } : ok('fine')), { retries: 3 });
    const res = await client.fetch('https://example.test/a');
    assert.equal(res.text(), 'fine');
    assert.deepEqual(clock.sleeps, [1000, 2000], 'delays double on each attempt (jitter is pinned by the test)');
    assert.equal(client.stats.retries, 2);
  });
  it('caps the back-off at backoffMaxMs and adds jitter between 50% and 100%', async () => {
    const { client, clock } = testClient(() => ({ status: 503, headers: {}, body: '' }), { retries: 5, backoffBaseMs: 1000, backoffMaxMs: 3000, random: () => 0 });
    await client.fetch('https://example.test/a');
    assert.deepEqual(clock.sleeps, [500, 1000, 1500, 1500, 1500]);
  });
  it('returns the last response when the retries are used up (it does not throw for an HTTP status)', async () => {
    const { client, calls } = testClient(() => ({ status: 500, headers: {}, body: 'down' }), { retries: 2 });
    const res = await client.fetch('https://example.test/a');
    assert.equal(res.status, 500);
    assert.equal(calls.length, 3);
  });
  it('retries timeouts and network errors, but not client errors', async () => {
    let n = 0;
    const flaky = testClient(() => { if (++n < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); return ok('back'); }, { retries: 3 });
    assert.equal((await flaky.client.fetch('https://example.test/a')).text(), 'back');
    assert.equal(flaky.calls.length, 3);
    const notFound = testClient(() => ({ status: 404, headers: {}, body: 'no' }), { retries: 3 });
    assert.equal((await notFound.client.fetch('https://example.test/a')).status, 404);
    assert.equal(notFound.calls.length, 1, '4xx is final');
  });
  it('gives up with a NETWORK error after the retries', async () => {
    const { client, calls } = testClient(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, { retries: 1 });
    await rejectsWith(client.fetch('https://example.test/a'), 'NETWORK');
    assert.equal(calls.length, 2);
  });
  it('honours Retry-After given in seconds', async () => {
    let n = 0;
    const { client, clock } = testClient(() => (++n === 1 ? { status: 429, headers: { 'retry-after': '7' }, body: '' } : ok()), { retries: 2 });
    await client.fetch('https://example.test/a');
    assert.deepEqual(clock.sleeps, [7000]);
  });
  it('honours Retry-After given as an HTTP date', async () => {
    let n = 0;
    const when = new Date(1_700_000_000_000 + 12_000).toUTCString();
    const { client, clock } = testClient(() => (++n === 1 ? { status: 503, headers: { 'retry-after': when }, body: '' } : ok()), { retries: 2 });
    await client.fetch('https://example.test/a');
    assert.deepEqual(clock.sleeps, [12_000]);
  });
  it('never waits longer than maxRateLimitWaitMs for a Retry-After', async () => {
    let n = 0;
    const { client, clock } = testClient(() => (++n === 1 ? { status: 429, headers: { 'retry-after': '99999' }, body: '' } : ok()), { retries: 2, maxRateLimitWaitMs: 10_000 });
    await client.fetch('https://example.test/a');
    assert.deepEqual(clock.sleeps, [10_000]);
  });
  it('waits for a GitHub primary rate-limit reset when it is near, and retries', async () => {
    const resetAt = (1_700_000_000_000 + 5000) / 1000;
    let n = 0;
    const { client, clock } = testClient(() => (++n === 1 ? { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) }, body: '{"message":"rate limit"}' } : ok('ok')), { retries: 2 });
    const res = await client.fetch('https://api.github.com/x');
    assert.equal(res.status, 200);
    assert.deepEqual(clock.sleeps, [6000], 'waits until the reset plus one second');
  });
  it('stops with RATE_LIMIT_EXHAUSTED when the reset is too far away', async () => {
    const resetAt = (1_700_000_000_000 + 3_600_000) / 1000;
    const { client, calls } = testClient(() => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) }, body: '' }), { retries: 2, maxRateLimitWaitMs: 120_000 });
    await rejectsWith(client.fetch('https://api.github.com/x'), 'RATE_LIMIT_EXHAUSTED');
    assert.equal(calls.length, 1);
  });
  it('a plain 403 (not a rate limit) is final', async () => {
    const { client, calls } = testClient(() => ({ status: 403, headers: {}, body: 'forbidden' }), { retries: 3 });
    assert.equal((await client.fetch('https://example.test/x')).status, 403);
    assert.equal(calls.length, 1);
  });
  it('TLS verification failures are final, explained, and never bypassed', async () => {
    const { client, calls } = testClient(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }); }, { retries: 3 });
    await assert.rejects(client.fetch('https://example.test/a'), (err) => {
      assert.equal(err.code, 'TLS_ERROR');
      assert.match(err.message, /NODE_EXTRA_CA_CERTS/);
      assert.match(err.message, /will not disable certificate checks/);
      return true;
    });
    assert.equal(calls.length, 1, 'no retry for a certificate problem');
  });
  it('contains no code path that switches certificate checking off', async () => {
    const files = await listFiles(path.join(root, 'scripts', 'crawler'), { ext: ['.mjs', '.json'] });
    for (const f of files) assert.doesNotMatch(await read(f, 'utf8'), /NODE_TLS_REJECT_UNAUTHORIZED\s*=|rejectUnauthorized\s*:\s*false|--insecure|\bcurl\s+-k\b/, path.relative(root, f));
  });
  it('a throwing event listener never breaks a crawl', async () => {
    const { client } = testClient(() => ok(), { onEvent: () => { throw new Error('logger exploded'); } });
    assert.equal((await client.fetch('https://example.test/a')).status, 200);
  });
});

describe('rate limiting and concurrency', () => {
  it('keeps a minimum interval between requests to the same host', async () => {
    const { client, clock } = testClient(() => ok(), { perHostMinIntervalMs: 1000 });
    for (let i = 0; i < 4; i++) await client.fetch(`https://example.test/p${i}`);
    assert.deepEqual(clock.sleeps, [1000, 1000, 1000]);
  });
  it('does not make different hosts wait for each other', async () => {
    const { client, clock } = testClient(() => ok(), { perHostMinIntervalMs: 1000 });
    await client.fetch('https://example.test/a');
    await client.fetch('https://sub.example.test/a');
    await client.fetch('https://api.github.com/a');
    assert.deepEqual(clock.sleeps, []);
  });
  it('per-host rules override the default interval', async () => {
    const { client, clock } = testClient(() => ok(), { perHostMinIntervalMs: 1000, hostRules: { 'api.github.com': { minIntervalMs: 120 } } });
    await client.fetch('https://api.github.com/a');
    await client.fetch('https://api.github.com/b');
    await client.fetch('https://example.test/a');
    await client.fetch('https://example.test/b');
    assert.deepEqual(clock.sleeps, [120, 1000]);
  });
  it('never has more than the allowed number of requests in flight per host', async () => {
    let inflight = 0; let max = 0;
    const { client } = testClient(async () => { inflight++; max = Math.max(max, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; return ok(); }, { maxPerHostConcurrency: 2 });
    await Promise.all(Array.from({ length: 10 }, (_, i) => client.fetch(`https://example.test/p${i}`)));
    assert.equal(max, 2);
  });
  it('a per-host concurrency rule of 1 serialises requests', async () => {
    let inflight = 0; let max = 0;
    const { client } = testClient(async () => { inflight++; max = Math.max(max, inflight); await new Promise((r) => setTimeout(r, 3)); inflight--; return ok(); }, { hostRules: { 'example.test': { concurrency: 1 } } });
    await Promise.all(Array.from({ length: 6 }, (_, i) => client.fetch(`https://example.test/p${i}`)));
    assert.equal(max, 1);
  });
  it('slots are released after errors, so a failing host cannot starve the queue', async () => {
    let n = 0;
    const { client } = testClient(() => { if (++n % 2) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); return ok(); }, { maxPerHostConcurrency: 1, retries: 0 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => client.fetch(`https://example.test/p${i}`)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 3);
  });
  it('counts requests per host and status', async () => {
    const { client } = testClient((req) => (req.url.endsWith('/missing') ? { status: 404, headers: {}, body: '' } : ok()));
    await client.fetch('https://example.test/a'); await client.fetch('https://example.test/missing'); await client.fetch('https://api.github.com/x');
    assert.equal(client.stats.requests, 3);
    assert.deepEqual(client.stats.byHost, { 'example.test': 2, 'api.github.com': 1 });
    assert.deepEqual(client.stats.byStatus, { 200: 2, 404: 1 });
  });
});

describe('response bodies: size caps and binaries', () => {
  it('stops reading a body that exceeds maxBytes (TOO_LARGE) and cancels the stream', async () => {
    const body = trackedBody(Array.from({ length: 200 }, () => 'x'.repeat(600))); // a 120 kB body
    const { client } = testClient(() => ({ status: 200, headers: { 'content-type': 'text/html' }, body }), { maxBytes: 1000 });
    await rejectsWith(client.fetch('https://example.test/big'), 'TOO_LARGE');
    assert.equal(body.state.cancelled, true);
    assert.ok(body.state.pulled <= 5, `read ${body.state.pulled} of 200 chunks: the rest must never be pulled`);
  });
  it('refuses a declared Content-Length above the limit without reading anything', async () => {
    const body = trackedBody(['x'.repeat(100)]);
    const { client } = testClient(() => ({ status: 200, headers: { 'content-type': 'text/html', 'content-length': '5000' }, body }), { maxBytes: 1000 });
    await rejectsWith(client.fetch('https://example.test/big'), 'TOO_LARGE');
    assert.equal(body.state.cancelled, true);
    assert.ok(body.state.pulled <= 1);
  });
  it('a per-request maxBytes overrides the default', async () => {
    const { client } = testClient(() => ok('x'.repeat(500)));
    await rejectsWith(client.fetch('https://example.test/a', { maxBytes: 100 }), 'TOO_LARGE');
    assert.equal((await client.fetch('https://example.test/b', { maxBytes: 1000 })).body.length, 500);
  });
  const binaryTypes = ['application/octet-stream', 'application/x-msdownload', 'application/zip', 'application/x-msi', 'application/vnd.microsoft.portable-executable', 'application/x-7z-compressed', 'application/x-iso9660-image',
    'application/x-apple-diskimage', 'application/vnd.ms-cab-compressed', 'application/pdf', 'image/png', 'video/mp4', 'audio/mpeg', 'font/woff2'];
  for (const type of binaryTypes) {
    it(`never downloads ${type} (the stream is cancelled after the headers)`, async () => {
      const body = trackedBody(['MZ\x90\x00'.repeat(1000)]);
      const { client } = testClient(() => ({ status: 200, headers: { 'content-type': type, 'content-length': '104857600', 'content-disposition': 'attachment; filename="setup.exe"' }, body }));
      const res = await client.fetch('https://example.test/setup.exe');
      assert.equal(res.binary, true);
      assert.equal(res.body.length, 0);
      assert.equal(res.headers['content-type'], type, 'the headers are still reported');
      assert.equal(body.state.cancelled, true);
      assert.ok(body.state.pulled <= 1, `pulled ${body.state.pulled} chunks`);
    });
  }
  for (const type of ['text/html; charset=utf-8', 'text/plain', 'application/json', 'application/vnd.github+json', 'application/vnd.github.raw+json', 'application/xml', 'application/ld+json', 'application/x-yaml', 'application/atom+xml']) {
    it(`reads ${type} as text`, async () => {
      const { client } = testClient(() => ({ status: 200, headers: { 'content-type': type }, body: 'hello' }));
      const res = await client.fetch('https://example.test/a');
      assert.equal(res.binary, false);
      assert.equal(res.text(), 'hello');
    });
  }
  it('reads a response with no content type as bounded text', async () => {
    const { client } = testClient(() => ({ status: 200, headers: {}, body: 'plain' }));
    assert.equal((await client.fetch('https://example.test/a')).text(), 'plain');
  });
  it('HEAD requests and redirects never read a body', async () => {
    const body = trackedBody(['should not be read']);
    const { client } = testClient(() => ({ status: 200, headers: { 'content-type': 'text/html' }, body }));
    const res = await client.fetch('https://example.test/a', { method: 'HEAD' });
    assert.equal(res.body.length, 0);
    const body2 = trackedBody(['redirect body']);
    const r2 = testClient(() => ({ status: 302, headers: { location: 'https://evil.example/' }, body: body2 }));
    await r2.client.fetch('https://example.test/a');
    assert.ok(body2.state.pulled <= 1);
  });
  it('parses JSON bodies and leaves malformed JSON to the caller', async () => {
    const good = testClient(() => json({ a: 1 }));
    assert.deepEqual((await good.client.fetch('https://example.test/a')).json(), { a: 1 });
    const bad = testClient(() => ok('{nope'));
    await assert.rejects(async () => (await bad.client.fetch('https://example.test/b')).json(), SyntaxError);
  });
});

describe('probe() inspects a URL without downloading it', () => {
  it('uses HEAD and reports type, size and disposition', async () => {
    const { client, calls } = testClient(() => ({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '123456', 'content-disposition': 'attachment; filename=x.exe', etag: '"abc"', 'accept-ranges': 'bytes' }, body: null }));
    const p = await client.probe('https://example.test/x.exe');
    assert.deepEqual([calls.length, calls[0].method], [1, 'HEAD']);
    assert.deepEqual([p.status, p.contentType, p.contentLength, p.contentDisposition, p.etag, p.acceptRanges], [200, 'application/octet-stream', 123456, 'attachment; filename=x.exe', '"abc"', 'bytes']);
  });
  it('falls back to a one-byte ranged GET when HEAD is refused, and still never reads a binary', async () => {
    const body = trackedBody(['MZ'.repeat(5000)]);
    const { client, calls } = testClient((req) => (req.method === 'HEAD' ? { status: 405, headers: {}, body: null } : { status: 206, headers: { 'content-type': 'application/x-msdownload', 'content-length': '1' }, body }));
    const p = await client.probe('https://example.test/x.exe');
    assert.deepEqual(calls.map((c) => c.method), ['HEAD', 'GET']);
    assert.equal(calls[1].headers.range, 'bytes=0-0');
    assert.equal(p.binary, true);
    assert.equal(body.state.cancelled, true);
  });
  it('follows allowed redirects and reports a blocked one', async () => {
    const hop = testClient((req) => (req.url.endsWith('/go') ? redirect('/final') : { status: 200, headers: { 'content-type': 'text/html' }, body: null }));
    const p = await hop.client.probe('https://example.test/go');
    assert.equal(p.finalUrl, 'https://example.test/final');
    assert.equal(p.redirects.length, 1);
    const evil = testClient(() => redirect('https://evil.example/x'));
    const blocked = await evil.client.probe('https://example.test/go');
    assert.equal(blocked.redirectBlocked.code, 'BLOCKED_HOST');
  });
});

describe('on-disk cache and incremental runs', () => {
  const withDir = async (fn) => { const dir = await mkdtemp(path.join(os.tmpdir(), 'anto-ltg-cache-')); try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } };
  const entries = async (dir) => (await listFiles(dir)).length;

  it('serves a repeat request from the cache without touching the network', () => withDir(async (dir) => {
    const { client, calls } = testClient(() => ok('v1', { etag: '"e1"' }), { cacheDir: dir });
    assert.equal((await client.fetch('https://example.test/a')).fromCache, false);
    const second = await client.fetch('https://example.test/a');
    assert.equal(second.fromCache, true);
    assert.equal(second.text(), 'v1');
    assert.equal(calls.length, 1);
    assert.equal(client.stats.cacheHits, 1);
  }));
  it('revalidates a stale entry with If-None-Match and reuses the body on 304', () => withDir(async (dir) => {
    const { client, calls, clock } = testClient((req) => (req.headers['if-none-match'] ? { status: 304, headers: {}, body: null } : ok('v1', { etag: '"e1"' })), { cacheDir: dir, cacheTtlMs: 1000 });
    await client.fetch('https://example.test/a');
    clock.t += 5000;
    const res = await client.fetch('https://example.test/a');
    assert.equal(res.status, 200);
    assert.equal(res.notModified, true);
    assert.equal(res.text(), 'v1');
    assert.equal(calls[1].headers['if-none-match'], '"e1"');
    assert.equal(client.stats.notModified, 1);
  }));
  it('uses If-Modified-Since when the server sent only Last-Modified', () => withDir(async (dir) => {
    const lm = 'Mon, 01 Jan 2026 00:00:00 GMT';
    const { client, calls, clock } = testClient((req) => (req.headers['if-modified-since'] ? { status: 304, headers: {}, body: null } : ok('v1', { 'last-modified': lm })), { cacheDir: dir, cacheTtlMs: 10 });
    await client.fetch('https://example.test/a');
    clock.t += 1000;
    assert.equal((await client.fetch('https://example.test/a')).notModified, true);
    assert.equal(calls[1].headers['if-modified-since'], lm);
  }));
  it('replaces the body when the server returns new content', () => withDir(async (dir) => {
    let version = 1;
    const { client, clock } = testClient(() => ok(`v${version}`, { etag: `"e${version}"` }), { cacheDir: dir, cacheTtlMs: 10 });
    assert.equal((await client.fetch('https://example.test/a')).text(), 'v1');
    version = 2; clock.t += 1000;
    assert.equal((await client.fetch('https://example.test/a')).text(), 'v2');
  }));
  it('offline mode serves the cache whatever its age, and reports a miss otherwise', () => withDir(async (dir) => {
    const online = testClient(() => ok('cached'), { cacheDir: dir, cacheTtlMs: 1 });
    await online.client.fetch('https://example.test/a');
    const offline = testClient(() => { throw new Error('the network must not be used'); }, { cacheDir: dir, cacheMode: 'offline' });
    offline.clock.t += 10 * 24 * 3600_000;
    assert.equal((await offline.client.fetch('https://example.test/a')).text(), 'cached');
    await rejectsWith(offline.client.fetch('https://example.test/never-fetched'), 'CACHE_MISS');
    assert.equal(offline.calls.length, 0);
  }));
  it('refresh mode revalidates even a fresh entry', () => withDir(async (dir) => {
    const { client, calls } = testClient((req) => (req.headers['if-none-match'] ? { status: 304, headers: {}, body: null } : ok('v1', { etag: '"e1"' })), { cacheDir: dir, cacheMode: 'refresh' });
    await client.fetch('https://example.test/a');
    const res = await client.fetch('https://example.test/a');
    assert.equal(calls.length, 2);
    assert.equal(res.notModified, true);
  }));
  it('cache mode "off" neither reads nor writes', () => withDir(async (dir) => {
    const { client, calls } = testClient(() => ok('x'), { cacheDir: dir, cacheMode: 'off' });
    await client.fetch('https://example.test/a'); await client.fetch('https://example.test/a');
    assert.equal(calls.length, 2);
    assert.equal(await entries(dir), 0);
  }));
  it('remembers a 404 for a shorter time', () => withDir(async (dir) => {
    const { client, calls, clock } = testClient(() => ({ status: 404, headers: { 'content-type': 'text/plain' }, body: 'nope' }), { cacheDir: dir, negativeCacheTtlMs: 1000 });
    await client.fetch('https://example.test/missing'); await client.fetch('https://example.test/missing');
    assert.equal(calls.length, 1);
    clock.t += 2000;
    await client.fetch('https://example.test/missing');
    assert.equal(calls.length, 2);
  }));
  it('never caches binaries, errors or non-GET requests', () => withDir(async (dir) => {
    const { client } = testClient((req) => (req.url.endsWith('/bin') ? { status: 200, headers: { 'content-type': 'application/zip' }, body: 'PK' } : req.url.endsWith('/err') ? { status: 500, headers: {}, body: 'boom' } : ok('x')), { cacheDir: dir, retries: 0 });
    await client.fetch('https://example.test/bin'); await client.fetch('https://example.test/err'); await client.fetch('https://example.test/head', { method: 'HEAD' });
    assert.equal(await entries(dir), 0);
  }));
  it('does not cache when asked not to (cache: false)', () => withDir(async (dir) => {
    const { client, calls } = testClient(() => ok('x'), { cacheDir: dir });
    await client.fetch('https://example.test/a', { cache: false }); await client.fetch('https://example.test/a', { cache: false });
    assert.equal(calls.length, 2);
    assert.equal(await entries(dir), 0);
  }));
  it('survives a corrupt cache entry by fetching again', () => withDir(async (dir) => {
    const { client } = testClient(() => ok('fresh'), { cacheDir: dir });
    await client.fetch('https://example.test/a');
    const [file] = await listFiles(dir);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{not json');
    const again = await client.fetch('https://example.test/a');
    assert.equal(again.text(), 'fresh');
  }));
  it('keeps one cache file per distinct URL and Accept header', () => withDir(async (dir) => {
    const { client } = testClient(() => ok('x'));
    const c2 = testClient(() => ok('x'), { cacheDir: dir });
    await c2.client.fetch('https://example.test/a'); await c2.client.fetch('https://example.test/a?x=1'); await c2.client.fetch('https://example.test/a', { accept: 'application/json' });
    assert.equal(await entries(dir), 3);
    assert.ok(client);
    const names = (await readdir(dir)).sort();
    assert.ok(names.every((n) => /^[0-9a-f]{2}$/.test(n)), 'sharded by hash prefix');
  }));
});

describe('robots.txt is honoured', () => {
  const site = (robots, pages = () => ok('page')) => (req) => (req.url.endsWith('/robots.txt') ? robots(req) : pages(req));
  const withRobots = (handler, opts = {}) => {
    const t = testClient(handler, opts);
    t.client.setRobots(new RobotsChecker({ client: t.client, productToken: 'ANTO-LTG-Crawler', now: t.clock.now }));
    return t;
  };

  it('does not request a page that robots.txt disallows', async () => {
    const { client, calls } = withRobots(site(() => ok('User-agent: *\nDisallow: /private/', { 'content-type': 'text/plain' })));
    await rejectsWith(client.fetch('https://example.test/private/page'), 'ROBOTS_DISALLOWED');
    assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ['/robots.txt']);
    assert.equal((await client.fetch('https://example.test/public')).text(), 'page');
  });
  it('fetches robots.txt once per origin and reuses it', async () => {
    const { client, calls } = withRobots(site(() => ok('User-agent: *\nAllow: /', { 'content-type': 'text/plain' })));
    for (const p of ['a', 'b', 'c']) await client.fetch(`https://example.test/${p}`);
    assert.equal(calls.filter((c) => c.url.endsWith('/robots.txt')).length, 1);
  });
  it('treats a missing robots.txt (404) as "everything allowed"', async () => {
    const { client } = withRobots(site(() => ({ status: 404, headers: {}, body: 'nope' })));
    assert.equal((await client.fetch('https://example.test/anything')).text(), 'page');
  });
  it('treats an unreachable robots.txt (5xx) as "disallow everything"', async () => {
    const { client, calls } = withRobots(site(() => ({ status: 503, headers: {}, body: '' })), { retries: 0 });
    await assert.rejects(client.fetch('https://example.test/anything'), (e) => { assert.equal(e.code, 'ROBOTS_DISALLOWED'); assert.match(e.message, /unreachable/); return true; });
    assert.ok(calls.every((c) => c.url.endsWith('/robots.txt')));
  });
  it('matches the longest rule and lets Allow win a tie', async () => {
    const { client } = withRobots(site(() => ok('User-agent: *\nDisallow: /files/\nAllow: /files/public/\nDisallow: /tie\nAllow: /tie', { 'content-type': 'text/plain' })));
    assert.equal((await client.fetch('https://example.test/files/public/x')).status, 200);
    await rejectsWith(client.fetch('https://example.test/files/secret'), 'ROBOTS_DISALLOWED');
    assert.equal((await client.fetch('https://example.test/tie')).status, 200);
  });
  it('applies the group for this crawler and ignores the others', async () => {
    const robots = 'User-agent: BadBot\nDisallow: /\n\nUser-agent: anto-ltg-crawler\nDisallow: /nope/\n\nUser-agent: *\nDisallow: /';
    const { client } = withRobots(site(() => ok(robots, { 'content-type': 'text/plain' })));
    assert.equal((await client.fetch('https://example.test/fine')).status, 200);
    await rejectsWith(client.fetch('https://example.test/nope/x'), 'ROBOTS_DISALLOWED');
  });
  it('honours Crawl-delay by waiting between requests to that host', async () => {
    const { client, clock } = withRobots(site(() => ok('User-agent: *\nCrawl-delay: 4', { 'content-type': 'text/plain' })), { perHostMinIntervalMs: 0 });
    await client.fetch('https://example.test/a'); await client.fetch('https://example.test/b');
    assert.ok(clock.sleeps.includes(4000), JSON.stringify(clock.sleeps));
  });
  it('checks robots.txt again for every redirect hop', async () => {
    const { client, calls } = withRobots(site(() => ok('User-agent: *\nDisallow: /blocked/', { 'content-type': 'text/plain' }), (req) => (req.url.endsWith('/start') ? redirect('/blocked/page') : ok('page'))));
    await rejectsWith(client.fetch('https://example.test/start'), 'ROBOTS_DISALLOWED');
    assert.ok(!calls.some((c) => c.url.endsWith('/blocked/page')), 'the disallowed page was never requested');
  });
  it('robots.txt requests themselves skip the robots check (robots: false) and the API can opt out', async () => {
    const { client, calls } = withRobots(site(() => ok('User-agent: *\nDisallow: /', { 'content-type': 'text/plain' })));
    assert.equal((await client.fetch('https://example.test/documented-api', { robots: false })).status, 200);
    assert.ok(calls.some((c) => c.url.endsWith('/robots.txt')) === false, 'opting out does not even fetch robots.txt');
  });
  it('blocked requests are counted', async () => {
    const { client } = withRobots(site(() => ok('User-agent: *\nDisallow: /', { 'content-type': 'text/plain' })));
    await assert.rejects(client.fetch('https://example.test/x'));
    assert.equal(client.stats.blocked, 1);
  });
});

describe('construction', () => {
  it('uses the global fetch when none is injected and exposes its configuration', () => {
    const c = createHttpClient({ allowedHosts: ['example.test'] });
    assert.equal(typeof c.fetch, 'function');
    assert.equal(c.config.userAgent, DEFAULT_USER_AGENT);
    assert.deepEqual(c.config.allowedHosts, ['example.test']);
  });
  it('a request made with the scripted fetch implementation sends exactly one fetch per call', async () => {
    const net = scriptedFetch(() => ok());
    const clock = virtualClock();
    const c = createHttpClient({ fetchImpl: net.fetchImpl, sleep: clock.sleep, now: clock.now, checkDns: false, allowedHosts: ['example.test'], perHostMinIntervalMs: 0 });
    await c.fetch('https://example.test/a');
    assert.equal(net.calls.length, 1);
  });
});

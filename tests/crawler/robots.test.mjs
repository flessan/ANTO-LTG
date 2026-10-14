// robots.txt parsing and matching (RFC 9309 semantics), including the real DriverScape robots.txt fixture.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRobots, selectGroup, isAllowed, RobotsChecker } from '../../scripts/crawler/lib/robots.mjs';
import { fromRoot } from '../helpers/repo.mjs';
import { testClient, ok } from '../helpers/net.mjs';

const TOKEN = 'ANTO-LTG-Crawler';
const allowed = (robots, p, token = TOKEN) => isAllowed(parseRobots(robots), token, p).allowed;

describe('parseRobots', () => {
  it('parses groups, rules, crawl-delay and sitemaps; ignores comments, blank lines and junk', () => {
    const parsed = parseRobots(`# comment\nUser-agent: *  # everyone\nDisallow: /a/\nAllow: /a/b\nCrawl-delay: 2.5\nnonsense line\nSitemap: https://example.com/sitemap.xml\n\nUser-agent: Foo\nUser-agent: Bar\nDisallow: /x`);
    assert.equal(parsed.groups.length, 2);
    assert.deepEqual(parsed.groups[0].agents, ['*']);
    assert.deepEqual(parsed.groups[0].rules, [{ type: 'disallow', pattern: '/a/' }, { type: 'allow', pattern: '/a/b' }]);
    assert.equal(parsed.groups[0].crawlDelay, 2.5);
    assert.deepEqual(parsed.groups[1].agents, ['foo', 'bar'], 'consecutive User-agent lines share one group');
    assert.deepEqual(parsed.sitemaps, ['https://example.com/sitemap.xml']);
  });
  it('is case-insensitive for field names and tolerates CRLF line endings', () => {
    const parsed = parseRobots('USER-AGENT: *\r\nDISALLOW: /secret\r\n');
    assert.equal(parsed.groups.length, 1);
    assert.equal(parsed.groups[0].rules[0].pattern, '/secret');
  });
  it('ignores rules that appear before any User-agent line and a negative or invalid crawl-delay', () => {
    const parsed = parseRobots('Disallow: /orphan\nUser-agent: *\nCrawl-delay: -3\nDisallow: /x');
    assert.equal(parsed.groups[0].rules.length, 1);
    assert.equal(parsed.groups[0].crawlDelay, null);
    assert.equal(parseRobots('User-agent: *\nCrawl-delay: soon').groups[0].crawlDelay, null);
  });
  it('copes with empty or non-text input', () => {
    assert.deepEqual(parseRobots(''), { groups: [], sitemaps: [] });
    assert.deepEqual(parseRobots(undefined).groups, []);
    assert.equal(parseRobots('\u0000\u0001garbage').groups.length, 0);
  });
});

describe('group selection', () => {
  it('prefers a group naming this crawler over the "*" group', () => {
    const robots = 'User-agent: *\nDisallow: /\n\nUser-agent: anto-ltg-crawler\nDisallow: /private/';
    assert.equal(allowed(robots, '/public'), true);
    assert.equal(allowed(robots, '/private/x'), false);
  });
  it('matches the product token case-insensitively and as a substring of the full token', () => {
    assert.ok(selectGroup(parseRobots('User-agent: ANTO-LTG\nDisallow: /x'), 'anto-ltg-crawler'));
    assert.ok(selectGroup(parseRobots('User-agent: anto-ltg-crawler\nDisallow: /x'), 'ANTO-LTG-Crawler'));
  });
  it('uses the longest matching agent name', () => {
    const robots = 'User-agent: anto\nDisallow: /short\n\nUser-agent: anto-ltg-crawler\nDisallow: /long';
    assert.equal(allowed(robots, '/long'), false);
    assert.equal(allowed(robots, '/short'), true);
  });
  it('no applicable group means everything is allowed', () => {
    assert.equal(allowed('User-agent: OtherBot\nDisallow: /', '/anything'), true);
    assert.equal(allowed('', '/anything'), true);
  });
});

describe('rule matching', () => {
  it('Disallow with no value allows everything', () => assert.equal(allowed('User-agent: *\nDisallow:', '/x'), true));
  it('"Disallow: /" blocks everything', () => assert.equal(allowed('User-agent: *\nDisallow: /', '/x/y'), false));
  it('matches by prefix', () => {
    const r = 'User-agent: *\nDisallow: /files';
    for (const p of ['/files', '/files/', '/files/a.exe', '/filesystem']) assert.equal(allowed(r, p), false, p);
    assert.equal(allowed(r, '/file'), true);
    assert.equal(allowed(r, '/other/files'), true);
  });
  it('supports * wildcards and the $ end anchor', () => {
    const r = 'User-agent: *\nDisallow: /*.exe$\nDisallow: /tmp/*/secret\nDisallow: /*?download=';
    assert.equal(allowed(r, '/setup.exe'), false);
    assert.equal(allowed(r, '/a/b/setup.exe'), false);
    assert.equal(allowed(r, '/setup.exe.txt'), true, '$ anchors the end');
    assert.equal(allowed(r, '/tmp/x/secret'), false);
    assert.equal(allowed(r, '/tmp/secret'), true);
    assert.equal(allowed(r, '/page?download=1'), false);
  });
  it('the longest matching pattern wins and Allow wins a tie', () => {
    const r = 'User-agent: *\nDisallow: /a/\nAllow: /a/b/\nDisallow: /a/b/c\nDisallow: /same\nAllow: /same';
    assert.equal(allowed(r, '/a/x'), false);
    assert.equal(allowed(r, '/a/b/x'), true);
    assert.equal(allowed(r, '/a/b/c/d'), false);
    assert.equal(allowed(r, '/same'), true);
  });
  it('treats regular-expression characters in a pattern literally', () => {
    const r = 'User-agent: *\nDisallow: /a.b+c(d)[e]?f';
    assert.equal(allowed(r, '/a.b+c(d)[e]?f'), false);
    assert.equal(allowed(r, '/aXb+c(d)[e]?f'), true);
    assert.equal(allowed(r, '/a.bbc(d)[e]?f'), true);
  });
  it('normalises percent-encoding before comparing', () => {
    const r = 'User-agent: *\nDisallow: /~private\nDisallow: /a%20b';
    assert.equal(allowed(r, '/%7Eprivate'), false);
    assert.equal(allowed(r, '/%7eprivate/x'), false);
    assert.equal(allowed(r, '/a%20b'), false);
  });
  it('considers the query string as part of the path', () => {
    const r = 'User-agent: *\nDisallow: /search?q=';
    assert.equal(allowed(r, '/search?q=abc'), false);
    assert.equal(allowed(r, '/search'), true);
  });
  it('reports the rule that decided and the crawl delay', () => {
    const v = isAllowed(parseRobots('User-agent: *\nCrawl-delay: 5\nDisallow: /x'), TOKEN, '/x/y');
    assert.deepEqual([v.allowed, v.rule, v.crawlDelay], [false, 'disallow: /x', 5]);
    assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow: /x'), TOKEN, '/free').rule, null);
  });
});

describe('the real DriverScape robots.txt fixture', () => {
  it('lets the listing page be read but never the /files/ download area', async () => {
    const text = await readFile(fromRoot('tests', 'fixtures', 'driverscape-robots.txt'), 'utf8');
    assert.equal(allowed(text, '/manufacturers/online/laptops-desktops/online/125322'), true);
    assert.equal(allowed(text, '/files/some-driver.exe'), false);
    assert.equal(allowed(text, '/files/'), false);
  });
});

describe('RobotsChecker policy', () => {
  const make = (handler, opts = {}) => {
    const t = testClient(handler, opts);
    const checker = new RobotsChecker({ client: t.client, productToken: TOKEN, ttlMs: 1000, now: t.clock.now });
    return { ...t, checker };
  };
  it('2xx: obeys the file; 4xx: no restrictions; 5xx and network errors: disallow all', async () => {
    const parsed = make(() => ok('User-agent: *\nDisallow: /no', { 'content-type': 'text/plain' }));
    assert.equal((await parsed.checker.check('https://example.test/no/x')).allowed, false);
    assert.equal((await parsed.checker.check('https://example.test/yes')).allowed, true);
    const none = make(() => ({ status: 404, headers: {}, body: '' }));
    assert.equal((await none.checker.check('https://example.test/anything')).allowed, true);
    const gone = make(() => ({ status: 410, headers: {}, body: '' }));
    assert.equal((await gone.checker.check('https://example.test/anything')).allowed, true);
    const down = make(() => ({ status: 503, headers: {}, body: '' }), { retries: 0 });
    const verdict = await down.checker.check('https://example.test/anything');
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /unreachable.*disallow-all/);
    const broken = make(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, { retries: 0 });
    assert.equal((await broken.checker.check('https://example.test/anything')).allowed, false);
  });
  it('caches per origin for the TTL, then asks again', async () => {
    const t = make(() => ok('User-agent: *\nAllow: /', { 'content-type': 'text/plain' }));
    await t.checker.check('https://example.test/a'); await t.checker.check('https://example.test/b');
    await t.checker.check('https://sub.example.test/a');
    assert.equal(t.calls.length, 2, 'one fetch per origin');
    t.clock.t += 5000;
    await t.checker.check('https://example.test/c');
    assert.equal(t.calls.length, 3, 'expired entries are refreshed');
  });
  it('requests robots.txt over https from the same origin and says why a URL is blocked', async () => {
    const t = make(() => ok('User-agent: *\nDisallow: /private', { 'content-type': 'text/plain' }));
    const v = await t.checker.check('https://example.test:8443/private/x');
    assert.equal(t.calls[0].url, 'https://example.test:8443/robots.txt');
    assert.equal(v.allowed, false);
    assert.match(v.reason, /matched robots\.txt rule "disallow: \/private"/);
  });
  it('reports the crawl delay of the matching group', async () => {
    const t = make(() => ok('User-agent: *\nCrawl-delay: 7', { 'content-type': 'text/plain' }));
    assert.equal((await t.checker.check('https://example.test/a')).crawlDelay, 7);
  });
});

// Polite HTTP client for the ANTO-LTG crawler.
//
// Guarantees (each one is covered by tests/crawler/http.test.mjs):
//  * identifies itself with a descriptive User-Agent;
//  * HTTPS only (HTTP allowed solely when `allowHttp` is set, which tests use for local mocks);
//  * every request - including every redirect hop - must target a host on the allow-list
//    and must not resolve to a private/loopback address (SSRF guard);
//  * robots.txt is consulted before every request, redirect hops included;
//  * per-host minimum interval, honouring Crawl-delay, plus a per-host concurrency cap;
//  * timeouts, bounded retries with exponential backoff + jitter, Retry-After support;
//  * response bodies are size-capped, and binary responses are never read: the stream is
//    cancelled after the headers, so installers/drivers are never downloaded or executed;
//  * credentials are attached only to the exact host they were configured for and are never
//    forwarded across redirects; cookies are never sent or stored;
//  * conditional requests (ETag / Last-Modified) with an on-disk cache for incremental runs.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import dns from 'node:dns/promises';
import path from 'node:path';
import { hostMatches, isPrivateAddress, isPrivateHostname } from './net-safety.mjs';

export class CrawlerError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'CrawlerError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Errors that trying again cannot fix: policy blocks (robots.txt, allow-list, SSRF guard) and deterministic
// failures. `--retry-failed` skips these; everything else (timeouts, network errors, rate limits) may succeed later.
export const PERMANENT_ERROR_CODES = new Set(['ROBOTS_DISALLOWED', 'BLOCKED_PROTOCOL', 'BLOCKED_URL', 'BLOCKED_HOST', 'BLOCKED_PRIVATE', 'BAD_URL', 'TLS_ERROR', 'TOO_LARGE', 'TOO_MANY_REDIRECTS']);
export const isRetryableError = (code) => !PERMANENT_ERROR_CODES.has(code);

export const DEFAULT_USER_AGENT =
  'ANTO-LTG-Crawler/0.2 (+https://github.com/flessan/ANTO-LTG; catalog research bot; honours robots.txt)';

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|ld\+json|xhtml\+xml|rss\+xml|atom\+xml|vnd\.github[^;]*))|\+json|\+xml/i;
const KEEP_HEADERS = [
  'content-type', 'content-length', 'content-disposition', 'etag', 'last-modified', 'location',
  'retry-after', 'accept-ranges', 'link', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-limit',
  'content-range', 'server',
];

export const DEFAULTS = {
  userAgent: DEFAULT_USER_AGENT,
  timeoutMs: 20_000,
  retries: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  perHostMinIntervalMs: 1_500,
  hostRules: {},
  maxPerHostConcurrency: 2,
  maxRateLimitWaitMs: 120_000,
  allowedHosts: [],
  allowHttp: false,
  allowPrivateHosts: false,
  checkDns: true,
  cacheDir: null,
  cacheMode: 'default', // default | refresh | offline | off
  cacheTtlMs: 24 * 3600_000,
  negativeCacheTtlMs: 6 * 3600_000,
  auth: {},
  robots: null,
};

function pickHeaders(headers) {
  const out = {};
  for (const name of KEEP_HEADERS) {
    const v = headers.get(name);
    if (v !== null && v !== undefined) out[name] = v;
  }
  return out;
}

function parseRetryAfter(value, nowMs) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  return Number.isNaN(when) ? null : Math.max(0, when - nowMs);
}

class Semaphore {
  constructor(max) { this.max = max; this.active = 0; this.queue = []; }
  async acquire() {
    if (this.active < this.max) { this.active++; return; }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export function createHttpClient(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const sleep = cfg.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = cfg.random ?? Math.random;
  const now = cfg.now ?? (() => Date.now());
  const hosts = new Map();
  const stats = { requests: 0, cacheHits: 0, notModified: 0, retries: 0, bytes: 0, blocked: 0, byHost: {}, byStatus: {} };
  const log = (event) => { try { cfg.onEvent?.(event); } catch { /* logging must never break a crawl */ } };

  function hostState(host) {
    let st = hosts.get(host);
    if (!st) { st = { next: 0, sem: new Semaphore(cfg.hostRules[host]?.concurrency ?? cfg.maxPerHostConcurrency) }; hosts.set(host, st); }
    return st;
  }

  async function throttle(host, extraMs = 0) {
    const st = hostState(host);
    const interval = Math.max(cfg.hostRules[host]?.minIntervalMs ?? cfg.perHostMinIntervalMs, extraMs);
    const t = now();
    const wait = Math.max(0, st.next - t);
    st.next = Math.max(st.next, t) + interval;
    if (wait > 0) await sleep(wait);
  }

  async function assertAllowed(url) {
    if (url.protocol !== 'https:' && !(cfg.allowHttp && url.protocol === 'http:')) {
      stats.blocked++;
      throw new CrawlerError('BLOCKED_PROTOCOL', `Protocol ${url.protocol} is not allowed for ${url.href}`, { url: url.href });
    }
    if (url.username || url.password) {
      stats.blocked++;
      throw new CrawlerError('BLOCKED_URL', 'URLs with embedded credentials are not allowed', { url: url.href });
    }
    if (cfg.allowedHosts.length && !hostMatches(url.hostname, cfg.allowedHosts)) {
      stats.blocked++;
      throw new CrawlerError('BLOCKED_HOST', `Host ${url.hostname} is not on the crawler allow-list`, { url: url.href });
    }
    if (!cfg.allowPrivateHosts) {
      if (isPrivateHostname(url.hostname)) {
        stats.blocked++;
        throw new CrawlerError('BLOCKED_PRIVATE', `Host ${url.hostname} is private or local`, { url: url.href });
      }
      if (cfg.checkDns && !/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(':')) {
        let addrs = [];
        try { addrs = await dns.lookup(url.hostname, { all: true }); } catch { /* unresolved: let fetch report it */ }
        if (addrs.some((a) => isPrivateAddress(a.address))) {
          stats.blocked++;
          throw new CrawlerError('BLOCKED_PRIVATE', `Host ${url.hostname} resolves to a private address`, { url: url.href });
        }
      }
    }
  }

  function cachePath(key) {
    return path.join(cfg.cacheDir, key.slice(0, 2), `${key}.json`);
  }
  function cacheKey(method, href, accept) {
    return createHash('sha256').update(`${method} ${href}\n${accept ?? ''}`).digest('hex');
  }
  async function readCache(key) {
    if (!cfg.cacheDir || cfg.cacheMode === 'off') return null;
    try { return JSON.parse(await readFile(cachePath(key), 'utf8')); } catch { return null; }
  }
  async function writeCache(key, entry) {
    if (!cfg.cacheDir || cfg.cacheMode === 'off') return;
    try {
      await mkdir(path.dirname(cachePath(key)), { recursive: true });
      await writeFile(cachePath(key), JSON.stringify(entry));
    } catch { /* cache problems must not fail a crawl */ }
  }

  function authHeaders(url) {
    const provider = cfg.auth[url.hostname];
    if (!provider) return {};
    const headers = typeof provider === 'function' ? provider() : provider;
    return headers && typeof headers === 'object' ? headers : {};
  }

  async function readBody(res, maxBytes, signal) {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw new CrawlerError('TOO_LARGE', `Declared size ${declared} exceeds limit ${maxBytes}`);
    }
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      if (signal?.aborted) { try { await reader.cancel(); } catch { /* ignore */ } throw new CrawlerError('TIMEOUT', 'Timed out while reading the response body'); }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw new CrawlerError('TOO_LARGE', `Response exceeded ${maxBytes} bytes`); }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }

  function makeResult(base) {
    const body = base.body ?? Buffer.alloc(0);
    return {
      ...base,
      body,
      text: () => body.toString('utf8'),
      json: () => JSON.parse(body.toString('utf8')),
    };
  }

  async function singleRequest(url, opt, conditionalHeaders) {
    const method = opt.method ?? 'GET';
    const headers = {
      'user-agent': cfg.userAgent,
      accept: opt.accept ?? 'text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1',
      'accept-encoding': 'gzip, deflate, br',
      ...(opt.headers ?? {}),
      ...conditionalHeaders,
      ...authHeaders(url),
    };
    const timeoutMs = opt.timeoutMs ?? cfg.timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    const started = now();
    let res;
    try {
      res = await doFetch(url.href, { method, headers, redirect: 'manual', signal, credentials: 'omit' });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new CrawlerError('TIMEOUT', `Request timed out after ${timeoutMs} ms`, { url: url.href });
      const code = err?.cause?.code ?? err?.code ?? '';
      if (/^(UNABLE_TO_|CERT_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH|ERR_CERT)/.test(code)) {
        // Deterministic and security relevant: never retried, never bypassed.
        throw new CrawlerError('TLS_ERROR', `TLS verification failed for ${url.hostname} (${code}). If you are behind a TLS-inspecting proxy, trust its CA with NODE_EXTRA_CA_CERTS=/path/to/ca.pem; the crawler will not disable certificate checks.`, { url: url.href });
      }
      throw new CrawlerError('NETWORK', `Network error for ${url.href}: ${code || err?.message || err}`, { url: url.href });
    }
    stats.requests++;
    stats.byHost[url.hostname] = (stats.byHost[url.hostname] ?? 0) + 1;
    stats.byStatus[res.status] = (stats.byStatus[res.status] ?? 0) + 1;
    const info = { status: res.status, headers: pickHeaders(res.headers), ms: now() - started };
    const type = res.headers.get('content-type') ?? '';
    const isRedirect = res.status >= 300 && res.status < 400;
    const wantsBody = method !== 'HEAD' && !isRedirect && res.status !== 304 && res.status !== 204;
    if (!wantsBody) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { ...info, body: Buffer.alloc(0), binary: false, truncated: false };
    }
    const looksBinary = Boolean(type) && !TEXT_TYPES.test(type) && !opt.allowBinary;
    if (looksBinary) {
      // Never download binaries: drop the stream after the headers.
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { ...info, body: Buffer.alloc(0), binary: true, truncated: true };
    }
    const body = await readBody(res, opt.maxBytes ?? cfg.maxBytes, signal);
    stats.bytes += body.length;
    return { ...info, body, binary: false, truncated: false };
  }

  async function requestWithRetry(url, opt, conditionalHeaders) {
    const retries = opt.retries ?? cfg.retries;
    for (let attempt = 0; ; attempt++) {
      let robotsDelay = 0;
      if (opt.robots !== false && cfg.robots) {
        const verdict = await cfg.robots.check(url.href);
        if (!verdict.allowed) {
          stats.blocked++;
          throw new CrawlerError('ROBOTS_DISALLOWED', `robots.txt disallows ${url.href}: ${verdict.reason}`, { url: url.href, reason: verdict.reason });
        }
        robotsDelay = (verdict.crawlDelay ?? 0) * 1000;
      }
      const st = hostState(url.hostname);
      await st.sem.acquire();
      let result;
      try {
        await throttle(url.hostname, robotsDelay);
        result = await singleRequest(url, opt, conditionalHeaders);
      } catch (err) {
        st.sem.release();
        const retryable = ['TIMEOUT', 'NETWORK'].includes(err.code);
        if (retryable && attempt < retries) {
          const delay = backoff(attempt);
          stats.retries++;
          log({ type: 'retry', url: url.href, attempt: attempt + 1, reason: err.code, delayMs: delay });
          await sleep(delay);
          continue;
        }
        throw err;
      }
      st.sem.release();
      log({ type: 'response', url: url.href, status: result.status, ms: result.ms, attempt });

      // GitHub-style primary rate limit exhaustion.
      if ((result.status === 403 || result.status === 429) && result.headers['x-ratelimit-remaining'] === '0') {
        const resetMs = Number(result.headers['x-ratelimit-reset']) * 1000 - now();
        if (resetMs > 0 && resetMs <= cfg.maxRateLimitWaitMs && attempt < retries) {
          log({ type: 'rate-limit-wait', url: url.href, waitMs: resetMs });
          await sleep(resetMs + 1000);
          stats.retries++;
          continue;
        }
        throw new CrawlerError('RATE_LIMIT_EXHAUSTED', `Rate limit exhausted for ${url.hostname}; resets in ${Math.max(0, Math.round(resetMs / 1000))}s`, { url: url.href });
      }
      const transient = result.status === 429 || result.status === 408 || result.status === 425 || result.status >= 500;
      if (transient && attempt < retries) {
        const ra = parseRetryAfter(result.headers['retry-after'], now());
        const delay = Math.min(ra ?? backoff(attempt), cfg.maxRateLimitWaitMs);
        stats.retries++;
        log({ type: 'retry', url: url.href, attempt: attempt + 1, reason: `HTTP ${result.status}`, delayMs: delay });
        await sleep(delay);
        continue;
      }
      return result;
    }
  }

  function backoff(attempt) {
    const exp = Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * 2 ** attempt);
    return Math.round(exp * (0.5 + random() * 0.5));
  }

  async function fetchUrl(input, opt = {}) {
    let url;
    try { url = new URL(input); } catch { throw new CrawlerError('BAD_URL', `Not a valid URL: ${input}`); }
    const method = opt.method ?? 'GET';
    const redirects = [];
    let current = url;

    for (let hop = 0; hop <= cfg.maxRedirects; hop++) {
      await assertAllowed(current);
      const key = cacheKey(method, current.href, opt.accept);
      let cached = null;
      let conditional = {};
      if (method === 'GET' && opt.cache !== false && cfg.cacheMode !== 'off') {
        cached = await readCache(key);
        if (cached) {
          const age = now() - cached.fetchedAt;
          const ttl = cached.status === 200 ? cfg.cacheTtlMs : cfg.negativeCacheTtlMs;
          if (cfg.cacheMode === 'offline' || (cfg.cacheMode === 'default' && age < ttl)) {
            stats.cacheHits++;
            return makeResult({
              url: url.href, finalUrl: current.href, status: cached.status, headers: cached.headers,
              body: Buffer.from(cached.body ?? '', 'base64'), fromCache: true, redirects, binary: false, truncated: false,
            });
          }
          if (cached.headers?.etag) conditional['if-none-match'] = cached.headers.etag;
          else if (cached.headers?.['last-modified']) conditional['if-modified-since'] = cached.headers['last-modified'];
        } else if (cfg.cacheMode === 'offline') {
          throw new CrawlerError('CACHE_MISS', `Offline mode and no cache entry for ${current.href}`, { url: current.href });
        }
      }

      const res = await requestWithRetry(current, opt, conditional);

      if (res.status === 304 && cached) {
        stats.notModified++;
        await writeCache(key, { ...cached, fetchedAt: now() });
        return makeResult({
          url: url.href, finalUrl: current.href, status: 200, headers: cached.headers,
          body: Buffer.from(cached.body ?? '', 'base64'), fromCache: true, notModified: true, redirects, binary: false, truncated: false,
        });
      }

      if (res.status >= 300 && res.status < 400 && res.headers.location && opt.followRedirects !== false) {
        let next;
        try { next = new URL(res.headers.location, current); } catch {
          return makeResult({ url: url.href, finalUrl: current.href, ...res, redirects, redirectBlocked: { location: res.headers.location, reason: 'invalid Location header' } });
        }
        redirects.push({ from: current.href, to: next.href, status: res.status });
        try {
          await assertAllowed(next);
        } catch (err) {
          return makeResult({ url: url.href, finalUrl: current.href, ...res, redirects, redirectBlocked: { location: next.href, reason: err.message, code: err.code } });
        }
        if (hop === cfg.maxRedirects) throw new CrawlerError('TOO_MANY_REDIRECTS', `More than ${cfg.maxRedirects} redirects from ${url.href}`, { url: url.href });
        current = next;
        continue;
      }

      if (method === 'GET' && (res.status === 200 || res.status === 404 || res.status === 410) && opt.cache !== false && !res.binary) {
        await writeCache(key, { url: current.href, status: res.status, headers: res.headers, body: res.body.toString('base64'), fetchedAt: now() });
      }
      return makeResult({ url: url.href, finalUrl: current.href, ...res, fromCache: false, redirects });
    }
    throw new CrawlerError('TOO_MANY_REDIRECTS', `Too many redirects from ${url.href}`, { url: url.href });
  }

  // Inspect a URL without downloading its body: HEAD first, then a 1-byte ranged GET.
  async function probe(input, opt = {}) {
    let res = await fetchUrl(input, { ...opt, method: 'HEAD', cache: false, allowBinary: true });
    if ([403, 405, 501].includes(res.status)) {
      res = await fetchUrl(input, { ...opt, method: 'GET', headers: { ...(opt.headers ?? {}), range: 'bytes=0-0' }, cache: false, allowBinary: false, maxBytes: 4096 });
    }
    return {
      url: res.url, finalUrl: res.finalUrl, status: res.status, redirects: res.redirects,
      redirectBlocked: res.redirectBlocked ?? null,
      contentType: res.headers['content-type'] ?? null,
      contentLength: res.headers['content-length'] ? Number(res.headers['content-length']) : null,
      contentDisposition: res.headers['content-disposition'] ?? null,
      acceptRanges: res.headers['accept-ranges'] ?? null,
      etag: res.headers.etag ?? null,
      lastModified: res.headers['last-modified'] ?? null,
      binary: Boolean(res.binary),
    };
  }

  return { fetch: fetchUrl, probe, stats, config: cfg, setRobots(checker) { cfg.robots = checker; } };
}

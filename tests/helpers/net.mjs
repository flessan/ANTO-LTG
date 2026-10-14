// Test doubles for the crawler's HTTP client: a scripted fetch(), a virtual clock (so rate limiting and
// backoff are measured, not waited for), and a response body that records whether anybody read it.
import { createHttpClient } from '../../scripts/crawler/lib/http.mjs';

/** A response stream that remembers whether it was cancelled (= "never downloaded") and how much was pulled. */
export function trackedBody(chunks) {
  const state = { pulled: 0, cancelled: false };
  const queue = chunks.map((c) => (typeof c === 'string' ? new TextEncoder().encode(c) : c));
  const stream = new ReadableStream({
    pull(controller) { if (state.pulled < queue.length) controller.enqueue(queue[state.pulled++]); else controller.close(); },
    cancel() { state.cancelled = true; },
  });
  return { stream, state };
}

/**
 * Scripted fetch. `handler(req)` returns { status, headers, body } where body may be a string, Buffer,
 * Uint8Array, a { stream } from trackedBody(), or null. It may also throw (to simulate network errors) or
 * return a Promise. Every call is recorded in `calls`.
 */
export function scriptedFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { url: String(url), method: init.method ?? 'GET', headers, init, signal: init.signal };
    calls.push(req);
    const out = await handler(req, calls.length - 1);
    const status = out.status ?? 200;
    const nullBody = [101, 204, 205, 304].includes(status) || req.method === 'HEAD';
    let body = out.body ?? null;
    if (body && typeof body === 'object' && 'stream' in body) body = body.stream;
    return new Response(nullBody ? null : body, { status, headers: out.headers ?? {} });
  };
  return { fetchImpl, calls };
}

/** Virtual time: sleep() advances the clock instead of waiting, and every sleep is recorded. */
export function virtualClock(start = 1_700_000_000_000) {
  const clock = { t: start, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += ms; };
  return clock;
}

/** Client wired to a scripted fetch and a virtual clock; checkDns is off so tests never touch the network. */
export function testClient(handler, options = {}) {
  const net = scriptedFetch(handler);
  const clock = virtualClock();
  const client = createHttpClient({
    fetchImpl: net.fetchImpl, sleep: clock.sleep, now: clock.now, random: () => 1, checkDns: false,
    allowedHosts: ['example.test', '*.example.test', 'api.github.com'], perHostMinIntervalMs: 0, retries: 2, backoffBaseMs: 1000, backoffMaxMs: 30_000,
    ...options,
  });
  return { client, calls: net.calls, clock };
}

export const ok = (body = 'ok', headers = {}) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body });
export const json = (value, headers = {}) => ({ status: 200, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
export const redirect = (location, status = 302) => ({ status, headers: { location }, body: null });

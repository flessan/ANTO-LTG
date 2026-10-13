// check-links: probes the download links stored in the catalogs and records what the server said.
//
//   node scripts/crawler/cli.mjs check-links [--catalog apps|drivers|tools] [--hosts a.com,b.com] [--only id,id]
//                                            [--limit N] [--concurrency N] [--apply]
//
// What it does, and what it deliberately does not do:
//  * header-only probes: HEAD, then a 1-byte ranged GET whose body is cancelled; a binary is NEVER downloaded;
//  * robots.txt is honoured for every host, requests are rate limited per host, and the crawler identifies itself;
//  * only hosts that appear in the checked links are contacted; a redirect to another host is not followed
//    (it is recorded as a redirect, naming only the target HOST, so signed CDN URLs are never stored);
//  * it only ever writes `link_check` objects. It never changes verification_status, never removes a link and
//    never marks anything "safe": "ok" means "the server answered", not "the file is trustworthy";
//  * without --apply it only writes a report to catalogs/proposed/link-check.report.json.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHttpClient } from '../lib/http.mjs';
import { RobotsChecker } from '../lib/robots.mjs';
import { classifyUrl, refineWithProbe } from '../lib/classify-url.mjs';
import { runPool } from '../lib/pool.mjs';
import { loadConfig, repoRoot } from '../lib/config.mjs';
import { readCatalog, writeCatalog, CATALOGS, canonicalizeDoc } from '../../lib/catalog-io.mjs';
import { loadSchemas, createValidators } from '../../lib/schema.mjs';
import { checkSemantics } from '../../lib/semantic.mjs';

export const LINK_CATALOGS = ['apps', 'drivers', 'tools'];
export const REPORT_SCHEMA = 'anto-ltg.link-check/1';

// ---- which links are checked ------------------------------------------------------------------------------------------
// Download links live in `downloads[]` (apps, tools) and `download` (drivers). Records with kind "none" have no URL.
export function collectLinks(catalogs, { catalog = null, hosts = null, only = null } = {}) {
  const links = [];
  for (const name of LINK_CATALOGS) {
    if (catalog && catalog !== name) continue;
    for (const item of catalogs[name]?.items ?? []) {
      if (only && !only.includes(item.id)) continue;
      const entries = name === 'drivers' ? (item.download?.url ? [item.download] : []) : (item.downloads ?? []);
      entries.forEach((d, index) => {
        if (!d?.url) return;
        let host;
        try { host = new URL(d.url).hostname.toLowerCase(); } catch { return; }
        if (hosts && !hosts.some((h) => host === h || host.endsWith(`.${h}`))) return;
        links.push({ catalog: name, id: item.id, index, url: d.url, kind: d.kind, host });
      });
    }
  }
  return links;
}

const FILE_LIKE = new Set(['direct_binary']);
const DENIED = new Set([401, 403, 429, 451]); // the server refused an automated request: that is not proof the link is dead

const oneLine = (v, max = 280) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// final_url is only stored when it is a plain https URL that does not look signed or time-limited.
function safeFinalUrl(finalUrl, original) {
  if (!finalUrl || finalUrl === original) return null;
  let u;
  try { u = new URL(finalUrl); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const kind = classifyUrl(finalUrl);
  if (kind.kind === 'signed_temporary' || u.search) return null;
  return u.href;
}

// ---- probe result -> link_check object (pure; unit-tested) ------------------------------------------------------------
export function toLinkCheck({ link, probe = null, error = null, now }) {
  const base = { checked_at: now };
  if (error) {
    const code = error.code ?? 'EXCEPTION';
    if (['ROBOTS_DISALLOWED', 'BLOCKED_HOST', 'BLOCKED_PRIVATE', 'BLOCKED_PROTOCOL', 'BLOCKED_URL', 'BAD_URL'].includes(code)) {
      return { status: 'blocked', ...base, http_status: null, note: oneLine(code === 'ROBOTS_DISALLOWED' ? `robots.txt does not allow automated requests to this URL${error.reason ? ` (${error.reason})` : ''}, so it was not probed.` : `Not probed: ${error.message}`, 300) };
    }
    return { status: 'error', ...base, http_status: null, note: oneLine(`${code}: ${error.message}`) };
  }
  const status = probe.status;
  const out = { ...base, http_status: status, content_type: probe.contentType ? oneLine(probe.contentType, 100) : null };
  if (probe.contentLength !== null && probe.contentLength !== undefined && Number.isFinite(probe.contentLength) && probe.contentLength >= 0) out.size_bytes = probe.contentLength;
  if (probe.redirectBlocked) {
    let host = 'another host';
    try { host = new URL(probe.redirectBlocked.location).hostname; } catch { /* keep the generic text */ }
    return { status: 'redirect', ...out, note: oneLine(`Redirects to a different host (${host}); not followed, so the final file was not inspected.`) };
  }
  if (status >= 200 && status < 300) {
    const refined = refineWithProbe(classifyUrl(link.url), probe);
    const expectedFile = FILE_LIKE.has(link.kind);
    if (expectedFile && refined.kind === 'landing_page') return { status: 'broken', ...out, note: 'Listed as a direct download, but the server answered with an HTML page instead of a file.' };
    const final = safeFinalUrl(probe.finalUrl, link.url);
    if (probe.redirects?.length) return { status: 'redirect', ...out, ...(final ? { final_url: final } : {}), note: oneLine(`${probe.redirects.length} redirect hop(s) followed.${final ? '' : ' The final URL is not stored (it carries a query string or looks signed).'}`) };
    return { status: 'ok', ...out };
  }
  if (status >= 300 && status < 400) return { status: 'redirect', ...out, note: 'Redirect that was not followed.' };
  if (DENIED.has(status)) return { status: 'blocked', ...out, note: oneLine(`The server refused an automated request (HTTP ${status}); this does not prove the link is broken.`) };
  if (status >= 500) return { status: 'error', ...out, note: oneLine(`Server error (HTTP ${status}); try again later.`) };
  return { status: 'broken', ...out, note: oneLine(`HTTP ${status}.`) };
}

// ---- run the probes ---------------------------------------------------------------------------------------------------
export async function runLinkChecks({ client, links, now = () => new Date().toISOString(), concurrency = 4, onProgress = null }) {
  const unique = [...new Map(links.map((l) => [l.url, l])).values()];
  let done = 0;
  const outcomes = await runPool(unique, concurrency, async (link) => {
    try {
      const probe = await client.probe(link.url);
      return toLinkCheck({ link, probe, now: now() });
    } catch (error) {
      return toLinkCheck({ link, error, now: now() });
    } finally { onProgress?.(++done, unique.length, link.url); }
  });
  const byUrl = new Map(unique.map((l, i) => [l.url, outcomes[i].value ?? toLinkCheck({ link: l, error: outcomes[i].error, now: now() })]));
  return links.map((l) => ({ ...l, link_check: byUrl.get(l.url) }));
}

export function summarizeResults(results) {
  const counts = {};
  for (const r of results) counts[r.link_check.status] = (counts[r.link_check.status] ?? 0) + 1;
  return counts;
}

// Writes link_check onto the matching download entries and nothing else. A catalog whose links changed gets a new
// updated_at (the date of the probes); catalogs that did not change are left byte-for-byte alone.
export function applyResults(catalogs, results, today) {
  const next = structuredClone(catalogs);
  const changedCatalogs = new Set();
  let changed = 0;
  for (const r of results) {
    const item = next[r.catalog].items.find((i) => i.id === r.id);
    const entry = r.catalog === 'drivers' ? item?.download : item?.downloads?.[r.index];
    if (!entry || entry.url !== r.url) continue; // the catalog moved on since the probe was planned
    if (JSON.stringify(entry.link_check) !== JSON.stringify(r.link_check)) { entry.link_check = r.link_check; changed++; changedCatalogs.add(r.catalog); }
  }
  for (const name of changedCatalogs) next[name].updated_at = `${today}T00:00:00.000Z`;
  return { catalogs: next, changed, changedCatalogs };
}

export function buildReport({ results, startedAt, finishedAt, args }) {
  return {
    schema: REPORT_SCHEMA,
    started_at: startedAt,
    finished_at: finishedAt,
    arguments: args,
    summary: summarizeResults(results),
    note: 'Header-only probes. "ok" means the server answered; it does not mean the file is safe or the record is verified. No file was downloaded or executed.',
    results: results.map((r) => ({ catalog: r.catalog, id: r.id, url: r.url, kind: r.kind, ...r.link_check })),
  };
}

// ---- the command ------------------------------------------------------------------------------------------------------
export async function checkLinks({ flags = {}, log = console.log, root = repoRoot, client: injected = null, now = () => new Date().toISOString() } = {}) {
  const cfg = await loadConfig();
  const catalogs = Object.fromEntries(await Promise.all(CATALOGS.map(async (n) => [n, await readCatalog(root, n)])));
  const catalog = flags.catalog ? String(flags.catalog) : null;
  if (catalog && !LINK_CATALOGS.includes(catalog)) { log(`--catalog must be one of ${LINK_CATALOGS.join(', ')}`); return 2; }
  const hosts = flags.hosts ? String(flags.hosts).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean) : null;
  const only = flags.only ? String(flags.only).split(',').map((s) => s.trim()).filter(Boolean) : null;
  let links = collectLinks(catalogs, { catalog, hosts, only });
  if (flags.limit) links = links.slice(0, Number(flags.limit));
  const unique = [...new Set(links.map((l) => l.url))];
  const probeHosts = [...new Set(links.map((l) => l.host))].sort();
  if (!links.length) { log('No links to check (check --catalog, --hosts and --only).'); return 0; }
  log(`Checking ${unique.length} unique URL(s) on ${probeHosts.length} host(s) with header-only requests (no file is downloaded).`);

  const outDir = path.resolve(root, cfg.output_dir);
  const client = injected ?? createHttpClient({
    userAgent: cfg.user_agent, timeoutMs: cfg.timeout_ms, retries: Math.min(cfg.retries, 1), backoffBaseMs: cfg.backoff_base_ms, backoffMaxMs: cfg.backoff_max_ms,
    maxBytes: 64 * 1024, maxRedirects: cfg.max_redirects, perHostMinIntervalMs: cfg.per_host_min_interval_ms, allowedHosts: probeHosts,
    cacheDir: null, cacheMode: 'off', maxPerHostConcurrency: 1,
  });
  if (!injected) client.setRobots(new RobotsChecker({ client, productToken: cfg.product_token }));

  const startedAt = now();
  const results = await runLinkChecks({
    client, links, now, concurrency: Number(flags.concurrency ?? cfg.concurrency),
    onProgress: (n, total, url) => { if (n % 25 === 0 || n === total) log(`  ${n}/${total} ${new URL(url).hostname}`); },
  });
  const finishedAt = now();
  const summary = summarizeResults(results);
  log(`Done: ${Object.entries(summary).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
  for (const r of results.filter((x) => ['broken', 'error'].includes(x.link_check.status)).slice(0, 30)) log(`  ${r.link_check.status.toUpperCase()} ${r.catalog}/${r.id}: ${r.url} (${r.link_check.note ?? r.link_check.http_status})`);

  const report = buildReport({ results, startedAt, finishedAt, args: { catalog, hosts, only, limit: flags.limit ?? null, apply: Boolean(flags.apply) } });
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'link-check.report.json'), `${JSON.stringify(report, null, 2)}\n`);
  log(`Report: ${path.relative(root, path.join(outDir, 'link-check.report.json'))}`);

  if (!flags.apply) { log('Dry run for the catalogs: re-run with --apply to record these results in catalogs/*.json (link_check only).'); return 0; }
  const { catalogs: updated, changed, changedCatalogs } = applyResults(catalogs, results, finishedAt.slice(0, 10));
  const canon = Object.fromEntries(CATALOGS.map((n) => [n, canonicalizeDoc(n, updated[n])]));
  const validators = createValidators(await loadSchemas(path.join(root, 'schemas')));
  const problems = [];
  for (const n of CATALOGS) { const r = validators.validate(n, canon[n]); if (!r.ok) problems.push(...r.errors.slice(0, 10).map((e) => `${n}.json ${e}`)); }
  problems.push(...checkSemantics(canon));
  if (problems.length) { log(`The updated catalogs would NOT validate; nothing was written:\n${problems.slice(0, 20).map((p) => `  - ${p}`).join('\n')}`); return 1; }
  for (const n of changedCatalogs) await writeCatalog(root, n, canon[n]);
  log(`Recorded ${changed} link check(s). Review with \`git diff catalogs/\`, then run \`npm run build\`.`);
  return 0;
}


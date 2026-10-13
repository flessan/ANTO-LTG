import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHttpClient } from '../lib/http.mjs';
import { RobotsChecker } from '../lib/robots.mjs';
import { loadConfig, loadAdapter, repoRoot, crawlerDir } from '../lib/config.mjs';
import { loadState, saveState, recordOutcome, failedTargets } from '../lib/state.mjs';
import { buildReport, flagHistogram, renderMarkdown } from '../lib/report.mjs';
import { readCatalog } from '../../lib/catalog-io.mjs';

export function githubAuth(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || '';
  if (!token) return null;
  // Only ever attached to api.github.com by the HTTP client (host-exact match).
  return () => ({ authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' });
}

export async function readProposalFile(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

export function mergeProposalFiles(existing, adapter, source, proposals, errors, now, replaceAll, attempted = []) {
  const kept = replaceAll || !existing ? [] : existing.proposals.filter((p) => !proposals.some((n) => n.target === p.target) && !errors.some((e) => e.target === p.target));
  const merged = [...kept, ...proposals].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  // Errors from earlier runs stay until the target is attempted again.
  const keptErrors = replaceAll || !existing ? [] : (existing.errors ?? []).filter((e) => !proposals.some((n) => n.target === e.target) && !errors.some((n) => n.target === e.target) && !attempted.includes(e.target));
  return { schema: 'anto-ltg.proposals/1', adapter, generated_at: now, source, proposals: merged, errors: [...keptErrors, ...errors].sort((a, b) => (a.target < b.target ? -1 : 1)) };
}

export async function crawl({ flags, positional, log = console.error }) {
  const cfg = await loadConfig(flags.config ? path.resolve(String(flags.config)) : undefined);
  const outDir = path.resolve(repoRoot, String(flags.out ?? cfg.output_dir));
  const names = positional.length ? positional : Object.keys(cfg.adapters).filter((n) => cfg.adapters[n].enabled);
  const state = await loadState(outDir);
  const startedAt = new Date().toISOString();
  const reportAdapters = [];
  const dryRun = Boolean(flags['dry-run']);

  for (const name of names) {
    const acfg = cfg.adapters[name];
    if (!acfg) throw new Error(`Unknown adapter "${name}". Known: ${Object.keys(cfg.adapters).join(', ')}`);
    if (acfg.requires_flag && !flags[acfg.requires_flag.replace(/^--/, '')]) {
      reportAdapters.push({ id: name, skipped: `needs ${acfg.requires_flag} (third-party aggregator source)` });
      log(`[${name}] skipped: needs ${acfg.requires_flag}`);
      continue;
    }
    const adapter = await loadAdapter(acfg.type);
    const hostRules = Object.fromEntries(Object.entries({ ...(acfg.host_rules ?? {}) }).map(([h, r]) => [h, { minIntervalMs: r.min_interval_ms, concurrency: r.concurrency }]));
    const auth = {};
    if (acfg.hosts.includes('api.github.com')) {
      const provider = githubAuth();
      if (provider) auth['api.github.com'] = provider;
      else log(`[${name}] WARNING: no GITHUB_TOKEN/GH_TOKEN set; unauthenticated GitHub API calls are limited to 60 per hour`);
    }
    const client = createHttpClient({
      userAgent: cfg.user_agent,
      timeoutMs: cfg.timeout_ms,
      retries: cfg.retries,
      backoffBaseMs: cfg.backoff_base_ms,
      backoffMaxMs: cfg.backoff_max_ms,
      maxBytes: cfg.max_bytes,
      maxRedirects: cfg.max_redirects,
      perHostMinIntervalMs: cfg.per_host_min_interval_ms,
      hostRules,
      allowedHosts: acfg.hosts,
      cacheDir: path.resolve(repoRoot, cfg.cache_dir),
      cacheTtlMs: cfg.cache_ttl_hours * 3600_000,
      cacheMode: flags.offline ? 'offline' : flags.refresh ? 'refresh' : 'default',
      auth,
      onEvent: flags.verbose ? (e) => log(`[${name}] ${JSON.stringify(e)}`) : undefined,
    });
    if (acfg.robots === 'required') client.setRobots(new RobotsChecker({ client, productToken: cfg.product_token }));

    const explicit = flags.ids ? String(flags.ids).split(',').map((s) => s.trim()).filter(Boolean) : null;
    const retry = flags['retry-failed'] ? failedTargets(state, name) : null;
    const targets = explicit ?? retry ?? undefined;
    if (retry && !retry.length) { log(`[${name}] nothing to retry`); reportAdapters.push({ id: name, skipped: 'no failed targets in state' }); continue; }

    // Offline fixtures stand in for live pages when --use-fixtures is given (tests and sandboxes with no
    // access to the site). Output then records mode "fixture" so nobody mistakes it for a live crawl.
    let fixtures = null;
    if (flags['use-fixtures'] && acfg.targets_file) {
      const seeds = JSON.parse(await readFile(path.join(crawlerDir, acfg.targets_file), 'utf8'));
      fixtures = Object.fromEntries(seeds.targets.filter((t) => t.fixture).map((t) => [t.id, { html: path.resolve(repoRoot, t.fixture.html), robots: t.fixture.robots ? path.resolve(repoRoot, t.fixture.robots) : null, label: t.fixture.html }]));
    }
    const ctx = {
      client,
      vendors: (await readCatalog(repoRoot, 'vendors')).items,
      productToken: cfg.product_token,
      fixtures,
      now: () => new Date().toISOString(),
      rootUrl: pathToFileURL(crawlerDir + path.sep),
      targets,
      concurrency: Number(flags.concurrency ?? cfg.concurrency),
      incremental: Boolean(flags.incremental),
      previous: state.adapters[name]?.targets ?? {},
      allowAggregators: Boolean(flags['allow-aggregators']),
      onProgress: (n, total, id) => { if (n % 25 === 0 || n === total) log(`[${name}] ${n}/${total} (${id})`); },
    };
    if (flags.limit) acfg.limit = Number(flags.limit);

    if (flags.plan) {
      log(`[${name}] plan: hosts=${acfg.hosts.join(',')} robots=${acfg.robots} targets=${targets?.length ?? 'all from seeds'}`);
      reportAdapters.push({ id: name, skipped: 'plan only (no network access)' });
      continue;
    }

    log(`[${name}] starting${dryRun ? ' (dry run: no files will be written)' : ''}`);
    const result = await adapter.run({ cfg: acfg, ctx });
    const summary = {
      id: name, source: result.source, stats: result.stats, errors: result.errors,
      quality_flags: flagHistogram(result.proposals), http: client.stats,
    };
    reportAdapters.push(summary);

    if (!dryRun) {
      const file = path.join(outDir, `${name}.proposals.json`);
      const existing = await readProposalFile(file);
      const replaceAll = !explicit && !retry;
      const doc = mergeProposalFiles(existing, name, result.source, result.proposals, result.errors, ctx.now(), replaceAll, result.attempted ?? []);
      await mkdir(outDir, { recursive: true });
      await writeFile(file, JSON.stringify(doc, null, 2) + '\n');
      recordOutcome(state, name, { proposals: result.proposals, errors: result.errors, unchanged: result.unchanged ?? [], attempted: result.attempted ?? [] }, ctx.now());
      log(`[${name}] wrote ${path.relative(repoRoot, file)} (${doc.proposals.length} proposals, ${doc.errors.length} errors)`);
    }
    log(`[${name}] done: ${JSON.stringify(result.stats)}; http: ${client.stats.requests} requests, ${client.stats.cacheHits} cache hits, ${client.stats.retries} retries`);
  }

  const finishedAt = new Date().toISOString();
  const report = buildReport({ startedAt, finishedAt, args: { adapters: names, ...flags }, adapters: reportAdapters });
  if (!dryRun && !flags.plan) {
    await mkdir(outDir, { recursive: true });
    await saveState(outDir, state);
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(path.join(outDir, 'report.md'), renderMarkdown(report) + '\n');
  }
  return report;
}

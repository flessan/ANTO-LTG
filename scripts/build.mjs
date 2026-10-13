#!/usr/bin/env node
// ANTO-LTG build and validation.
//
//   node scripts/build.mjs --validate   check everything, write nothing (CI; `npm run validate`)
//   node scripts/build.mjs --build      regenerate API files, search index, OpenAPI, credits and page chrome
//   node scripts/build.mjs --format     rewrite catalogs/*.json in canonical form
//
// Validation covers: JSON Schema validity of every catalog, cross-file/policy rules (unique ids,
// references, official-domain and aggregator rules, URL safety, dates), generated artifacts being
// up to date, the shared page chrome, HTML structure/CSP/link integrity, the image provenance
// manifest and the vendored 7.css integrity.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CATALOGS, SCHEMA_VERSION, canonicalizeDoc, serialize, readCatalog } from './lib/catalog-io.mjs';
import { loadSchemas, createValidators } from './lib/schema.mjs';
import { checkSemantics } from './lib/semantic.mjs';
import { checkPublication } from './lib/publication.mjs';
import { buildSearchDocs } from './lib/search-docs.mjs';
import { buildOpenApi } from './lib/openapi.mjs';
import { syncPages } from './lib/chrome.mjs';
import { checkAssets } from './lib/assets-check.mjs';
import { lintPages } from './lib/html-lint.mjs';
import { writeSeo } from './lib/seo.mjs';
import { buildIndex } from '../assets/js/lib/search.js';
import { installMethods, compatFor } from '../assets/js/lib/model.js';
import { renderCredits } from './assets/credits.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const mode = argv.has('--build') ? 'build' : argv.has('--format') ? 'format' : 'validate';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const results = [];
async function step(name, fn) {
  let problems = [];
  try { problems = (await fn()) ?? []; } catch (e) { problems = [`crashed: ${e.stack ?? e}`]; }
  results.push({ name, problems });
  console.log(`${problems.length ? 'FAIL' : ' ok '}  ${name}${problems.length ? ` (${problems.length})` : ''}`);
  for (const p of problems.slice(0, 25)) console.log(`        - ${p}`);
  if (problems.length > 25) console.log(`        ... and ${problems.length - 25} more`);
}

// ---- load ---------------------------------------------------------------------------------------
const schemas = await loadSchemas(path.join(root, 'schemas'));
const validators = createValidators(schemas);
const raw = {}; const catalogs = {};
for (const name of CATALOGS) {
  try { raw[name] = JSON.parse(await readFile(path.join(root, 'catalogs', `${name}.json`), 'utf8')); } catch (e) { console.error(`catalogs/${name}.json: ${e.message}`); process.exit(1); }
  catalogs[name] = canonicalizeDoc(name, raw[name]);
}

if (mode === 'format') {
  for (const name of CATALOGS) await writeFile(path.join(root, 'catalogs', `${name}.json`), serialize(catalogs[name]));
  console.log('catalogs rewritten in canonical form');
  process.exit(0);
}

// ---- derive artifacts ---------------------------------------------------------------------------
const countWhere = (names, pred) => names.reduce((n, c) => n + (catalogs[c]?.items ?? []).filter(pred).length, 0);

function stats() {
  const by = (items, f) => Object.fromEntries(Object.entries(items.reduce((m, i) => { const k = f(i); m[k] = (m[k] ?? 0) + 1; return m; }, {})).sort(([a], [b]) => (a < b ? -1 : 1)));
  const apps = catalogs.apps.items;
  return {
    apps: { total: apps.length, by_category: by(apps, (a) => a.category), by_primary_method: by(apps, (a) => installMethods(a).primary), windows11_declared: apps.filter((a) => compatFor(a, 'windows11') === 'declared').length, windows10_declared: apps.filter((a) => compatFor(a, 'windows10') === 'declared').length },
    drivers: { total: catalogs.drivers.items.length, by_component: by(catalogs.drivers.items, (d) => d.component), by_source_kind: by(catalogs.drivers.items, (d) => d.source_kind), by_kind: by(catalogs.drivers.items, (d) => d.kind) },
    vendors: { total: catalogs.vendors.items.length },
    // Human review (verification_status) and machine publication are counted separately.
    review: { verified: countWhere(['apps', 'drivers', 'tools', 'vendors'], (i) => i.verification_status === 'verified'), not_reviewed: countWhere(['apps', 'drivers', 'tools', 'vendors'], (i) => i.verification_status === 'not_reviewed') },
    publication: {
      published: countWhere(['apps', 'drivers'], (i) => i.publication?.state === 'published'),
      unavailable: countWhere(['apps', 'drivers'], (i) => i.publication?.state === 'unavailable'),
      automated: countWhere(['apps', 'drivers'], (i) => i.publication?.method === 'automated'),
      maintainer_curated: countWhere(['apps', 'drivers'], (i) => i.publication?.method === 'maintainer_curated'),
    },
  };
}

function artifacts() {
  const files = new Map();
  for (const name of CATALOGS) files.set(`api/v1/${name}.json`, serialize(catalogs[name]));
  const index = buildIndex(buildSearchDocs(catalogs));
  files.set('api/v1/search-index.json', `${JSON.stringify(index)}\n`);
  const endpoints = CATALOGS.map((name) => ({ name, path: `/api/v1/${name}.json`, count: catalogs[name].items.length, updated_at: catalogs[name].updated_at ?? null, sha256: sha(files.get(`api/v1/${name}.json`)) }));
  endpoints.push({ name: 'search-index', path: '/api/v1/search-index.json', count: index.docs.length, updated_at: null, sha256: sha(files.get('api/v1/search-index.json')) });
  files.set('api/v1/index.json', `${JSON.stringify({ api_version: 'v1', schema_version: SCHEMA_VERSION, note: 'Static files generated from catalogs/ by `npm run build`. A research index, not a live driver database and not a real-time API.', endpoints, stats: stats() }, null, 2)}\n`);
  const counts = Object.fromEntries(CATALOGS.map((n) => [n, catalogs[n].items.length]));
  files.set('openapi.json', `${JSON.stringify(buildOpenApi({ schemas, version: SCHEMA_VERSION, counts }), null, 2)}\n`);
  return files;
}

const files = artifacts();
const drift = async () => {
  const problems = [];
  for (const [rel, content] of files) {
    const current = await readFile(path.join(root, rel), 'utf8').catch(() => null);
    if (current !== content) problems.push(`${rel} is ${current === null ? 'missing' : 'out of date'} (run npm run build)`);
  }
  return problems;
};

// ---- steps --------------------------------------------------------------------------------------
await step('JSON Schemas compile', async () => (Object.keys(schemas).length >= 8 ? [] : ['expected at least 8 schemas']));
await step('Catalogs match their schemas', async () => {
  const problems = [];
  for (const name of CATALOGS) { const r = validators.validate(name, raw[name]); if (!r.ok) problems.push(...r.errors.slice(0, 15).map((e) => `catalogs/${name}.json ${e}`)); }
  return problems;
});
await step('Catalogs are in canonical form (sorted ids, stable key order)', async () => CATALOGS.filter((n) => serialize(catalogs[n]) !== `${JSON.stringify(raw[n], null, 2)}\n`).map((n) => `catalogs/${n}.json is not canonical (run npm run format:catalogs)`));
await step('Cross-file and policy rules (references, official domains, aggregators, URLs, dates)', async () => checkSemantics(catalogs));
await step('Every catalog record carries a publication state that matches the automated rules', async () => checkPublication(catalogs));
await step('Crawler proposals match their schema', async () => {
  const { readdir } = await import('node:fs/promises');
  const dir = path.join(root, 'catalogs', 'proposed'); const problems = [];
  for (const f of (await readdir(dir).catch(() => [])).filter((x) => x.endsWith('.proposals.json'))) {
    const doc = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    const r = validators.validate('proposals', doc);
    if (!r.ok) problems.push(...r.errors.slice(0, 8).map((e) => `catalogs/proposed/${f} ${e}`));
    for (const p of doc.proposals ?? []) if (p.record?.verification_status !== 'not_reviewed' || 'reviewed_at' in (p.record ?? {})) problems.push(`catalogs/proposed/${f}: proposal ${p.target} claims a human review (crawlers must never promote to verified)`);
  }
  return problems;
});
if (mode === 'build') {
  await step('Write API files, search index and OpenAPI', async () => {
    await mkdir(path.join(root, 'api', 'v1'), { recursive: true });
    for (const [rel, content] of files) await writeFile(path.join(root, rel), content);
    const manifest = JSON.parse(await readFile(path.join(root, 'assets', 'manifest.json'), 'utf8'));
    await writeFile(path.join(root, 'assets', 'CREDITS.md'), renderCredits(manifest));
    return [];
  });
  await step('Sync shared page chrome', async () => { const r = await syncPages(root, { write: true }); if (r.stale.length) console.log(`        updated: ${r.stale.join(', ')}`); return r.problems; });
} else {
  await step('Generated files are up to date (api/v1, search index, openapi.json)', drift);
  await step('Shared page chrome is up to date', async () => { const r = await syncPages(root, { write: false }); return [...r.problems, ...r.stale.map((f) => `${f}: chrome blocks are stale (run npm run build)`)]; });
}
await step('Image provenance manifest, credits and vendored 7.css', () => checkAssets(root));
await step('HTML structure, accessibility basics, CSP compatibility and links', () => lintPages(root));

if (mode === 'build') {
  const siteUrl = process.env.SITE_URL;
  if (!siteUrl) console.warn('SITE_URL is not set; sitemap.xml, robots.txt and feed.xml were not generated. Set SITE_URL to the canonical HTTPS origin to create them.');
  else if (!results.some((r) => r.problems.length)) {
    const out = await writeSeo(root, siteUrl, catalogs.updates);
    if (out.error) { console.error(out.error); process.exitCode = 1; } else console.log(`Generated sitemap.xml, robots.txt and feed.xml for ${out.base}`);
  }
}
const failed = results.filter((r) => r.problems.length);
if (failed.length) { console.error(`\nANTO-LTG ${mode} failed: ${failed.length} check(s) reported problems.`); process.exitCode = 1; }
else {
  const s = stats();
  console.log(`\nANTO-LTG ${mode} succeeded: ${s.apps.total} apps, ${s.drivers.total} drivers, ${s.vendors.total} vendors, ${catalogs.tools.items.length} tools, ${catalogs.bundles.items.length} bundles (${s.publication.published} published automatically, ${s.publication.unavailable} unavailable, ${s.review.verified} human-verified).`);
}

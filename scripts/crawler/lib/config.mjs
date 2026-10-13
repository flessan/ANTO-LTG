import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const crawlerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(crawlerDir, '..', '..');

export async function loadConfig(file = path.join(crawlerDir, 'crawler.config.json')) {
  const cfg = JSON.parse(await readFile(file, 'utf8'));
  const problems = validateConfig(cfg);
  if (problems.length) throw new Error(`Invalid crawler config:\n- ${problems.join('\n- ')}`);
  return cfg;
}

export function validateConfig(cfg) {
  const problems = [];
  if (typeof cfg.user_agent !== 'string' || !/\(\+https?:\/\//.test(cfg.user_agent)) problems.push('user_agent must identify the crawler and include a contact URL, e.g. "Name/1.0 (+https://example.org/about)"');
  if (typeof cfg.product_token !== 'string' || !cfg.product_token) problems.push('product_token is required (used to match robots.txt groups)');
  for (const key of ['timeout_ms', 'retries', 'concurrency', 'per_host_min_interval_ms', 'max_bytes']) {
    if (!Number.isFinite(cfg[key]) || cfg[key] < 0) problems.push(`${key} must be a non-negative number`);
  }
  if (cfg.concurrency > 16) problems.push('concurrency above 16 is not polite; lower it');
  if (cfg.per_host_min_interval_ms < 100) problems.push('per_host_min_interval_ms below 100 is not polite; raise it');
  if (!cfg.adapters || typeof cfg.adapters !== 'object') problems.push('adapters must be an object');
  for (const [name, a] of Object.entries(cfg.adapters ?? {})) {
    if (!a.type) problems.push(`adapter "${name}" needs a type`);
    if (!Array.isArray(a.hosts) || !a.hosts.length) problems.push(`adapter "${name}" must declare at least one allowed host`);
    for (const h of a.hosts ?? []) if (/[/:\s]/.test(h)) problems.push(`adapter "${name}" host "${h}" must be a bare hostname (optionally *.example.com)`);
    if (!['required', 'not_applicable'].includes(a.robots)) problems.push(`adapter "${name}" must set robots to "required" or "not_applicable"`);
    if (a.robots === 'not_applicable' && !a.robots_note) problems.push(`adapter "${name}" skips robots.txt and must explain why in robots_note`);
  }
  return problems;
}

export async function loadAdapter(type) {
  const map = { winget: 'winget.mjs', 'vendor-page': 'vendor-page.mjs', 'driver-listing': 'driver-listing.mjs' };
  if (!map[type]) throw new Error(`Unknown adapter type "${type}"`);
  const mod = await import(pathToFileURL(path.join(crawlerDir, 'adapters', map[type])).href);
  return mod.default;
}

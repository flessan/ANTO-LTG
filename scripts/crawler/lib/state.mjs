// Crawl state: remembers per-target outcomes so a later run can retry only failures
// (--retry-failed) or skip unchanged targets (--incremental).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const STATE_SCHEMA = 'anto-ltg.crawl-state/1';

export async function loadState(dir) {
  try {
    const doc = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
    if (doc.schema === STATE_SCHEMA) return doc;
  } catch { /* first run */ }
  return { schema: STATE_SCHEMA, adapters: {} };
}

export function recordOutcome(state, adapter, { proposals = [], errors = [], unchanged = [], attempted = [] }, now) {
  const a = (state.adapters[adapter] ??= { targets: {} });
  a.last_run = now;
  for (const t of attempted) {
    const prev = a.targets[t] ?? {};
    const err = errors.find((e) => e.target === t);
    const prop = proposals.find((p) => p.target === t);
    if (err) a.targets[t] = { ...prev, status: 'failed', attempts: (prev.attempts ?? 0) + 1, last_attempt: now, error: { code: err.code, message: err.message, retryable: err.retryable !== false } };
    else if (prop) a.targets[t] = { status: 'ok', attempts: 0, last_attempt: now, last_success: now, version: typeof prop.record?.version === 'string' ? prop.record.version : prop.record?.version?.value ?? null, fingerprint: prop.meta?.fingerprint ?? null };
    else if (unchanged.includes(t)) a.targets[t] = { ...prev, status: 'ok', last_attempt: now };
  }
  return state;
}

export function failedTargets(state, adapter) {
  const targets = state.adapters[adapter]?.targets ?? {};
  return Object.entries(targets).filter(([, v]) => v.status === 'failed' && v.error?.retryable !== false).map(([k]) => k);
}

export async function saveState(dir, state) {
  await mkdir(dir, { recursive: true });
  const sorted = { ...state, adapters: Object.fromEntries(Object.entries(state.adapters).map(([k, v]) => [k, { ...v, targets: Object.fromEntries(Object.entries(v.targets).sort(([a], [b]) => (a < b ? -1 : 1))) }])) };
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(sorted, null, 2) + '\n');
}

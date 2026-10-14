// localStorage with guard rails: private-mode failures, quota errors and corrupt values never throw
// into the UI, and nothing but JSON-parseable, size-capped data is ever read back.
import { cleanName, ID_RE } from './bundle.js';
import { normalizeOs } from './model.js';

export const KEYS = { selection: 'anto-ltg:selection:v1', bundles: 'anto-ltg:bundles:v1', prefs: 'anto-ltg:prefs:v1', lang: 'anto-ltg:lang' };
const MAX_BUNDLES = 50;

export function createStorage(backend) {
  let store = backend ?? null;
  if (!store) { try { store = globalThis.localStorage ?? null; } catch { store = null; } }
  const read = (key, fallback) => {
    try { const raw = store?.getItem(key); if (raw === null || raw === undefined || raw.length > 400_000) return fallback; return JSON.parse(raw); } catch { return fallback; }
  };
  const write = (key, value) => { try { store.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
  const remove = (key) => { try { store.removeItem(key); return true; } catch { return false; } };
  return { read, write, remove, available: Boolean(store) };
}

const cleanIds = (ids) => (Array.isArray(ids) ? [...new Set(ids.filter((x) => typeof x === 'string' && ID_RE.test(x)))].slice(0, 500) : []);

export function loadSelection(storage) {
  const v = storage.read(KEYS.selection, null);
  return v && typeof v === 'object' ? { ids: cleanIds(v.ids), os: normalizeOs(v.os), method: v.method === 'download-kit' ? 'download-kit' : 'winget' } : { ids: [], os: 'windows11', method: 'winget' };
}
export const saveSelection = (storage, sel) => storage.write(KEYS.selection, { ids: cleanIds(sel.ids), os: sel.os, method: sel.method });

export function loadBundles(storage) {
  const v = storage.read(KEYS.bundles, {});
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [name, b] of Object.entries(v).slice(0, MAX_BUNDLES)) {
      if (!b || typeof b !== 'object') continue;
      const clean = cleanName(name, '');
      if (clean) out[clean] = { ids: cleanIds(b.ids), os: normalizeOs(b.os), method: b.method === 'download-kit' ? 'download-kit' : 'winget', saved_at: typeof b.saved_at === 'string' ? b.saved_at.slice(0, 30) : '' };
    }
  }
  return out;
}

export function saveBundle(storage, name, bundle, now = new Date().toISOString()) {
  const all = loadBundles(storage);
  const key = cleanName(name);
  if (!(key in all) && Object.keys(all).length >= MAX_BUNDLES) return { ok: false, reason: 'limit' };
  all[key] = { ids: cleanIds(bundle.ids), os: bundle.os, method: bundle.method, saved_at: now };
  return storage.write(KEYS.bundles, all) ? { ok: true, name: key } : { ok: false, reason: 'storage' };
}

export function deleteBundle(storage, name) {
  const all = loadBundles(storage);
  delete all[name];
  return storage.write(KEYS.bundles, all);
}

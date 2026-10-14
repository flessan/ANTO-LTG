// Portable bundle manifests, share codes and name hygiene.
//
// Importing a manifest or share code only restores a SELECTION of catalog ids. Install commands are
// always regenerated from the current catalog, so imported data can never inject a package id, a URL
// or a command. Unknown ids are reported and dropped, never invented.
import { sanitizeText } from './html.js';

export const MANIFEST_FORMAT = 'anto-ltg.bundle';
export const MANIFEST_VERSION = 1;
export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_APPS = 500;
export const MAX_MANIFEST_BYTES = 256 * 1024;
const OS = new Set(['windows11', 'windows10', 'windows81', 'windows8', 'windows7']);
const METHODS = new Set(['winget', 'download-kit']);

export function cleanName(value, fallback = 'My bundle') {
  const s = sanitizeText(value, 200).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || fallback;
}

export function createManifest({ name, apps, os = 'windows11', method = 'winget', options = {}, catalog = {}, now = new Date().toISOString() }) {
  return {
    format: MANIFEST_FORMAT,
    format_version: MANIFEST_VERSION,
    name: cleanName(name),
    created_at: now,
    target: { os: OS.has(os) ? os : 'windows11' },
    method: METHODS.has(method) ? method : 'winget',
    options: {
      accept_agreements: options.acceptAgreements !== false,
      silent: options.silent !== false,
      include_unknown_compatibility: options.includeUnknown !== false,
    },
    apps: apps.map((a) => ({ id: a.id, name: sanitizeText(a.name, 120), ...(a.winget_id ? { winget_id: a.winget_id } : {}) })),
    ...(catalog.schema_version ? { catalog: { schema_version: catalog.schema_version, app_count: catalog.app_count ?? 0 } } : {}),
  };
}

export function manifestToJson(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function parseManifest(input, { knownIds }) {
  const errors = []; const warnings = [];
  let doc = input;
  if (typeof input === 'string') {
    if (input.length > MAX_MANIFEST_BYTES) return { ok: false, errors: ['The file is too large to be a bundle manifest.'], warnings };
    try { doc = JSON.parse(input); } catch { return { ok: false, errors: ['The file is not valid JSON.'], warnings }; }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, errors: ['The manifest must be a JSON object.'], warnings };
  if (doc.format !== MANIFEST_FORMAT) errors.push(`This is not an ANTO-LTG bundle manifest (expected format "${MANIFEST_FORMAT}").`);
  if (doc.format_version !== MANIFEST_VERSION) errors.push(`Unsupported manifest version ${String(doc.format_version).slice(0, 20)}.`);
  if (!Array.isArray(doc.apps)) errors.push('The manifest has no "apps" list.');
  if (errors.length) return { ok: false, errors, warnings };
  if (doc.apps.length > MAX_APPS) return { ok: false, errors: [`A manifest may list at most ${MAX_APPS} apps.`], warnings };

  const ids = []; const unknownIds = []; const seen = new Set();
  for (const entry of doc.apps) {
    const id = entry && typeof entry === 'object' ? entry.id : null;
    if (typeof id !== 'string' || !ID_RE.test(id) || id.length > 80) { warnings.push('Skipped an entry with a missing or malformed id.'); continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    if (knownIds.has(id)) ids.push(id); else unknownIds.push(id);
  }
  if (unknownIds.length) warnings.push(`${unknownIds.length} app id(s) are not in the current catalog and were skipped: ${unknownIds.slice(0, 5).join(', ')}${unknownIds.length > 5 ? ', ...' : ''}.`);
  const o = doc.options && typeof doc.options === 'object' ? doc.options : {};
  return {
    ok: true, errors, warnings, unknownIds,
    manifest: {
      name: cleanName(doc.name, 'Imported bundle'),
      ids,
      os: OS.has(doc.target?.os) ? doc.target.os : 'windows11',
      method: METHODS.has(doc.method) ? doc.method : 'winget',
      options: {
        acceptAgreements: typeof o.accept_agreements === 'boolean' ? o.accept_agreements : true,
        silent: typeof o.silent === 'boolean' ? o.silent : true,
        includeUnknown: typeof o.include_unknown_compatibility === 'boolean' ? o.include_unknown_compatibility : true,
      },
    },
  };
}

// ---- share codes: "#b=apps=git,vscode&os=windows11&method=winget&name=My%20kit" ----------------------------
export function encodeShare({ ids, os = 'windows11', method = 'winget', name = '' }) {
  const p = new URLSearchParams();
  p.set('apps', ids.filter((id) => ID_RE.test(id)).join(','));
  p.set('os', OS.has(os) ? os : 'windows11');
  p.set('method', METHODS.has(method) ? method : 'winget');
  if (name) p.set('name', cleanName(name));
  return p.toString();
}

export function decodeShare(hash, { knownIds }) {
  const text = String(hash ?? '').replace(/^#/, '');
  if (text.length > 20_000) return null;
  const p = new URLSearchParams(text);
  const raw = p.get('apps');
  if (raw === null) return null;
  const ids = []; const unknownIds = [];
  for (const id of raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_APPS)) {
    if (!ID_RE.test(id)) continue;
    if (knownIds.has(id)) { if (!ids.includes(id)) ids.push(id); } else unknownIds.push(id);
  }
  return { ids, unknownIds, os: OS.has(p.get('os')) ? p.get('os') : 'windows11', method: METHODS.has(p.get('method')) ? p.get('method') : 'winget', name: p.get('name') ? cleanName(p.get('name')) : '' };
}

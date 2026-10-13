// Reading and writing catalogs in one canonical form so diffs stay small and reviewable:
// items sorted by id, keys in a fixed order, 2-space JSON, trailing newline.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CATALOGS = ['apps', 'drivers', 'tools', 'vendors', 'bundles', 'updates'];
export const SCHEMA_VERSION = '1.1.0';

const COMMON_REVIEW = ['verification_status', 'reviewed_at', 'review_notes', 'evidence_url'];
export const KEY_ORDER = {
  apps: ['id', 'name', 'publisher', 'category', 'description', 'description_id', 'source_url', 'source_kind', ...COMMON_REVIEW, 'windows_compatibility', 'compatibility', 'architectures', 'license', 'license_url', 'notes', 'notes_id', 'winget_id', 'version', 'release_date', 'installer_types', 'installer_scopes', 'elevation', 'portable', 'downloads', 'availability', 'tags', 'quality_flags', 'sources', 'added_at'],
  drivers: ['id', 'name', 'publisher', 'manufacturer', 'vendor_id', 'model', 'hardware_family', 'component', 'kind', 'description', 'description_id', 'source_url', 'source_kind', 'official_source', ...COMMON_REVIEW, 'windows_versions', 'os_support', 'architectures', 'version', 'release_date', 'file_size_text', 'file_size_bytes', 'hardware_ids', 'download', 'install_instructions', 'install_instructions_id', 'evidence', 'quality_flags', 'notes', 'notes_id', 'tags', 'sources', 'added_at'],
  tools: ['id', 'name', 'category', 'description', 'description_id', 'publisher', 'app_id', 'source_url', 'source_kind', ...COMMON_REVIEW, 'requires_admin', 'portable', 'bootable_media', 'use_cases', 'use_cases_id', 'cautions', 'cautions_id', 'downloads', 'notes', 'notes_id', 'tags', 'sources'],
  vendors: ['id', 'name', 'kind', 'homepage_url', 'support_url', 'driver_search_url', 'detection_tool', 'domains', 'pci_vendor_ids', 'usb_vendor_ids', 'requires', 'instructions', 'instructions_id', 'source_kind', ...COMMON_REVIEW, 'notes', 'notes_id', 'sources'],
  bundles: ['id', 'name', 'name_id', 'description', 'description_id', 'app_ids', 'status', 'target_windows', 'tags', 'notes', 'notes_id'],
  updates: ['id', 'title', 'description', 'path', 'published_at'],
};
const NESTED_ORDER = {
  download: ['kind', 'url', 'architecture', 'installer_type', 'scope', 'size_bytes', 'sha256', 'sha256_source', 'sha512', 'sha512_source', 'stability', 'requires', 'evidence', 'link_check'],
  source: ['id', 'kind', 'url', 'ref', 'retrieved_at', 'fields', 'note'],
  evidence: ['type', 'url', 'retrieved_at', 'note'],
  compatibility: ['windows10', 'windows11', 'min_os_version', 'basis', 'note'],
  official_source: ['url', 'vendor_id', 'type', 'stable'],
  link_check: ['status', 'checked_at', 'http_status', 'final_url', 'content_type', 'size_bytes', 'note'],
};
const SORTED_ARRAYS = new Set(['architectures', 'installer_types', 'installer_scopes', 'elevation', 'tags', 'quality_flags', 'windows_versions', 'hardware_ids', 'domains', 'requires', 'pci_vendor_ids', 'usb_vendor_ids']);

function orderKeys(obj, preferred) {
  const out = {};
  for (const k of preferred) if (k in obj && obj[k] !== undefined) out[k] = obj[k];
  for (const k of Object.keys(obj).sort()) if (!(k in out) && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function canonValue(key, value) {
  if (Array.isArray(value)) {
    const mapped = value.map((v) => canonValue(key, v));
    if (SORTED_ARRAYS.has(key)) return [...mapped].sort();
    return mapped;
  }
  if (value && typeof value === 'object') {
    const shape = key === 'downloads' || key === 'download' ? 'download' : key === 'sources' ? 'source' : key === 'evidence' ? 'evidence' : key;
    const preferred = NESTED_ORDER[shape] ?? [];
    const ordered = orderKeys(value, preferred);
    for (const k of Object.keys(ordered)) ordered[k] = canonValue(k, ordered[k]);
    return ordered;
  }
  return value;
}

export function canonicalizeItem(catalog, item) {
  const ordered = orderKeys(item, KEY_ORDER[catalog] ?? []);
  for (const k of Object.keys(ordered)) ordered[k] = canonValue(k, ordered[k]);
  return ordered;
}

export function canonicalizeDoc(catalog, doc) {
  const items = [...doc.items].map((i) => canonicalizeItem(catalog, i)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schema_version: doc.schema_version ?? SCHEMA_VERSION, updated_at: doc.updated_at ?? null, items };
}

export const serialize = (doc) => JSON.stringify(doc, null, 2) + '\n';

export async function readCatalog(root, name) {
  return JSON.parse(await readFile(path.join(root, 'catalogs', `${name}.json`), 'utf8'));
}

export async function writeCatalog(root, name, doc) {
  await writeFile(path.join(root, 'catalogs', `${name}.json`), serialize(canonicalizeDoc(name, doc)));
}

#!/usr/bin/env node
// One-off migration of the catalogs from schema 1.0.0 to 1.1.0 (kept as documentation of the change).
//
//  * schema_version -> 1.1.0 in every catalog
//  * apps: category values renamed to the controlled vocabulary; the original Indonesian
//    description/notes move to description_id/notes_id (English text is filled in by the crawler
//    merge); a "curated" source records where the original source_url came from
//
// Run it BEFORE `npm run crawl:merge`; it is not idempotent on purpose (it refuses to run twice).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATEGORY_MAP = {
  browser: 'browsers', 'file-utility': 'utilities', media: 'media', productivity: 'office', developer: 'developer-tools',
  'boot-media': 'boot-media', search: 'utilities', 'system-utility': 'system-tools', screenshot: 'media', network: 'network-remote',
  diagnostics: 'diagnostics', 'remote-support': 'network-remote', communication: 'communication',
  'storage-health': 'diagnostics', 'memory-test': 'diagnostics',
};
const SEED_DATE = '2026-10-12';

for (const name of ['apps', 'drivers', 'bundles', 'tools', 'updates']) {
  const file = path.join(root, 'catalogs', `${name}.json`);
  const doc = JSON.parse(await readFile(file, 'utf8'));
  if (doc.schema_version !== '1.0.0') { console.log(`${name}.json is already ${doc.schema_version}; skipped`); continue; }
  doc.schema_version = '1.1.0';
  if (name === 'apps' || name === 'tools') {
    for (const item of doc.items) {
      item.category = CATEGORY_MAP[item.category] ?? item.category;
      if (item.description) { item.description_id = item.description; delete item.description; }
      if (item.notes) { item.notes_id = item.notes; item.notes = ''; }
      item.sources = [{ id: 'anto-seed', kind: 'curated', url: item.source_url, retrieved_at: SEED_DATE, fields: ['source_url', 'category'], note: 'Initial seed entry added by the maintainers in the first catalog release.' }];
    }
  }
  await writeFile(file, JSON.stringify(doc, null, 2) + '\n');
  console.log(`${name}.json migrated (${doc.items.length} items)`);
}

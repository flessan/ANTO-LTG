#!/usr/bin/env node
// One-off migration of the catalogs from schema 1.1.0 to 1.2.0 (kept as documentation of the change).
//
//  * Human review and machine publication are separated. Every "pending_review" becomes
//    "not_reviewed" (no human has checked the record). Nothing is ever marked "verified" here.
//  * apps and drivers gain a `publication` object, computed by the automated rules in
//    scripts/lib/publication.mjs (the same rules the crawler and the validator use).
//  * Driver "aggregator" leads are removed from catalogs/drivers.json. They were derived from a
//    reconstructed fixture, not from a live crawl, and a third-party listing is a lead, never a
//    publishable record. They stay in catalogs/proposed/driver-listings.proposals.json, marked
//    unavailable, so the decision is visible.
//  * Every catalog and proposal file moves to schema_version 1.2.0.
//
// Run it once, then `npm run format:catalogs && npm run build`. It refuses to run on 1.2.0 files.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicationFor } from '../lib/publication.mjs';
import { isAggregatorHost } from '../lib/semantic.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATED_AT = '2026-10-13T00:00:00.000Z';
const NEW_VERSION = '1.2.0';
const read = async (f) => JSON.parse(await readFile(f, 'utf8'));
const write = (f, doc) => writeFile(f, JSON.stringify(doc, null, 2) + '\n');

const fixStatus = (item) => {
  if (item.verification_status === 'pending_review') item.verification_status = 'not_reviewed';
};

for (const name of ['apps', 'drivers', 'tools', 'vendors', 'bundles', 'updates']) {
  const file = path.join(root, 'catalogs', `${name}.json`);
  const doc = await read(file);
  if (doc.schema_version === NEW_VERSION) { console.log(`${name}.json is already ${NEW_VERSION}; skipped`); continue; }
  if (doc.schema_version !== '1.1.0') throw new Error(`${name}.json is ${doc.schema_version}; this migration starts from 1.1.0`);
  doc.schema_version = NEW_VERSION;
  let removed = 0;
  if (name === 'drivers') {
    const kept = [];
    for (const item of doc.items) {
      const aggregator = item.source_kind === 'third_party_aggregator' || isAggregatorHost(new URL(item.source_url).hostname);
      if (aggregator) { removed++; continue; }
      kept.push(item);
    }
    doc.items = kept;
  }
  for (const item of doc.items) {
    fixStatus(item);
    if (name === 'apps' || name === 'drivers') item.publication = publicationFor(name, item, { now: MIGRATED_AT });
  }
  await write(file, doc);
  console.log(`${name}.json migrated (${doc.items.length} items${removed ? `, ${removed} aggregator leads moved to proposals` : ''})`);
}

// Proposal files: statuses and publication, so `npm run validate` accepts them.
const dir = path.join(root, 'catalogs', 'proposed');
for (const f of (await readdir(dir)).filter((x) => x.endsWith('.proposals.json'))) {
  const file = path.join(dir, f);
  const doc = await read(file);
  if (doc.schema === 'anto-ltg.proposals/1' && doc.proposals.every((p) => p.record?.publication)) { console.log(`${f} is already migrated; skipped`); continue; }
  for (const p of doc.proposals) {
    fixStatus(p.record);
    const catalog = p.catalog ?? (p.key?.startsWith('listing:') ? 'drivers' : 'apps');
    p.catalog = catalog;
    p.record.publication = publicationFor(catalog, p.record, { now: MIGRATED_AT, method: 'automated' });
  }
  await write(file, doc);
  console.log(`${f} migrated (${doc.proposals.length} proposals)`);
}

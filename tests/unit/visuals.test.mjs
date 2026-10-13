// Visual map: every catalog record resolves to a local file, brand marks only go to their exact record, and the
// fallback chain (brand, component, category, bundled vector) is applied in that order.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVisuals, BUNDLED, VISUALS_SCHEMA } from '../../scripts/lib/visuals.mjs';
import { readJson } from '../helpers/repo.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalogs = Object.fromEntries(['apps', 'tools', 'drivers', 'vendors', 'bundles'].map((n) => [n, null]));
for (const n of Object.keys(catalogs)) catalogs[n] = await readJson('catalogs', `${n}.json`);
const manifest = await readJson('assets', 'manifest.json');
const visuals = buildVisuals({ catalogs, manifest });

describe('visual map', () => {
  it('uses the versioned schema name and resolves every catalog record', () => {
    assert.equal(visuals.schema, VISUALS_SCHEMA);
    for (const [group, name] of [['apps', 'apps'], ['tools', 'tools'], ['drivers', 'drivers'], ['vendors', 'vendors'], ['bundles', 'bundles']]) {
      for (const item of catalogs[name].items) assert.ok(visuals.items[group][item.id], `${group} ${item.id} has no visual`);
    }
  });

  it('points only at files that exist in assets/ (no third-party URLs)', async () => {
    const srcs = [];
    for (const group of Object.values(visuals.items)) for (const e of Object.values(group)) srcs.push(e.src);
    for (const v of Object.values(visuals.bundled)) srcs.push(v);
    for (const p of Object.values(visuals.photos)) for (const v of p.variants) srcs.push(v.src);
    for (const src of new Set(srcs)) {
      assert.match(src, /^assets\/(icons|img)\//, src);
      await access(path.join(root, src));
    }
  });

  it('uses a brand mark only for the record the manifest names exactly', () => {
    const brandTargets = new Set(manifest.assets.filter((a) => a.kind === 'brand-mark').flatMap((a) => a.targets.map((t) => `${t.type}:${t.id}`)));
    for (const [group, type] of [['apps', 'app'], ['tools', 'tool'], ['vendors', 'vendor']]) {
      for (const [id, e] of Object.entries(visuals.items[group])) {
        if (e.level === 'brand') assert.ok(brandTargets.has(`${type}:${id}`), `${group} ${id} shows a brand mark it is not targeted for`);
      }
    }
  });

  it('falls back in order: brand, then category or component, then a bundled vector', () => {
    for (const e of Object.values(visuals.items.apps)) {
      if (e.level === 'category') assert.ok(e.src.includes('/categories/'), e.src);
      if (e.level === 'bundled') assert.equal(e.src, BUNDLED.software);
    }
    for (const e of Object.values(visuals.items.drivers)) {
      assert.ok(['brand', 'component', 'bundled'].includes(e.level), e.level);
      if (e.level === 'component') assert.ok(e.src.includes('/hardware/component-'), e.src);
    }
  });

  it('gives each bundle a cover photo that exists in the photo map', () => {
    for (const [id, e] of Object.entries(visuals.items.bundles)) {
      assert.ok(e.photo && visuals.photos[e.photo], `bundle ${id} has no cover photo`);
      assert.ok(visuals.photos[e.photo].alt.length >= 15);
    }
  });

  it('lists the responsive photo variants with explicit dimensions', () => {
    for (const [id, p] of Object.entries(visuals.photos)) {
      assert.ok(p.variants.every((v) => v.width > 0 && v.height > 0), id);
      assert.ok(p.variants.some((v) => v.format === 'jpg'), `${id} has a JPEG fallback`);
    }
  });

  it('keeps the committed api/v1/visuals.json identical to what the build writes', async () => {
    const committed = await readJson('api', 'v1', 'visuals.json');
    assert.deepEqual(committed, JSON.parse(JSON.stringify(visuals)));
    assert.ok(existsSync(path.join(root, 'api', 'v1', 'visuals.json')));
  });
});

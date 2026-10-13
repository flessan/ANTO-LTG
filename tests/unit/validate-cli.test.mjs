// End-to-end: run the real `node scripts/build.mjs --validate` on throw-away copies of the repository, each
// broken in exactly one way. CI relies on this command, so it has to fail for the right reasons.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, runBuild } from '../helpers/sandbox.mjs';
import { root } from '../helpers/repo.mjs';

async function expectFailure(name, mutate, { step, message }) {
  const sb = await makeSandbox();
  try {
    await mutate(sb);
    const r = sb.validate();
    assert.equal(r.code, 1, `${name}: expected exit code 1\n${r.out.slice(-600)}`);
    assert.match(r.out, new RegExp(`FAIL\\s+${step}`), `${name}: expected the "${step}" check to fail\n${r.out.slice(-900)}`);
    if (message) assert.match(r.out, message, `${name}: expected the explanation to mention ${message}`);
    const failed = r.out.split('\n').filter((l) => l.startsWith('FAIL')).length;
    assert.ok(failed >= 1);
  } finally { await sb.destroy(); }
}

describe('npm run validate', () => {
  it('passes on the repository as it is', () => {
    const r = runBuild(root, ['--validate']);
    assert.equal(r.code, 0, r.out.slice(-1200));
    assert.match(r.out, /ANTO-LTG validate succeeded: \d+ apps, \d+ drivers, \d+ vendors, \d+ tools, \d+ bundles \(\d+ pending review, \d+ verified\)/);
    assert.doesNotMatch(r.out, /FAIL/);
  });

  it('does not write anything (validate is read-only)', async () => {
    const sb = await makeSandbox();
    try {
      const before = await sb.read('api', 'v1', 'apps.json');
      const r = sb.validate();
      assert.equal(r.code, 0, r.out.slice(-600));
      assert.equal(await sb.read('api', 'v1', 'apps.json'), before);
    } finally { await sb.destroy(); }
  });

  const failures = [
    ['a schema violation (unknown property on a record)', (sb) => sb.editJson(['catalogs', 'apps.json'], (d) => { d.items[0].surprise = true; }), { step: 'Catalogs match their schemas', message: /surprise/ }],
    ['a record marked verified without review evidence', (sb) => sb.editJson(['catalogs', 'tools.json'], (d) => { d.items[0].verification_status = 'verified'; }), { step: 'Catalogs match their schemas', message: /reviewed_at|review_notes|evidence_url/ }],
    ['an http URL', (sb) => sb.editJson(['catalogs', 'vendors.json'], (d) => { d.items[0].homepage_url = 'http://example.com/'; }), { step: 'Catalogs match their schemas' }],
    ['catalog items that are not in canonical order', (sb) => sb.editJson(['catalogs', 'tools.json'], (d) => { d.items.reverse(); }), { step: 'Catalogs are in canonical form', message: /tools\.json is not canonical/ }],
    ['a bundle that references an app that does not exist', (sb) => sb.editJson(['catalogs', 'bundles.json'], (d) => { d.items[0].app_ids.push('no-such-app'); }), { step: 'Cross-file and policy rules', message: /unknown app id "no-such-app"/ }],
    ['an aggregator-sourced driver that carries a download link', (sb) => sb.editJson(['catalogs', 'drivers.json'], (d) => { const lead = d.items.find((x) => x.source_kind === 'third_party_aggregator'); lead.download = { kind: 'landing_page', url: 'https://www.driverscape.com/files/driver.exe' }; }), { step: 'Cross-file and policy rules', message: /must not carry a download URL/ }],
    ['a stale generated API file', (sb) => sb.edit(['api', 'v1', 'apps.json'], (t) => `${t} `), { step: 'Generated files are up to date', message: /api\/v1\/apps\.json is out of date/ }],
    ['a missing generated search index', async (sb) => { const { rm } = await import('node:fs/promises'); await rm(sb.file('api', 'v1', 'search-index.json')); }, { step: 'Generated files are up to date', message: /search-index\.json is missing/ }],
    ['a stale openapi.json', (sb) => sb.edit(['openapi.json'], (t) => t.replace('3.1.0', '3.0.0')), { step: 'Generated files are up to date', message: /openapi\.json is out of date/ }],
    ['stale shared page chrome', (sb) => sb.edit(['drivers', 'index.html'], (h) => h.replace('class="taskbar"', 'class="taskbar changed"')), { step: 'Shared page chrome is up to date', message: /chrome blocks are stale/ }],
    ['an inline script in a page', (sb) => sb.edit(['guides', 'index.html'], (h) => h.replace('</body>', '<script>alert(1)</script></body>')), { step: 'HTML structure', message: /inline <script>/ }],
    ['a modified vendored stylesheet', (sb) => sb.edit(['assets', 'vendor', '7.css', '7.css'], (c) => `${c}\n`), { step: 'Image provenance manifest', message: /modified/ }],
    ['an image with no provenance entry', (sb) => sb.write(['assets', 'img', 'random-wallpaper.jpg'], 'x'), { step: 'Image provenance manifest', message: /not listed in assets\/manifest\.json/ }],
    ['a crawler proposal that tries to promote itself to verified', async (sb) => {
      await sb.editJson(['catalogs', 'proposed', 'driver-listings.proposals.json'], (d) => {
        d.proposals[0].record.verification_status = 'verified';
        d.proposals[0].record.reviewed_at = '2026-10-13T00:00:00.000Z';
        d.proposals[0].record.review_notes = 'the crawler says so';
        d.proposals[0].record.evidence_url = 'https://example.com/';
      });
    }, { step: 'Crawler proposals match their schema', message: /never promote|pending_review/ }],
  ];
  for (const [name, mutate, expect] of failures) it(`fails on ${name}`, () => expectFailure(name, mutate, expect));

  it('the build command regenerates exactly what validate checks (build then validate is clean)', async () => {
    const sb = await makeSandbox();
    try {
      await sb.edit(['api', 'v1', 'apps.json'], (t) => `${t} `);
      assert.equal(sb.validate().code, 1);
      const built = runBuild(sb.dir, ['--build']);
      assert.equal(built.code, 0, built.out.slice(-600));
      assert.equal(sb.validate().code, 0, 'validate passes once the build has regenerated the API files');
      assert.match(built.out, /SITE_URL is not set; sitemap\.xml, robots\.txt and feed\.xml were not generated/);
    } finally { await sb.destroy(); }
  });
});

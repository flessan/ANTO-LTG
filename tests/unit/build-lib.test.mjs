// Build libraries: HTML lint, shared page chrome, asset provenance checks and SEO files. Each rule is
// proven both ways: the real site passes, and a deliberately broken copy is rejected.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lintPages } from '../../scripts/lib/html-lint.mjs';
import { PAGES, renderBlocks, applyBlocks, syncPages } from '../../scripts/lib/chrome.mjs';
import { checkAssets } from '../../scripts/lib/assets-check.mjs';
import { writeSeo } from '../../scripts/lib/seo.mjs';
import { renderCredits } from '../../scripts/assets/credits.mjs';
import { root, readJson } from '../helpers/repo.mjs';
import { makeSandbox } from '../helpers/sandbox.mjs';

const lintPage = ['guides', 'index.html'];
const lintOriginal = await readFile(path.join(root, ...lintPage), 'utf8');

describe('HTML lint', () => {
  it('the real site has no problems', async () => assert.deepEqual(await lintPages(root), []));

  let sb;
  before(async () => { sb = await makeSandbox(); });
  after(async () => { await sb.destroy(); });
  const page = lintPage;
  const original = lintOriginal;
  const restore = () => writeFile(sb.file(...page), original);

  const cases = [
    ['a missing lang attribute', (h) => h.replace(/<html lang="en">/, '<html>'), /needs a lang attribute/],
    ['an empty title', (h) => h.replace(/<title>[^<]*<\/title>/, '<title></title>'), /missing or empty <title>/],
    ['a missing meta description', (h) => h.replace(/<meta name="description"[^>]*>/, ''), /missing meta description/],
    ['two h1 elements', (h) => h.replace('</main>', '<h1>Second</h1></main>'), /expected exactly one <h1>, found 2/],
    ['no main landmark', (h) => h.replace(/<main id="main"/, '<main'), /missing <main id="main"> landmark/],
    ['an inline event handler', (h) => h.replace('<main id="main"', '<main onclick="steal()" id="main"'), /inline event handler/],
    ['an inline style attribute', (h) => h.replace('<main id="main"', '<main style="color:red" id="main"'), /inline style attribute/],
    ['a <style> element', (h) => h.replace('</head>', '<style>body{color:red}</style></head>'), /<style> element/],
    ['an inline script', (h) => h.replace('</head>', '<script>alert(1)</script></head>'), /inline <script>/],
    ['a javascript: link', (h) => h.replace('</main>', '<a href="javascript:alert(1)">x</a></main>'), /javascript: URL/],
    ['an image without alt', (h) => h.replace('</main>', '<img src="../assets/img/sky-meadow-horizon-640.jpg" width="1" height="1"></main>'), /<img> without alt/],
    ['an image without dimensions', (h) => h.replace('</main>', '<img src="../assets/img/sky-meadow-horizon-640.jpg" alt="x"></main>'), /<img> without width and height/],
    ['a new-tab link without noopener', (h) => h.replace('</main>', '<a href="https://example.com/" target="_blank">x</a></main>'), /without rel="noopener noreferrer"/],
    ['a duplicate id', (h) => h.replace('</main>', '<p id="main">x</p></main>'), /duplicate id\(s\): main/],
    ['a broken internal link', (h) => h.replace('</main>', '<a href="../nope/missing.html">x</a></main>'), /broken internal reference "..\/nope\/missing.html"/],
    ['a broken asset reference', (h) => h.replace('</head>', '<link rel="stylesheet" href="../assets/css/missing.css"></head>'), /broken internal reference/],
  ];
  for (const [name, mutate, expected] of cases) {
    it(`rejects ${name}`, async () => {
      await writeFile(sb.file(...page), mutate(original));
      try {
        const problems = await lintPages(sb.dir);
        assert.ok(problems.some((p) => expected.test(p)), `expected ${expected}; got ${JSON.stringify(problems)}`);
      } finally { await restore(); }
    });
  }
  it('reports a missing page', async () => {
    await rm(sb.file('tools', 'index.html'));
    try { assert.ok((await lintPages(sb.dir)).some((p) => /tools\/index\.html: missing/.test(p))); } finally { await writeFile(sb.file('tools', 'index.html'), await readFile(path.join(root, 'tools', 'index.html'), 'utf8')); }
  });
});

describe('shared page chrome', () => {
  const templates = path.join(root, 'scripts', 'templates');
  it('the real pages are up to date', async () => assert.deepEqual(await syncPages(root, { write: false }), { stale: [], problems: [] }));

  it('renders root-relative links for nested pages and marks the current page', async () => {
    const home = await renderBlocks(templates, PAGES.find((p) => p.key === 'home'));
    const drivers = await renderBlocks(templates, PAGES.find((p) => p.key === 'drivers'));
    assert.match(home.header, /href="software\/"/);
    assert.match(drivers.header, /href="\.\.\/software\/"/);
    assert.match(drivers.header, /href="\.\.\/assets\/icons\/sprite\.svg#chip"/);
    assert.match(drivers.header, /<a href="\.\.\/drivers\/" aria-current="page">/);
    assert.equal((drivers.header.match(/aria-current="page"/g) ?? []).length, 1);
    assert.doesNotMatch(home.header, /aria-current/, 'the home page highlights no nav item');
  });
  it('the head block carries the strict CSP and loads only local assets', async () => {
    const { head } = await renderBlocks(templates, PAGES[0]);
    assert.match(head, /Content-Security-Policy/);
    assert.doesNotMatch(head, /https?:\/\/(?!github\.com)/, 'no remote origins in the head');
    assert.match(head, /assets\/vendor\/7\.css\/7\.css/);
  });
  it('every external link in the shared chrome opens safely', async () => {
    for (const page of PAGES) {
      const { header, footer } = await renderBlocks(templates, page);
      for (const m of `${header}${footer}`.matchAll(/<a\b[^>]*>/g)) if (/target="_blank"/.test(m[0])) assert.match(m[0], /rel="noopener noreferrer"/, m[0]);
    }
  });
  it('applyBlocks swaps only the marked regions and is idempotent', () => {
    const html = '<head><!--chrome:head:start-->OLD<!--chrome:head:end--></head><body><!--chrome:header:start-->OLD<!--chrome:header:end-->MAIN<!--chrome:footer:start-->OLD<!--chrome:footer:end--></body>';
    const once = applyBlocks(html, { head: 'H', header: 'N', footer: 'F' });
    assert.equal(once, '<head><!--chrome:head:start-->\nH\n<!--chrome:head:end--></head><body><!--chrome:header:start-->\nN\n<!--chrome:header:end-->MAIN<!--chrome:footer:start-->\nF\n<!--chrome:footer:end--></body>');
    assert.equal(applyBlocks(once, { head: 'H', header: 'N', footer: 'F' }), once);
  });
  it('applyBlocks refuses a page whose markers are missing or reversed', () => {
    assert.throws(() => applyBlocks('<p>no markers</p>', { head: 'H', header: 'N', footer: 'F' }), /missing/);
    assert.throws(() => applyBlocks('<!--chrome:head:end--><!--chrome:head:start-->', { head: 'H', header: 'N', footer: 'F' }), /missing/);
  });
  it('syncPages detects stale chrome and repairs it when asked to write', async () => {
    const sb = await makeSandbox();
    try {
      await sb.edit(['software', 'index.html'], (h) => h.replace('<header class="taskbar">', '<header class="taskbar tampered">'));
      assert.deepEqual((await syncPages(sb.dir, { write: false })).stale, ['software/index.html']);
      assert.deepEqual((await syncPages(sb.dir, { write: true })).stale, ['software/index.html']);
      assert.deepEqual(await syncPages(sb.dir, { write: false }), { stale: [], problems: [] });
      await sb.edit(['guides', 'index.html'], (h) => h.replace('<!--chrome:footer:start-->', ''));
      assert.match((await syncPages(sb.dir, { write: false })).problems.join(), /guides\/index\.html: missing/);
    } finally { await sb.destroy(); }
  });
});

describe('asset provenance checks', () => {
  it('the real manifest, credits and vendored 7.css pass', async () => assert.deepEqual(await checkAssets(root), []));

  const cases = [
    ['an image whose bytes changed', async (sb, m) => { const f = m.assets[0].files[0].path; await sb.write(f.split('/'), Buffer.from('tampered')); }, /SHA-256 differs|size .* differs/],
    ['an image that is listed but missing', async (sb, m) => { const { rm: remove } = await import('node:fs/promises'); await remove(sb.file(...m.assets[0].files[0].path.split('/'))); }, /listed in the manifest but missing/],
    ['an image with no provenance', async (sb) => { await sb.write(['assets', 'img', 'stolen-wallpaper.jpg'], 'x'); }, /not listed in assets\/manifest\.json/],
    ['a manifest entry without a license', async (sb) => { await sb.editJson(['assets', 'manifest.json'], (d) => { delete d.assets[0].license; }); }, /missing license/],
    ['a manifest entry with an http source', async (sb) => { await sb.editJson(['assets', 'manifest.json'], (d) => { d.assets[0].source_url = 'http://example.com/photo'; }); }, /source_url and license_url must be https/],
    ['alt text that says nothing', async (sb) => { await sb.editJson(['assets', 'manifest.json'], (d) => { d.assets[0].alt = 'photo'; }); }, /alt text is too short/],
    ['credits that no longer match the manifest', async (sb) => { await sb.write(['assets', 'CREDITS.md'], '# stale'); }, /CREDITS\.md is out of date/],
    ['a modified vendored 7.css', async (sb) => { await sb.edit(['assets', 'vendor', '7.css', '7.css'], (c) => `${c}\n/* local hack */`); }, /modified \(SHA-256 differs from VENDOR\.json\)/],
    ['a vendored file that went missing', async (sb) => { const { rm: remove } = await import('node:fs/promises'); await remove(sb.file('assets', 'vendor', '7.css', 'LICENSE')); }, /LICENSE: missing/],
    ['a vendor license that is not recorded', async (sb) => { await sb.editJson(['assets', 'vendor', '7.css', 'VENDOR.json'], (d) => { d.license = 'unknown'; }); }, /license must be recorded as MIT/],
  ];
  for (const [name, mutate, expected] of cases) {
    it(`rejects ${name}`, async () => {
      const sb = await makeSandbox();
      try {
        const manifest = await readJson('assets', 'manifest.json');
        await mutate(sb, manifest);
        const problems = await checkAssets(sb.dir);
        assert.ok(problems.some((p) => expected.test(p)), `expected ${expected}; got ${JSON.stringify(problems.slice(0, 4))}`);
      } finally { await sb.destroy(); }
    });
  }

  it('every photo credits its author, source and license with real alt text', async () => {
    const manifest = await readJson('assets', 'manifest.json');
    assert.ok(manifest.assets.length >= 5);
    for (const a of manifest.assets) {
      assert.match(a.source_url, /^https:\/\/(unsplash|www\.pexels|images\.pexels)\.com\//, a.id);
      assert.match(a.license_url, /^https:\/\//);
      assert.ok(a.author.length > 2 && a.alt.length >= 30, a.id);
      const exts = new Set(a.files.map((f) => f.path.split('.').pop()));
      assert.ok(exts.has('jpg') && exts.has('webp'), `${a.id} ships a WebP and a JPEG fallback`);
      if (a.id !== 'wing-sky') assert.ok(a.files.length >= 6, `${a.id} ships responsive sizes (the wing accent is a small 500px licensed preview by design)`);
    }
    const credits = await readFile(path.join(root, 'assets', 'CREDITS.md'), 'utf8');
    assert.equal(credits, renderCredits(manifest));
    for (const a of manifest.assets) assert.ok(credits.includes(a.author), a.id);
  });
});

describe('SEO files', () => {
  // A minimal well-formedness check: balanced tags and no stray "&" or "<" in text.
  function wellFormed(xmlText) {
    const body = xmlText.replace(/<\?xml[^>]*\?>/, '');
    const stack = [];
    let i = 0;
    while (i < body.length) {
      const lt = body.indexOf('<', i);
      const text = body.slice(i, lt === -1 ? body.length : lt);
      assert.doesNotMatch(text, /&(?!(amp|lt|gt|quot|apos);)/, `unescaped & in text: ${text.slice(0, 60)}`);
      if (lt === -1) break;
      const gt = body.indexOf('>', lt);
      assert.ok(gt > lt, 'unterminated tag');
      const tag = body.slice(lt + 1, gt);
      if (tag.startsWith('/')) assert.equal(stack.pop(), tag.slice(1).trim(), `mismatched </${tag.slice(1)}>`);
      else if (!tag.endsWith('/') && !tag.startsWith('!')) stack.push(tag.split(/\s/)[0]);
      i = gt + 1;
    }
    assert.deepEqual(stack, [], 'unclosed tags');
  }

  it('writes a sitemap, robots.txt and feed that are well formed, with hostile text escaped', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'anto-ltg-seo-'));
    try {
      const updates = { items: [{ id: 'a', title: 'Fish & <script>alert(1)</script> "chips"', description: "It's <b>fine</b> & more", path: '/software/', published_at: '2026-10-13T00:00:00.000Z' }] };
      const out = await writeSeo(dir, 'https://example.org/some/path', updates);
      assert.equal(out.base, 'https://example.org');
      const [sitemap, robots, feed] = await Promise.all(['sitemap.xml', 'robots.txt', 'feed.xml'].map((f) => readFile(path.join(dir, f), 'utf8')));
      wellFormed(sitemap); wellFormed(feed);
      assert.equal((sitemap.match(/<loc>/g) ?? []).length, PAGES.length);
      assert.match(sitemap, /<loc>https:\/\/example\.org\/software\/<\/loc>/);
      assert.match(robots, /^User-agent: \*\nAllow: \/\nSitemap: https:\/\/example\.org\/sitemap\.xml\n$/);
      assert.doesNotMatch(feed, /<script>|<b>/);
      assert.match(feed, /Fish &amp; &lt;script&gt;/);
      assert.match(feed, /Mon|Tue|Wed|Thu|Fri|Sat|Sun/, 'RFC 822 date');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('refuses a SITE_URL that is not HTTPS or not a URL', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'anto-ltg-seo-'));
    try {
      for (const bad of ['http://example.org', 'example.org', 'javascript:alert(1)', '']) assert.match((await writeSeo(dir, bad, { items: [] })).error, /Invalid SITE_URL/, bad);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('the generated SEO files are not committed (they depend on SITE_URL)', async () => {
    const ignore = await readFile(path.join(root, '.gitignore'), 'utf8');
    for (const f of ['/sitemap.xml', '/robots.txt', '/feed.xml']) assert.ok(ignore.includes(f), f);
  });
});

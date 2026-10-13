// Headless-browser smoke and behaviour tests. They drive the real pages through the real static server.
// Nothing is mocked except where a test deliberately serves a hostile catalog to prove sanitisation.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from '../../scripts/serve.mjs';
import { findBrowser } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'tests', 'e2e', 'screenshots');
const PAGES = ['/', '/software/', '/drivers/', '/bundles/', '/tools/', '/guides/', '/developers/'];
const found = await findBrowser();
const skip = !found && process.env.E2E_REQUIRED !== '1' ? 'no Chrome/Chromium found (set CHROME_PATH or E2E_REQUIRED=1)' : false;
if (!found && !skip) throw new Error('E2E_REQUIRED=1 but no browser was found; set CHROME_PATH');

let server; let browser; let base; let page; let problems;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const contexts = new Set();
// Every page lives in its own incognito context so localStorage never leaks between tests.
async function newPage(viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.createBrowserContext();
  contexts.add(ctx);
  const p = await ctx.newPage();
  p.once('close', () => { contexts.delete(ctx); ctx.close().catch(() => {}); });
  await p.setViewport(viewport);
  await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const list = [];
  p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) list.push(`console.${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => list.push(`pageerror: ${e.message}`));
  p.on('requestfailed', (r) => list.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  p.on('response', (r) => { if (r.status() >= 400) list.push(`http ${r.status()}: ${r.url()}`); });
  await p.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    const blobs = []; window.__blobs = blobs;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { blobs.push(b); return orig(b); };
  });
  return { p, list };
}
const go = async (p, url) => { await p.goto(base + url, { waitUntil: 'networkidle0' }); await p.waitForSelector('html[data-ready="true"]'); };
const text = (sel) => page.$eval(sel, (e) => e.textContent.trim());
const count = (sel) => page.$$eval(sel, (els) => els.length);
async function setValue(sel, value) { await page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, value); await sleep(350); }
async function waitResults(sel) { await page.waitForFunction((s) => document.querySelector(s)?.getAttribute('aria-busy') === 'false', {}, sel); }

describe('browser smoke tests', { skip }, () => {
  before(async () => {
    await mkdir(shots, { recursive: true });
    server = createServer(root);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ executablePath: found.executablePath, args: found.args, headless: 'shell' });
  });
  after(async () => { await browser?.close(); await new Promise((r) => server?.close(r)); });
  beforeEach(async () => { ({ p: page, list: problems } = await newPage()); });
  afterEach(async () => { await page.close(); for (const c of [...contexts]) { contexts.delete(c); await c.close().catch(() => {}); } });

  it('every page loads without console errors, CSP violations, failed requests or layout overflow', async () => {
    for (const url of PAGES) {
      const { p, list } = await newPage();
      await go(p, url); await sleep(500);
      assert.deepEqual(list, [], `${url}: ${list.join(' | ')}`);
      assert.deepEqual(await p.evaluate(() => window.__csp), [], `${url}: CSP violations`);
      assert.equal(await p.$$eval('h1', (e) => e.filter((x) => x.offsetParent !== null).length), 1, `${url}: exactly one visible h1`);
      assert.ok(await p.$('main#main'), `${url}: main landmark`);
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${url}: horizontal overflow`);
      const broken = await p.$$eval('img', (imgs) => imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src));
      assert.deepEqual(broken, [], `${url}: images failed to decode`);
      await p.screenshot({ path: path.join(shots, `${url.replace(/\W+/g, '_') || 'home'}.png`) });
      await p.close();
    }
  });

  it('keeps a strict CSP: injected inline script does not run and is reported', async () => {
    await go(page, '/');
    await page.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.append(s); });
    await sleep(200);
    assert.equal(await page.evaluate(() => window.__inline), undefined);
    assert.ok((await page.evaluate(() => window.__csp)).some((v) => v.startsWith('script-src')));
    assert.match(await page.$eval('meta[http-equiv="Content-Security-Policy"]', (m) => m.content), /default-src 'none'/);
  });

  it('a hostile catalog is rendered as text only (no markup, no javascript: links, no handlers)', async () => {
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      if (!req.url().endsWith('/api/v1/apps.json')) return req.continue();
      const doc = await (await fetch(req.url())).json();
      const evil = doc.items.find((a) => a.id === 'git');
      evil.name = '<img src=x onerror="window.__xss=1">Evil';
      evil.description = '<script>window.__xss=2</script>Plain <b>text</b>';
      evil.source_url = 'https://example.com/ok';
      evil.license_url = 'javascript:window.__xss=3';
      evil.downloads = [{ kind: 'direct_binary', url: 'javascript:window.__xss=4', sha256: null, evidence: 'x' }];
      evil.sources = [{ id: 'x', kind: 'vendor_page', url: 'data:text/html,<script>window.__xss=5</script>', retrieved_at: '2026-10-13', fields: ['name'] }];
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) });
    });
    await go(page, '/software/'); await waitResults('#sw-results');
    await setValue('#sw-q', 'git');
    await page.waitForSelector('[data-info="git"]');
    await page.$eval('[data-info="git"]', (b) => b.click()); await sleep(300);
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'no injected code ran');
    assert.equal(await count('img[src="x"]'), 0, 'no injected <img>');
    assert.equal(await page.$$eval('a[href^="javascript:"], a[href^="data:"]', (a) => a.length), 0, 'no dangerous hrefs rendered');
    assert.match(await text('dialog[open] h2'), /<img src=x/, 'the markup is shown as literal text');
  });

  it('software: search, facets and "unknown never matches" filters', async () => {
    await go(page, '/software/'); await waitResults('#sw-results');
    assert.ok((await count('.qp-item')) > 250, 'full catalog rendered');
    await setValue('#sw-q', 'firefox');
    assert.ok((await page.$$eval('.qp-name', (e) => e.map((x) => x.textContent))).some((n) => /Mozilla Firefox/.test(n)));
    await setValue('#sw-q', 'Git.Git');
    assert.ok((await page.$$eval('.qp-name', (e) => e.map((x) => x.textContent))).includes('Git'), 'search by WinGet package id');
    await setValue('#sw-q', '');
    await setValue('#sw-method', 'unavailable');
    const names = await page.$$eval('.qp-name', (e) => e.map((x) => x.textContent));
    assert.deepEqual(names.sort(), ['Adobe Flash Player', 'Microsoft Security Essentials']);
    assert.equal(await page.$$eval('.qp-item input:disabled', (e) => e.length), 2, 'unavailable apps cannot be selected');
    await setValue('#sw-method', ''); await setValue('#sw-arch', 'x64');
    const archNames = await page.$$eval('.qp-name', (e) => e.map((x) => x.textContent));
    assert.ok(!archNames.includes('Microsoft Security Essentials'), 'an app with unknown architecture must not match an active architecture filter');
  });

  it('software: selection survives filtering and reloads, and bulk select works', async () => {
    await go(page, '/software/'); await waitResults('#sw-results');
    await page.click('#qp-git'); await page.click('#qp-visual-studio-code');
    assert.equal(await text('#in-count'), '2');
    await setValue('#sw-cat', 'browsers');
    assert.equal(await text('#in-count'), '2', 'selection is independent of filters');
    await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('html[data-ready="true"]'); await waitResults('#sw-results');
    assert.equal(await text('#in-count'), '2', 'selection is restored from localStorage');
    await setValue('#sw-cat', 'browsers');
    await page.click('#sw-select-visible'); await sleep(200);
    const afterAll = Number(await text('#in-count'));
    assert.ok(afterAll > 10, `select all visible added the browsers (${afterAll})`);
    await page.click('#sw-deselect-visible'); await sleep(200);
    assert.equal(await text('#in-count'), '2', 'deselect visible leaves the other selections');
  });

  it('software: plan, manual steps and the generated script are safe and honest', async () => {
    await go(page, '/software/'); await waitResults('#sw-results');
    await page.click('#qp-git'); await page.click('#qp-memtest86');
    await page.waitForSelector('#in-script');
    const script = await text('#in-script');
    assert.match(script, /winget\.exe/); assert.match(script, /-cne 'YES'/); assert.match(script, /'Git\.Git'/);
    assert.doesNotMatch(script, /-ExecutionPolicy\s+Bypass/i);
    const packagesBlock = script.match(/\$Packages = @\(([\s\S]*?)\n\)/)?.[1] ?? '';
    const manualBlock = script.match(/\$ManualSteps = @\(([\s\S]*?)\n\)/)?.[1] ?? '';
    assert.match(packagesBlock, /Git\.Git/); assert.doesNotMatch(packagesBlock, /MemTest86/i, 'no WinGet package => not in the install list');
    assert.match(manualBlock, /MemTest86/i, 'it is listed as a manual step instead');
    assert.match(await text('#in-notices'), /manual step/i);
    await setValue('#in-name', "Bob's kit'; Remove-Item C:\\ -Recurse #");
    const script2 = await text('#in-script');
    const carriers = script2.split('\n').filter((l) => /Remove-Item/.test(l));
    assert.ok(carriers.length >= 1 && carriers.every((l) => l.startsWith('# ')), 'user text may appear only inside a single comment line, never as code');
    // the download is a Blob created by the page; read it back instead of touching the file system
    await page.click('#in-download'); await sleep(300);
    const { head, blobText } = await page.evaluate(async () => {
      const blob = window.__blobs.at(-1);
      return { head: [...new Uint8Array(await blob.slice(0, 3).arrayBuffer())], blobText: await blob.text() }; // text() drops the BOM, so read the bytes too
    });
    assert.deepEqual(head, [0xef, 0xbb, 0xbf], 'downloaded script starts with a UTF-8 BOM so Windows PowerShell 5.1 reads it correctly');
    assert.ok(blobText.startsWith('#Requires'), 'and then the #Requires line');
    assert.match(blobText, /Read-Host/);
    await page.select('#in-method', 'download-kit'); await sleep(250);
    const kit = await text('#in-script');
    assert.match(kit, /Get-FileHash/); assert.doesNotMatch(kit, /Start-Process|Invoke-Expression|\biex\b/i, 'the download kit never runs a file');
  });

  it('software: share links and imports restore only known ids and sanitise names', async () => {
    const hostile = `${'#apps=git,mozilla-firefox,evil%27%3B%20Remove-Item%20C%3A%5C'}&os=windows10&method=winget&name=${encodeURIComponent('<img src=x onerror=alert(1)>Kit')}`;
    await go(page, `/software/${hostile}`); await waitResults('#sw-results');
    await page.waitForSelector('dialog[open]');
    assert.match(await text('dialog[open] .window-body'), /2 apps/);
    await page.$$eval('dialog[open] button', (bs) => bs.find((b) => /Load/.test(b.textContent)).click()); await sleep(400);
    assert.equal(await text('#in-count'), '2');
    assert.equal(await page.$eval('#in-name', (e) => e.value), 'img src=x onerror=alert(1)Kit', 'angle brackets are stripped from names');
    assert.equal(await page.$eval('#in-os', (e) => e.value), 'windows10');
    assert.doesNotMatch(await text('#in-script'), /Remove-Item/);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
  });

  it('software: details dialog shows provenance, closes with Escape; clear asks for confirmation', async () => {
    await go(page, '/software/'); await waitResults('#sw-results');
    await page.$eval('[data-info="mozilla-firefox"]', (b) => b.click());
    await page.waitForSelector('dialog[open]');
    const body = await text('dialog[open] .window-body');
    assert.match(body, /winget install --id Mozilla\.Firefox --exact --source winget/); assert.match(body, /winget-pkgs/); assert.match(body, /Published automatically|automated|publication/i);
    assert.match(body, /[a-f0-9]{64}/, 'SHA-256 published in the manifest is shown');
    await page.keyboard.press('Escape'); await sleep(200);
    assert.equal(await count('dialog[open]'), 0);
    await page.click('#qp-git');
    await page.click('#in-clear'); await page.waitForSelector('dialog[open]');
    await page.$$eval('dialog[open] button', (bs) => bs.find((b) => /Cancel/.test(b.textContent)).click()); await sleep(250);
    assert.equal(await text('#in-count'), '1', 'cancel keeps the selection');
    await page.click('#in-clear'); await page.waitForSelector('dialog[open]');
    await page.$$eval('dialog[open] button', (bs) => bs.find((b) => /Clear selection/.test(b.textContent)).click()); await sleep(250);
    assert.equal(await text('#in-count'), '0');
  });

  it('language switch changes the UI, <html lang> and persists', async () => {
    await go(page, '/software/');
    assert.equal(await page.$eval('html', (h) => h.lang), 'en');
    await page.click('.lang-switch [data-lang="id"]'); await sleep(250);
    assert.equal(await page.$eval('html', (h) => h.lang), 'id');
    assert.match(await text('#taskbar-nav a[aria-current="page"]'), /Perangkat lunak/);
    await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('html[data-ready="true"]');
    assert.equal(await page.$eval('html', (h) => h.lang), 'id', 'persisted');
    await page.click('.lang-switch [data-lang="en"]'); await sleep(200);
    assert.match(await text('#taskbar-nav a[aria-current="page"]'), /Software/);
  });

  it('title-bar controls work: minimize collapses, maximize gives focus mode, Escape restores', async () => {
    await go(page, '/software/');
    await page.click('#win-installer [data-win="minimize"]');
    assert.ok(await page.$eval('#win-installer', (w) => w.classList.contains('is-collapsed')));
    await page.click('#win-installer [data-win="minimize"]');
    await page.click('#win-installer [data-win="maximize"]');
    assert.ok(await page.$eval('#win-installer', (w) => w.classList.contains('is-focus')));
    assert.ok(await page.$eval('body', (b) => b.classList.contains('has-focus-window')));
    await page.keyboard.press('Escape'); await sleep(150);
    assert.ok(!(await page.$eval('#win-installer', (w) => w.classList.contains('is-focus'))));
  });

  it('drivers: official records, leads and direct links are labelled honestly', async () => {
    await go(page, '/drivers/'); await waitResults('#drv-results');
    await setValue('#drv-q', 'realtek');
    assert.ok((await count('.driver-card')) >= 10);
    await setValue('#drv-q', ''); await setValue('#drv-source', 'lead');
    // Third-party aggregator listings are never published in drivers.json (publication rule), so the lead filter is empty.
    const leads = await count('.driver-card');
    assert.equal(leads, 0, 'no aggregator listing is published as a driver record');
    assert.equal(await count('.driver-card.lead'), leads);
    assert.equal(await page.$$eval('.driver-card.lead a[href*="driverscape.com/files"]', (a) => a.length), 0, 'aggregator file links are never rendered');
    assert.equal(await page.$$eval('.driver-card.lead .btn-aero.green', (a) => a.length), 0, 'no direct-download button on a lead');
    await setValue('#drv-source', ''); await page.click('#drv-direct'); await sleep(300);
    const direct = await page.$$eval('.driver-card', (cards) => cards.map((c) => c.querySelector('a.btn-aero.green')?.href ?? null));
    assert.ok(direct.length >= 5 && direct.every((h) => h && h.startsWith('https://')), 'direct-only shows https vendor links');
    await page.$eval('[data-detail="ftdi-cdm-2-12-36-20-whql"]', (b) => b.click()); await page.waitForSelector('dialog[open]');
    assert.match(await text('dialog[open] .window-body'), /Evidence/); assert.match(await text('dialog[open] .window-body'), /ftdichip\.com/);
  });

  it('drivers: hardware IDs are matched to vendors and to records that state the same ID', async () => {
    await go(page, '/drivers/'); await waitResults('#drv-results');
    await page.type('#hw-input', 'PCI\\VEN_8086&DEV_1C3A&SUBSYS_00000000\nUSB\\VID_0403&PID_6001\nPCI\\VEN_ABCD&DEV_0001');
    await page.click('#hw-run'); await sleep(400);
    const out = await text('#hw-results');
    assert.match(out, /Intel/); assert.match(out, /FTDI/); assert.match(out, /Unknown vendor \(ID ABCD\)/);
    assert.doesNotMatch(out, /state this exact hardware ID/, 'no published record states these IDs, so no exact match is claimed');
  });

  it('bundles open in the Software Center with their apps preselected', async () => {
    await go(page, '/bundles/'); await page.waitForSelector('#b-list .card');
    const first = await page.$eval('#b-list .card h2', (e) => e.textContent);
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#b-list .card a.btn-aero.green')]);
    await page.waitForSelector('dialog[open]');
    await page.$$eval('dialog[open] button', (bs) => bs.find((b) => /Load/.test(b.textContent)).click()); await sleep(400);
    assert.ok(Number(await text('#in-count')) >= 4, `bundle "${first}" loaded`);
  });

  it('tools page filters', async () => {
    await go(page, '/tools/'); await page.waitForSelector('#t-list .card');
    await setValue('#t-q', 'memtest');
    assert.equal(await count('#t-list .card'), 2);
    await setValue('#t-q', ''); await page.click('#t-boot'); await sleep(250);
    assert.ok((await count('#t-list .card')) >= 3);
  });

  it('accessibility basics hold on every page: names, landmarks, skip link', async () => {
    for (const url of PAGES) {
      const { p } = await newPage(); await go(p, url); await sleep(600);
      const issues = await p.evaluate(() => {
        const bad = [];
        const named = (el) => el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label') || el.textContent.trim();
        for (const el of document.querySelectorAll('input:not([type=hidden]):not(.sr-only), select, textarea')) if (!named(el)) bad.push(`unnamed control ${el.tagName}#${el.id}`);
        for (const el of document.querySelectorAll('button, a[href]')) if (!el.textContent.trim() && !el.getAttribute('aria-label') && !el.getAttribute('title') && !el.querySelector('img[alt]')) bad.push(`unnamed ${el.tagName} ${el.className}`);
        for (const el of document.querySelectorAll('img')) if (!el.hasAttribute('alt')) bad.push('img without alt');
        for (const sel of ['header', 'nav', 'main', 'footer']) if (!document.querySelector(sel)) bad.push(`missing <${sel}>`);
        if (!document.querySelector('a.skip-link[href="#main"]')) bad.push('missing skip link');
        return bad;
      });
      assert.deepEqual(issues, [], `${url}: ${issues.join('; ')}`);
      await p.keyboard.press('Tab');
      assert.equal(await p.evaluate(() => document.activeElement.className), 'skip-link', `${url}: first Tab stop is the skip link`);
      await p.close();
    }
  });

  it('mobile layout: no horizontal overflow, menu toggles, sticky installer bar appears', async () => {
    const { p } = await newPage({ width: 390, height: 844 });
    for (const url of PAGES) { await go(p, url); await sleep(400); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${url} overflows on mobile`); }
    await go(p, '/software/'); await p.waitForSelector('.qp-item');
    assert.ok(!(await p.$eval('#taskbar-nav', (n) => n.offsetParent !== null)), 'nav is collapsed');
    await p.click('.taskbar-toggle');
    assert.ok(await p.$eval('#taskbar-nav', (n) => n.offsetParent !== null), 'nav opens');
    await p.click('.taskbar-toggle');
    await p.$eval('#qp-git', (el) => el.click()); await sleep(250);
    assert.ok(await p.$eval('#mobile-bar', (b) => !b.hidden));
    await p.screenshot({ path: path.join(shots, 'software_mobile.png') });
    await p.close();
  });
});

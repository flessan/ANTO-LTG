// Deciding what a URL actually is: a direct binary, a redirector, a landing page, a gated form or a signed temporary link.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl, refineWithProbe, classifyHtmlPage } from '../../scripts/crawler/lib/classify-url.mjs';

const kind = (u) => classifyUrl(u).kind;

describe('classifyUrl (by URL pattern alone)', () => {
  it('recognises installers and archives by file extension, and says whether a version is pinned', () => {
    for (const ext of ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'zip', '7z', 'iso', 'cab', 'msu', 'rar', 'dmg', 'deb', 'tar.gz']) {
      const c = classifyUrl(`https://example.com/downloads/tool-1.2.3.${ext}`);
      assert.equal(c.kind, 'direct_binary', ext);
      assert.equal(c.stability, 'versioned', ext);
      assert.equal(c.confidence, 'url_pattern');
    }
    assert.deepEqual([kind('https://example.com/latest/setup.exe'), classifyUrl('https://example.com/latest/setup.exe').stability], ['direct_binary', 'evergreen']);
  });
  it('GitHub release assets are direct binaries (versioned for a tag, evergreen for /latest/download/)', () => {
    assert.deepEqual([classifyUrl('https://github.com/o/r/releases/download/v1.2.3/app-x64.zip').kind, classifyUrl('https://github.com/o/r/releases/download/v1.2.3/app-x64.zip').stability], ['direct_binary', 'versioned']);
    assert.deepEqual([classifyUrl('https://github.com/o/r/releases/latest/download/app.exe').kind, classifyUrl('https://github.com/o/r/releases/latest/download/app.exe').stability], ['direct_binary', 'evergreen']);
    assert.equal(kind('https://github.com/o/r/releases'), 'landing_page');
    assert.equal(kind('https://github.com/o/r/releases/latest'), 'landing_page');
    assert.equal(kind('https://github.com/o/r/releases/tag/v1.0'), 'landing_page');
  });
  it('redirector hosts are redirects', () => {
    for (const u of ['https://aka.ms/getwinget', 'https://go.microsoft.com/fwlink/?linkid=2171764', 'https://go.microsoft.com/fwlink/p/?LinkId=1', 'https://bit.ly/abc', 'https://download.mozilla.org/?product=firefox-latest&os=win64']) assert.equal(kind(u), 'redirect', u);
    assert.equal(classifyUrl('https://aka.ms/x').stability, 'evergreen');
  });
  it('download and home pages are landing pages', () => {
    for (const u of ['https://example.com/', 'https://example.com', 'https://example.com/download', 'https://example.com/downloads/', 'https://example.com/get', 'https://example.com/app/latest', 'https://example.com/page.html', 'https://example.com/index.php', 'https://example.com/a.aspx']) assert.equal(kind(u), 'landing_page', u);
  });
  it('signed or expiring URLs are never stored as links (signed_temporary, ephemeral)', () => {
    const signed = ['https://bucket.s3.amazonaws.com/setup.exe?X-Amz-Signature=abc&X-Amz-Expires=300', 'https://cdn.example.com/a.exe?token=abc123', 'https://cdn.example.com/a.exe?sig=abc', 'https://x.blob.core.windows.net/a.exe?sv=2020&se=2026-01-01&sp=r&sr=b&sig=zzz', 'https://cdn.example.com/a.exe?expires=1700000000&hmac=ff', 'https://cdn.example.com/a.exe?Policy=abc&Key-Pair-Id=K1', 'https://example.com/a.exe?access_token=zzz'];
    for (const u of signed) { const c = classifyUrl(u); assert.equal(c.kind, 'signed_temporary', u); assert.equal(c.stability, 'ephemeral', u); }
  });
  it('signature detection beats the file extension', () => assert.equal(kind('https://example.com/setup.exe?Signature=abc'), 'signed_temporary'));
  it('says "unknown" rather than guessing when there is nothing to go on', () => {
    for (const u of ['https://example.com/some/opaque/path', 'https://example.com/x?id=42']) { const c = classifyUrl(u); assert.equal(c.kind, 'unknown', u); assert.equal(c.confidence, 'none'); }
    const bad = classifyUrl('not a url');
    assert.deepEqual([bad.kind, bad.stability, bad.confidence], ['unknown', 'unknown', 'none']);
  });
  it('notes when a URL is not https', () => assert.match(classifyUrl('http://example.com/setup.exe').reasons.join(' '), /not HTTPS/));
  it('decodes the path before looking at the file name', () => assert.equal(kind('https://example.com/dl/Setup%20Tool%201.0.exe'), 'direct_binary'));
  it('every answer carries a human-readable reason', () => {
    for (const u of ['https://example.com/a.exe', 'https://aka.ms/x', 'https://example.com/', 'https://example.com/z', 'https://x.test/a?sig=1']) assert.ok(classifyUrl(u).reasons.length >= 1, u);
  });
});

describe('refineWithProbe (header-only evidence)', () => {
  const probe = (o) => ({ status: 200, finalUrl: 'https://example.com/x', redirects: [], redirectBlocked: null, contentType: null, contentLength: null, contentDisposition: null, binary: false, ...o });
  it('a binary content type or an attachment disposition proves a direct binary and records the size', () => {
    const base = classifyUrl('https://example.com/get');
    const r = refineWithProbe(base, probe({ contentType: 'application/octet-stream', contentLength: 123456 }));
    assert.deepEqual([r.kind, r.confidence, r.size_bytes], ['direct_binary', 'http_probe', 123456]);
    assert.equal(refineWithProbe(base, probe({ contentType: 'text/html', contentDisposition: 'attachment; filename="a.exe"' })).kind, 'direct_binary');
    assert.equal(refineWithProbe(base, probe({ binary: true, contentType: 'application/x-weird' })).kind, 'direct_binary');
  });
  it('an HTML response makes it a landing page even if the URL looked like a file', () => {
    const r = refineWithProbe(classifyUrl('https://example.com/setup.exe'), probe({ contentType: 'text/html; charset=utf-8' }));
    assert.deepEqual([r.kind, r.stability], ['landing_page', 'unknown']);
    assert.match(r.reasons.join(' '), /HTML page, not a file/);
  });
  it('an error status marks the link broken and unknown, never "direct"', () => {
    for (const status of [404, 410, 500, 403]) { const r = refineWithProbe(classifyUrl('https://example.com/a.exe'), probe({ status })); assert.equal(r.kind, 'unknown'); assert.equal(r.broken, true); assert.equal(r.http_status, status); }
  });
  it('a blocked redirect stays a redirect and says where it pointed', () => {
    const r = refineWithProbe(classifyUrl('https://example.com/go'), probe({ status: 302, redirectBlocked: { location: 'https://evil.example/x', code: 'BLOCKED_HOST' } }));
    assert.equal(r.kind, 'redirect');
    assert.match(r.reasons.join(' '), /evil\.example.*BLOCKED_HOST/);
  });
  it('a final URL carrying a signature downgrades a non-binary guess to signed_temporary and ephemeral', () => {
    const r = refineWithProbe(classifyUrl('https://example.com/get'), probe({ contentType: 'application/zip', finalUrl: 'https://cdn.example.com/a.zip?X-Amz-Signature=abc' }));
    assert.deepEqual([r.kind, r.stability], ['signed_temporary', 'ephemeral']);
  });
  it('records redirect hops, content type and final URL as evidence', () => {
    const r = refineWithProbe(classifyUrl('https://example.com/get'), probe({ contentType: 'application/zip', redirects: [{ from: 'a', to: 'b', status: 302 }], finalUrl: 'https://example.com/final.zip' }));
    assert.match(r.reasons.join(' '), /1 redirect hop/);
    assert.equal(r.final_url, 'https://example.com/final.zip');
    assert.equal(r.content_type, 'application/zip');
  });
  it('an unrecognised content type leaves the kind alone but says so', () => {
    const r = refineWithProbe(classifyUrl('https://example.com/data'), probe({ contentType: 'application/json' }));
    assert.equal(r.kind, 'unknown');
    assert.match(r.reasons.join(' '), /unclassified content type application\/json/);
  });
  it('does not mutate the classification it was given', () => {
    const base = classifyUrl('https://example.com/get'); const copy = structuredClone(base);
    refineWithProbe(base, probe({ contentType: 'application/zip' }));
    assert.deepEqual(base, copy);
  });
});

describe('classifyHtmlPage (is the file hidden behind a gate?)', () => {
  it('a plain page is a landing page', () => assert.deepEqual(classifyHtmlPage('<html><body><a href="/x.exe">Download</a></body></html>'), { kind: 'landing_page', gates: [] }));
  it('detects captcha / verification codes, logins, serial-number lookups and email forms', () => {
    assert.deepEqual(classifyHtmlPage('<p>Enter the verification code below</p>').gates, ['captcha or verification code']);
    assert.deepEqual(classifyHtmlPage('<div class="g-recaptcha"></div>').gates, ['captcha or verification code']);
    assert.deepEqual(classifyHtmlPage('<form><input type="password" name="p"></form>').gates, ['login']);
    assert.deepEqual(classifyHtmlPage('<p>Please sign in to download</p>').gates, ['login']);
    assert.deepEqual(classifyHtmlPage('<p>Enter your service tag</p>').gates, ['serial number or product lookup']);
    assert.deepEqual(classifyHtmlPage('<form action="/x"><label>Mail</label><input type="email"></form>').gates, ['email form']);
    const many = classifyHtmlPage('<p>captcha</p><p>serial number</p><input type=password>');
    assert.equal(many.kind, 'download_form');
    assert.deepEqual(many.gates.sort(), ['captcha or verification code', 'login', 'serial number or product lookup'].sort());
  });
  it('only reads the first 200 kB (a hostile page cannot make this slow)', () => {
    const t0 = Date.now();
    classifyHtmlPage(`${'x'.repeat(5_000_000)}captcha`);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(classifyHtmlPage(`${'x'.repeat(300_000)}captcha`).kind, 'landing_page', 'text past the cut-off is ignored');
  });
});

// Security tests for the browser code: safe DOM construction, URL validation, no dangerous sinks,
// no secrets, and a strict Content-Security-Policy on every page.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { installFakeDom } from '../helpers/fake-dom.mjs';
import { root, fromRoot, listFiles, stripJsComments, readText } from '../helpers/repo.mjs';
import { escapeHtml, sanitizeText, safeHttpUrl, safeSitePath, h, clear, replaceChildren } from '../../assets/js/lib/html.js';
import { PAGES } from '../../scripts/lib/chrome.mjs';

describe('escapeHtml / sanitizeText', () => {
  it('escapes every HTML metacharacter and tolerates null', () => {
    assert.equal(escapeHtml('<img src=x onerror="a&b">\'`'), '&lt;img src=x onerror=&quot;a&amp;b&quot;&gt;&#39;&#96;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
  });

  it('removes control, bidirectional and zero-width characters but keeps ordinary whitespace', () => {
    const dirty = 'a\u0000b\u0007c\u202ed\u200be\u2066f\ufeffg\u007fh\u0085i\tj\nk';
    assert.equal(sanitizeText(dirty), 'abcdefghi\tj\nk');
    assert.equal(sanitizeText('  padded  '), 'padded');
  });

  it('caps the length', () => assert.equal(sanitizeText('x'.repeat(5000), 10), 'x'.repeat(10)));
});

describe('safeHttpUrl', () => {
  const ok = [
    ['https://example.com/path?x=1#y', 'https://example.com/path?x=1#y'],
    ['HTTPS://Example.COM', 'https://example.com/'],
    ['https://learn.microsoft.com/sysinternals/downloads/sysinternals-suite', 'https://learn.microsoft.com/sysinternals/downloads/sysinternals-suite'],
    ['  https://www.realtek.com/Download/List?cate_id=593  ', 'https://www.realtek.com/Download/List?cate_id=593'],
  ];
  for (const [input, expected] of ok) it(`accepts ${JSON.stringify(input)}`, () => assert.equal(safeHttpUrl(input), expected));

  const rejected = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/3f0c', 'file:///etc/passwd', 'vbscript:msgbox(1)', 'ftp://example.com/x', 'http://example.com/', '//example.com/x',
    'https://user:pass@example.com/', 'https://user@example.com/', 'https://localhost/', 'https://app.localhost/', 'https://printer.local/', 'https://db.internal/',
    'https://127.0.0.1/', 'https://10.0.0.5/', 'https://192.168.1.1/', 'https://2130706433/', 'https://0x7f.0.0.1/', 'https://[::1]/', 'https://[fe80::1]/',
    'https://example.com/\u0000', 'https://exa mple.com/', 'https://example.com\\@evil.example/', '', '   ', `https://example.com/${'a'.repeat(3000)}`,
  ];
  for (const input of rejected) it(`rejects ${JSON.stringify(input).slice(0, 60)}`, () => assert.equal(safeHttpUrl(input), null));

  it('rejects values that are not strings', () => {
    for (const v of [null, undefined, 42, {}, [], true]) assert.equal(safeHttpUrl(v), null);
  });
  it('allows plain http only when asked', () => assert.equal(safeHttpUrl('http://example.com/', { allowHttp: true }), 'http://example.com/'));
});

describe('safeSitePath', () => {
  for (const v of ['software/', './x', '../x/y.html', '/assets/img/a.png', 'software/#app=git', 'index.html?x=1&y=2', '#top']) {
    it(`accepts ${v}`, () => assert.equal(safeSitePath(v), v));
  }
  for (const v of ['//evil.example/x', 'javascript:alert(1)', 'https://evil.example/', 'a b', '../../../etc/passwd', 'data:text/html,x', '\\\\server\\share', 'x\ny', 42, null]) {
    it(`rejects ${JSON.stringify(v)}`, () => assert.equal(safeSitePath(v), null));
  }
});

describe('h() builds DOM without ever parsing markup', () => {
  let restore;
  before(() => { restore = installFakeDom(); });
  after(() => restore());

  it('puts text into text nodes, so markup stays inert', () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const el = h('p', null, payload);
    assert.equal(el.children.length, 0, 'no element children were created');
    assert.equal(el.childNodes.length, 1);
    assert.equal(el.textContent, payload);
  });

  it('flattens children and skips null, false and booleans', () => {
    const el = h('ul', { class: 'a b' }, [h('li', null, 'one'), null, [false, 'two', 3]], true);
    assert.equal(el.className, 'a b');
    assert.equal(el.textContent, 'onetwo3');
  });

  it('accepts a child as the first argument', () => {
    const child = h('b', null, 'x');
    assert.equal(h('p', child).children[0], child);
    assert.equal(h('p', 'text').textContent, 'text');
  });

  it('keeps hostile attribute VALUES inert (they are set as data, never parsed)', () => {
    const el = h('div', { title: '"><script>alert(1)</script>', alt: "' onmouseover='alert(1)" });
    assert.equal(el.getAttribute('title'), '"><script>alert(1)</script>');
    assert.equal(el.children.length, 0);
  });

  describe('event handlers and styles', () => {
    it('rejects string handlers', () => {
      for (const name of ['onclick', 'onerror', 'onload', 'onmouseover', 'onfocus']) {
        assert.throws(() => h('button', { [name]: 'alert(1)' }), TypeError, name);
      }
    });
    it('registers function handlers with addEventListener', () => {
      const fn = () => {};
      const el = h('button', { onClick: fn });
      assert.deepEqual(el.listeners.map((l) => l.type), ['click']);
      assert.equal(el.listeners[0].fn, fn);
      assert.equal(el.getAttribute('onclick'), null);
    });
    it('rejects the style attribute (CSP forbids inline styles)', () => assert.throws(() => h('div', { style: 'color:red' }), TypeError));
    it('allows only well-formed custom properties through "vars"', () => {
      const el = h('div', { vars: { '--hue': 180, color: 'red', '--BAD': 1, '--ok-1': 'x' } });
      assert.deepEqual([...el.styleProps.keys()], ['--hue', '--ok-1']);
    });
    it('only creates data-* attributes with simple camelCase keys', () => {
      const el = h('div', { dataset: { appId: 'git', 'data-x': 'no', 'x y': 'no', Upper: 'no' } });
      assert.deepEqual(el.dataset, { appId: 'git' });
    });
  });

  describe('URL attributes', () => {
    const href = (v) => h('a', { href: v }).getAttribute('href');
    it('keeps https and same-site relative links', () => {
      assert.equal(href('https://example.com/x'), 'https://example.com/x');
      assert.equal(href('#section'), '#section');
      assert.equal(href('../drivers/'), '../drivers/');
      assert.equal(href('software/#app=git'), 'software/#app=git');
    });
    it('drops every dangerous or unusual scheme', () => {
      for (const v of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,hi', 'vbscript:x', 'file:///c:/windows', 'http://example.com/', '//evil.example/', 'https://u:p@example.com/', 'https://127.0.0.1/', 'https://localhost/x']) {
        assert.equal(href(v), null, v);
      }
    });
    it('src only accepts same-site paths, never remote URLs', () => {
      assert.equal(h('img', { src: 'assets/img/a.avif' }).getAttribute('src'), 'assets/img/a.avif');
      assert.equal(h('img', { src: 'https://tracker.example/p.gif' }).getAttribute('src'), null);
      assert.equal(h('img', { src: 'data:image/svg+xml,<svg onload=alert(1)>' }).getAttribute('src'), null);
    });
    it('srcset is all-or-nothing', () => {
      assert.equal(h('img', { srcset: 'assets/a.webp 1x, assets/b.webp 2x' }).getAttribute('srcset'), 'assets/a.webp 1x, assets/b.webp 2x');
      assert.equal(h('img', { srcset: 'assets/a.webp 1x, https://evil.example/b.webp 2x' }).getAttribute('srcset'), null);
    });
    it('target=_blank always gets rel="noopener noreferrer", whatever the attribute order', () => {
      assert.equal(h('a', { href: 'https://example.com/', target: '_blank' }).getAttribute('rel'), 'noopener noreferrer');
      assert.equal(h('a', { target: '_blank', rel: 'opener' }).getAttribute('rel'), 'noopener noreferrer');
      assert.equal(h('a', { rel: 'opener', target: '_blank' }).getAttribute('rel'), 'noopener noreferrer');
      assert.equal(h('a', { target: '_self' }).getAttribute('target'), null);
    });
    it('rel is stripped to letters, spaces and hyphens', () => assert.equal(h('a', { rel: 'nofollow"><x' }).getAttribute('rel'), 'nofollowx'));
  });

  describe('attribute allow-list', () => {
    it('refuses attributes that can execute or load code', () => {
      for (const name of ['srcdoc', 'formaction', 'xlink:href', 'action', 'ping', 'is', 'contenteditable', 'content', 'http-equiv', 'integrity', 'onclick2', 'data-x']) {
        assert.throws(() => h('div', { [name]: 'x' }), TypeError, name);
      }
    });
    it('accepts the aria-* attributes the UI uses and rejects malformed ones', () => {
      assert.equal(h('div', { 'aria-label': 'x', 'aria-labelledby': 'y' }).getAttribute('aria-labelledby'), 'y');
      assert.throws(() => h('div', { 'aria-foo-bar': 'x' }), TypeError);
    });
    it('boolean attributes appear only when truthy', () => {
      const el = h('input', { disabled: true, checked: false, hidden: 1 });
      assert.equal(el.hasAttribute('disabled'), true);
      assert.equal(el.hasAttribute('checked'), false);
      assert.equal(el.hasAttribute('hidden'), true);
    });
    it('skips null, undefined and false values', () => assert.equal(h('div', { title: null, id: undefined, lang: false }).attrs.size, 0));
  });

  it('clear() and replaceChildren() remove old content', () => {
    const el = h('div', null, 'a', h('b', null, 'b'));
    replaceChildren(el, 'x', ['y']);
    assert.equal(el.textContent, 'xy');
    assert.equal(clear(el).childNodes.length, 0);
  });
});

describe('no dangerous sinks or remote calls in the browser code', () => {
  const FORBIDDEN = [
    [/\binnerHTML\b/, 'innerHTML'], [/\bouterHTML\b/, 'outerHTML'], [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'], [/\bdocument\s*\.\s*write(ln)?\b/, 'document.write'],
    [/\beval\s*\(/, 'eval()'], [/\bnew\s+Function\b/, 'new Function'], [/\bFunction\s*\(/, 'Function()'], [/\bset(Timeout|Interval)\s*\(\s*['"`]/, 'setTimeout/setInterval with a string'],
    [/\.srcdoc\b/, 'srcdoc'], [/\bcreateContextualFragment\b/, 'createContextualFragment'], [/\bDOMParser\b/, 'DOMParser'], [/\bimportScripts\b/, 'importScripts'],
    [/\bjavascript:/i, 'javascript: URL'], [/\bXMLHttpRequest\b/, 'XMLHttpRequest'], [/\bWebSocket\b/, 'WebSocket'], [/\bsendBeacon\b/, 'sendBeacon'],
    [/\bfetch\s*\(\s*['"`]https?:/, 'fetch() to an absolute URL'], [/https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i, 'URL pointing at the local machine'], [/\bdocument\s*\.\s*cookie\b/, 'document.cookie'],
    [/\.\s*setAttribute\s*\(\s*['"`]on/i, 'setAttribute("on…")'], [/\.\s*setAttribute\s*\(\s*['"`]style['"`]/, 'setAttribute("style")'],
  ];
  it('scans every file under assets/js', async () => {
    const files = await listFiles(fromRoot('assets', 'js'), { ext: ['.js'] });
    assert.ok(files.length >= 15, `expected the browser modules, found ${files.length}`);
    const hits = [];
    for (const file of files) {
      const code = stripJsComments(await readFile(file, 'utf8'));
      for (const [re, label] of FORBIDDEN) if (re.test(code)) hits.push(`${path.relative(root, file)}: ${label}`);
    }
    assert.deepEqual(hits, []);
  });

  it('only fetches same-origin api/ and data files', async () => {
    const files = await listFiles(fromRoot('assets', 'js'), { ext: ['.js'] });
    const urls = [];
    for (const file of files) {
      const code = stripJsComments(await readFile(file, 'utf8'));
      for (const m of code.matchAll(/\bfetch\s*\(\s*([^,)]+)/g)) urls.push(`${path.relative(root, file)}: ${m[1].trim()}`);
    }
    assert.ok(urls.length > 0, 'the pages do fetch the catalogs');
    for (const u of urls) assert.doesNotMatch(u, /https?:\/\//, u);
  });
});

describe('no secrets are committed', () => {
  const PATTERNS = [
    [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'GitHub token'], [/github_pat_[A-Za-z0-9_]{30,}/, 'GitHub fine-grained token'], [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'], [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'], [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
    [/\bsk-[A-Za-z0-9]{32,}\b/, 'API secret key'], [/(?:api[_-]?key|secret|passwd|password|authorization)\s*[:=]\s*['"][A-Za-z0-9+/_-]{16,}['"]/i, 'hard-coded credential'],
  ];
  it('finds no token or key shaped strings in source, data, docs or workflows', async () => {
    const files = [
      ...await listFiles(root, { ext: ['.js', '.mjs', '.json', '.html', '.css', '.md', '.yml', '.yaml', '.ps1', '.svg'], skip: ['node_modules', '.git', '.cache', 'img', 'vendor', 'package-lock.json'] }),
    ].filter((f) => !f.endsWith('package-lock.json'));
    const hits = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const [re, label] of PATTERNS) if (re.test(text)) hits.push(`${path.relative(root, file)}: ${label}`);
    }
    assert.deepEqual(hits, []);
  });

  it('the crawler only reads tokens from the environment and never writes them out', async () => {
    const crawl = await readText('scripts', 'crawler', 'commands', 'crawl.mjs');
    assert.match(crawl, /process\.env/);
    assert.doesNotMatch(crawl, /console\.[a-z]+\([^)]*token/i);
  });
});

describe('every page ships a strict Content-Security-Policy and safe markup', () => {
  const REQUIRED = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'"];
  for (const page of PAGES) {
    it(`${page.file}`, async () => {
      const html = await readText(page.file);
      const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
      assert.ok(csp, 'has a CSP meta tag');
      for (const directive of REQUIRED) assert.ok(csp.includes(directive), `CSP includes ${directive}`);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*|https?:/i, 'CSP has no unsafe keywords, wildcards or remote origins');
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline scripts');
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handlers');
      assert.doesNotMatch(html, /\sstyle\s*=/i, 'no inline styles');
      assert.doesNotMatch(html, /<(iframe|object|embed|base)\b/i, 'no iframes, plugins or <base>');
      assert.doesNotMatch(html, /<form\b[^>]*\saction\s*=/i, 'forms never submit anywhere (JavaScript handles them; CSP form-action is none)');
      assert.doesNotMatch(html, /<(script|link)[^>]+(?:src|href)="https?:/i, 'no runtime CDN scripts or stylesheets');
    });
  }
});

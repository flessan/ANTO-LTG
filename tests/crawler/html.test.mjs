// The defensive HTML tokenizer: it extracts text, links, tables and metadata from untrusted pages and never
// builds a DOM or runs anything. It must also stay fast on hostile input.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, tokenize, visibleText, extractLinks, extractTables, extractMeta } from '../../scripts/crawler/lib/html.mjs';

const tokens = (html) => [...tokenize(html)];

describe('decodeEntities', () => {
  it('decodes named, decimal and hexadecimal entities', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;&#66; &nbsp;|&copy;|&mdash;'), 'a & b <c> "d" \'e\' AB  |(c)|-');
  });
  it('leaves unknown entities alone and replaces impossible code points with a space', () => {
    assert.equal(decodeEntities('&bogus; &#0; &#1114112; &#xD800; &#99999999999;'), `&bogus;${' '.repeat(8)}`, 'four impossible references become four spaces, plus the four spaces between them');
    assert.equal(decodeEntities('&#0;&#1114112;&#xD800;&#99999999999;'), '    ');
  });
  it('does not decode twice (&amp;lt; stays &lt;)', () => assert.equal(decodeEntities('&amp;lt;script&amp;gt;'), '&lt;script&gt;'));
});

describe('tokenize', () => {
  it('yields text, start and end tokens with parsed attributes', () => {
    const t = tokens('<p class="a b" data-x=\'1\' hidden id=main>Hi &amp; bye</p>');
    assert.deepEqual(t[0], { type: 'start', name: 'p', attrs: { class: 'a b', 'data-x': '1', hidden: '', id: 'main' }, selfClosing: false });
    assert.deepEqual(t[1], { type: 'text', text: 'Hi & bye' });
    assert.deepEqual(t[2], { type: 'end', name: 'p' });
  });
  it('lower-cases tag and attribute names and keeps the first of duplicate attributes', () => {
    const [start] = tokens('<A HREF="https://a.test/" href="https://b.test/">x</A>');
    assert.equal(start.name, 'a');
    assert.equal(start.attrs.href, 'https://a.test/');
  });
  it('treats void elements and "/>" as self-closing', () => {
    for (const html of ['<br>', '<img src=x>', '<input/>', '<meta charset=utf-8>', '<foo />']) assert.equal(tokens(html)[0].selfClosing, true, html);
    assert.equal(tokens('<div>')[0].selfClosing, false);
  });
  it('drops comments, doctypes and processing instructions', () => {
    assert.deepEqual(tokens('a<!-- <script>alert(1)</script> -->b<!DOCTYPE html><?xml version="1.0"?>c').map((t) => t.text).join(''), 'abc');
    assert.deepEqual(tokens('<!-- never closed <b>x</b>'), []);
  });
  it('never yields script or style bodies as text, only as rawtext, and decodes nothing inside them', () => {
    const t = tokens('<script>if (a < b && c > d) { x = "&amp;"; }</script><style>p > a { color: red }</style>after');
    const raw = t.filter((x) => x.type === 'rawtext');
    assert.equal(raw.length, 2);
    assert.match(raw[0].text, /&amp;/, 'raw text is left exactly as written');
    assert.equal(visibleText('<p>shown</p><script>hidden()</script><style>.x{}</style>'), 'shown');
  });
  it('a script that mentions </div> or tags inside strings does not leak', () => assert.equal(visibleText('<script>document.write("</div><p>evil</p>")</script><p>ok</p>'), 'ok'));
  it('title and textarea bodies are text, not markup', () => {
    const t = tokens('<title>A <b>bold</b> title</title>');
    assert.deepEqual(t.filter((x) => x.type === 'text').map((x) => x.text), ['A <b>bold</b> title']);
  });
  it('handles an unterminated script or a stray "<" without throwing', () => {
    assert.doesNotThrow(() => tokens('<script>no end'));
    assert.deepEqual(tokens('1 < 2 and 3 > 2').map((t) => t.text).join(''), '1 < 2 and 3 > 2');
    assert.doesNotThrow(() => tokens('<a href="unterminated'));
  });
  it('quoted ">" inside an attribute does not end the tag early', () => {
    const [start, text] = tokens('<a title="x > y" href="/z">link</a>');
    assert.equal(start.attrs.title, 'x > y');
    assert.equal(text.text, 'link');
  });
  it('caps the amount of input it reads', () => {
    const big = `${'x'.repeat(5 * 1024 * 1024)}<b>never seen</b>`;
    assert.equal(tokens(big).some((t) => t.type === 'start'), false);
  });
});

describe('stays fast on hostile input (a malicious page must not stall a crawl)', () => {
  const slowest = (html) => { const t0 = performance.now(); for (const _ of tokenize(html)) { /* consume */ } extractTables(html); extractLinks(html); visibleText(html); return performance.now() - t0; };
  const budgetMs = 3000;
  const cases = {
    'repeated <a " (unbalanced quotes)': '<a "'.repeat(500_000),
    'unterminated attribute quotes': '<a href="x'.repeat(200_000),
    'two million "<"': '<'.repeat(2_000_000),
    'unterminated comments': '<!--'.repeat(500_000),
    'unterminated scripts': '<script>'.repeat(200_000),
    'a hundred thousand scripts': '<script>x</script>'.repeat(100_000),
    'deeply nested tables': '<table><tr><td>'.repeat(100_000),
    'a huge number of cells': `<table><tr>${'<td>a</td>'.repeat(200_000)}</tr></table>`,
    'entity soup': '&amp;&#x41;&#9999999999;&bogus;'.repeat(100_000),
    'very long attribute value': `<a href="${'x'.repeat(1_000_000)}">t</a>`,
  };
  for (const [name, html] of Object.entries(cases)) it(`${name} (${(html.length / 1024).toFixed(0)} kB) is handled in under ${budgetMs / 1000}s`, () => assert.ok(slowest(html) < budgetMs));
});

describe('visibleText, extractLinks, extractTables, extractMeta', () => {
  it('visibleText puts block elements on their own lines and joins table cells with spaces', () => {
    assert.equal(visibleText('<h1>Title</h1><p>One<br>Two</p><table><tr><td>A</td><td>B</td></tr></table>'), 'Title\nOne\nTwo\nA B');
    assert.equal(visibleText(''), '');
  });
  it('extractLinks returns href and clean text, and ignores anchors without href', () => {
    assert.deepEqual(extractLinks('<a href="/a">  First\n link </a><a name="x">no</a><a href="https://b.test/">B <b>bold</b></a>'), [{ href: '/a', text: 'First link' }, { href: 'https://b.test/', text: 'B bold' }]);
  });
  it('extractLinks returns hostile hrefs verbatim (callers must validate them) and never follows them', () => {
    const links = extractLinks('<a href="javascript:alert(1)">x</a><a href="data:text/html,hi">y</a>');
    assert.deepEqual(links.map((l) => l.href), ['javascript:alert(1)', 'data:text/html,hi']);
  });
  it('extractTables returns rows of cells with text and links, plus the first link after each table', () => {
    const tables = extractTables('<table><tr><td>Name:</td><td><a href="/x">Thing</a></td></tr><tr><th>Ver</th><td>1.0</td></tr></table><p>Please wait</p><a href="/files/x.zip">Download</a>');
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0].rows.map((r) => r.map((c) => c.text)), [['Name:', 'Thing'], ['Ver', '1.0']]);
    assert.deepEqual(tables[0].rows[0][1].links, [{ href: '/x', text: 'Thing' }]);
    assert.deepEqual(tables[0].after, { href: '/files/x.zip', text: 'Download' });
  });
  it('extractTables copes with nested tables and rows without cells', () => {
    const tables = extractTables('<table><tr></tr><tr><td>outer<table><tr><td>inner</td></tr></table></td></tr></table>');
    assert.equal(tables.length, 2);
    assert.deepEqual(tables[0].rows[0][0].text, 'inner');
  });
  it('extractMeta reads title, description, canonical, Open Graph and valid JSON-LD only', () => {
    const meta = extractMeta(`<html><head><title> My  Page </title><meta name="description" content=" A  page "><meta property="og:title" content="OG"><link rel="canonical" href="https://x.test/p">
      <script type="application/ld+json">{"@type":"SoftwareApplication","name":"X"}</script><script type="application/ld+json">{broken</script></head></html>`);
    assert.deepEqual([meta.title, meta.description, meta.canonical, meta.og.title], ['My Page', 'A page', 'https://x.test/p', 'OG']);
    assert.deepEqual(meta.jsonld, [{ '@type': 'SoftwareApplication', name: 'X' }]);
    assert.ok(!('_ld' in meta));
  });
});

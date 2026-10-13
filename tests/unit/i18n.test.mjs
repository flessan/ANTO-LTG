// i18n: English and Indonesian dictionaries stay in lockstep, every key the UI can ask for exists, and the
// default text baked into each HTML page equals the English dictionary (so there is no flash of change).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import en from '../../assets/js/i18n/en.js';
import id from '../../assets/js/i18n/id.js';
import { STRINGS, LANGS, pickLang, format, translate } from '../../assets/js/i18n.js';
import { PAGES } from '../../scripts/lib/chrome.mjs';
import { BLOCKING_FLAGS } from '../../scripts/crawler/lib/merge.mjs';
import { PERSISTED_FLAGS } from '../../scripts/crawler/adapters/winget.mjs';
import { root, listFiles, readText, readJson, stripJsComments, loadCatalogs } from '../helpers/repo.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', mdash: '\u2014', ndash: '\u2013', middot: '\u00b7', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', times: '\u00d7', copy: '\u00a9' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  assert.ok(e in ENTITIES, `unknown HTML entity ${m}`);
  return ENTITIES[e];
});
const norm = (s) => decode(s).replace(/\s+/g, ' ').trim();

describe('dictionaries', () => {
  it('English and Indonesian have exactly the same keys', () => {
    assert.deepEqual(Object.keys(id).sort(), Object.keys(en).sort());
    assert.ok(Object.keys(en).length > 400);
  });
  it('placeholders match key by key', () => {
    for (const k of Object.keys(en)) assert.equal(placeholders(id[k]), placeholders(en[k]), `${k}: "${en[k]}" vs "${id[k]}"`);
  });
  it('no value is empty, padded, or contains markup (text is applied with textContent)', () => {
    for (const [lang, dict] of Object.entries({ en, id })) {
      for (const [k, v] of Object.entries(dict)) {
        assert.equal(typeof v, 'string', `${lang}:${k}`);
        assert.ok(v.trim().length > 0, `${lang}:${k} is empty`);
        assert.equal(v, v.trim(), `${lang}:${k} has leading or trailing space`);
        assert.doesNotMatch(v, /[<>]/, `${lang}:${k} contains markup`);
        assert.doesNotMatch(v, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/, `${lang}:${k} has control characters`);
      }
    }
  });
  it('plural keys come in .one/.other pairs in both languages', () => {
    for (const dict of [en, id]) {
      for (const k of Object.keys(dict)) {
        if (k.endsWith('.one')) assert.ok(`${k.slice(0, -4)}.other` in dict, `${k} has no .other`);
        if (k.endsWith('.other')) assert.ok(`${k.slice(0, -6)}.one` in dict, `${k} has no .one`);
      }
    }
  });
  it('Indonesian is a real translation: only brand names and unit words match English', () => {
    const same = Object.keys(en).filter((k) => en[k] === id[k]);
    assert.ok(same.length <= 20, `too many untranslated strings: ${same.join(', ')}`);
    for (const k of same) assert.ok(en[k].length <= 40, `${k} looks untranslated: ${en[k]}`);
  });
  it('is exposed through the i18n module', () => {
    assert.deepEqual(LANGS, ['en', 'id']);
    assert.equal(STRINGS.en, en);
    assert.equal(STRINGS.id, id);
  });
});

describe('language selection and formatting', () => {
  it('uses a stored choice first, then the browser languages, then English', () => {
    assert.equal(pickLang({ stored: 'id', languages: ['en-US'] }), 'id');
    assert.equal(pickLang({ stored: 'en', languages: ['id-ID'] }), 'en');
    assert.equal(pickLang({ stored: 'fr', languages: ['id-ID'] }), 'id', 'an unsupported stored value is ignored');
    assert.equal(pickLang({ languages: ['fr-FR', 'id'] }), 'id');
    assert.equal(pickLang({ languages: ['in'] }), 'id', 'legacy Indonesian code');
    assert.equal(pickLang({ languages: ['de', 'en-GB'] }), 'en');
    assert.equal(pickLang({ languages: ['de'] }), 'en');
    assert.equal(pickLang(), 'en');
    assert.equal(pickLang({ stored: '<script>', languages: [] }), 'en');
  });
  it('fills placeholders and leaves unknown ones visible', () => {
    assert.equal(format('{n} apps via {wg}', { n: 3, wg: 'WinGet' }), '3 apps via WinGet');
    assert.equal(format('Hello {name}', {}), 'Hello {name}');
    assert.equal(format('a {x} b {x}', { x: 1 }), 'a 1 b 1');
  });
  it('translate falls back to English, then to the key itself', () => {
    assert.equal(translate('id', 'nav.software'), id['nav.software']);
    assert.equal(translate('xx', 'nav.software'), en['nav.software']);
    assert.equal(translate('en', 'no.such.key'), 'no.such.key');
  });
  it('does not execute or interpret translation values (values are inert text)', () => {
    assert.equal(format('{a}', { a: '<img src=x onerror=alert(1)>' }), '<img src=x onerror=alert(1)>');
  });
});

describe('every key the UI asks for exists', () => {
  it('literal t()/tn() keys in the JavaScript exist in both dictionaries', async () => {
    const files = await listFiles(path.join(root, 'assets', 'js'), { ext: ['.js'] });
    const missing = [];
    let refs = 0;
    for (const file of files.filter((f) => !f.includes(`${path.sep}i18n${path.sep}`))) {
      const code = stripJsComments(await readFile(file, 'utf8'));
      for (const m of code.matchAll(/\bt(n?)\(\s*['"`]([a-z0-9_.]+)['"`]/g)) {
        refs++;
        const keys = m[1] ? [`${m[2]}.one`, `${m[2]}.other`] : [m[2]];
        for (const k of keys) if (!(k in en) || !(k in id)) missing.push(`${path.relative(root, file)}: ${k}`);
      }
    }
    assert.ok(refs > 100, `found only ${refs} literal references`);
    assert.deepEqual(missing, []);
  });

  it('dynamic key families cover every value the data and schemas can produce', async () => {
    const common = (await readJson('schemas', 'common.schema.json')).$defs;
    const vendorSchema = (await readJson('schemas', 'vendors.schema.json')).$defs.vendor;
    const families = [
      ['dl', common.downloadKind.enum], ['req', common.requirement.enum], ['link', common.linkCheck.properties.status.enum], ['ev', common.evidence.properties.type.enum],
      ['compat', common.compatState.enum], ['vkind', vendorSchema.properties.kind.enum], ['chip', ['winget', 'direct', 'redirect', 'page', 'unavailable']],
    ];
    const missing = [];
    for (const [prefix, values] of families) for (const v of values) for (const dict of [en, id]) if (!(`${prefix}.${v}` in dict)) missing.push(`${prefix}.${v}`);
    for (const c of common.compatState.enum) if (!(`compat.${c}.hint` in en)) missing.push(`compat.${c}.hint`);
    assert.deepEqual([...new Set(missing)], []);
  });

  it('every data-quality flag in the catalogs and in the crawler has a label', async () => {
    const catalogs = await loadCatalogs();
    const flags = new Set([...BLOCKING_FLAGS.drivers, ...PERSISTED_FLAGS]);
    for (const name of ['apps', 'drivers']) for (const i of catalogs[name].items) for (const f of i.quality_flags ?? []) flags.add(f);
    assert.ok(flags.size >= 12);
    for (const f of flags) for (const [lang, dict] of [['en', en], ['id', id]]) assert.ok(`flag.${f}` in dict, `${lang}: flag.${f}`);
  });

  it('every software category and driver component has an English and Indonesian label', async () => {
    const { CATEGORIES, COMPONENTS } = await import('../../assets/js/lib/model.js');
    for (const c of CATEGORIES) { assert.ok(c.label.en && c.label.id, c.id); assert.notEqual(c.label.en, '', c.id); }
    for (const [k, v] of Object.entries(COMPONENTS)) assert.ok(v.en && v.id, k);
  });
});

const pages = await Promise.all(PAGES.map(async (p) => ({ ...p, html: await readText(p.file) })));

describe('HTML pages', () => {
  for (const page of pages) {
    describe(page.file, () => {
      it('declares English as the default language', () => assert.match(page.html, /<html lang="en">/));

      it('every data-i18n key exists and its default text equals the English dictionary', () => {
        const re = /<([a-z][a-z0-9]*)\b[^>]*?\bdata-i18n="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
        let n = 0;
        for (const m of page.html.matchAll(re)) {
          n++;
          const [, , key, inner] = m;
          assert.ok(key in en && key in id, `${page.file}: unknown key ${key}`);
          assert.doesNotMatch(inner, /</, `${page.file}: <${m[1]} data-i18n="${key}"> must contain text only (textContent would erase child elements)`);
          assert.equal(norm(inner), norm(en[key]), `${page.file}: default text of ${key} differs from en.js`);
        }
        assert.ok(n > 0 || page.key === 'home' === false, `${page.file}: expected translated elements`);
      });

      for (const [dataAttr, attr] of [['data-i18n-aria-label', 'aria-label'], ['data-i18n-placeholder', 'placeholder'], ['data-i18n-title', 'title'], ['data-i18n-alt', 'alt']]) {
        it(`every ${dataAttr} key exists and the ${attr} default equals English`, () => {
          for (const tag of page.html.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/g)) {
            const key = tag[0].match(new RegExp(`\\s${dataAttr}="([^"]+)"`))?.[1];
            if (!key) continue;
            assert.ok(key in en && key in id, `${page.file}: unknown key ${key}`);
            const base = tag[0].match(new RegExp(`\\s${attr}="([^"]*)"`))?.[1];
            assert.ok(base !== undefined, `${page.file}: ${tag[0].slice(0, 80)} has ${dataAttr} but no ${attr}`);
            assert.equal(norm(base), norm(en[key]), `${page.file}: default ${attr} of ${key} differs from en.js`);
          }
        });
      }

      it('long-prose blocks come in en/id pairs, English visible and Indonesian hidden at load, each with a matching lang', () => {
        const tags = [...page.html.matchAll(/<[a-z][a-z0-9]*\b[^>]*\bdata-lang-block="(en|id)"[^>]*>/g)];
        const order = tags.map((m) => m[1]);
        if (page.key === 'developers') {
          // The developer docs are English by design (they mirror the code and schemas); the page offers one
          // Indonesian summary notice, shown only when Indonesian is selected.
          assert.ok(order.every((x) => x === 'id'), 'the developers page has Indonesian-only summary blocks');
        } else {
          assert.equal(order.filter((x) => x === 'en').length, order.filter((x) => x === 'id').length, 'equal number of en and id blocks');
          for (let i = 0; i < order.length; i += 2) assert.deepEqual(order.slice(i, i + 2), ['en', 'id'], `block ${i / 2}: an English block is followed by its Indonesian twin`);
        }
        for (const m of tags) {
          assert.match(m[0], new RegExp(`\\slang="${m[1]}"`), `a ${m[1]} block declares lang="${m[1]}" so screen readers pronounce it correctly`);
          if (m[1] === 'id') assert.match(m[0], /\shidden(\s|>|=)/, 'Indonesian blocks start hidden');
          else assert.doesNotMatch(m[0], /\shidden(\s|>|=)/, 'English blocks start visible');
        }
      });

      it('has no leftover template placeholders', () => assert.doesNotMatch(page.html, /\{\{|\}\}|TODO|FIXME|lorem ipsum/i));
    });
  }
});

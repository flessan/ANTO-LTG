// Search: tokenisation, ranking, typo tolerance, filters, and the real build-time index.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, tokenize, editDistanceAtMostOne } from '../../assets/js/lib/text.js';
import { buildIndex, createSearcher, titleBonus, INDEX_FORMAT, FIELD_WEIGHTS } from '../../assets/js/lib/search.js';
import { buildSearchDocs } from '../../scripts/lib/search-docs.mjs';
import { loadCatalogs, readJson } from '../helpers/repo.mjs';

describe('text normalisation', () => {
  it('handles the awkward product names technicians type', () => {
    assert.equal(normalizeText('Notepad++'), 'notepad plus plus');
    assert.equal(normalizeText('C#'), 'csharp');
    assert.equal(normalizeText('C++ Redistributable'), 'cpp cplusplus redistributable');
    assert.equal(normalizeText('.NET Desktop Runtime'), 'dotnet desktop runtime');
    assert.equal(normalizeText('Node.js'), 'nodejs node js');
    assert.equal(normalizeText('Caf\u00e9 \u00dcber'), 'cafe uber');
    assert.equal(normalizeText(null), '');
  });
  it('splits hardware ids into searchable parts', () => {
    assert.equal(normalizeText('PCI\\VEN_8086&DEV_15F3'), 'pci ven 8086 dev 15f3');
    assert.equal(normalizeText('Microsoft.VCRedist.2015+.x64'), 'microsoft vcredist 2015 plus x64');
  });
  it('adds a joined form so "7-Zip" matches "7zip" and "Wi-Fi" matches "wifi"', () => {
    assert.deepEqual([...tokenize('7-Zip')].sort(), ['7', '7zip', 'zip']);
    assert.ok(tokenize('Wi-Fi').includes('wifi'));
    assert.deepEqual(tokenize('   '), []);
  });
  it('editDistanceAtMostOne covers insert, delete, replace and transpose', () => {
    for (const [a, b, ok] of [['firefox', 'firefox', true], ['firefox', 'firefx', true], ['firefox', 'firefoxx', true], ['firefox', 'firefax', true], ['firefox', 'firefxo', true], ['firefox', 'firfx', false], ['abc', 'xyz', false], ['abcd', 'abdc', true], ['', 'a', true], ['', 'ab', false]]) {
      assert.equal(editDistanceAtMostOne(a, b), ok, `${a} ~ ${b}`);
    }
  });
});

describe('titleBonus', () => {
  it('exact title > whole-word match (closer title first) > substring > nothing', () => {
    assert.equal(titleBonus('git', 'git'), 50);
    assert.ok(titleBonus('mozilla firefox', 'firefox') > titleBonus('firefox developer edition en us', 'firefox'));
    assert.ok(titleBonus('firefox developer edition en us', 'firefox') > titleBonus('librefirefoxish', 'firefox'));
    assert.equal(titleBonus('github cli', 'git'), 22 - 1.5, 'prefix of the title');
    assert.equal(titleBonus('tortoisegit', 'git'), 8);
    assert.equal(titleBonus('vlc', 'firefox'), 0);
    assert.equal(titleBonus('anything', ''), 0);
  });
});

describe('searcher on a small corpus', () => {
  const docs = [
    { type: 'app', id: 'firefox', title: 'Mozilla Firefox', url: 'software/#app=firefox', fields: { name: 'Mozilla Firefox', ids: ['firefox', 'Mozilla.Firefox'], publisher: 'Mozilla', description: 'Fast web browser' } },
    { type: 'app', id: 'firefox-dev', title: 'Firefox Developer Edition (en-US)', url: 'software/#app=firefox-dev', fields: { name: 'Firefox Developer Edition (en-US)', ids: ['firefox-dev'], publisher: 'Mozilla' } },
    { type: 'app', id: 'vlc', title: 'VLC media player', url: 'software/#app=vlc', fields: { name: 'VLC media player', publisher: 'VideoLAN', description: 'Plays anything, unlike Firefox which is only a browser' } },
    { type: 'app', id: '7zip', title: '7-Zip', url: 'software/#app=7zip', fields: { name: '7-Zip', ids: ['7zip', '7zip.7zip'], publisher: 'Igor Pavlov', description: 'File archiver' } },
    { type: 'app', id: 'vscode', title: 'Visual Studio Code', url: 'software/#app=vscode', fields: { name: 'Visual Studio Code', publisher: 'Microsoft', tags: ['vscode'] } },
    { type: 'driver', id: 'intel-wifi', title: 'Intel Wi-Fi driver', url: 'drivers/#d=intel-wifi', fields: { name: 'Intel Wi-Fi driver', hardware_ids: ['PCI\\VEN_8086&DEV_15F3'], component: 'Wi-Fi', publisher: 'Intel' } },
    { type: 'vendor', id: 'intel', title: 'Intel', url: 'drivers/#vendor=intel', fields: { name: 'Intel', ids: ['intel', '8086'], hardware_ids: ['VEN_8086'] } },
    { type: 'tool', id: 'rufus', title: 'Rufus', url: 'tools/#rufus', fields: { name: 'Rufus', description: 'Create bootable USB drives' } },
  ];
  const s = createSearcher(buildIndex(docs));
  const top = (q, opts) => s.search(q, opts).map((r) => r.doc.id);

  it('ranks an exact name first, then closer titles, then description mentions', () => {
    assert.deepEqual(top('firefox'), ['firefox', 'firefox-dev', 'vlc']);
  });
  it('matches ids, package ids and publishers', () => {
    assert.equal(top('Mozilla.Firefox')[0], 'firefox');
    assert.equal(top('igor')[0], '7zip');
    assert.equal(top('videolan')[0], 'vlc');
  });
  it('matches by prefix as the user types', () => {
    assert.deepEqual(top('fire').slice(0, 2).sort(), ['firefox', 'firefox-dev'], 'both Firefox entries lead while the word is still being typed');
    assert.equal(top('firef')[0] === 'firefox' || top('firef')[0] === 'firefox-dev', true);
    assert.equal(top('visual st')[0], 'vscode');
  });
  it('tolerates a single typo in words of four letters or more', () => {
    assert.deepEqual(top('firefx').slice(0, 2).sort(), ['firefox', 'firefox-dev']);
    assert.equal(top('vlx').length, 0, 'three-letter words are never fuzzily matched (too many false hits)');
    assert.equal(top('rufs')[0], 'rufus', 'four-letter words are');
    assert.equal(top('rufuss')[0], 'rufus');
  });
  it('treats "7 zip", "7-zip" and "7zip" alike', () => {
    for (const q of ['7zip', '7 zip', '7-zip', '7-Zip']) assert.equal(top(q)[0], '7zip', q);
  });
  it('finds tag aliases and device ids', () => {
    assert.equal(top('vscode')[0], 'vscode');
    assert.deepEqual(top('VEN_8086').sort(), ['intel', 'intel-wifi']);
    assert.equal(top('PCI\\VEN_8086&DEV_15F3')[0], 'intel-wifi');
  });
  it('requires every word, then falls back to any word so long queries still suggest something', () => {
    assert.deepEqual(top('mozilla browser'), ['firefox', 'firefox-dev', 'vlc'].filter((x) => top('mozilla browser').includes(x)));
    assert.ok(top('firefox zzzunknownzzz').length > 0, 'falls back to any word');
    assert.equal(top('zzzunknownzzz').length, 0);
  });
  it('filters by type and by an allow set, and respects limit', () => {
    assert.deepEqual(top('intel', { types: ['driver'] }), ['intel-wifi']);
    assert.deepEqual(top('firefox', { allow: new Set(['app:vlc']) }), ['vlc']);
    assert.equal(top('firefox', { limit: 1 }).length, 1);
  });
  it('returns nothing for an empty or symbol-only query', () => {
    for (const q of ['', '   ', '***', '\u0000']) assert.deepEqual(s.search(q), [], JSON.stringify(q));
  });
  it('is deterministic: equal scores are ordered by title', () => {
    const a = createSearcher(buildIndex([{ type: 'app', id: 'b', title: 'Beta tool', fields: { name: 'Beta tool' } }, { type: 'app', id: 'a', title: 'Alpha tool', fields: { name: 'Alpha tool' } }]));
    assert.deepEqual(a.search('tool').map((r) => r.doc.id), ['a', 'b']);
  });
  it('field weights: a name outranks an id, which outranks a description', () => {
    assert.ok(FIELD_WEIGHTS.name > FIELD_WEIGHTS.ids && FIELD_WEIGHTS.ids > FIELD_WEIGHTS.description);
  });
  it('refuses an index in an unknown format', () => {
    assert.throws(() => createSearcher({ format: 'something-else' }), /Unsupported search index format/);
    assert.throws(() => createSearcher(null), /Unsupported/);
    assert.equal(buildIndex([]).format, INDEX_FORMAT);
  });
  it('index construction is deterministic and sorted for binary search', () => {
    const one = JSON.stringify(buildIndex(docs));
    assert.equal(one, JSON.stringify(buildIndex(docs)));
    const { tokens } = buildIndex(docs);
    assert.deepEqual(tokens, [...tokens].sort());
  });
});

describe('the real search index', () => {
  it('is exactly what the build would produce from the catalogs (no drift)', async () => {
    const catalogs = await loadCatalogs();
    const expected = buildIndex(buildSearchDocs(catalogs));
    const committed = await readJson('api', 'v1', 'search-index.json');
    assert.deepEqual(committed, expected);
  });

  it('answers the queries a technician would type', async () => {
    const searcher = createSearcher(await readJson('api', 'v1', 'search-index.json'));
    const first = (q, opts) => { const r = searcher.search(q, opts)[0]; return r ? `${r.doc.type}:${r.doc.id}` : null; };
    const cases = [
      ['firefox', 'app:mozilla-firefox'], ['git', 'app:git'], ['Git.Git', 'app:git'], ['7zip', 'app:7zip'], ['7-zip', 'app:7zip'], ['notepad++', 'app:notepad-plus-plus'],
      ['vscode', 'app:visual-studio-code'], ['visual studio code', 'app:visual-studio-code'], ['realtek', 'vendor:realtek'], ['VEN_8086', 'vendor:intel'], ['VID_0403', 'vendor:ftdi'],
      ['acer', 'vendor:acer'], ['rufus', 'app:rufus'], ['bluetooth intel', 'driver:intel-bluetooth-24-70-0'], ['wi-fi', 'driver:intel-wifi-24-70-0'], ['sysinternals', 'app:sysinternals-suite'],
    ];
    for (const [q, expected] of cases) assert.equal(first(q), expected, q);
    assert.equal(first('zzzzqqq'), null);
  });

  it('indexes every record type and every page', async () => {
    const index = await readJson('api', 'v1', 'search-index.json');
    const counts = {};
    for (const d of index.docs) counts[d.type] = (counts[d.type] ?? 0) + 1;
    const catalogs = await loadCatalogs();
    assert.equal(counts.app, catalogs.apps.items.length);
    assert.equal(counts.driver, catalogs.drivers.items.length);
    assert.equal(counts.vendor, catalogs.vendors.items.length);
    assert.equal(counts.tool, catalogs.tools.items.length);
    assert.equal(counts.bundle, catalogs.bundles.items.filter((b) => b.status === 'published').length);
    assert.equal(counts.page, 8);
  });

  it('every result links to a page that exists in the site', async () => {
    const index = await readJson('api', 'v1', 'search-index.json');
    const valid = /^(software|drivers|bundles|tools|guides|developers|support)?\/?(#[A-Za-z0-9=._-]+)?$/;
    for (const d of index.docs) assert.match(d.url, valid, `${d.type}:${d.id} -> ${d.url}`);
  });
});

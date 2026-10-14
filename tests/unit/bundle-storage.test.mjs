// Portable bundle manifests, share codes and the localStorage guard rails.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST_FORMAT, MANIFEST_VERSION, ID_RE, MAX_APPS, MAX_MANIFEST_BYTES, cleanName, createManifest, manifestToJson, parseManifest, encodeShare, decodeShare,
} from '../../assets/js/lib/bundle.js';
import { KEYS, createStorage, loadSelection, saveSelection, loadBundles, saveBundle, deleteBundle } from '../../assets/js/lib/storage.js';
import { loadSchemas, createValidators } from '../../scripts/lib/schema.mjs';
import { fromRoot, loadCatalogs } from '../helpers/repo.mjs';

const known = new Set(['git', 'mozilla-firefox', '7zip', 'visual-studio-code']);
const apps = [{ id: 'git', name: 'Git', winget_id: 'Git.Git' }, { id: '7zip', name: '7-Zip', winget_id: '7zip.7zip' }];
const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); }, removeItem: (k) => { data.delete(k); }, data };
};

describe('cleanName', () => {
  it('strips angle brackets and control characters, collapses space and caps at 80', () => {
    assert.equal(cleanName('  My <b>kit</b>\u0000\n  for   PCs '), 'My bkit/b for PCs');
    assert.equal(cleanName('x'.repeat(200)).length, 80);
  });
  it('falls back when nothing is left', () => {
    assert.equal(cleanName('<>'), 'My bundle');
    assert.equal(cleanName('', 'Imported bundle'), 'Imported bundle');
    assert.equal(cleanName(null), 'My bundle');
  });
});

describe('createManifest / parseManifest', () => {
  const manifest = createManifest({ name: 'Field kit', apps, os: 'windows10', method: 'winget', options: { silent: false }, catalog: { schema_version: '1.1.0', app_count: 278 }, now: '2026-10-13T00:00:00.000Z' });

  it('produces the documented format', () => {
    assert.equal(manifest.format, MANIFEST_FORMAT);
    assert.equal(manifest.format_version, MANIFEST_VERSION);
    assert.deepEqual(manifest.target, { os: 'windows10' });
    assert.deepEqual(manifest.options, { accept_agreements: true, silent: false, include_unknown_compatibility: true });
    assert.deepEqual(manifest.apps, [{ id: 'git', name: 'Git', winget_id: 'Git.Git' }, { id: '7zip', name: '7-Zip', winget_id: '7zip.7zip' }]);
    assert.deepEqual(manifest.catalog, { schema_version: '1.1.0', app_count: 278 });
  });
  it('falls back to safe defaults for unknown targets and methods', () => {
    const m = createManifest({ name: 'x', apps: [], os: 'windows95', method: 'run-it-for-me' });
    assert.equal(m.target.os, 'windows11');
    assert.equal(m.method, 'winget');
    assert.equal('catalog' in m, false);
  });
  it('serialises with a trailing newline', () => assert.ok(manifestToJson(manifest).endsWith('}\n')));

  it('validates against the published JSON Schema', async () => {
    const v = createValidators(await loadSchemas(fromRoot('schemas')));
    const result = v.validate('bundle-manifest', JSON.parse(manifestToJson(manifest)));
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.equal(v.validate('bundle-manifest', { ...manifest, extra: 1 }).ok, false, 'additional properties are rejected');
    assert.equal(v.validate('bundle-manifest', { ...manifest, apps: [{ id: 'Not A Slug' }] }).ok, false);
  });

  it('round-trips through JSON and restores only ids that exist in the catalog', () => {
    const r = parseManifest(manifestToJson(manifest), { knownIds: known });
    assert.equal(r.ok, true);
    assert.deepEqual(r.manifest.ids, ['git', '7zip']);
    assert.equal(r.manifest.name, 'Field kit');
    assert.equal(r.manifest.os, 'windows10');
    assert.deepEqual(r.manifest.options, { acceptAgreements: true, silent: false, includeUnknown: true });
    assert.deepEqual(r.unknownIds, []);
  });

  it('drops unknown ids and reports them; never invents anything', () => {
    const doc = { ...manifest, apps: [{ id: 'git' }, { id: 'totally-new-app' }, { id: 'another-one' }] };
    const r = parseManifest(doc, { knownIds: known });
    assert.deepEqual(r.manifest.ids, ['git']);
    assert.deepEqual(r.unknownIds, ['totally-new-app', 'another-one']);
    assert.match(r.warnings.join(' '), /2 app id\(s\) are not in the current catalog/);
  });

  it('ignores package ids, commands and URLs smuggled into the file', () => {
    const doc = { ...manifest, apps: [{ id: 'git', winget_id: 'Evil.Pkg; calc', command: 'calc.exe', url: 'https://evil.example/x.exe', name: '<img src=x onerror=alert(1)>' }], run: 'calc.exe', script: 'Remove-Item C:\\' };
    const r = parseManifest(doc, { knownIds: known });
    assert.deepEqual(r.manifest.ids, ['git']);
    assert.deepEqual(Object.keys(r.manifest).sort(), ['ids', 'method', 'name', 'options', 'os']);
    assert.doesNotMatch(JSON.stringify(r), /Evil|calc|Remove-Item|evil\.example/);
  });

  it('skips malformed ids and removes duplicates', () => {
    const doc = { ...manifest, apps: [{ id: 'git' }, { id: 'git' }, { id: 'Git' }, { id: '../etc/passwd' }, { id: 5 }, null, 'git', { id: 'a'.repeat(100) }, { id: "git'; calc" }] };
    const r = parseManifest(doc, { knownIds: known });
    assert.deepEqual(r.manifest.ids, ['git']);
    assert.ok(r.warnings.some((w) => /malformed id/.test(w)));
  });

  it('sanitises name, target, method and options', () => {
    const doc = { ...manifest, name: '<script>alert(1)</script>', target: { os: 'dos' }, method: 'exec', options: { silent: 'yes', accept_agreements: 1, include_unknown_compatibility: false } };
    const r = parseManifest(doc, { knownIds: known });
    assert.equal(r.manifest.name, 'scriptalert(1)/script');
    assert.equal(r.manifest.os, 'windows11');
    assert.equal(r.manifest.method, 'winget');
    assert.deepEqual(r.manifest.options, { acceptAgreements: true, silent: true, includeUnknown: false });
  });

  it('rejects files that are not a manifest', () => {
    const cases = [
      ['not json {', /not valid JSON/], ['[]', /JSON object/], ['null', /JSON object/], ['"text"', /JSON object/], [{ format: 'other', format_version: 1, apps: [] }, /not an ANTO-LTG bundle/],
      [{ format: MANIFEST_FORMAT, format_version: 2, apps: [] }, /Unsupported manifest version/], [{ format: MANIFEST_FORMAT, format_version: 1 }, /no "apps" list/],
      [{ format: MANIFEST_FORMAT, format_version: 1, apps: Array.from({ length: MAX_APPS + 1 }, () => ({ id: 'git' })) }, /at most/],
    ];
    for (const [input, re] of cases) {
      const r = parseManifest(input, { knownIds: known });
      assert.equal(r.ok, false, JSON.stringify(input)?.slice(0, 50));
      assert.match(r.errors.join(' '), re);
    }
  });
  it('rejects oversized text before parsing it', () => {
    const r = parseManifest(`{"pad":"${'x'.repeat(MAX_MANIFEST_BYTES)}"}`, { knownIds: known });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /too large/);
  });
  it('does not allow prototype pollution through a hostile file', () => {
    const text = `{"format":"${MANIFEST_FORMAT}","format_version":1,"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"apps":[{"id":"git","__proto__":{"polluted":"yes"}}]}`;
    const r = parseManifest(text, { knownIds: known });
    assert.equal(r.ok, true);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  });
  it('the id pattern is a strict slug', () => {
    for (const ok of ['git', '7zip', 'mozilla-firefox', 'a1-b2']) assert.match(ok, ID_RE);
    for (const bad of ['', 'Git', '-git', 'git-', 'git--x', 'git x', 'git_x', 'git/x', 'git.x']) assert.doesNotMatch(bad, ID_RE);
  });
});

describe('share codes', () => {
  it('round-trip ids, target, method and name', () => {
    const code = encodeShare({ ids: ['git', '7zip'], os: 'windows10', method: 'download-kit', name: 'My <kit>' });
    const r = decodeShare(`#${code}`, { knownIds: known });
    assert.deepEqual(r, { ids: ['git', '7zip'], unknownIds: [], os: 'windows10', method: 'download-kit', name: 'My kit' });
  });
  it('encodes only well-formed ids', () => assert.equal(new URLSearchParams(encodeShare({ ids: ['git', 'bad id', "x'; calc", '../x'] })).get('apps'), 'git'));
  it('reports unknown ids and ignores malformed ones', () => {
    const r = decodeShare('#apps=git,mystery-app,BAD,../x,mozilla-firefox,git', { knownIds: known });
    assert.deepEqual(r.ids, ['git', 'mozilla-firefox']);
    assert.deepEqual(r.unknownIds, ['mystery-app']);
  });
  it('falls back for hostile os / method values and cleans the name', () => {
    const r = decodeShare(`#apps=git&os=../../x&method=iex&name=${encodeURIComponent('<img src=x onerror=alert(1)>')}`, { knownIds: known });
    assert.equal(r.os, 'windows11');
    assert.equal(r.method, 'winget');
    assert.equal(r.name, 'img src=x onerror=alert(1)');
  });
  it('returns null when there is nothing to restore or the hash is absurdly long', () => {
    assert.equal(decodeShare('', { knownIds: known }), null);
    assert.equal(decodeShare('#section', { knownIds: known }), null);
    assert.equal(decodeShare(`#apps=${'git,'.repeat(10000)}`, { knownIds: known }), null);
    assert.equal(decodeShare(undefined, { knownIds: known }), null);
  });
  it('caps the number of ids it will read', () => {
    const many = new Set(Array.from({ length: 800 }, (_, i) => `app-${i}`));
    const r = decodeShare(`#apps=${[...many].join(',')}`, { knownIds: many });
    assert.equal(r.ids.length, MAX_APPS);
  });
});

describe('storage guard rails', () => {
  it('reads and writes JSON through a backend', () => {
    const s = createStorage(memory());
    assert.equal(s.write('k', { a: 1 }), true);
    assert.deepEqual(s.read('k', null), { a: 1 });
    assert.equal(s.remove('k'), true);
    assert.equal(s.read('k', 'fallback'), 'fallback');
    assert.equal(s.available, true);
  });
  it('never throws on corrupt, oversized or missing values', () => {
    const s = createStorage(memory({ bad: '{not json', huge: 'x'.repeat(400_001) }));
    assert.equal(s.read('bad', 'fb'), 'fb');
    assert.equal(s.read('huge', 'fb'), 'fb');
    assert.equal(s.read('missing', 'fb'), 'fb');
  });
  it('survives quota errors and private-mode backends that throw', () => {
    const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('QuotaExceededError'); }, removeItem() { throw new Error('denied'); } };
    const s = createStorage(throwing);
    assert.equal(s.read('k', 'fb'), 'fb');
    assert.equal(s.write('k', 1), false);
    assert.equal(s.remove('k'), false);
  });
  it('works without any storage at all', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
      const s = createStorage();
      assert.equal(s.available, false);
      assert.equal(s.read('k', 'fb'), 'fb');
      assert.equal(s.write('k', 1), false);
    } finally { if (saved) Object.defineProperty(globalThis, 'localStorage', saved); else delete globalThis.localStorage; }
  });
});

describe('selection persistence', () => {
  it('defaults to an empty Windows 11 WinGet selection', () => assert.deepEqual(loadSelection(createStorage(memory())), { ids: [], os: 'windows11', method: 'winget' }));
  it('saves and restores, de-duplicating and dropping malformed ids', () => {
    const s = createStorage(memory());
    saveSelection(s, { ids: ['git', 'git', 'Bad Id', "x'; calc", 5, null, '7zip'], os: 'windows10', method: 'download-kit' });
    assert.deepEqual(loadSelection(s), { ids: ['git', '7zip'], os: 'windows10', method: 'download-kit' });
  });
  it('sanitises a tampered stored value', () => {
    const s = createStorage(memory({ [KEYS.selection]: JSON.stringify({ ids: ['git', { x: 1 }, '../x'], os: 'dos', method: 'iex' }) }));
    assert.deepEqual(loadSelection(s), { ids: ['git'], os: 'windows11', method: 'winget' });
    for (const raw of ['null', '[]', '"x"', '42']) assert.deepEqual(loadSelection(createStorage(memory({ [KEYS.selection]: raw }))).ids, [], raw);
  });
  it('caps the number of stored ids', () => {
    const s = createStorage(memory());
    saveSelection(s, { ids: Array.from({ length: 900 }, (_, i) => `app-${i}`), os: 'windows11', method: 'winget' });
    assert.equal(loadSelection(s).ids.length, 500);
  });
});

describe('saved bundles', () => {
  it('saves, lists and deletes named bundles', () => {
    const s = createStorage(memory());
    const r = saveBundle(s, '  Office <PCs>  ', { ids: ['git', 'bad id'], os: 'windows11', method: 'winget' }, '2026-10-13T00:00:00.000Z');
    assert.deepEqual(r, { ok: true, name: 'Office PCs' });
    assert.deepEqual(loadBundles(s), { 'Office PCs': { ids: ['git'], os: 'windows11', method: 'winget', saved_at: '2026-10-13T00:00:00.000Z' } });
    assert.equal(deleteBundle(s, 'Office PCs'), true);
    assert.deepEqual(loadBundles(s), {});
  });
  it('overwrites a bundle with the same name', () => {
    const s = createStorage(memory());
    saveBundle(s, 'A', { ids: ['git'], os: 'windows11', method: 'winget' });
    saveBundle(s, 'A', { ids: ['7zip'], os: 'windows10', method: 'winget' });
    assert.deepEqual(loadBundles(s).A.ids, ['7zip']);
    assert.equal(Object.keys(loadBundles(s)).length, 1);
  });
  it('stops at 50 bundles but still lets an existing one be updated', () => {
    const s = createStorage(memory());
    for (let i = 0; i < 50; i++) assert.equal(saveBundle(s, `bundle ${i}`, { ids: [], os: 'windows11', method: 'winget' }).ok, true);
    assert.deepEqual(saveBundle(s, 'one too many', { ids: [], os: 'windows11', method: 'winget' }), { ok: false, reason: 'limit' });
    assert.equal(saveBundle(s, 'bundle 3', { ids: ['git'], os: 'windows11', method: 'winget' }).ok, true);
  });
  it('reports storage failures instead of throwing', () => {
    const s = createStorage({ getItem: () => null, setItem() { throw new Error('QuotaExceededError'); }, removeItem() {} });
    assert.deepEqual(saveBundle(s, 'A', { ids: [], os: 'windows11', method: 'winget' }), { ok: false, reason: 'storage' });
  });
  it('ignores tampered entries when loading', () => {
    const s = createStorage(memory({ [KEYS.bundles]: JSON.stringify({ '<b>ok</b>': { ids: ['git', 'Bad'], os: 'dos', method: 'iex', saved_at: 'x'.repeat(100) }, '': { ids: ['git'] }, junk: 5, nul: null }) }));
    const all = loadBundles(s);
    assert.deepEqual(Object.keys(all), ['bok/b']);
    assert.deepEqual(all['bok/b'], { ids: ['git'], os: 'windows11', method: 'winget', saved_at: 'x'.repeat(30) });
    for (const raw of ['[]', 'null', '"x"']) assert.deepEqual(loadBundles(createStorage(memory({ [KEYS.bundles]: raw }))), {}, raw);
  });
});

describe('the real catalog bundles', () => {
  it('every published bundle resolves entirely to catalog apps and round-trips through a manifest', async () => {
    const { apps: appsDoc, bundles } = await loadCatalogs();
    const byId = new Map(appsDoc.items.map((a) => [a.id, a]));
    const ids = new Set(byId.keys());
    for (const b of bundles.items) {
      const members = b.app_ids.map((id) => byId.get(id));
      assert.ok(members.every(Boolean), `${b.id} references only real apps`);
      const m = createManifest({ name: b.name, apps: members });
      const r = parseManifest(manifestToJson(m), { knownIds: ids });
      assert.deepEqual(r.manifest.ids, b.app_ids, b.id);
      assert.deepEqual(r.unknownIds, []);
    }
  });
});

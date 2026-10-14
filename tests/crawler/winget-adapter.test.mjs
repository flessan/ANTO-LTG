// The winget-pkgs adapter, driven end-to-end against an in-memory GitHub API: version choice, manifest parsing,
// evidence-based compatibility, honest "not found" errors, incremental runs, truncation, and hostile manifests.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import adapter, { manifestDirFor, loadSeeds, buildAppProposal, PERSISTED_FLAGS, WINGET_ID_RE } from '../../scripts/crawler/adapters/winget.mjs';
import { createHttpClient } from '../../scripts/crawler/lib/http.mjs';
import { loadSchemas, createValidators } from '../../scripts/lib/schema.mjs';
import { checkSemantics } from '../../scripts/lib/semantic.mjs';
import { planMerge } from '../../scripts/crawler/lib/merge.mjs';
import { CATEGORY_BY_ID } from '../../assets/js/lib/model.js';
import { fakeGithub, manifestFiles } from '../helpers/fake-github.mjs';
import { scriptedFetch, virtualClock } from '../helpers/net.mjs';
import { fromRoot, loadCatalogs } from '../helpers/repo.mjs';

const NOW = '2026-10-13T00:00:00.000Z';
const CFG = { repo: 'microsoft/winget-pkgs', branch: 'master', seed_file: 'seeds.json', default_locale: 'en-US', limit: null };

async function run(files, { seeds = { categories: { utilities: ['Example.App'] } }, targets, incremental = false, previous = {}, failures = {}, head, cfg = {}, auth } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anto-ltg-winget-'));
  try {
    await writeFile(path.join(dir, 'seeds.json'), JSON.stringify(seeds));
    const gh = fakeGithub(files, { failures, head });
    const net = scriptedFetch(gh.handler);
    const clock = virtualClock();
    const client = createHttpClient({ fetchImpl: net.fetchImpl, sleep: clock.sleep, now: clock.now, checkDns: false, allowedHosts: ['api.github.com'], perHostMinIntervalMs: 0, retries: 0, auth: auth ?? {} });
    const result = await adapter.run({ cfg: { ...CFG, ...cfg }, ctx: { client, now: () => NOW, rootUrl: pathToFileURL(dir + path.sep), targets, concurrency: 2, incremental, previous } });
    return { ...result, gh, calls: net.calls };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('manifestDirFor and package ids', () => {
  it('maps an id to its directory in the winget-pkgs layout', () => {
    assert.equal(manifestDirFor('Git.Git'), 'manifests/g/Git/Git');
    assert.equal(manifestDirFor('Microsoft.VisualStudioCode'), 'manifests/m/Microsoft/VisualStudioCode');
    assert.equal(manifestDirFor('7zip.7zip'), 'manifests/7/7zip/7zip');
    assert.equal(manifestDirFor('Notepad++.Notepad++'), 'manifests/n/Notepad++/Notepad++');
    assert.equal(manifestDirFor('Microsoft.VCRedist.2015+.x64'), 'manifests/m/Microsoft/VCRedist/2015+/x64');
  });
  it('refuses a malformed id before any request could be built from it', () => {
    for (const id of ['', '../../etc/passwd', 'Git.Git/../../x', 'a b', 'Git.Git?x=1', 'Git.Git#', '.hidden', '-flag', 'x'.repeat(200), 'Evil.App; rm -rf', 'Evil\nApp', null, undefined]) assert.throws(() => manifestDirFor(id), /Refusing malformed/, String(id));
    assert.ok(WINGET_ID_RE.test('Git.Git'));
  });
});

describe('the seed file (package ids come only from here and are proven to exist)', () => {
  it('the real seed file has 250+ unique, valid ids in known categories', async () => {
    const seeds = await loadSeeds(fromRoot('scripts', 'crawler', 'seeds', 'winget.json'));
    assert.ok(seeds.size >= 250, `only ${seeds.size} seeds`);
    for (const [id, spec] of seeds) { assert.match(id, WINGET_ID_RE); assert.ok(CATEGORY_BY_ID[spec.category], `${id}: unknown category ${spec.category}`); }
    assert.equal(new Set([...seeds.keys()].map((i) => i.toLowerCase())).size, seeds.size, 'no case-insensitive duplicates');
    assert.deepEqual(seeds.get('Microsoft.VisualStudioCode').tags, ['vscode']);
  });
  it('every seed id exists in the catalog (the catalog was built from these seeds)', async () => {
    const seeds = await loadSeeds(fromRoot('scripts', 'crawler', 'seeds', 'winget.json'));
    const { apps } = await loadCatalogs();
    const known = new Set(apps.items.map((a) => a.winget_id?.toLowerCase()).filter(Boolean));
    const missing = [...seeds.keys()].filter((id) => !known.has(id.toLowerCase()));
    assert.deepEqual(missing, []);
  });
  const withSeedFile = async (content, fn) => { const dir = await mkdtemp(path.join(os.tmpdir(), 'anto-ltg-seed-')); try { await writeFile(path.join(dir, 's.json'), JSON.stringify(content)); return await fn(path.join(dir, 's.json')); } finally { await rm(dir, { recursive: true, force: true }); } };
  it('rejects an invalid id, a duplicate id and accepts both entry shapes', async () => {
    await withSeedFile({ categories: { utilities: ['Good.One', { winget_id: 'Also.Good', id: 'custom-id', tags: ['x'] }] } }, async (f) => {
      const s = await loadSeeds(f);
      assert.deepEqual([...s.keys()], ['Good.One', 'Also.Good']);
      assert.deepEqual(s.get('Also.Good'), { category: 'utilities', id: 'custom-id', tags: ['x'] });
    });
    await withSeedFile({ categories: { utilities: ['Bad Id; calc'] } }, (f) => assert.rejects(loadSeeds(f), /invalid WinGet ID/));
    await withSeedFile({ categories: { utilities: ['A.B'], media: ['A.B'] } }, (f) => assert.rejects(loadSeeds(f), /twice/));
    await withSeedFile({ categories: { utilities: [{ id: 'no-package-id' }] } }, (f) => assert.rejects(loadSeeds(f), /invalid WinGet ID/));
    await withSeedFile({ categories: { utilities: [{ winget_id: 42 }, ] } }, (f) => assert.rejects(loadSeeds(f), /invalid WinGet ID/));
  });
});

describe('crawling a package', () => {
  const files = manifestFiles({ id: 'Example.App', version: '1.2.0', locale: { Tags: ['Utility', 'Open Source'] } });

  it('turns the three manifests into one reviewable proposal', async () => {
    const r = await run(files, { seeds: { categories: { 'developer-tools': [{ winget_id: 'Example.App', id: 'example-app', tags: ['seed-tag'] }] } } });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(r.proposals.length, 1);
    const p = r.proposals[0];
    assert.deepEqual([p.target, p.key], ['Example.App', 'winget:example.app']);
    const rec = p.record;
    assert.deepEqual([rec.id, rec.name, rec.publisher, rec.category, rec.winget_id, rec.version, rec.release_date, rec.license], ['example-app', 'Example App', 'Example Publisher', 'developer-tools', 'Example.App', '1.2.0', '2026-09-30', 'MIT']);
    assert.equal(rec.description, 'An example application for testing the crawler.');
    assert.deepEqual([rec.verification_status, rec.windows_compatibility], ['not_reviewed', 'not_reviewed']);
    assert.deepEqual(rec.architectures, ['x64']);
    assert.deepEqual(rec.installer_types, ['inno']);
    assert.deepEqual(rec.installer_scopes, ['machine']);
    assert.equal(rec.portable, false);
    assert.deepEqual(rec.tags, ['seed-tag', 'utility', 'open source']);
    assert.equal(rec.source_url, 'https://example.com/App', 'the package page wins over the publisher page');
    assert.equal(rec.source_kind, 'official_project_site');
    assert.equal(rec.license_url, 'https://example.com/license');
  });

  it('copies the installer URL and the hash that the manifest states; never computes one', async () => {
    const [{ record }] = (await run(files)).proposals;
    assert.equal(record.downloads.length, 1);
    const d = record.downloads[0];
    assert.deepEqual([d.kind, d.architecture, d.installer_type, d.scope, d.stability], ['direct_binary', 'x64', 'inno', 'machine', 'versioned']);
    assert.equal(d.url, 'https://example.com/dl/Example.App-1.2.0-x64.exe');
    assert.equal(d.sha256, 'a'.repeat(64), 'lower-cased from the manifest');
    assert.equal(d.sha256_source, 'winget-pkgs installer manifest');
    assert.deepEqual(d.link_check, { status: 'unchecked' }, 'a link is never marked checked just because a manifest lists it');
    assert.match(d.evidence, /listed in a winget-pkgs manifest/);
  });

  it('declares compatibility only from MinimumOSVersion, as "declared" (not tested) with its basis', async () => {
    const [{ record }] = (await run(files)).proposals;
    assert.deepEqual(record.compatibility, { windows10: 'declared', windows11: 'declared', min_os_version: '10.0.17763.0', basis: 'winget-pkgs MinimumOSVersion', note: 'Declared by the package manifest; not tested by ANTO-LTG.' });
    const noMin = manifestFiles({ id: 'Example.App', version: '1.0.0' });
    for (const k of Object.keys(noMin)) noMin[k] = noMin[k].replace('MinimumOSVersion: 10.0.17763.0\n', '');
    const [{ record: r2, meta }] = (await run(noMin)).proposals;
    assert.deepEqual([r2.compatibility.windows10, r2.compatibility.windows11, r2.compatibility.min_os_version], ['unknown', 'unknown', null]);
    assert.ok(meta.quality_flags.includes('min_os_not_declared'));
  });

  it('records where each field came from: the manifest directory, the repository commit and the retrieval time', async () => {
    const r = await run(files, { head: 'c0ffee'.padEnd(40, '0') });
    const [{ record, meta }] = r.proposals;
    assert.equal(record.sources.length, 1);
    const s = record.sources[0];
    assert.deepEqual([s.id, s.kind, s.retrieved_at], ['winget-pkgs', 'package_index', NOW]);
    assert.equal(s.url, 'https://github.com/microsoft/winget-pkgs/tree/master/manifests/e/Example/App/1.2.0');
    assert.equal(s.ref, `microsoft/winget-pkgs@${'c0ffee'.padEnd(40, '0')}`);
    for (const f of ['name', 'publisher', 'description', 'version', 'release_date', 'compatibility', 'downloads', 'architectures']) assert.ok(s.fields.includes(f), f);
    assert.equal(meta.source_ref, s.ref);
    assert.equal(meta.manifest_version, '1.2.0');
    assert.match(meta.fingerprint, /Example\.App\.installer\.yaml:[0-9a-f]{40}/);
    assert.deepEqual(r.source, { id: 'winget-pkgs', repo: 'microsoft/winget-pkgs', ref: 'master', commit: 'c0ffee'.padEnd(40, '0') });
  });

  it('can never produce anything but not_reviewed (the adapter has no way to verify)', async () => {
    const r = await run({ ...files, ...manifestFiles({ id: 'Other.Tool', version: '2.0' }) }, { seeds: { categories: { utilities: ['Example.App', 'Other.Tool'] } } });
    assert.equal(r.proposals.length, 2);
    for (const p of r.proposals) { assert.equal(p.record.verification_status, 'not_reviewed'); assert.ok(!('reviewed_at' in p.record) && !('review_notes' in p.record) && !('evidence_url' in p.record)); }
  });

  it('chooses the newest STABLE version numerically and ignores directories that are not versions', async () => {
    const all = {};
    for (const v of ['1.2.0', '1.9.0', '1.10.0', '2.0.0-beta.1']) Object.assign(all, manifestFiles({ id: 'Example.App', version: v }));
    all['manifests/e/Example/App/Beta/readme.txt'] = 'not a version';
    const [{ record, meta }] = (await run(all)).proposals;
    assert.equal(record.version, '1.10.0');
    assert.equal(meta.manifest_version, '1.10.0');
  });

  it('falls back to an older version directory when the newest holds only sub-packages (and says so)', async () => {
    const all = { ...manifestFiles({ id: 'Example.App', version: '1.0.0' }), 'manifests/e/Example/App/2.0.0/Example.App.Beta/readme.txt': 'a sub-package directory' };
    const [{ record, meta }] = (await run(all)).proposals;
    assert.equal(record.version, '1.0.0');
    assert.ok(meta.quality_flags.includes('newest_version_directory_unusable'));
  });

  it('reads a singleton manifest (one file instead of three)', async () => {
    const single = { 'manifests/s/Single/Tool/3.1/Single.Tool.yaml': 'PackageIdentifier: Single.Tool\nPackageVersion: 3.1\nPackageLocale: en-US\nPublisher: Solo\nPackageName: Single Tool\nLicense: MIT\nShortDescription: A singleton manifest used by older packages.\nInstallers:\n- Architecture: x86\n  InstallerType: msi\n  InstallerUrl: https://example.com/single.msi\n  InstallerSha256: ' + 'B'.repeat(64) + '\nManifestType: singleton\nManifestVersion: 1.0.0\n' };
    const r = await run(single, { seeds: { categories: { utilities: ['Single.Tool'] } } });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.deepEqual([r.proposals[0].record.name, r.proposals[0].record.version, r.proposals[0].record.architectures], ['Single Tool', '3.1', ['x86']]);
  });

  it('uses the locale named by the version manifest, else any locale file', async () => {
    const f = manifestFiles({ id: 'Example.App', version: '1.0.0' });
    const key = Object.keys(f).find((k) => k.endsWith('locale.en-US.yaml'));
    f[key.replace('en-US', 'de-DE')] = f[key].replace('Example App', 'Beispiel').replace('en-US', 'de-DE');
    delete f[key];
    const [{ record }] = (await run(f)).proposals;
    assert.equal(record.name, 'Beispiel');
  });

  it('API calls go only to api.github.com/repos/microsoft/winget-pkgs; installers are never fetched', async () => {
    const r = await run(files);
    assert.ok(r.calls.length >= 5);
    for (const c of r.calls) assert.match(c.url, /^https:\/\/api\.github\.com\/repos\/microsoft\/winget-pkgs\/(contents|commits|git\/trees)\//, c.url);
    assert.ok(!r.calls.some((c) => c.url.includes('example.com')), 'the installer URL was never requested');
    for (const c of r.calls) assert.equal(c.method, 'GET');
  });
});

describe('honest errors: nothing is invented', () => {
  it('an id that does not exist is reported NOT_FOUND (permanent) and no record appears', async () => {
    const r = await run({}, { seeds: { categories: { utilities: ['Missing.Package'] } } });
    assert.equal(r.proposals.length, 0);
    assert.deepEqual(r.errors.map((e) => [e.target, e.code, e.retryable]), [['Missing.Package', 'NOT_FOUND', false]]);
    assert.match(r.errors[0].message, /manifests\/m\/Missing\/Package/);
  });
  it('a server error is recorded as retryable', async () => {
    const r = await run(manifestFiles({ id: 'Example.App', version: '1.0.0' }), { failures: { 'Example/App': 500 } });
    assert.deepEqual(r.errors.map((e) => [e.code, e.retryable]), [['HTTP_500', true]]);
  });
  it('a package whose newest versions have no usable manifest is NO_MANIFEST', async () => {
    const r = await run({ 'manifests/e/Example/App/1.0.0/other.txt': 'x' });
    assert.deepEqual(r.errors.map((e) => e.code), ['NO_MANIFEST']);
  });
  it('a directory with no version-like entries is NO_VERSION', async () => {
    const r = await run({ 'manifests/e/Example/App/Beta/x.yaml': 'x', 'manifests/e/Example/App/latest/y.yaml': 'y' });
    assert.deepEqual(r.errors.map((e) => e.code), ['NO_VERSION']);
  });
  it('one bad manifest does not stop the others', async () => {
    const f = { ...manifestFiles({ id: 'Good.One', version: '1.0' }), ...manifestFiles({ id: 'Bad.One', version: '1.0' }) };
    const badKey = Object.keys(f).find((k) => k.endsWith('Bad.One.locale.en-US.yaml'));
    f[badKey] = 'Publisher: &anchor x\nPackageName: *anchor\n';
    const r = await run(f, { seeds: { categories: { utilities: ['Good.One', 'Bad.One'] } } });
    assert.deepEqual(r.proposals.map((p) => p.target), ['Good.One']);
    assert.deepEqual(r.errors.map((e) => e.target), ['Bad.One']);
    assert.match(r.errors[0].message, /Anchors and aliases/);
    assert.deepEqual(r.attempted, ['Good.One', 'Bad.One']);
  });
  it('an id that was not seeded is refused (explicit targets may be extra, malformed ones never reach the network)', async () => {
    const f = manifestFiles({ id: 'Example.App', version: '1.0' });
    const refused = await run(f, { seeds: { categories: { utilities: [] } }, targets: ['../../etc/passwd'] });
    assert.equal(refused.proposals.length, 0);
    assert.equal(refused.errors[0].target, '../../etc/passwd');
    assert.ok(!refused.calls.some((c) => c.url.includes('passwd')), 'a malformed id never produced a request');
    const explicit = await run(f, { seeds: { categories: { utilities: [] } }, targets: ['Example.App'] });
    assert.equal(explicit.proposals.length, 1, 'an explicit --ids target is crawled even when it is not in the seed file');
  });
  it('--limit crawls only the first N seeds', async () => {
    const f = { ...manifestFiles({ id: 'A.One', version: '1' }), ...manifestFiles({ id: 'B.Two', version: '1' }), ...manifestFiles({ id: 'C.Three', version: '1' }) };
    const r = await run(f, { seeds: { categories: { utilities: ['A.One', 'B.Two', 'C.Three'] } }, cfg: { limit: 2 } });
    assert.deepEqual(r.attempted, ['A.One', 'B.Two']);
    assert.equal(r.stats.targets, 2);
  });
});

describe('incremental runs', () => {
  const files = manifestFiles({ id: 'Example.App', version: '1.0.0' });
  it('skips a package whose manifest fingerprint is unchanged, without downloading its manifests', async () => {
    const first = await run(files);
    const fingerprint = first.proposals[0].meta.fingerprint;
    const rawBefore = first.gh.calls.filter((c) => (c.accept ?? '').includes('raw')).length;
    assert.ok(rawBefore >= 3);
    const second = await run(files, { incremental: true, previous: { 'Example.App': { status: 'ok', fingerprint } } });
    assert.deepEqual([second.proposals.length, second.unchanged], [0, ['Example.App']]);
    assert.equal(second.gh.calls.filter((c) => (c.accept ?? '').includes('raw')).length, 0, 'no manifest files were fetched');
  });
  it('re-crawls when the fingerprint differs, when the last run failed, or when --incremental is off', async () => {
    const fp = (await run(files)).proposals[0].meta.fingerprint;
    assert.equal((await run(files, { incremental: true, previous: { 'Example.App': { status: 'ok', fingerprint: 'stale' } } })).proposals.length, 1);
    assert.equal((await run(files, { incremental: true, previous: { 'Example.App': { status: 'failed', fingerprint: fp } } })).proposals.length, 1);
    assert.equal((await run(files, { incremental: false, previous: { 'Example.App': { status: 'ok', fingerprint: fp } } })).proposals.length, 1);
  });
  it('the fingerprint changes when any manifest file changes', async () => {
    const a = (await run(files)).proposals[0].meta.fingerprint;
    const changed = { ...files }; const k = Object.keys(files).find((x) => x.endsWith('installer.yaml')); changed[k] = `${files[k]}# edited\n`;
    assert.notEqual((await run(changed)).proposals[0].meta.fingerprint, a);
  });
});

describe('very large version listings', () => {
  it('falls back to the git trees API when GitHub truncates a listing at 1000 entries', async () => {
    const files = { ...manifestFiles({ id: 'Example.App', version: '9.0.0' }) };
    for (let i = 0; i < 1100; i++) files[`manifests/e/Example/App/0.${i}/Example.App.locale.xx-${i}.yaml`] = 'x';
    const r = await run(files);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(r.proposals[0].record.version, '9.0.0', 'the newest version is found although the plain listing was cut at 1000');
    assert.ok(r.gh.calls.some((c) => c.url.includes('/git/trees/')), 'the trees API was used');
  });
});

describe('hostile manifests are treated as untrusted text', () => {
  const evil = (locale, installers) => manifestFiles({ id: 'Example.App', version: '1.0.0', locale, installers });
  it('strips markup, control characters and bidi overrides from every text field', async () => {
    const [{ record }] = (await run(evil({ Publisher: '"Evil <b>Corp</b>\\u202e"', PackageName: '"Name\\u0000<script>alert(1)</script>"', ShortDescription: '"Desc <img src=x onerror=alert(1)> ok"' }))).proposals;
    for (const field of [record.publisher, record.name, record.description]) { assert.doesNotMatch(field, /<|>|\u202e|\u0000/); }
    assert.equal(record.publisher, 'Evil Corp');
    assert.match(record.description, /^Desc\s+ok$/);
  });
  it('drops non-https and credential-bearing URLs and falls back to the package index page (with a flag)', async () => {
    const [{ record, meta }] = (await run(evil({ PublisherUrl: 'javascript:alert(1)', PackageUrl: 'http://example.com/insecure', LicenseUrl: 'https://user:pw@example.com/l' }))).proposals;
    assert.equal(record.source_url, 'https://github.com/microsoft/winget-pkgs/tree/master/manifests/e/Example/App/1.0.0');
    assert.equal(record.source_kind, 'package_index');
    assert.ok(!('license_url' in record));
    assert.ok(meta.quality_flags.includes('no_https_publisher_url'));
    assert.ok(record.quality_flags.includes('no_https_publisher_url'), 'user-visible flags are persisted on the record');
  });
  it('skips installers that are not https, flags them, and never stores a hash that is not 64 hex digits', async () => {
    const installers = [
      { Architecture: 'x64', InstallerUrl: 'http://example.com/a.exe', InstallerSha256: 'C'.repeat(64) },
      { Architecture: 'x86', InstallerUrl: 'https://example.com/b.exe', InstallerSha256: 'not-a-hash' },
      { Architecture: 'arm64', InstallerUrl: 'ftp://example.com/c.exe', InstallerSha256: 'D'.repeat(64) },
    ];
    const [{ record, meta }] = (await run(evil({}, installers))).proposals;
    assert.deepEqual(record.downloads.map((d) => [d.architecture, d.url]), [['x86', 'https://example.com/b.exe']]);
    assert.equal(record.downloads[0].sha256, null);
    assert.equal(record.downloads[0].sha256_source, null, 'no origin is claimed for a hash that does not exist');
    for (const f of ['installer_url_not_https', 'installer_without_sha256']) { assert.ok(meta.quality_flags.includes(f), f); assert.ok(record.quality_flags.includes(f), f); }
  });
  it('percent-encodes characters RFC 3986 forbids in installer URLs instead of storing them raw', async () => {
    const [{ record }] = (await run(evil({}, [{ Architecture: 'x64', InstallerUrl: 'https://example.com/dl/app[1].exe', InstallerSha256: 'E'.repeat(64) }]))).proposals;
    assert.equal(record.downloads[0].url, 'https://example.com/dl/app%5B1%5D.exe');
  });
  it('keeps at most 8 installer variants and de-duplicates by architecture and type', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ Architecture: i % 2 ? 'x64' : 'x86', InstallerUrl: `https://example.com/${i}.exe`, InstallerSha256: 'F'.repeat(64) }));
    const [{ record }] = (await run(evil({}, many))).proposals;
    assert.equal(record.downloads.length, 2);
  });
  it('only accepts sane tags', async () => {
    const [{ record }] = (await run(evil({ Tags: ['good-tag', '"<script>"', '"; DROP"', '"a"', 'x'.repeat(40)] }))).proposals;
    assert.ok(record.tags.includes('good-tag'));
    assert.ok(record.tags.every((t) => /^[\p{L}\p{N}][\p{L}\p{N} ._+#-]*$/u.test(t) && t.length <= 30), JSON.stringify(record.tags));
  });
  it('an absurd release date is dropped, not guessed', async () => {
    const f = manifestFiles({ id: 'Example.App', version: '1.0.0' });
    const k = Object.keys(f).find((x) => x.endsWith('installer.yaml'));
    f[k] = f[k].replace('ReleaseDate: 2026-09-30', 'ReleaseDate: 2999-01-01');
    assert.equal((await run(f)).proposals[0].record.release_date, null);
  });
  it('an old manifest is flagged', () => {
    const { flags } = buildAppProposal({ id: 'A.B', versionDoc: { PackageVersion: '1' }, installerDoc: { ReleaseDate: '2020-01-01', Installers: [{ Architecture: 'x64', InstallerUrl: 'https://example.com/a.exe', InstallerSha256: 'a'.repeat(64) }] }, localeDoc: { PackageName: 'N', Publisher: 'P', ShortDescription: 'A fairly long description here.' }, versionName: '1', paths: { versionDir: 'manifests/a/A/B/1' }, api: { treeUrl: (p) => `https://github.com/microsoft/winget-pkgs/tree/master/${p}`, repo: 'microsoft/winget-pkgs', ref: 'master' }, headSha: null, retrievedAt: NOW, seed: {} });
    assert.ok(flags.includes('manifest_older_than_2_years'));
    assert.ok(PERSISTED_FLAGS.includes('manifest_older_than_2_years'));
  });
});

describe('proposals are valid and mergeable', () => {
  it('every proposal validates against the apps schema and merges into the real catalog without breaking a policy rule', async () => {
    const f = { ...manifestFiles({ id: 'Example.App', version: '1.0.0', locale: { Tags: ['utility'] } }), ...manifestFiles({ id: 'Second.App', version: '3.4.5' }) };
    const r = await run(f, { seeds: { categories: { utilities: ['Example.App', 'Second.App'] } } });
    const v = createValidators(await loadSchemas(fromRoot('schemas')));
    for (const p of r.proposals) assert.deepEqual(v.validateRef('urn:anto-ltg:schema:apps#/$defs/app', p.record).errors, [], p.target);
    const catalogs = await loadCatalogs();
    const { doc, actions } = planMerge({ catalog: 'apps', doc: catalogs.apps, proposals: r.proposals, today: '2026-10-13' });
    assert.deepEqual(actions.map((a) => a.type), ['add', 'add']);
    assert.deepEqual(checkSemantics({ ...catalogs, apps: doc }), []);
  });
});

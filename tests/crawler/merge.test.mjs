// Merging crawler proposals into a catalog. The hard rules: a proposal can never verify anything, never
// overwrite human-written text or review fields, never modify a record a person verified (it reports drift
// instead), and merging the same proposals twice changes nothing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planMerge, summarize, findExisting, uniqueId, BLOCKING_FLAGS } from '../../scripts/crawler/lib/merge.mjs';
import { loadSchemas, createValidators } from '../../scripts/lib/schema.mjs';
import { checkSemantics } from '../../scripts/lib/semantic.mjs';
import { canonicalizeDoc } from '../../scripts/lib/catalog-io.mjs';
import { fromRoot, loadCatalogs } from '../helpers/repo.mjs';

const TODAY = '2026-10-13';
const source = (extra = {}) => ({ id: 'winget-pkgs', kind: 'package_index', url: 'https://github.com/microsoft/winget-pkgs/tree/master/manifests/e/Example/App/1.0', ref: 'microsoft/winget-pkgs@abc', retrieved_at: '2026-10-13T00:00:00.000Z', fields: ['version', 'downloads'], ...extra });
const app = (o = {}) => ({
  id: 'example-app', name: 'Example App', publisher: 'Example', category: 'utilities', description: 'An example.', source_url: 'https://example.com/app', source_kind: 'publisher_page',
  verification_status: 'not_reviewed', windows_compatibility: 'not_reviewed', architectures: ['x64'], license: 'MIT', notes: '', winget_id: 'Example.App', version: '1.0',
  downloads: [], tags: ['example'], sources: [source()], ...o,
});
const proposal = (record, flags = []) => ({ target: record.winget_id ?? record.id, key: `k:${record.id}`, catalog: 'apps', record, meta: { adapter: 'winget', crawled_at: '2026-10-13T00:00:00.000Z', quality_flags: flags } });
const doc = (items, updated_at = '2026-01-01T00:00:00.000Z') => ({ schema_version: '1.1.0', updated_at, items });
const merge = (items, proposals, o = {}) => planMerge({ catalog: o.catalog ?? 'apps', doc: doc(items), proposals, today: TODAY, allowFlagged: o.allowFlagged });

describe('adding new records', () => {
  it('adds an unknown package as not_reviewed with the date it was added', () => {
    const { doc: out, actions } = merge([], [proposal(app())]);
    assert.deepEqual(actions, [{ type: 'add', id: 'example-app', target: 'Example.App' }]);
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].verification_status, 'not_reviewed');
    assert.equal(out.items[0].added_at, TODAY);
    assert.equal(out.updated_at, `${TODAY}T00:00:00.000Z`);
  });
  it('gives a new record a unique id when its slug is taken by a different package', () => {
    const existing = app({ id: 'example-app', winget_id: 'Other.Thing', name: 'Other', publisher: 'Other' });
    const incoming = app({ id: 'example-app', winget_id: 'Example.App' });
    const { doc: out, actions } = merge([existing], [proposal(incoming)]);
    assert.equal(actions[0].type, 'add');
    assert.notEqual(actions[0].id, 'example-app');
    assert.equal(out.items.length, 2);
    assert.equal(new Set(out.items.map((i) => i.id)).size, 2);
  });
  it('uniqueId falls back through readable candidates before numbering', () => {
    const items = [{ id: 'a-b' }, { id: 'pub-name' }];
    assert.equal(uniqueId(items, { id: 'a-b', publisher: 'Pub', name: 'Name', winget_id: 'Pub.Name' }), 'pub-name-pub-name');
    assert.equal(uniqueId([{ id: 'x' }, { id: 'x-2' }], { id: 'x', publisher: '', name: '' }), 'x-3');
    assert.equal(uniqueId([], { id: 'free', publisher: 'P', name: 'N' }), 'free');
  });
  it('can add several proposals in one pass without id collisions among themselves', () => {
    const p1 = proposal(app({ id: 'same', winget_id: 'A.One', name: 'Same', publisher: 'A' }));
    const p2 = proposal(app({ id: 'same', winget_id: 'B.Two', name: 'Same', publisher: 'B' }));
    const { doc: out } = merge([], [p1, p2]);
    assert.equal(out.items.length, 2);
    assert.equal(new Set(out.items.map((i) => i.id)).size, 2);
  });
});

describe('a proposal can never promote or verify', () => {
  it('skips a proposal that claims to be anything but not_reviewed', () => {
    for (const status of ['verified', 'withdrawn', undefined]) {
      const { doc: out, actions } = merge([], [proposal(app({ verification_status: status }))]);
      assert.deepEqual(actions.map((a) => [a.type, a.reason]), [['skip', 'proposal_claims_review']], String(status));
      assert.equal(out.items.length, 0);
    }
  });
  it('never changes verification or review fields of an existing record, whatever the proposal says', () => {
    const existing = app({ verification_status: 'not_reviewed', reviewed_at: null, review_notes: 'human note', windows_compatibility: 'partial', evidence_url: 'https://example.com/e' });
    const incoming = app({ version: '2.0', windows_compatibility: 'supported', review_notes: 'crawler wrote this', evidence_url: 'https://evil.example/', reviewed_at: '2026-10-13T00:00:00.000Z' });
    const { doc: out } = merge([existing], [proposal(incoming)]);
    const r = out.items[0];
    assert.equal(r.version, '2.0', 'data fields are refreshed');
    assert.equal(r.verification_status, 'not_reviewed');
    assert.equal(r.reviewed_at, null);
    assert.equal(r.review_notes, 'human note');
    assert.equal(r.windows_compatibility, 'partial');
    assert.equal(r.evidence_url, 'https://example.com/e');
  });
  it('never overwrites human-written text: notes and Indonesian translations survive', () => {
    const existing = app({ notes: 'Human note', notes_id: 'Catatan manusia', description: 'Human description', description_id: 'Deskripsi manusia', name: 'Human Name' });
    const incoming = app({ notes: 'CRAWLER', notes_id: 'CRAWLER', description: 'CRAWLER description', description_id: 'CRAWLER', name: 'CRAWLER NAME', version: '9.9' });
    const r = merge([existing], [proposal(incoming)]).doc.items[0];
    assert.deepEqual([r.notes, r.notes_id, r.description, r.description_id, r.name], ['Human note', 'Catatan manusia', 'Human description', 'Deskripsi manusia', 'Human Name']);
    assert.equal(r.version, '9.9');
  });
  it('fills text fields only where the record has none', () => {
    const existing = app({ description: '', publisher: '' });
    const incoming = app({ description: 'Fresh description', publisher: 'Fresh Publisher' });
    const r = merge([existing], [proposal(incoming)]).doc.items[0];
    assert.deepEqual([r.description, r.publisher], ['Fresh description', 'Fresh Publisher']);
  });
  it('never changes a record id', () => {
    const r = merge([app({ id: 'stable-id' })], [proposal(app({ id: 'different-id' }))]).doc.items[0];
    assert.equal(r.id, 'stable-id');
  });
  it('a crawled record that is verified is NEVER modified; differences are reported as drift', () => {
    const verified = app({ verification_status: 'verified', reviewed_at: '2026-10-01T00:00:00.000Z', review_notes: 'checked', evidence_url: 'https://example.com/e', version: '1.0', downloads: [{ kind: 'landing_page', url: 'https://example.com/d' }] });
    const before = structuredClone(verified);
    const { doc: out, actions } = merge([verified], [proposal(app({ version: '2.0', downloads: [] }))]);
    assert.deepEqual(out.items[0], before, 'identical to before');
    assert.equal(actions[0].type, 'drift');
    assert.deepEqual(actions[0].fields.sort(), ['downloads', 'version']);
    assert.equal(out.updated_at, '2026-01-01T00:00:00.000Z', 'nothing changed, so the catalog timestamp did not move');
  });
  it('a verified record with identical data is simply "unchanged"', () => {
    const verified = app({ verification_status: 'verified', reviewed_at: '2026-10-01T00:00:00.000Z', review_notes: 'checked', evidence_url: 'https://example.com/e' });
    assert.equal(merge([verified], [proposal(app())]).actions[0].type, 'unchanged');
  });
});

describe('which fields a crawler may refresh on an unverified record', () => {
  it('refreshes version, dates, compatibility, architectures, installers and downloads', () => {
    const dl = [{ kind: 'direct_binary', url: 'https://example.com/a.exe', evidence: 'e' }];
    const incoming = app({ version: '3.0', release_date: '2026-09-01', architectures: ['x64', 'arm64'], compatibility: { windows10: 'declared', windows11: 'declared', min_os_version: '10.0.17763.0' }, installer_types: ['inno'], downloads: dl, license: 'GPL-2.0' });
    const { doc: out, actions } = merge([app()], [proposal(incoming)]);
    const r = out.items[0];
    assert.deepEqual([r.version, r.release_date, r.architectures, r.downloads, r.license, r.installer_types], ['3.0', '2026-09-01', ['x64', 'arm64'], dl, 'GPL-2.0', ['inno']]);
    assert.equal(actions[0].type, 'update');
    assert.ok(actions[0].fields.includes('version') && actions[0].fields.includes('downloads'));
  });
  it('does not touch fields the crawler does not own (category, tags set by humans stay, new tags are added)', () => {
    const existing = app({ category: 'developer-tools', tags: ['mine'] });
    const incoming = app({ category: 'utilities', tags: ['theirs', 'mine'] });
    const r = merge([existing], [proposal(incoming)]).doc.items[0];
    assert.equal(r.category, 'developer-tools');
    assert.deepEqual(r.tags.sort(), ['mine', 'theirs']);
  });
  it('caps the tag list at 12', () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag${i}`);
    assert.equal(merge([app({ tags: [] })], [proposal(app({ tags: many }))]).doc.items[0].tags.length, 12);
  });
  it('merges sources by id: the same source is replaced, other sources are kept', () => {
    const curated = { id: 'anto-ltg-curation', kind: 'curated', url: 'https://example.com/c', retrieved_at: '2026-10-01', fields: ['notes'] };
    const existing = app({ sources: [source({ retrieved_at: '2026-01-01T00:00:00.000Z' }), curated] });
    const r = merge([existing], [proposal(app({ sources: [source({ retrieved_at: '2026-10-13T00:00:00.000Z' })] }))]).doc.items[0];
    assert.equal(r.sources.length, 2);
    assert.equal(r.sources.find((s) => s.id === 'winget-pkgs').retrieved_at, '2026-10-13T00:00:00.000Z');
    assert.ok(r.sources.some((s) => s.id === 'anto-ltg-curation'));
  });
  it('removes quality flags that a fresh crawl no longer reports', () => {
    const r = merge([app({ quality_flags: ['installer_without_sha256'] })], [proposal(app())]).doc.items[0];
    assert.equal('quality_flags' in r, false);
  });
});

describe('finding the existing record (never by name alone)', () => {
  const items = [app({ id: 'git', winget_id: 'Git.Git', source_url: 'https://git-scm.com/' }), app({ id: 'curated', winget_id: undefined, source_url: 'https://curated.example/page/' })];
  it('matches a WinGet id case-insensitively', () => assert.equal(findExisting('apps', items, { winget_id: 'git.git', id: 'zzz' }).id, 'git'));
  it('matches by id when no WinGet id conflicts', () => assert.equal(findExisting('apps', items, { id: 'curated', source_url: 'https://other.example/' }).id, 'curated'));
  it('does NOT merge two different WinGet packages that happen to share an id', () => assert.equal(findExisting('apps', items, { id: 'git', winget_id: 'Other.Git' }), null));
  it('matches a curated record by canonical source URL when neither has a WinGet id', () => assert.equal(findExisting('apps', items, { id: 'new', source_url: 'https://www.curated.example/page?utm_source=x#top' }).id, 'curated'));
  it('does not match by URL when both sides have different WinGet ids', () => assert.equal(findExisting('apps', items, { id: 'new', winget_id: 'New.App', source_url: 'https://git-scm.com/' }), null));
  it('two records with the same NAME but different ids and packages stay separate', () => assert.equal(findExisting('apps', items, { id: 'another-git', name: 'Git', winget_id: 'Else.Where' }), null));
  it('drivers are matched by id only', () => assert.equal(findExisting('drivers', [{ id: 'd1', source_url: 'https://x.test/' }], { id: 'd2', source_url: 'https://x.test/' }), null));
});

describe('quality gates for driver leads', () => {
  const lead = (flags) => ({ target: 't1', key: 'k', catalog: 'drivers', record: { id: 'lead-1', name: 'Lead', verification_status: 'not_reviewed', version: '1.0', sources: [source()], source_url: 'https://www.driverscape.com/x' }, meta: { quality_flags: flags } });
  it('an aggregator lead is never published, whatever its flags say', () => {
    for (const flags of [[], ['architecture_not_stated'], ['lists_end_of_support_os'], ['legacy_os_only']]) {
      const { doc: out, actions } = merge([], [lead(flags)], { catalog: 'drivers' });
      assert.equal(actions[0].type, 'skip', flags.join(','));
      assert.equal(actions[0].reason, 'ineligible');
      assert.ok(actions[0].problems.includes('aggregator_not_published'));
      assert.equal(out.items.length, 0);
    }
  });
  it('--allow-flagged does not publish a lead either: leads are never part of drivers.json', () => assert.equal(merge([], [lead(['vendor_device_mismatch'])], { catalog: 'drivers', allowFlagged: true }).actions[0].type, 'skip'));
  it('blocking flags are still enforced before the publication rules run', () => {
    for (const flag of BLOCKING_FLAGS.drivers) assert.equal(merge([], [lead([flag])], { catalog: 'drivers' }).actions[0].reason, 'blocking_quality_flags', flag);
  });
  it('apps have no blocking flags', () => assert.deepEqual(BLOCKING_FLAGS.apps, []));
});

describe('idempotency and purity', () => {
  it('merging the same proposals twice changes nothing the second time', () => {
    const proposals = [proposal(app({ version: '2.0' })), proposal(app({ id: 'second', winget_id: 'Second.App', name: 'Second' }))];
    const first = planMerge({ catalog: 'apps', doc: doc([app()]), proposals, today: TODAY });
    const second = planMerge({ catalog: 'apps', doc: first.doc, proposals, today: '2026-11-30' });
    assert.deepEqual(second.actions.map((a) => a.type), ['unchanged', 'unchanged']);
    assert.deepEqual(second.doc.items, first.doc.items);
    assert.equal(second.doc.updated_at, first.doc.updated_at, 'no change means no new timestamp');
  });
  it('does not mutate the document or the proposals it was given', () => {
    const d = doc([app()]); const props = [proposal(app({ version: '5.0', tags: ['new'] }))];
    const dCopy = structuredClone(d); const pCopy = structuredClone(props);
    planMerge({ catalog: 'apps', doc: d, proposals: props, today: TODAY });
    assert.deepEqual(d, dCopy);
    assert.deepEqual(props, pCopy);
  });
  it('summarises actions by type', () => assert.deepEqual(summarize([{ type: 'add' }, { type: 'add' }, { type: 'skip' }, { type: 'drift' }]), { add: 2, skip: 1, drift: 1 }));
  it('an empty proposal list is a no-op that keeps the timestamp', () => {
    const r = merge([app()], []);
    assert.deepEqual(r.actions, []);
    assert.equal(r.doc.updated_at, '2026-01-01T00:00:00.000Z');
  });
});

describe('merged output still validates', () => {
  it('real catalog + a real-shaped proposal passes the schema and policy rules, and stays not_reviewed', async () => {
    const catalogs = await loadCatalogs();
    const validators = createValidators(await loadSchemas(fromRoot('schemas')));
    const example = JSON.parse(await (await import('node:fs/promises')).readFile(fromRoot('docs', 'examples', 'proposal.example.json'), 'utf8'));
    const { doc: apps, actions } = planMerge({ catalog: 'apps', doc: catalogs.apps, proposals: example.proposals, today: TODAY });
    assert.equal(actions[0].type, 'add');
    const merged = { ...catalogs, apps: canonicalizeDoc('apps', apps) };
    assert.deepEqual(validators.validate('apps', merged.apps).errors, []);
    assert.deepEqual(checkSemantics(merged).filter((e) => !/example-package/.test(e) || !/winget-pkgs source/.test(e)), [], 'no policy problems beyond the example package placeholders');
    assert.equal(merged.apps.items.find((i) => i.id === 'example-package').verification_status, 'not_reviewed');
  });
});

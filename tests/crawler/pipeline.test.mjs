// The smaller pieces of the crawl pipeline: crawl state and "retry failed", reports, the worker pool,
// proposal-file merging, configuration validation and the command-line parser.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STATE_SCHEMA, loadState, recordOutcome, failedTargets, saveState } from '../../scripts/crawler/lib/state.mjs';
import { buildReport, flagHistogram, renderMarkdown, mdCell } from '../../scripts/crawler/lib/report.mjs';
import { runPool } from '../../scripts/crawler/lib/pool.mjs';
import { validateConfig, loadConfig, loadAdapter, crawlerDir } from '../../scripts/crawler/lib/config.mjs';
import { parseArgs } from '../../scripts/crawler/cli.mjs';
import { githubAuth, mergeProposalFiles } from '../../scripts/crawler/commands/crawl.mjs';
import { loadSchemas, createValidators } from '../../scripts/lib/schema.mjs';
import { fromRoot, readJson } from '../helpers/repo.mjs';

const withDir = async (fn) => { const dir = await mkdtemp(path.join(os.tmpdir(), 'anto-ltg-state-')); try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } };
const T1 = '2026-10-13T01:00:00.000Z'; const T2 = '2026-10-13T02:00:00.000Z';

describe('crawl state and --retry-failed', () => {
  const fresh = () => ({ schema: STATE_SCHEMA, adapters: {} });
  it('records a success with its version and fingerprint, and resets the attempt counter', () => {
    const s = recordOutcome(fresh(), 'winget', { proposals: [{ target: 'Git.Git', record: { version: '2.55.0.5' }, meta: { fingerprint: 'fp1' } }], attempted: ['Git.Git'] }, T1);
    assert.deepEqual(s.adapters.winget.targets['Git.Git'], { status: 'ok', attempts: 0, last_attempt: T1, last_success: T1, version: '2.55.0.5', fingerprint: 'fp1' });
    assert.equal(s.adapters.winget.last_run, T1);
  });
  it('records a failure with its error and counts attempts across runs', () => {
    let s = recordOutcome(fresh(), 'winget', { errors: [{ target: 'X.Y', code: 'HTTP_503', message: 'busy', retryable: true }], attempted: ['X.Y'] }, T1);
    s = recordOutcome(s, 'winget', { errors: [{ target: 'X.Y', code: 'HTTP_503', message: 'busy', retryable: true }], attempted: ['X.Y'] }, T2);
    assert.deepEqual(s.adapters.winget.targets['X.Y'], { status: 'failed', attempts: 2, last_attempt: T2, error: { code: 'HTTP_503', message: 'busy', retryable: true } });
  });
  it('an unchanged target stays ok without losing its history', () => {
    let s = recordOutcome(fresh(), 'winget', { proposals: [{ target: 'A.B', record: { version: '1' }, meta: { fingerprint: 'f' } }], attempted: ['A.B'] }, T1);
    s = recordOutcome(s, 'winget', { unchanged: ['A.B'], attempted: ['A.B'] }, T2);
    assert.equal(s.adapters.winget.targets['A.B'].status, 'ok');
    assert.equal(s.adapters.winget.targets['A.B'].last_success, T1);
    assert.equal(s.adapters.winget.targets['A.B'].last_attempt, T2);
    assert.equal(s.adapters.winget.targets['A.B'].fingerprint, 'f');
  });
  it('a later success clears an earlier failure', () => {
    let s = recordOutcome(fresh(), 'winget', { errors: [{ target: 'A.B', code: 'NETWORK', message: 'x' }], attempted: ['A.B'] }, T1);
    s = recordOutcome(s, 'winget', { proposals: [{ target: 'A.B', record: {}, meta: {} }], attempted: ['A.B'] }, T2);
    assert.equal(s.adapters.winget.targets['A.B'].status, 'ok');
    assert.equal('error' in s.adapters.winget.targets['A.B'], false);
    assert.equal(s.adapters.winget.targets['A.B'].attempts, 0);
  });
  it('failedTargets lists only retryable failures; permanent errors are not retried', () => {
    const s = recordOutcome(fresh(), 'winget', {
      errors: [{ target: 'Gone.Pkg', code: 'NOT_FOUND', message: 'no', retryable: false }, { target: 'Busy.Pkg', code: 'HTTP_503', message: 'busy', retryable: true }, { target: 'Default.Pkg', code: 'NETWORK', message: 'x' }],
      proposals: [{ target: 'Fine.Pkg', record: {}, meta: {} }], attempted: ['Gone.Pkg', 'Busy.Pkg', 'Default.Pkg', 'Fine.Pkg'],
    }, T1);
    assert.deepEqual(failedTargets(s, 'winget').sort(), ['Busy.Pkg', 'Default.Pkg']);
    assert.deepEqual(failedTargets(s, 'no-such-adapter'), []);
  });
  it('targets that were not attempted are left alone', () => {
    const s = recordOutcome(fresh(), 'winget', { proposals: [{ target: 'A.B', record: {}, meta: {} }], attempted: [] }, T1);
    assert.deepEqual(s.adapters.winget.targets, {});
  });
  it('round-trips through disk with targets sorted for stable diffs', () => withDir(async (dir) => {
    let s = fresh();
    s = recordOutcome(s, 'winget', { proposals: ['Z.Last', 'A.First', 'M.Middle'].map((t) => ({ target: t, record: {}, meta: {} })), attempted: ['Z.Last', 'A.First', 'M.Middle'] }, T1);
    await saveState(dir, s);
    const text = await readFile(path.join(dir, 'state.json'), 'utf8');
    assert.ok(text.endsWith('}\n'));
    assert.ok(text.indexOf('A.First') < text.indexOf('M.Middle') && text.indexOf('M.Middle') < text.indexOf('Z.Last'));
    assert.deepEqual(await loadState(dir), JSON.parse(text));
  }));
  it('starts fresh when the file is missing, corrupt or from another schema', () => withDir(async (dir) => {
    assert.deepEqual(await loadState(dir), fresh());
    await writeFile(path.join(dir, 'state.json'), '{not json');
    assert.deepEqual(await loadState(dir), fresh());
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ schema: 'something-else', adapters: { x: 1 } }));
    assert.deepEqual(await loadState(dir), fresh());
  }));
  it('the committed state file is valid and keeps no secrets or request headers', async () => {
    const text = await readFile(fromRoot('catalogs', 'proposed', 'state.json'), 'utf8');
    const doc = JSON.parse(text);
    assert.equal(doc.schema, STATE_SCHEMA);
    assert.doesNotMatch(text, /authorization|bearer|ghp_|token/i);
  });
});

describe('proposal files', () => {
  const p = (target, v = 1) => ({ target, key: `k:${target}`, record: { v }, meta: {} });
  it('a full run replaces everything; a targeted run keeps proposals and errors it did not touch', () => {
    const existing = { proposals: [p('A'), p('B')], errors: [{ target: 'C', code: 'X', message: 'old' }] };
    const full = mergeProposalFiles(existing, 'winget', {}, [p('A', 2)], [], T1, true);
    assert.deepEqual(full.proposals.map((x) => x.target), ['A']);
    assert.deepEqual(full.errors, []);
    const partial = mergeProposalFiles(existing, 'winget', {}, [p('A', 2)], [], T1, false, ['A']);
    assert.deepEqual(partial.proposals.map((x) => [x.target, x.record.v]), [['A', 2], ['B', 1]]);
    assert.deepEqual(partial.errors.map((e) => e.target), ['C'], 'an error for a target that was not retried stays');
  });
  it('a retried target drops its old error; a new error replaces its old proposal', () => {
    const existing = { proposals: [p('A')], errors: [{ target: 'C', code: 'X', message: 'old' }] };
    const out = mergeProposalFiles(existing, 'winget', {}, [p('C')], [{ target: 'A', code: 'HTTP_500', message: 'new' }], T1, false, ['A', 'C']);
    assert.deepEqual(out.proposals.map((x) => x.target), ['C']);
    assert.deepEqual(out.errors.map((e) => [e.target, e.code]), [['A', 'HTTP_500']]);
  });
  it('output is sorted by target and uses the documented schema id', () => {
    const out = mergeProposalFiles(null, 'winget', { id: 's' }, [p('Z'), p('A'), p('M')], [{ target: 'Q', code: 'x', message: 'm' }, { target: 'B', code: 'x', message: 'm' }], T1, true);
    assert.deepEqual(out.proposals.map((x) => x.target), ['A', 'M', 'Z']);
    assert.deepEqual(out.errors.map((x) => x.target), ['B', 'Q']);
    assert.equal(out.schema, 'anto-ltg.proposals/1');
    assert.deepEqual([out.adapter, out.generated_at], ['winget', T1]);
  });
  it('the output validates against the proposals schema', async () => {
    const v = createValidators(await loadSchemas(fromRoot('schemas')));
    const example = await readJson('docs', 'examples', 'proposal.example.json');
    const out = mergeProposalFiles(example, 'winget', example.source, example.proposals, example.errors, T1, true);
    assert.deepEqual(v.validate('proposals', out).errors, []);
  });
});

describe('reports', () => {
  it('builds a report with timings and an honesty note', () => {
    const r = buildReport({ startedAt: '2026-10-13T00:00:00.000Z', finishedAt: '2026-10-13T00:02:44.000Z', args: { adapters: ['winget'] }, adapters: [] });
    assert.equal(r.schema, 'anto-ltg.crawl-report/1');
    assert.equal(r.duration_seconds, 164);
    assert.match(r.note, /Nothing is verified, nothing was downloaded or executed, and no binary was mirrored/);
  });
  it('counts quality flags', () => assert.deepEqual(flagHistogram([{ meta: { quality_flags: ['b', 'a'] } }, { meta: { quality_flags: ['a'] } }, { meta: {} }, {}]), { a: 2, b: 1 }));
  it('renders markdown with errors in a table, and skipped adapters', () => {
    const md = renderMarkdown(buildReport({ startedAt: T1, finishedAt: T2, args: {}, adapters: [
      { id: 'winget', source: { repo: 'microsoft/winget-pkgs', commit: 'abc' }, stats: { targets: 3, proposed: 2, unchanged: 0, failed: 1 }, http: { requests: 10, cacheHits: 2, notModified: 1, retries: 0, blocked: 0 }, quality_flags: { installer_without_sha256: 1 }, errors: [{ target: 'X.Y', code: 'NOT_FOUND', message: 'No manifest' }] },
      { id: 'driver-listings', skipped: 'needs --allow-aggregators' },
    ] }));
    assert.match(md, /^# Crawl report/);
    assert.match(md, /## Adapter `winget`/);
    assert.match(md, /\| `X\.Y` \| NOT_FOUND \| No manifest \|/);
    assert.match(md, /\| installer_without_sha256 \| 1 \|/);
    assert.match(md, /Skipped: needs --allow-aggregators/);
  });
  it('untrusted error text cannot break the table, open a code span or inject markup or links', () => {
    const hostile = 'line1\nline2 | extra | cells `code` <script>alert(1)</script> [click](javascript:alert(1)) \u202e';
    const md = renderMarkdown(buildReport({ startedAt: T1, finishedAt: T2, args: {}, adapters: [{ id: 'a', stats: { targets: 1, proposed: 0, failed: 1 }, errors: [{ target: 'T`|\n<b>', code: 'C|X', message: hostile }] }] }));
    const rows = md.split('\n').filter((l) => l.startsWith('| `'));
    assert.equal(rows.length, 1, 'one error is exactly one table row');
    assert.doesNotMatch(md, /<script>|<b>|\]\(javascript:/);
    assert.doesNotMatch(rows[0], /\u202e/);
    const unescapedPipes = rows[0].replace(/\\\|/g, '').split('|').length - 1;
    assert.equal(unescapedPipes, 4, 'only the 4 structural pipes of a 3-column row remain');
    assert.equal(mdCell('a\u0000b'), 'a b');
    assert.equal(mdCell('x'.repeat(500)).length, 160);
  });
  it('the committed report files describe a run in which nothing was promoted', async () => {
    const json = await readJson('catalogs', 'proposed', 'report.json');
    assert.match(json.note, /Nothing is verified/);
    const md = await readFile(fromRoot('catalogs', 'proposed', 'report.md'), 'utf8');
    assert.match(md, /Nothing is verified, nothing was downloaded or executed/);
  });
});

describe('runPool', () => {
  it('keeps results in input order, whatever the completion order', async () => {
    const out = await runPool([30, 5, 20, 1], 4, async (ms, i) => { await new Promise((r) => setTimeout(r, ms)); return i; });
    assert.deepEqual(out.map((r) => r.value), [0, 1, 2, 3]);
  });
  it('never exceeds the concurrency limit', async () => {
    let active = 0; let max = 0;
    await runPool(Array.from({ length: 20 }, (_, i) => i), 3, async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 2)); active--; });
    assert.equal(max, 3);
  });
  it('a throwing worker yields { error } and does not stop the others', async () => {
    const out = await runPool([1, 2, 3, 4], 2, async (n) => { if (n % 2 === 0) throw new Error(`bad ${n}`); return n; });
    assert.deepEqual(out.map((r) => r.value ?? null), [1, null, 3, null]);
    assert.deepEqual(out.map((r) => r.error?.message ?? null), [null, 'bad 2', null, 'bad 4']);
  });
  it('handles empty input and a limit larger than the work or smaller than 1', async () => {
    assert.deepEqual(await runPool([], 4, async () => 1), []);
    assert.deepEqual((await runPool([1, 2], 100, async (n) => n)).map((r) => r.value), [1, 2]);
    assert.deepEqual((await runPool([1, 2], 0, async (n) => n)).map((r) => r.value), [1, 2]);
  });
});

describe('configuration', () => {
  const good = () => ({
    user_agent: 'Bot/1.0 (+https://example.org/about)', product_token: 'Bot', timeout_ms: 1000, retries: 2, concurrency: 4, per_host_min_interval_ms: 500, max_bytes: 1000,
    adapters: { a: { type: 'winget', hosts: ['api.github.com'], robots: 'not_applicable', robots_note: 'documented API' }, b: { type: 'driver-listing', hosts: ['*.example.com'], robots: 'required' } },
  });
  it('accepts a polite configuration', () => assert.deepEqual(validateConfig(good()), []));
  it('the real configuration is valid and polite', async () => {
    const cfg = await loadConfig();
    assert.deepEqual(validateConfig(cfg), []);
    assert.match(cfg.user_agent, /\(\+https:\/\/github\.com\/flessan\/ANTO-LTG/);
    assert.ok(cfg.per_host_min_interval_ms >= 1000);
    assert.ok(cfg.concurrency <= 8);
    assert.ok(cfg.retries <= 3);
    assert.ok(cfg.max_bytes <= 5 * 1024 * 1024);
  });
  const bad = (name, edit, re) => it(`rejects ${name}`, () => { const c = good(); edit(c); const problems = validateConfig(c); assert.ok(problems.some((p) => re.test(p)), JSON.stringify(problems)); });
  bad('a User-Agent without a contact URL', (c) => { c.user_agent = 'Bot/1.0'; }, /user_agent must identify the crawler/);
  bad('a missing product token', (c) => { delete c.product_token; }, /product_token/);
  bad('negative numbers', (c) => { c.timeout_ms = -1; }, /timeout_ms/);
  bad('impolite concurrency', (c) => { c.concurrency = 64; }, /not polite/);
  bad('an impolite request interval', (c) => { c.per_host_min_interval_ms = 10; }, /per_host_min_interval_ms below 100/);
  bad('an adapter without a type', (c) => { delete c.adapters.a.type; }, /needs a type/);
  bad('an adapter without hosts', (c) => { c.adapters.a.hosts = []; }, /at least one allowed host/);
  bad('a host that is a URL, not a name', (c) => { c.adapters.a.hosts = ['https://api.github.com/']; }, /bare hostname/);
  bad('a host with a path or port', (c) => { c.adapters.a.hosts = ['example.com:8080']; }, /bare hostname/);
  bad('an adapter that does not declare its robots policy', (c) => { delete c.adapters.b.robots; }, /robots to "required" or "not_applicable"/);
  bad('skipping robots.txt without saying why', (c) => { delete c.adapters.a.robots_note; }, /must explain why/);
  bad('a config without adapters', (c) => { delete c.adapters; }, /adapters must be an object/);

  it('every adapter in the real config has an implementation, and web-page adapters require robots.txt', async () => {
    const cfg = await loadConfig();
    for (const [name, a] of Object.entries(cfg.adapters)) {
      const adapter = await loadAdapter(a.type);
      assert.equal(typeof adapter.run, 'function', name);
      assert.ok(adapter.id && adapter.describe, name);
      if (a.hosts.some((h) => h !== 'api.github.com')) assert.equal(a.robots, 'required', `${name} reads web pages, so it must honour robots.txt`);
    }
  });
  it('refuses an unknown adapter type', async () => {
    await assert.rejects(loadAdapter('vendor-page'), /Unknown adapter type/);
    await assert.rejects(loadAdapter('../../etc/passwd'), /Unknown adapter type/);
  });
  it('third-party aggregators are opt-in and lead-only', async () => {
    const cfg = await loadConfig();
    assert.equal(cfg.adapters['driver-listings'].enabled, false);
    assert.equal(cfg.adapters['driver-listings'].requires_flag, '--allow-aggregators');
    assert.equal(cfg.adapters['driver-listings'].policy, 'lead_only');
  });
  it('crawlerDir points at the crawler sources', () => assert.ok(crawlerDir.endsWith(path.join('scripts', 'crawler'))));
});

describe('credentials and the command line', () => {
  it('githubAuth reads GITHUB_TOKEN or GH_TOKEN from the environment, and returns nothing without one', () => {
    assert.equal(githubAuth({}), null);
    assert.equal(githubAuth({ GITHUB_TOKEN: '' }), null);
    assert.deepEqual(githubAuth({ GITHUB_TOKEN: 'tok' })(), { authorization: 'Bearer tok', 'x-github-api-version': '2022-11-28' });
    assert.equal(githubAuth({ GH_TOKEN: 'other' })().authorization, 'Bearer other');
    assert.equal(githubAuth({ GITHUB_TOKEN: 'first', GH_TOKEN: 'second' })().authorization, 'Bearer first');
  });
  it('parseArgs handles flags, values, positionals and --key=value', () => {
    assert.deepEqual(parseArgs(['winget', '--dry-run', '--limit', '5', '--ids=a,b', '--incremental', 'driver-listings']), {
      flags: { 'dry-run': true, limit: '5', ids: 'a,b', incremental: true }, positional: ['winget', 'driver-listings'],
    });
    assert.deepEqual(parseArgs(['--apply']).flags, { apply: true });
    assert.deepEqual(parseArgs(['--catalog', 'drivers', '--hosts', 'a.com,b.com']).flags, { catalog: 'drivers', hosts: 'a.com,b.com' });
    assert.deepEqual(parseArgs(['--limit', '--dry-run']).flags, { limit: true, 'dry-run': true }, 'a flag name is never swallowed as a value');
  });
});

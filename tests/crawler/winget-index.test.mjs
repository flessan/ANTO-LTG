// Discovery rules of the git-based WinGet index adapter. Pure functions: no git, no network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discoverIds } from '../../scripts/crawler/adapters/winget-index.mjs';
import { readJson } from '../helpers/repo.mjs';

const cfg = await readJson('scripts', 'crawler', 'crawler.config.json');
const DISCOVERY = cfg.adapters['winget-index'].discovery;
const run = (ids, over = {}, seeded = new Set()) => discoverIds(new Set(ids), { ...DISCOVERY, ...over }, seeded);

describe('winget-index discovery', () => {
  it('matches the category rules and reports the category', () => {
    assert.deepEqual(run(['Mozilla.Firefox', 'Git.Git']), [{ id: 'Git.Git', category: 'developer-tools' }, { id: 'Mozilla.Firefox', category: 'browsers' }]);
  });

  it('caps each category separately, so one large family cannot crowd out the rest', () => {
    const devs = Array.from({ length: 30 }, (_, i) => `GitHub.Tool${String(i).padStart(2, '0')}`);
    const browsers = ['Mozilla.Firefox', 'Google.Chrome', 'Brave.Brave'];
    const out = run([...devs, ...browsers], { max_per_category: 5 });
    assert.equal(out.filter((x) => x.category === 'developer-tools').length, 5);
    assert.equal(out.filter((x) => x.category === 'browsers').length, 3, 'a small category keeps all of its matches');
  });

  it('takes IDs in a deterministic (alphabetical) order inside a category', () => {
    const out = run(['GitHub.Zed', 'GitHub.Apex', 'GitHub.Mid'], { max_per_category: 2 });
    assert.deepEqual(out.map((x) => x.id), ['GitHub.Apex', 'GitHub.Mid']);
  });

  it('never discovers seeded IDs twice, invalid IDs, or excluded channels', () => {
    assert.deepEqual(run(['Git.Git'], {}, new Set(['Git.Git'])), []);
    assert.deepEqual(run(['not a valid id!']), []);
    for (const id of ['Git.Git.Beta', 'Git.Git.Preview', 'vim.vim.nightly', 'pnpm.pnpm.preview', 'GitHub.Copilot.Prerelease', 'Git.Git.Insiders']) {
      assert.deepEqual(run([id]), [], `${id} is a pre-release channel`);
    }
  });

  it('keeps Chinese-market apps and the Lenovo OEM utilities out of discovery', () => {
    assert.deepEqual(run(['Tencent.QQ', 'Tencent.WeChat', 'Lenovo.Vantage', 'NirSoft.USBDeview']), []);
  });

  it('the exclusions are case-sensitive, so \"Git.Git\" is not dropped by a lower-case rule', () => {
    assert.deepEqual(run(['Git.Git']).map((x) => x.id), ['Git.Git']);
  });

  it('the seed file no longer contains the entries the review removed', async () => {
    const seeds = await readJson('scripts', 'crawler', 'seeds', 'winget.json');
    const ids = Object.values(seeds.categories).flat().map((e) => (typeof e === 'string' ? e : e.winget_id));
    for (const gone of ['Tencent.QQ', 'Tencent.WeChat', 'NirSoft.USBDeview', 'Microsoft.DirectX', 'Anaconda.Miniconda3']) assert.ok(!ids.includes(gone), gone);
    assert.ok(!ids.some((id) => id.startsWith('Microsoft.VCRedist.')), 'VCRedist is trimmed from runtimes');
  });
});

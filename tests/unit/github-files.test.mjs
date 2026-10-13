// The repository automation files that are not workflows: Dependabot, issue forms, the pull request template,
// and the Node version files. (Workflow policy lives in workflows.test.mjs.)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readText, readJson } from '../helpers/repo.mjs';

describe('repository automation files', () => {
  it('Dependabot watches both GitHub Actions and npm', async () => {
    const y = await readText('.github', 'dependabot.yml');
    assert.match(y, /package-ecosystem:\s*github-actions/);
    assert.match(y, /package-ecosystem:\s*npm/);
    assert.match(y, /interval:\s*weekly/);
  });

  it('issue templates keep security reports out of public issues', async () => {
    const config = await readText('.github', 'ISSUE_TEMPLATE', 'config.yml');
    assert.match(config, /blank_issues_enabled:\s*false/);
    assert.match(config, /SECURITY\.md/);
  });

  it('the data-correction form demands evidence and forbids binaries and secrets', async () => {
    const form = await readText('.github', 'ISSUE_TEMPLATE', 'data-correction.yml');
    assert.match(form, /id:\s*evidence[\s\S]*required:\s*true/);
    assert.match(form, /Do not attach installers, drivers or firmware/);
    assert.match(form, /not mirrors or aggregators/);
  });

  it('the pull request template carries the evidence rules', async () => {
    const t = await readText('.github', 'PULL_REQUEST_TEMPLATE.md');
    for (const rule of ['npm run check', 'pending_review', 'did \\*\\*not\\*\\* invent', 'added no installer, driver, firmware', 'en.js', 'assets/manifest.json']) {
      assert.match(t, new RegExp(rule), rule);
    }
  });
});

describe('Node version files', () => {
  it('.nvmrc satisfies the engines range in package.json', async () => {
    const engines = (await readJson('package.json')).engines.node;
    const minimum = engines.match(/>=\s*(\d+)(?:\.(\d+))?/);
    const nvmrc = (await readText('.nvmrc')).trim();
    assert.ok(minimum, `engines.node "${engines}" should be a ">=" range`);
    assert.match(nvmrc, /^\d+(\.\d+){0,2}$/, '.nvmrc holds a plain version');
    assert.ok(Number(nvmrc.split('.')[0]) >= Number(minimum[1]), `.nvmrc (${nvmrc}) must satisfy engines.node (${engines})`);
  });

  it('the dev dependency that sets the floor really requires it', async () => {
    // puppeteer-core 25 needs Node >= 22.12; if it ever stops, engines may be relaxed on purpose.
    const pkg = await readJson('package.json');
    const pup = await readJson('node_modules', 'puppeteer-core', 'package.json');
    const floor = (pup.engines?.node ?? '').match(/>=\s*([\d.]+)/)?.[1];
    assert.ok(floor, 'puppeteer-core declares an engines.node floor');
    const asNumber = (v) => v.split('.').map(Number).reduce((acc, n, i) => acc + n / 1000 ** i, 0);
    assert.ok(asNumber(pkg.engines.node.match(/>=\s*([\d.]+)/)[1]) >= asNumber(floor), `engines.node (${pkg.engines.node}) must be at least puppeteer-core's floor (${floor})`);
  });
});

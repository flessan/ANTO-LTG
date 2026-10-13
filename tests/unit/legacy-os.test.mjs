// Windows 7, 8 and 8.1 support: the script headers, the install planner's forced download-kit mode,
// stored-selection normalisation, the OS filter, and a static PowerShell 2.0 scan of every generated script.
// PowerShell is not available in CI, so the scan is structural: it rejects known PowerShell 3+ commands and syntax.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planInstall, buildWingetScript, buildDownloadKitScript } from '../../assets/js/lib/psgen.js';
import { OS_TARGETS, OS_IDS, WINGET_OS, normalizeOs } from '../../assets/js/lib/model.js';
import { createStorage, loadSelection, saveSelection, KEYS } from '../../assets/js/lib/storage.js';
import { filterApps, DEFAULT_FILTERS } from '../../assets/js/lib/apps-filter.js';
import { loadCatalogs } from '../helpers/repo.mjs';

const META = { generatedAt: '2026-10-13T00:00:00.000Z', bundleName: 'Legacy test', schemaVersion: '1.2.0', catalogUpdated: '2026-10-13' };
const HASH = 'a'.repeat(64);
const oldApp = {
  id: 'example-tool', name: 'Example Tool', winget_id: 'Example.Tool', category: 'utilities', verification_status: 'not_reviewed',
  source_url: 'https://example.org/', compatibility: { windows7: 'declared', windows81: 'declared', windows10: 'declared', windows11: 'unknown' },
  downloads: [{ kind: 'direct_binary', url: 'https://example.org/tool-1.0.exe', sha256: HASH, architecture: 'x64', publisher_official: true }],
};
const wingetOnly = { ...oldApp, id: 'winget-only', name: 'WinGet Only', downloads: [] };

describe('script headers', () => {
  it('the WinGet script declares PowerShell 5.1 and the download kit declares PowerShell 2.0', () => {
    const plan = planInstall({ apps: [wingetOnly], os: 'windows11', method: 'winget' });
    assert.ok(buildWingetScript({ plan, meta: META }).startsWith('#Requires -Version 5.1\n'));
    const kit = buildDownloadKitScript({ plan: planInstall({ apps: [oldApp], os: 'windows7', method: 'download-kit' }), meta: META });
    assert.ok(kit.startsWith('#Requires -Version 2.0\n'));
  });

  it('the kit header names the target OS in plain text', () => {
    const kit = buildDownloadKitScript({ plan: planInstall({ apps: [oldApp], os: 'windows7', method: 'download-kit' }), meta: META });
    assert.match(kit, /# Target\s*: Windows 7/);
  });
});

describe('planInstall on legacy Windows', () => {
  it('forces download-kit for every OS that cannot run WinGet, even when WinGet is requested', () => {
    for (const os of ['windows81', 'windows8', 'windows7']) {
      const plan = planInstall({ apps: [oldApp], os, method: 'winget' });
      assert.equal(plan.method, 'download-kit', os);
      assert.equal(plan.included.length, 1, os);
      assert.ok(plan.included[0].variants.length > 0, os);
    }
  });

  it('a package with no published hash goes to manual steps, never to a download', () => {
    const plan = planInstall({ apps: [wingetOnly], os: 'windows7', method: 'winget' });
    assert.equal(plan.included.length, 0);
    assert.equal(plan.manual[0].reason, 'no_direct_download_with_published_hash');
  });

  it('keeps WinGet for Windows 10 and 11 only', () => {
    assert.deepEqual([...WINGET_OS].sort(), ['windows10', 'windows11']);
    assert.equal(planInstall({ apps: [oldApp], os: 'windows10', method: 'winget' }).method, 'winget');
  });
});

describe('OS identifiers and storage normalisation', () => {
  it('lists the five supported targets with their display names', () => {
    assert.deepEqual(OS_IDS, ['windows11', 'windows10', 'windows81', 'windows8', 'windows7']);
    assert.equal(OS_TARGETS.windows7, 'Windows 7');
  });

  it('normalises unknown or hostile OS values to Windows 11', () => {
    assert.equal(normalizeOs('windows2000'), 'windows11');
    assert.equal(normalizeOs(undefined), 'windows11');
    assert.equal(normalizeOs('__proto__'), 'windows11');
    assert.equal(normalizeOs('windows7'), 'windows7');
  });

  it('keeps a stored legacy OS and falls back for a corrupt one', () => {
    const memory = new Map([[KEYS.selection, JSON.stringify({ ids: ['git'], os: 'windows7', method: 'download-kit' })]]);
    const storage = createStorage({ getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) });
    assert.deepEqual(loadSelection(storage), { ids: ['git'], os: 'windows7', method: 'download-kit' });
    memory.set(KEYS.selection, JSON.stringify({ ids: ['git'], os: 'windows95', method: 'winget' }));
    assert.equal(loadSelection(storage).os, 'windows11');
    saveSelection(storage, { ids: ['git'], os: 'windows8', method: 'download-kit' });
    assert.equal(JSON.parse(memory.get(KEYS.selection)).os, 'windows8');
  });
});

describe('OS filter', () => {
  const apps = [
    { ...oldApp, id: 'old-declared', name: 'Declared Old' },
    { ...oldApp, id: 'new-only', name: 'New Only', compatibility: { windows7: 'unsupported', windows81: 'unsupported', windows8: 'unsupported', windows10: 'declared', windows11: 'declared' } },
    { ...oldApp, id: 'unknown-old', name: 'Unknown Old', compatibility: {} },
  ];
  it('hides apps declared unsupported on the chosen OS but keeps unknown ones', () => {
    const ids = filterApps(apps, { ...DEFAULT_FILTERS, os: 'windows7' }).map((a) => a.id).sort();
    assert.deepEqual(ids, ['old-declared', 'unknown-old']);
  });
  it('declaredOnly keeps only apps that declare support for the chosen OS', () => {
    const ids = filterApps(apps, { ...DEFAULT_FILTERS, os: 'windows7', declaredOnly: true }).map((a) => a.id);
    assert.deepEqual(ids, ['old-declared']);
  });
  it('the real catalog only uses declared, unknown or unsupported per OS', async () => {
    const { apps: real } = await loadCatalogs();
    for (const a of real.items) for (const os of OS_IDS) assert.ok(['declared', 'unknown', 'unsupported'].includes(a.compatibility?.[os] ?? 'unknown'), `${a.id} ${os}`);
  });
});

// Constructs that PowerShell 2.0 does not have (or that need a later version). Matched on code, not on comments.
const PS3_PLUS = [
  [/\bConvertFrom-Json\b/i, 'ConvertFrom-Json (3.0)'], [/\bConvertTo-Json\b/i, 'ConvertTo-Json (3.0)'],
  [/\bInvoke-RestMethod\b/i, 'Invoke-RestMethod (3.0)'], [/\bInvoke-WebRequest\b/i, 'Invoke-WebRequest (3.0)'],
  [/\bGet-FileHash\b/i, 'Get-FileHash (4.0)'], [/\bGet-CimInstance\b/i, 'Get-CimInstance (3.0)'],
  [/\bStart-BitsTransfer\b/i, 'Start-BitsTransfer'], [/\bUsing\s+namespace\b/i, 'using namespace (5.0)'],
  [/\[ordered\]/i, '[ordered] (3.0)'], [/\[pscustomobject\]/i, '[pscustomobject] (3.0)'],
  [/\?\?/, 'null-coalescing operator (7.0)'], [/\?\./, 'null-conditional operator (7.0)'],
  [/\$PSVersionTable\.PSVersion\.Major\s*-ge\s*[3-9]/i, 'version gate above 2'], [/-Raw\b/, 'Get-Content -Raw (3.0)'],
];
// Strip block and line comments before scanning so that documentation mentioning a command does not fail the scan.
const code = (s) => s.replace(/<#[\s\S]*?#>/g, '').split('\n').map((l) => l.replace(/(^|\s)#.*$/, '$1')).join('\n');
const ps2Problems = (text) => PS3_PLUS.filter(([re]) => re.test(code(text))).map(([, label]) => label);

describe('static PowerShell 2.0 scan', () => {
  it('the generated download kit uses no PowerShell 3+ command or syntax', () => {
    const kit = buildDownloadKitScript({ plan: planInstall({ apps: [oldApp], os: 'windows7', method: 'download-kit' }), meta: META });
    assert.deepEqual(ps2Problems(kit), []);
  });
  it('an empty kit is refused rather than generated', () => {
    assert.throws(() => buildDownloadKitScript({ plan: planInstall({ apps: [wingetOnly], os: 'windows7', method: 'download-kit' }), meta: META }), /Nothing to download/);
  });
  it('the hardware report passes the same scan', () => {
    const report = readFileSync(new URL('../../assets/scripts/Get-AntoHardwareReport.ps1', import.meta.url), 'utf8');
    assert.match(report, /^#Requires -Version 2\.0\r?\n/);
    assert.deepEqual(ps2Problems(report), []);
  });
  it('the scan itself catches a known PowerShell 3+ command (self-test)', () => {
    assert.ok(ps2Problems('$x = Invoke-RestMethod -Uri $u').length > 0);
    assert.ok(ps2Problems('$h = Get-FileHash $f').length > 0);
    assert.deepEqual(ps2Problems('# Invoke-RestMethod is not used here\nWrite-Host ok'), []);
  });
});

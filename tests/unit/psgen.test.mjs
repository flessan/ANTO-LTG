// PowerShell generation: validated IDs, safe quoting, skeleton invariance under hostile input, the YES gate,
// no execution-policy tricks, honest exit codes. PowerShell itself is not available in CI, so these are
// structural tests (see tests/helpers/ps.mjs); they do not execute the generated scripts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WINGET_ID_RE, WINGET_RESULTS, isValidWingetId, sanitizeForScript, psQuote, psComment, planInstall, commandLine,
  buildWingetScript, buildDownloadKitScript, buildWingetImport,
} from '../../assets/js/lib/psgen.js';
import { skeleton, bracketBalance, literals, commandsUsed, mulberry32, hostileString } from '../helpers/ps.mjs';
import { loadCatalogs } from '../helpers/repo.mjs';

const META = { generatedAt: '2026-10-13T00:00:00.000Z', bundleName: 'Test bundle', schemaVersion: '1.1.0', catalogUpdated: '2026-10-13' };
const app = (o = {}) => ({
  id: 'git', name: 'Git', winget_id: 'Git.Git', category: 'developer-tools', verification_status: 'not_reviewed', source_url: 'https://git-scm.com/',
  compatibility: { windows10: 'unknown', windows11: 'unknown' }, downloads: [], ...o,
});
const winget = (apps, os = 'windows11') => planInstall({ apps, os, method: 'winget' });
const script = (apps, extra = {}) => buildWingetScript({ plan: winget(apps, extra.os), options: extra.options, meta: { ...META, ...(extra.meta ?? {}) } });

describe('WinGet package id validation', () => {
  const valid = ['Git.Git', 'Microsoft.VisualStudioCode', '7zip.7zip', 'Notepad++.Notepad++', 'Valve.Steam', 'Microsoft.VCRedist.2015+.x64', 'Mozilla.Firefox.ESR', 'a', 'A1_b-c.d'.replace('_', '-')];
  const invalid = [
    '', ' ', 'Git.Git ', ' Git.Git', 'Git Git', "Git.Git'", 'Git.Git"', 'Git.Git;', 'Git.Git|x', 'Git.Git&x', 'Git.Git$x', 'Git.Git`x', 'Git.Git(x)', 'Git.Git\n', 'Git.Git\r', 'Git.Git\0',
    '$(whoami)', '-Git.Git', '.Git', '+Git', 'Git/Git', 'Git\\Git', 'Git.Git#', '日本語.アプリ', 'Git.Git%20', 'x'.repeat(129), null, undefined, 42, {}, [], ['Git.Git'],
  ];
  for (const id of valid) it(`accepts ${JSON.stringify(id)}`, () => assert.equal(isValidWingetId(id), true));
  for (const id of invalid) it(`rejects ${JSON.stringify(id)?.slice(0, 40)}`, () => assert.equal(isValidWingetId(id), false));
  it('the regex is anchored (no partial matches)', () => assert.equal(WINGET_ID_RE.test('ok\nbad id'), false));
});

describe('quoting helpers', () => {
  it('doubles single quotes, including typographic ones PowerShell treats as quotes', () => {
    assert.equal(psQuote("it's"), "'it''s'");
    assert.equal(psQuote('a\u2018b\u2019c\u201ad\u201be'), "'a''b''c''d''e'");
    assert.equal(psQuote('say \u201chi\u201d'), "'say \"hi\"'");
  });
  it('removes newlines, control characters and bidi controls', () => {
    assert.equal(psQuote('a\nb\rc\u2028d\u0000e\u202ef'), "'a b c d e f'");
    assert.equal(sanitizeForScript('x\ud83d\ude00y'), 'x??y');
    assert.equal(sanitizeForScript('caf\u00e9'), 'cafe');
  });
  it('truncates with an ellipsis and never exceeds the maximum', () => {
    const out = sanitizeForScript('x'.repeat(300), { max: 50 });
    assert.equal(out.length, 50);
    assert.ok(out.endsWith('...'));
  });
  it('comments cannot open or close a block comment and stay on one line', () => {
    const c = psComment('evil <# block #> \n Remove-Item');
    assert.ok(c.startsWith('# '));
    assert.doesNotMatch(c, /<#|#>|\n|\r/);
  });
  it('fuzz: a literal never contains an unescaped quote, a newline or a non-ASCII character (2,000 cases)', () => {
    const rand = mulberry32(20261013);
    for (let i = 0; i < 2000; i++) {
      const q = psQuote(hostileString(rand));
      assert.match(q, /^'[\x20-\x7e]*'$/, JSON.stringify(q));
      const inner = q.slice(1, -1).replace(/''/g, '');
      assert.ok(!inner.includes("'"), `lone quote in ${JSON.stringify(q)}`);
      const c = psComment(hostileString(rand));
      assert.match(c, /^# [\x20-\x7e]*$/, JSON.stringify(c));
      assert.doesNotMatch(c, /<#|#>/);
    }
  });
});

describe('planInstall', () => {
  const runtime = app({ id: 'vcredist', name: 'VC++ Redist', winget_id: 'Microsoft.VCRedist.2015+.x64', category: 'runtimes' });
  const browser = app({ id: 'firefox', name: 'Firefox', winget_id: 'Mozilla.Firefox', category: 'browsers' });
  const game = app({ id: 'steam', name: 'Steam', winget_id: 'Valve.Steam', category: 'gaming' });
  const noWinget = app({ id: 'sysinternals', name: 'Sysinternals', winget_id: undefined, category: 'system-tools', source_url: 'https://learn.microsoft.com/sysinternals/' });
  const gone = app({ id: 'flash', name: 'Flash', winget_id: undefined, downloads: [], availability: { status: 'unavailable', reason: 'End of life' }, source_url: 'https://www.adobe.com/products/flashplayer/end-of-life.html' });

  it('orders runtimes first and games last, then by name', () => {
    const plan = winget([game, browser, runtime, app({ id: 'git', name: 'Git' })]);
    assert.deepEqual(plan.included.map((x) => x.app.id), ['vcredist', 'firefox', 'git', 'steam']);
  });
  it('turns apps without a WinGet package into manual steps and drops unavailable ones', () => {
    const plan = winget([browser, noWinget, gone]);
    assert.deepEqual(plan.included.map((x) => x.app.id), ['firefox']);
    assert.deepEqual(plan.manual.map((x) => x.app.id), ['sysinternals']);
    assert.deepEqual(plan.excluded.map((x) => [x.app.id, x.reason]), [['flash', 'unavailable']]);
  });
  it('never trusts an invalid package id: the app becomes a manual step', () => {
    const plan = winget([app({ id: 'evil', name: 'Evil', winget_id: 'Evil.App; Remove-Item C:\\' })]);
    assert.equal(plan.included.length, 0);
    assert.equal(plan.manual.length, 1);
  });
  it('excludes withdrawn records and apps declared unsupported on the target', () => {
    const old = app({ id: 'old', name: 'Old', winget_id: 'Old.App', compatibility: { windows10: 'declared', windows11: 'unsupported', min_os_version: '10.0.19041' } });
    assert.deepEqual(winget([old], 'windows11').excluded.map((x) => x.reason), ['unsupported_on_target']);
    assert.equal(winget([old], 'windows10').included.length, 1);
    assert.deepEqual(winget([app({ verification_status: 'withdrawn' })]).excluded.map((x) => x.reason), ['withdrawn']);
  });
  it('can leave out apps whose compatibility is not declared', () => {
    const plan = planInstall({ apps: [app()], os: 'windows11', method: 'winget', includeUnknown: false });
    assert.deepEqual(plan.excluded.map((x) => x.reason), ['compatibility_unknown']);
    const flagged = winget([app()]);
    assert.deepEqual(flagged.included[0].flags, ['compatibility_not_declared']);
  });
  it('the download kit only accepts https direct downloads that publish a SHA-256', () => {
    const sha = 'a'.repeat(64);
    const good = app({ id: 'memtest', name: 'Memtest86+', winget_id: undefined, downloads: [{ kind: 'direct_binary', url: 'https://memtest.org/download/v8.10/mt86plus_8.10_x64.iso.zip', sha256: sha, architecture: 'x64' }] });
    const noHash = app({ id: 'nohash', name: 'No hash', winget_id: undefined, downloads: [{ kind: 'direct_binary', url: 'https://example.com/a.exe', architecture: 'x64' }] });
    const http = app({ id: 'http', name: 'Http', winget_id: undefined, downloads: [{ kind: 'direct_binary', url: 'http://example.com/a.exe', sha256: sha }] });
    const badHash = app({ id: 'badhash', name: 'Bad hash', winget_id: undefined, downloads: [{ kind: 'direct_binary', url: 'https://example.com/a.exe', sha256: 'XYZ' }] });
    const plan = planInstall({ apps: [good, noHash, http, badHash], os: 'windows11', method: 'download-kit' });
    assert.deepEqual(plan.included.map((x) => x.app.id), ['memtest']);
    assert.deepEqual(plan.manual.map((x) => x.app.id).sort(), ['badhash', 'http', 'nohash']);
  });
});

describe('commandLine', () => {
  it('builds the documented command with --exact and --source winget', () => {
    assert.equal(commandLine('Git.Git'), 'winget install --id Git.Git --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity');
    assert.equal(commandLine('Git.Git', { silent: false, acceptAgreements: false }), 'winget install --id Git.Git --exact --source winget');
  });
  it('refuses an invalid id outright', () => {
    for (const id of ['Git.Git; calc', '$(calc)', '', null, 'a b']) assert.throws(() => commandLine(id), /invalid package id/);
  });
});

describe('WinGet script', () => {
  const apps = [app({ id: 'vcredist', name: 'VC++ Redist', winget_id: 'Microsoft.VCRedist.2015+.x64', category: 'runtimes' }), app(), app({ id: 'steam', name: 'Steam', winget_id: 'Valve.Steam', category: 'gaming' })];
  const s = script(apps);

  it('refuses to generate an empty script', () => assert.throws(() => buildWingetScript({ plan: winget([]), meta: META }), /Nothing to install/));
  it('refuses a plan that somehow carries an invalid id', () => {
    const plan = winget([app()]);
    plan.included[0].app.winget_id = "Git.Git'; calc; '";
    assert.throws(() => buildWingetScript({ plan, meta: META }), /invalid package id/);
  });

  it('checks the OS, Windows build and WinGet before doing anything', () => {
    assert.match(s, /\$env:OS -ne 'Windows_NT'/);
    assert.match(s, /Win32_OperatingSystem/);
    assert.match(s, /\$build -lt 17763/);
    assert.match(s, /Get-Command -Name winget\.exe/);
    assert.ok(s.indexOf('Checking this PC') < s.indexOf('Checking WinGet'));
    assert.ok(s.indexOf('Checking WinGet') < s.indexOf('Installation plan'));
  });

  it('prepares for the chosen Windows version and warns on a mismatch', () => {
    assert.match(script(apps, { os: 'windows10' }), /\$TargetOs = 'Windows 10'/);
    assert.match(s, /\$TargetOs = 'Windows 11'/);
    assert.match(s, /prepared for Windows 11 but this PC reports build/);
    assert.match(s, /prepared for Windows 10 but this PC is running Windows 11/);
  });

  it('asks for an explicit, case-sensitive YES before installing anything', () => {
    const gate = s.indexOf("-cne 'YES'");
    assert.ok(gate > 0, 'has the gate');
    assert.ok(gate < s.indexOf('& winget.exe @wingetArgs'), 'the gate comes before the first install');
    assert.match(s, /Read-Host \('Type YES in capital letters/);
    assert.match(s, /Cancelled\. Nothing was installed\.'; Exit-Script 3/);
    assert.match(s, /if \(\$DryRun\) \{\s+Write-Host 'DRY RUN: nothing will be installed\.'/, '-DryRun skips the prompt and installs nothing');
    assert.match(s, /if \(\$DryRun\) \{\s+Write-Host \('DRY RUN: winget '/);
  });

  it('installs through an argument array with --id, --exact and --source winget', () => {
    assert.match(s, /\$wingetArgs = @\('install', '--id', \$p\.Id, '--exact', '--source', 'winget'\)/);
    assert.match(s, /& winget\.exe @wingetArgs/);
    assert.doesNotMatch(s, /Invoke-Expression|\biex\b|cmd(\.exe)?\s+\/c|Start-Process/i, 'no string-built command lines');
  });

  it('lists every package id as a literal and nothing else as one', () => {
    const ids = [...s.matchAll(/Id = '([^']*)'/g)].map((m) => m[1]);
    assert.deepEqual(ids, ['Microsoft.VCRedist.2015+.x64', 'Git.Git', 'Valve.Steam']);
  });

  it('reports failed packages with the winget exit code and a readable reason', () => {
    assert.match(s, /FAILED PACKAGES/);
    assert.match(s, /\[exit code \{3\}\]/);
    assert.match(s, /\$okStates = @\('Installed', 'AlreadyInstalled', 'RebootRequired', 'DryRun'\)/);
    assert.match(s, /if \(\$failed\.Count -gt 0\) \{ Exit-Script 1 \} else \{ Exit-Script 0 \}/);
    for (const r of WINGET_RESULTS) assert.ok(s.includes(`'${r.code}' = @('${r.status}'`), `maps exit code ${r.code}`);
  });

  it('never weakens the system: no execution-policy changes, elevation, downloads or encoded commands', () => {
    for (const re of [/-ExecutionPolicy/i, /Set-ExecutionPolicy/i, /\bBypass\b/i, /-Verb\s+RunAs/i, /Invoke-WebRequest|Invoke-RestMethod|DownloadString|DownloadFile|\bWebClient\b|\bcurl\b|\bwget\b|\birm\b/i,
      /-EncodedCommand|FromBase64String|\[Convert\]/i, /Add-Type|\[Reflection\.Assembly\]/i, /@'|@"|<#|#>/]) {
      assert.doesNotMatch(s, re, String(re));
    }
  });

  it('uses only an allow-list of PowerShell commands, so any new command needs a deliberate review', () => {
    const allowed = ['Exit-Script', 'ForEach-Object', 'Get-CimInstance', 'Get-Command', 'Get-Date', 'Join-Path', 'New-Object', 'Out-String', 'Read-Host', 'Set-Content', 'Set-StrictMode', 'Where-Object', 'Write-Host', 'Write-Step'];
    assert.deepEqual(commandsUsed(s).filter((c) => !allowed.includes(c)), []);
  });

  it('starts with #Requires, is ASCII only and uses LF line endings with a trailing newline', () => {
    assert.ok(s.startsWith('#Requires -Version 5.1\n'));
    assert.match(s, /^[\x0a\x20-\x7e]*$/);
    assert.ok(s.endsWith('\n') && !s.endsWith('\n\n'));
  });

  it('is deterministic for the same input', () => assert.equal(script(apps), script(apps)));
  it('has balanced brackets (a cheap syntax check, since PowerShell is not available here)', () => assert.deepEqual(bracketBalance(s), { ok: true }));
  it('honours the silent and agreement options', () => {
    const off = script(apps, { options: { silent: false, acceptAgreements: false } });
    assert.match(off, /\$AcceptAgreements = \$false/);
    assert.match(off, /\$Silent = \$false/);
    assert.match(s, /\$AcceptAgreements = \$true/);
    assert.match(s, /which accepts the license terms of the listed packages on your behalf/);
  });
  it('lists manual steps separately and says they are not part of the script', () => {
    const withManual = script([app(), app({ id: 'sys', name: 'Sysinternals Suite', winget_id: undefined, category: 'system-tools', source_url: 'https://learn.microsoft.com/sysinternals/' })]);
    assert.match(withManual, /\$ManualSteps = @\(\s+\[pscustomobject\]@\{ Name = 'Sysinternals Suite'/);
    assert.match(withManual, /Not part of this script \(install these yourself\)/);
    assert.ok(!/Id = 'Sysinternals/.test(withManual));
  });
});

describe('hostile input cannot change the structure of the script', () => {
  const benign = [app({ name: 'Benign App', winget_id: 'Benign.App' }), app({ id: 'two', name: 'Second', winget_id: 'Second.App', category: 'runtimes' })];
  const benignWinget = script(benign, { meta: { bundleName: 'Benign bundle' } });

  const names = [
    "Evil'; Remove-Item C:\\ -Recurse; '", "x' + (iex 'calc') + '", 'a\nRemove-Item C:\\ -Recurse\nb', 'a\r\nStart-Process calc\r\nb', '$(Remove-Item C:\\ -Recurse)', '`$(calc)`', '<# comment #> calc',
    "@'\nhere-string\n'@", '"; calc; "', 'x\u2028Remove-Item C:\\\u2029y', 'x\u2018; calc; \u2019', "\u201a'; calc; '\u201b", '\u202eRemove-Item\u202c', '{0} {1} {2}', 'x'.repeat(5000),
    '\u65e5\u672c\u8a9e\u30a2\u30d7\u30ea', '\ud83d\ude00\ud83d\ude00', '', ' ', '#', '# not a comment? it is', '%PATH%', '..\\..\\Windows\\System32',
  ];

  for (const hostile of names) {
    it(`WinGet script: ${JSON.stringify(hostile).slice(0, 48)}`, () => {
      const apps = benign.map((a, i) => (i === 0 ? { ...a, name: hostile, publisher: hostile, description: hostile, source_url: `https://example.com/${encodeURIComponent(hostile)}` } : a));
      const s = script(apps, { meta: { bundleName: hostile, catalogUpdated: hostile } });
      assert.equal(skeleton(s), skeleton(benignWinget), 'skeleton is identical to the benign script');
      assert.match(s, /^[\x0a\x20-\x7e]*$/, 'ASCII only');
      assert.doesNotMatch(s, /\r|\u2028|\u2029/, 'no stray line separators');
      assert.deepEqual(bracketBalance(s), { ok: true });
      for (const line of s.split('\n')) if (/Remove-Item|Start-Process|calc\b/.test(line)) assert.ok(/^\s*#/.test(line) || /'(?:[^']|'')*(Remove-Item|Start-Process|calc)/.test(line), `hostile text outside a literal or comment: ${line}`);
    });
  }

  it('fuzz: 500 random hostile names and bundle names keep the skeleton identical', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const hostile = hostileString(rand);
      const apps = benign.map((a, k) => (k === 0 ? { ...a, name: hostile } : a));
      const s = script(apps, { meta: { bundleName: hostileString(rand) } });
      assert.equal(skeleton(s), skeleton(benignWinget), `case ${i}: ${JSON.stringify(hostile)}`);
      assert.match(s, /^[\x0a\x20-\x7e]*$/);
    }
  });

  it('a name with no ASCII text falls back to the package id', () => {
    const s = script([app({ name: '\u65e5\u672c\u8a9e\u30a2\u30d7\u30ea', winget_id: 'Jp.App' })]);
    assert.match(s, /Id = 'Jp\.App'; Name = 'Jp\.App'/);
  });

  it('a hostile bundle name appears only on a single comment line', () => {
    const s = script(benign, { meta: { bundleName: "x'\nRemove-Item C:\\ -Recurse #" } });
    const carriers = s.split('\n').filter((l) => l.includes('Remove-Item'));
    assert.equal(carriers.length, 1);
    assert.ok(carriers[0].startsWith('# Bundle'));
  });

  it('download kit: hostile URLs, architectures and names stay inside literals', () => {
    const sha = 'b'.repeat(64);
    const mk = (name, url) => app({ id: 'kit', name, winget_id: undefined, downloads: [{ kind: 'direct_binary', url, sha256: sha, architecture: 'x64' }] });
    const build = (a) => buildDownloadKitScript({ plan: planInstall({ apps: [a], os: 'windows11', method: 'download-kit' }), meta: META });
    const benignKit = build(mk('Kit', 'https://example.com/kit.zip'));
    for (const hostile of ["x'; Remove-Item C:\\ -Recurse; '", 'a\nStart-Process calc', '$(calc)', '"; calc; "']) {
      const k = build(mk(hostile, `https://example.com/${hostile}`.replace(/\s/g, '%20')));
      assert.equal(skeleton(k), skeleton(benignKit), JSON.stringify(hostile));
      assert.match(k, /^[\x0a\x20-\x7e]*$/);
    }
  });
});

describe('download kit script', () => {
  const sha = 'c'.repeat(64);
  const kitApps = [app({ id: 'memtest', name: 'Memtest86+', winget_id: undefined, downloads: [{ kind: 'direct_binary', url: 'https://memtest.org/download/v8.10/mt86plus_8.10_x64.iso.zip', sha256: sha, architecture: 'x64' }] })];
  const k = buildDownloadKitScript({ plan: planInstall({ apps: kitApps, os: 'windows11', method: 'download-kit' }), meta: META });

  it('refuses to generate an empty kit', () => assert.throws(() => buildDownloadKitScript({ plan: planInstall({ apps: [app()], method: 'download-kit' }), meta: META }), /Nothing to download/));
  it('downloads over https, verifies SHA-256, and deletes a file that does not match', () => {
    assert.match(k, /\$uri\.Scheme -ne 'https'/);
    assert.match(k, /Get-FileHash -LiteralPath \$dest -Algorithm SHA256/);
    assert.match(k, /Remove-Item -LiteralPath \$dest -Force/);
    assert.match(k, /SHA-256 does not match the published value; the file was deleted/);
    assert.match(k, new RegExp(`Sha256 = '${sha}'`));
  });
  it('never runs, opens, expands or installs anything it downloads', () => {
    assert.doesNotMatch(k, /Start-Process|Invoke-Item|Invoke-Expression|\biex\b|& \$dest|& \$variant|Expand-Archive|msiexec|\.Invoke\(|\[Diagnostics\.Process\]|rundll32|Install-/i);
    assert.match(k, /NEVER runs, opens or installs anything it downloads/);
  });
  it('supports -DryRun and a configurable folder, and sanitises the file name taken from the URL', () => {
    assert.match(k, /\[switch\]\$DryRun/);
    assert.match(k, /\[string\]\$Folder/);
    assert.match(k, /-replace '\[\^A-Za-z0-9\._-\]', '_'/);
  });
  it('reports failures and has balanced brackets', () => {
    assert.match(k, /FAILED DOWNLOADS/);
    assert.deepEqual(bracketBalance(k), { ok: true });
  });
  it('contains no execution-policy tricks', () => assert.doesNotMatch(k, /-ExecutionPolicy|Bypass|-Verb\s+RunAs|EncodedCommand/i));
  it('uses only an allow-list of PowerShell commands (download, hash, delete the mismatched file, report)', () => {
    const allowed = ['Exit-Script', 'ForEach-Object', 'Get-Date', 'Get-FileHash', 'Invoke-WebRequest', 'Join-Path', 'New-Item', 'New-Object', 'Out-Null', 'Read-Host', 'Remove-Item', 'Set-StrictMode', 'Test-Path', 'Where-Object', 'Write-Host', 'Write-Step'];
    assert.deepEqual(commandsUsed(k).filter((c) => !allowed.includes(c)), []);
  });
});

describe('winget import file', () => {
  const plan = winget([app(), app({ id: 'ff', name: 'Firefox', winget_id: 'Mozilla.Firefox', category: 'browsers' }), app({ id: 'nowinget', name: 'No', winget_id: undefined })]);
  it('lists only valid catalog package ids with the default winget source', () => {
    const doc = buildWingetImport(plan, { now: '2026-10-13T00:00:00.000Z' });
    assert.equal(doc.$schema, 'https://aka.ms/winget-packages.schema.2.0.json');
    assert.deepEqual(doc.Sources[0].Packages.map((p) => p.PackageIdentifier), ['Mozilla.Firefox', 'Git.Git']);
    assert.equal(doc.Sources[0].SourceDetails.Name, 'winget');
    assert.equal(doc.Sources[0].SourceDetails.Identifier, 'Microsoft.Winget.Source_8wekyb3d8bbwe');
    assert.equal(doc.CreationDate, '2026-10-13T00:00:00.000Z');
  });
  it('refuses to export nothing', () => assert.throws(() => buildWingetImport(winget([])), /No WinGet packages/));
});

describe('WinGet exit-code table', () => {
  it('has unique int32 codes and a status for each', () => {
    const codes = WINGET_RESULTS.map((r) => r.code);
    assert.equal(new Set(codes).size, codes.length);
    for (const r of WINGET_RESULTS) {
      assert.ok(Number.isInteger(r.code) && r.code >= -2147483648 && r.code <= 2147483647, String(r.code));
      assert.ok(['Installed', 'AlreadyInstalled', 'RebootRequired', 'Failed'].includes(r.status));
    }
    assert.equal(WINGET_RESULTS.find((r) => r.code === -1978335135).status, 'AlreadyInstalled');
    assert.equal(WINGET_RESULTS.find((r) => r.code === -1978335215).status, 'Failed', 'a hash mismatch is a failure, never a success');
  });
});

describe('the real catalog generates a safe script', () => {
  it('every catalog app with a WinGet id produces valid output', async () => {
    const { apps } = await loadCatalogs();
    const plan = planInstall({ apps: apps.items, os: 'windows11', method: 'winget' });
    assert.ok(plan.included.length >= 200, `expected 200+ packages, got ${plan.included.length}`);
    const s = buildWingetScript({ plan, meta: META });
    assert.match(s, /^[\x0a\x20-\x7e]*$/);
    assert.deepEqual(bracketBalance(s), { ok: true });
    const ids = [...s.matchAll(/Id = '([^']*)'/g)].map((m) => m[1]);
    assert.equal(ids.length, plan.included.length);
    for (const id of ids) assert.ok(isValidWingetId(id), id);
    assert.equal(new Set(ids.map((i) => i.toLowerCase())).size, ids.length, 'no duplicate package ids');
    assert.ok(literals(s).every((l) => !/[\r\n]/.test(l)));
  });
});

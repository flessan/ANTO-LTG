// PowerShell script generation for the Software Center.
//
// SECURITY MODEL (covered by tests/unit/psgen.test.mjs, including a structural injection test):
//  * Only catalog records feed the script - never imported manifests or free text from the user.
//  * Package identifiers must match WINGET_ID_RE (no quotes, spaces, $, `, ;, |, &, parentheses).
//  * Every string placed in the script is ASCII, single-quoted with ' doubled, and cannot contain a
//    newline; user-influenced text is never placed in a block comment or a here-string.
//  * The script never uses -ExecutionPolicy Bypass, never elevates itself, never runs a downloaded
//    file, and installs nothing until the person types YES (case-sensitive).
//  * WinGet is invoked with an argument ARRAY (splatting), so the shell does no parsing of IDs.
import { sortForInstall, compatFor, installMethods, OS_TARGETS } from './model.js';

export const WINGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
export const isValidWingetId = (id) => typeof id === 'string' && WINGET_ID_RE.test(id);

// Exit codes from winget-cli's doc/windows/package-manager/winget/returnCodes.md (verified 2026-10-13).
export const WINGET_RESULTS = [
  { code: 0, status: 'Installed', note: '' },
  { code: -1978335135, status: 'AlreadyInstalled', note: 'Already installed (PACKAGE_ALREADY_INSTALLED)' },
  { code: -1978334963, status: 'AlreadyInstalled', note: 'Another version is already installed (INSTALL_ALREADY_INSTALLED)' },
  { code: -1978334967, status: 'RebootRequired', note: 'Restart needed to finish installation (INSTALL_REBOOT_REQUIRED_TO_FINISH)' },
  { code: -1978334965, status: 'RebootRequired', note: 'Restart initiated to finish installation (INSTALL_REBOOT_INITIATED)' },
  { code: -1978335216, status: 'Failed', note: 'No installer applies to this PC (NO_APPLICABLE_INSTALLER)' },
  { code: -1978335215, status: 'Failed', note: 'Installer hash does not match the manifest (INSTALLER_HASH_MISMATCH)' },
  { code: -1978335224, status: 'Failed', note: 'Downloading the installer failed (DOWNLOAD_FAILED)' },
  { code: -1978334975, status: 'Failed', note: 'The application is running; close it and retry (INSTALL_PACKAGE_IN_USE)' },
  { code: -1978334971, status: 'Failed', note: 'The disk is full (INSTALL_DISK_FULL)' },
  { code: -1978334961, status: 'Failed', note: 'Blocked by organization policy (INSTALL_BLOCKED_BY_POLICY)' },
  { code: -1978335174, status: 'Failed', note: 'Blocked by Group Policy (BLOCKED_BY_POLICY)' },
  { code: -1978335162, status: 'Failed', note: 'Source agreements were not accepted (SOURCE_AGREEMENTS_NOT_ACCEPTED)' },
  { code: -1978335212, status: 'Failed', note: 'Package not found in the source (NO_APPLICATIONS_FOUND)' },
  { code: -1978334960, status: 'Failed', note: 'Installing a dependency failed (INSTALL_DEPENDENCIES)' },
];

// ---- text safety -------------------------------------------------------------------------------
export function sanitizeForScript(text, { max = 100 } = {}) {
  let s = String(text ?? '');
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  // PowerShell treats typographic quotes as quote characters: map them to ASCII so they get doubled.
  s = s.replace(/[\u2018\u2019\u201a\u201b\u2032\uff07]/g, "'").replace(/[\u201c\u201d\u201e\u201f\u2033\uff02]/g, '"');
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, ' ');
  s = s.replace(/[^\x20-\x7e]/g, '?').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max - 3).trimEnd()}...`;
  return s;
}

export function psQuote(text, opts) {
  return `'${sanitizeForScript(text, opts).replace(/['\u2018\u2019\u201a\u201b]/g, "''")}'`;
}

// Line comments only; "<#" and "#>" are broken up so text can never open or close a block comment.
export function psComment(text, opts) {
  return `# ${sanitizeForScript(text, { max: 140, ...opts }).replace(/<#/g, '< #').replace(/#>/g, '# >')}`;
}

const displayName = (app) => {
  const s = sanitizeForScript(app.name, { max: 80 });
  return s.replace(/\?/g, '').length < Math.ceil(s.length / 2) ? sanitizeForScript(app.winget_id ?? app.id, { max: 80 }) : s;
};

// ---- planning ------------------------------------------------------------------------------------
// Decides, for each selected app, whether it is part of the script, a manual step, or excluded - and why.
export function planInstall({ apps, os = 'windows11', method = 'winget', includeUnknown = true }) {
  const included = []; const manual = []; const excluded = [];
  for (const app of sortForInstall(apps)) {
    const m = installMethods(app);
    if (m.unavailable) { excluded.push({ app, reason: 'unavailable', detail: app.availability?.reason ?? '' }); continue; }
    if (app.verification_status === 'withdrawn') { excluded.push({ app, reason: 'withdrawn', detail: '' }); continue; }
    const compat = compatFor(app, os);
    if (compat === 'unsupported') { excluded.push({ app, reason: 'unsupported_on_target', detail: app.compatibility?.min_os_version ? `Declared minimum Windows ${app.compatibility.min_os_version}` : '' }); continue; }
    if (compat === 'unknown' && !includeUnknown) { excluded.push({ app, reason: 'compatibility_unknown', detail: '' }); continue; }
    const flags = compat === 'unknown' ? ['compatibility_not_declared'] : [];
    if (method === 'winget') {
      if (m.winget && isValidWingetId(app.winget_id)) included.push({ app, compat, flags });
      else manual.push({ app, reason: 'no_winget_package', link: app.source_url });
    } else {
      const variants = (app.downloads ?? []).filter((d) => d.kind === 'direct_binary' && /^https:\/\//.test(d.url) && /^[a-f0-9]{64}$/.test(d.sha256 ?? ''));
      if (variants.length) included.push({ app, compat, flags, variants });
      else manual.push({ app, reason: 'no_direct_download_with_published_hash', link: app.source_url });
    }
  }
  return { included, manual, excluded, os, method };
}

export function commandLine(id, { silent = true, acceptAgreements = true } = {}) {
  if (!isValidWingetId(id)) throw new Error('Refusing to build a command for an invalid package id');
  return ['winget install --id', id, '--exact --source winget', silent ? '--silent' : '', acceptAgreements ? '--accept-package-agreements --accept-source-agreements --disable-interactivity' : ''].filter(Boolean).join(' ');
}

const REASON_TEXT = {
  no_winget_package: 'No WinGet package is listed; install it from the page',
  no_direct_download_with_published_hash: 'No official direct download with a published hash; use the page',
};
const FLAG_TEXT = { compatibility_not_declared: 'Windows compatibility is not declared by the package source.' };

function header(kind, plan, meta) {
  const title = kind === 'winget' ? 'WinGet installer script' : 'Download kit (download and verify only)';
  const lines = [
    '#Requires -Version 5.1',
    `# ANTO-LTG ${title}`,
    psComment(`Bundle    : ${meta.bundleName || 'Untitled bundle'}`),
    psComment(`Target    : ${OS_TARGETS[plan.os] ?? 'Windows'}`),
    `# Packages  : ${plan.included.length}${plan.manual.length ? ` (+ ${plan.manual.length} manual step${plan.manual.length === 1 ? '' : 's'})` : ''}`,
    psComment(`Generated : ${meta.generatedAt}`),
    psComment(`Catalog   : schema ${meta.schemaVersion ?? '1.1.0'}, updated ${meta.catalogUpdated ?? 'unknown'}; records are pending human review`),
    '#',
    '# READ THIS SCRIPT BEFORE YOU RUN IT.',
  ];
  if (kind === 'winget') {
    lines.push(
      '#  * It installs only the packages listed in $Packages, from the WinGet community source,',
      '#    with: winget install --id <ID> --exact --source winget',
      '#  * It does not use -ExecutionPolicy Bypass and does not elevate itself.',
      '#  * Nothing is installed until you type YES. Use -DryRun to preview without installing.',
    );
  } else {
    lines.push(
      '#  * It downloads only the files listed in $Items, over HTTPS, into one folder, and checks each',
      '#    file against the SHA-256 published by the source. A file that does not match is deleted.',
      '#  * It NEVER runs, opens or installs anything it downloads. Install files yourself after review.',
      '#  * Use -DryRun to see what would be downloaded.',
    );
  }
  return lines;
}

function manualBlock(plan) {
  if (!plan.manual.length) return ['$ManualSteps = @()'];
  const rows = plan.manual.map((m) => `    [pscustomobject]@{ Name = ${psQuote(displayName(m.app))}; Reason = ${psQuote(REASON_TEXT[m.reason] ?? m.reason)}; Link = ${psQuote(/^https:\/\//.test(m.link ?? '') ? m.link : '', { max: 300 })} }`);
  return ['$ManualSteps = @(', ...rows, ')'];
}

const STEP_HELPERS = [
  'function Write-Step([string]$Text) { Write-Host \'\'; Write-Host "== $Text" -ForegroundColor Cyan }',
  'function Exit-Script([int]$Code) {',
  '    if (-not $NoPause) { [void](Read-Host \'Press Enter to close\') }',
  '    exit $Code',
  '}',
];

// ---- WinGet script ---------------------------------------------------------------------------------
export function buildWingetScript({ plan, options = {}, meta = {} }) {
  const opt = { silent: options.silent !== false, acceptAgreements: options.acceptAgreements !== false };
  const m = { generatedAt: new Date(0).toISOString(), ...meta };
  if (!plan.included.length) throw new Error('Nothing to install: the plan has no WinGet packages');
  const packages = plan.included.map(({ app, flags }) => {
    if (!isValidWingetId(app.winget_id)) throw new Error('Refusing to include an invalid package id');
    const note = flags.map((f) => FLAG_TEXT[f] ?? '').filter(Boolean).join(' ');
    return `    [pscustomobject]@{ Id = ${psQuote(app.winget_id, { max: 128 })}; Name = ${psQuote(displayName(app))}; Note = ${psQuote(note, { max: 200 })} }`;
  });
  const known = WINGET_RESULTS.map((r) => `    ${psQuote(String(r.code))} = @(${psQuote(r.status)}, ${psQuote(r.note, { max: 200 })})`);
  const L = [
    ...header('winget', plan, m),
    '[CmdletBinding()]', 'param(', '    [switch]$DryRun,', '    [switch]$NoPause', ')', '',
    'Set-StrictMode -Version Latest', '$ErrorActionPreference = \'Stop\'', '$global:LASTEXITCODE = 0', '',
    `$TargetOs = ${psQuote(OS_TARGETS[plan.os] ?? 'Windows')}`,
    `$AcceptAgreements = ${opt.acceptAgreements ? '$true' : '$false'}`,
    `$Silent = ${opt.silent ? '$true' : '$false'}`,
    '$Packages = @(', ...packages, ')',
    ...manualBlock(plan),
    '$KnownResults = @{', ...known, '}', '',
    ...STEP_HELPERS, '',
    'Write-Step \'Checking this PC\'',
    'if ($env:OS -ne \'Windows_NT\') { Write-Host \'This script only supports Windows.\' -ForegroundColor Red; Exit-Script 2 }',
    '$os = Get-CimInstance -ClassName Win32_OperatingSystem',
    '$build = [int]$os.BuildNumber',
    '$arch = $env:PROCESSOR_ARCHITECTURE',
    'Write-Host (\'Detected     : {0} (build {1}, {2})\' -f $os.Caption, $build, $arch)',
    'Write-Host (\'Prepared for : {0}\' -f $TargetOs)',
    '$warnings = New-Object System.Collections.Generic.List[string]',
    'if ($build -lt 17763) { Write-Host \'WinGet needs Windows 10 version 1809 (build 17763) or later.\' -ForegroundColor Red; Exit-Script 2 }',
    'if ($TargetOs -eq \'Windows 11\' -and $build -lt 22000) { $warnings.Add(\'This script was prepared for Windows 11 but this PC reports build \' + $build + \'.\') }',
    'if ($TargetOs -eq \'Windows 10\' -and $build -ge 22000) { $warnings.Add(\'This script was prepared for Windows 10 but this PC is running Windows 11 (build \' + $build + \').\') }',
    '$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    'if (-not $isAdmin) { Write-Host \'Not running as administrator: packages that need it will show a Windows UAC prompt.\' -ForegroundColor Yellow }', '',
    'Write-Step \'Checking WinGet\'',
    '$wingetCmd = Get-Command -Name winget.exe -ErrorAction SilentlyContinue',
    'if (-not $wingetCmd) {',
    '    Write-Host \'WinGet (App Installer) was not found on this PC.\' -ForegroundColor Red',
    '    Write-Host \'Install or update "App Installer" from the Microsoft Store (https://aka.ms/getwinget), then run this script again.\'',
    '    Exit-Script 2', '}',
    '$wingetVersion = ((& winget.exe --version) 2>&1 | Out-String).Trim()',
    'Write-Host (\'WinGet       : {0}\' -f $wingetVersion)', '',
    'Write-Step \'Installation plan\'',
    '$i = 0',
    'foreach ($p in $Packages) {',
    '    $i++',
    '    Write-Host (\'{0,3}. {1}  [{2}]\' -f $i, $p.Name, $p.Id)',
    '    if ($p.Note) { Write-Host (\'       note: {0}\' -f $p.Note) -ForegroundColor Yellow }',
    '}',
    'if ($ManualSteps.Count -gt 0) {',
    '    Write-Host \'\'',
    '    Write-Host \'Not part of this script (install these yourself):\'',
    '    foreach ($m in $ManualSteps) { Write-Host (\' - {0}: {1} {2}\' -f $m.Name, $m.Reason, $m.Link) }',
    '}',
    'foreach ($w in $warnings) { Write-Host (\'WARNING: \' + $w) -ForegroundColor Yellow }', '',
    'Write-Host \'\'',
    'Write-Host \'Each package is installed with: winget install --id <ID> --exact --source winget ...\'',
    'if ($AcceptAgreements) { Write-Host \'This script passes --accept-package-agreements and --accept-source-agreements, which accepts the license terms of the listed packages on your behalf.\' -ForegroundColor Yellow }',
    'if ($DryRun) {',
    '    Write-Host \'DRY RUN: nothing will be installed.\' -ForegroundColor Green',
    '} else {',
    '    $answer = Read-Host (\'Type YES in capital letters to install {0} package(s), or press Enter to cancel\' -f $Packages.Count)',
    '    if ($answer -cne \'YES\') { Write-Host \'Cancelled. Nothing was installed.\'; Exit-Script 3 }',
    '}', '',
    '$results = New-Object System.Collections.Generic.List[object]',
    '$n = $Packages.Count',
    '$i = 0',
    'foreach ($p in $Packages) {',
    '    $i++',
    '    Write-Step (\'[{0}/{1}] {2} ({3})\' -f $i, $n, $p.Name, $p.Id)',
    '    $wingetArgs = @(\'install\', \'--id\', $p.Id, \'--exact\', \'--source\', \'winget\')',
    '    if ($Silent) { $wingetArgs += \'--silent\' }',
    '    if ($AcceptAgreements) { $wingetArgs += @(\'--accept-package-agreements\', \'--accept-source-agreements\', \'--disable-interactivity\') }',
    '    if ($DryRun) {',
    '        Write-Host (\'DRY RUN: winget \' + ($wingetArgs -join \' \'))',
    '        $results.Add([pscustomobject]@{ Id = $p.Id; Name = $p.Name; Status = \'DryRun\'; ExitCode = 0; Reason = \'Not executed\' })',
    '        continue',
    '    }',
    '    $global:LASTEXITCODE = 0',
    '    $reason = \'\'',
    '    try {',
    '        & winget.exe @wingetArgs',
    '        $code = $LASTEXITCODE',
    '    } catch {',
    '        $code = -1',
    '        $reason = $_.Exception.Message',
    '    }',
    '    $key = [string]$code',
    '    if ($KnownResults.ContainsKey($key)) { $status = $KnownResults[$key][0]; $reason = $KnownResults[$key][1] }',
    '    else { $status = \'Failed\'; if (-not $reason) { $reason = \'winget exited with code \' + $code } }',
    '    $results.Add([pscustomobject]@{ Id = $p.Id; Name = $p.Name; Status = $status; ExitCode = $code; Reason = $reason })',
    '}', '',
    'Write-Step \'Summary\'',
    '$okStates = @(\'Installed\', \'AlreadyInstalled\', \'RebootRequired\', \'DryRun\')',
    '$failed = @($results | Where-Object { $okStates -notcontains $_.Status })',
    '$succeeded = @($results | Where-Object { $okStates -contains $_.Status })',
    'Write-Host (\'Succeeded: {0}   Failed: {1}   Total: {2}\' -f $succeeded.Count, $failed.Count, $results.Count)',
    'foreach ($r in $results) { Write-Host (\' {0,-17} {1} ({2}) {3}\' -f $r.Status, $r.Name, $r.Id, $r.Reason) }',
    'if ($failed.Count -gt 0) {',
    '    Write-Host \'\'',
    '    Write-Host \'FAILED PACKAGES\' -ForegroundColor Red',
    '    foreach ($f in $failed) { Write-Host (\' - {0} ({1}): {2} [exit code {3}]\' -f $f.Name, $f.Id, $f.Reason, $f.ExitCode) -ForegroundColor Red }',
    '    Write-Host \'Run this script again to retry; packages that are already installed are skipped.\'',
    '}',
    'if (@($results | Where-Object { $_.Status -eq \'RebootRequired\' }).Count -gt 0) { Write-Host \'Restart Windows to finish installing the packages marked RebootRequired.\' -ForegroundColor Yellow }',
    'if (-not $DryRun) {',
    '    try {',
    '        $reportPath = Join-Path -Path ([Environment]::GetFolderPath(\'Desktop\')) -ChildPath \'anto-ltg-install-report.txt\'',
    '        $lines = @(\'ANTO-LTG install report\', (\'Date: \' + (Get-Date -Format \'s\')), (\'Windows: {0} build {1} ({2})\' -f $os.Caption, $build, $arch), (\'WinGet: \' + $wingetVersion), \'\')',
    '        $lines += @($results | ForEach-Object { \'{0,-17} {1} ({2}) exit={3} {4}\' -f $_.Status, $_.Name, $_.Id, $_.ExitCode, $_.Reason })',
    '        Set-Content -LiteralPath $reportPath -Value $lines -Encoding UTF8',
    '        Write-Host (\'Report saved to \' + $reportPath)',
    '    } catch { Write-Host \'Could not save the report file.\' -ForegroundColor Yellow }',
    '}',
    'if ($failed.Count -gt 0) { Exit-Script 1 } else { Exit-Script 0 }',
  ];
  return `${L.join('\n')}\n`;
}

// ---- download kit (download + verify, never execute) ------------------------------------------------
export function buildDownloadKitScript({ plan, meta = {} }) {
  const m = { generatedAt: new Date(0).toISOString(), ...meta };
  if (!plan.included.length) throw new Error('Nothing to download: no app has an official direct download with a published hash');
  const items = plan.included.map(({ app, variants }) => {
    const rows = variants.map((v) => `        [pscustomobject]@{ Arch = ${psQuote(v.architecture ?? 'neutral')}; Url = ${psQuote(v.url, { max: 600 })}; Sha256 = ${psQuote(v.sha256)} }`);
    return `    [pscustomobject]@{ Name = ${psQuote(displayName(app))}; Variants = @(\n${rows.join(',\n')}\n    ) }`;
  });
  const L = [
    ...header('kit', plan, m),
    '[CmdletBinding()]', 'param(', '    [switch]$DryRun,', '    [switch]$NoPause,', '    [string]$Folder', ')', '',
    'Set-StrictMode -Version Latest', '$ErrorActionPreference = \'Stop\'', '',
    '$Items = @(', items.join(',\n'), ')',
    ...manualBlock(plan), '',
    ...STEP_HELPERS, '',
    'if (-not $Folder) { $Folder = Join-Path -Path ([Environment]::GetFolderPath(\'UserProfile\')) -ChildPath \'Downloads\\ANTO-LTG-kit\' }',
    '$archKey = switch ($env:PROCESSOR_ARCHITECTURE) { \'AMD64\' { \'x64\' } \'ARM64\' { \'arm64\' } \'x86\' { \'x86\' } default { \'x64\' } }',
    '$prefer = switch ($archKey) { \'x64\' { @(\'x64\', \'x86\', \'neutral\') } \'arm64\' { @(\'arm64\', \'x64\', \'x86\', \'neutral\') } default { @(\'x86\', \'neutral\') } }',
    'Write-Step (\'Download kit for \' + $archKey + \' into \' + $Folder)',
    'Write-Host \'Files are only downloaded and verified. Nothing is run or installed.\'',
    'if ($DryRun) { Write-Host \'DRY RUN: nothing will be downloaded.\' -ForegroundColor Green }',
    'elseif (-not (Test-Path -LiteralPath $Folder)) { New-Item -ItemType Directory -Path $Folder | Out-Null }',
    '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12',
    '$ProgressPreference = \'SilentlyContinue\'',
    '$results = New-Object System.Collections.Generic.List[object]',
    '$n = 0',
    'foreach ($item in $Items) {',
    '    $n++',
    '    $variant = $null',
    '    foreach ($a in $prefer) { $variant = @($item.Variants | Where-Object { $_.Arch -eq $a })[0]; if ($variant) { break } }',
    '    if (-not $variant) { $results.Add([pscustomobject]@{ Name = $item.Name; Status = \'Failed\'; Reason = \'No download for this processor architecture\'; File = \'\' }); continue }',
    '    $uri = [Uri]$variant.Url',
    '    if ($uri.Scheme -ne \'https\') { $results.Add([pscustomobject]@{ Name = $item.Name; Status = \'Failed\'; Reason = \'Not an https URL\'; File = \'\' }); continue }',
    '    $fileName = ([Uri]::UnescapeDataString([IO.Path]::GetFileName($uri.AbsolutePath)) -replace \'[^A-Za-z0-9._-]\', \'_\')',
    '    if (-not $fileName) { $fileName = \'download-\' + $n + \'.bin\' }',
    '    $dest = Join-Path -Path $Folder -ChildPath $fileName',
    '    Write-Step (\'[{0}/{1}] {2}\' -f $n, $Items.Count, $item.Name)',
    '    if ($DryRun) { Write-Host (\'DRY RUN: would download \' + $variant.Url); $results.Add([pscustomobject]@{ Name = $item.Name; Status = \'DryRun\'; Reason = \'Not downloaded\'; File = $fileName }); continue }',
    '    try {',
    '        Invoke-WebRequest -Uri $variant.Url -OutFile $dest -UseBasicParsing',
    '        $actual = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant()',
    '        if ($actual -ne $variant.Sha256.ToLowerInvariant()) {',
    '            Remove-Item -LiteralPath $dest -Force',
    '            $results.Add([pscustomobject]@{ Name = $item.Name; Status = \'Failed\'; Reason = \'SHA-256 does not match the published value; the file was deleted\'; File = $fileName })',
    '        } else {',
    '            Write-Host (\'Verified SHA-256 \' + $actual)',
    '            $results.Add([pscustomobject]@{ Name = $item.Name; Status = \'Verified\'; Reason = \'\'; File = $fileName })',
    '        }',
    '    } catch {',
    '        $results.Add([pscustomobject]@{ Name = $item.Name; Status = \'Failed\'; Reason = $_.Exception.Message; File = $fileName })',
    '    }',
    '}', '',
    'Write-Step \'Summary\'',
    'foreach ($r in $results) { Write-Host (\' {0,-9} {1} {2} {3}\' -f $r.Status, $r.Name, $r.File, $r.Reason) }',
    '$failed = @($results | Where-Object { $_.Status -eq \'Failed\' })',
    'if ($failed.Count -gt 0) { Write-Host \'\'; Write-Host \'FAILED DOWNLOADS\' -ForegroundColor Red; foreach ($f in $failed) { Write-Host (\' - {0}: {1}\' -f $f.Name, $f.Reason) -ForegroundColor Red } }',
    'if ($ManualSteps.Count -gt 0) { Write-Host \'\'; Write-Host \'Not part of this kit (get these from their page):\'; foreach ($m in $ManualSteps) { Write-Host (\' - {0}: {1} {2}\' -f $m.Name, $m.Reason, $m.Link) } }',
    'if (-not $DryRun) { Write-Host \'\'; Write-Host (\'Files are in \' + $Folder + \'. Review them before installing.\') }',
    'if ($failed.Count -gt 0) { Exit-Script 1 } else { Exit-Script 0 }',
  ];
  return `${L.join('\n')}\n`;
}

// ---- winget import file -------------------------------------------------------------------------------
// Format: https://aka.ms/winget-packages.schema.2.0.json (default source values from winget-cli SourceList.cpp).
export function buildWingetImport(plan, { now = new Date(0).toISOString() } = {}) {
  const ids = plan.included.map(({ app }) => app.winget_id).filter(isValidWingetId);
  if (!ids.length) throw new Error('No WinGet packages to export');
  return {
    $schema: 'https://aka.ms/winget-packages.schema.2.0.json',
    CreationDate: now,
    Sources: [{
      Packages: ids.map((PackageIdentifier) => ({ PackageIdentifier })),
      SourceDetails: { Argument: 'https://cdn.winget.microsoft.com/cache', Identifier: 'Microsoft.Winget.Source_8wekyb3d8bbwe', Name: 'winget', Type: 'Microsoft.PreIndexed.Package' },
    }],
  };
}

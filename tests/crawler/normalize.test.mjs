// Normalisation helpers: when a value cannot be parsed with confidence they return null. They never guess.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify, isPrerelease, compareVersions, looksLikeVersion, pickLatestVersion, parseIsoDate, cleanText, firstSentence, parseSha256, toHttpsUrl, canonicalUrl,
  osKeyFromLabel, parseSupportedOs, normalizeArchitecture, buildFromOsVersion, compatibilityFromMinOs, TARGET_BUILDS, OS_LABELS,
} from '../../scripts/crawler/lib/normalize.mjs';

describe('slugify', () => {
  it('makes stable, URL-safe ids', () => {
    assert.equal(slugify('7-Zip'), '7-zip');
    assert.equal(slugify('Notepad++'), 'notepad-plus-plus');
    assert.equal(slugify('Caf\u00e9 & Bar'), 'cafe-and-bar');
    assert.equal(slugify('  Visual Studio Code  '), 'visual-studio-code');
    assert.equal(slugify('C++ Redistributable (x64)'), 'c-plus-plus-redistributable-x64');
    assert.equal(slugify(''), '');
    assert.equal(slugify(null), '');
  });
  it('caps the length without leaving a trailing hyphen', () => {
    const s = slugify('word '.repeat(50), 20);
    assert.ok(s.length <= 20 && !s.endsWith('-'), s);
  });
  it('only ever produces lowercase letters, digits and single hyphens', () => {
    for (const input of ['\u202eevil', 'a/b\\c', '../../etc/passwd', 'x'.repeat(200), '\u65e5\u672c\u8a9e', '<script>', '"; DROP TABLE']) assert.match(slugify(input) || 'x', /^[a-z0-9]+(-[a-z0-9]+)*$/, input);
  });
});

describe('versions', () => {
  it('compares numerically, not lexically (10 > 9, 2.10 > 2.9)', () => {
    assert.equal(compareVersions('10.0', '9.0'), 1);
    assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
    assert.equal(compareVersions('1.0', '1.0.0'), 0);
    assert.equal(compareVersions('v1.2', '1.2'), 0);
    assert.equal(compareVersions('1.2.3.4', '1.2.3.5'), -1);
    assert.equal(compareVersions('99999999999999999999.1', '99999999999999999998.1'), 1, 'no precision loss on huge numbers');
  });
  it('ranks pre-releases below the release', () => {
    assert.equal(compareVersions('2.0.0-beta.1', '2.0.0'), -1);
    assert.equal(compareVersions('2.0.0', '2.0.0-rc1'), 1);
    assert.equal(compareVersions('2.0.1', '2.0.0-rc1'), 1);
    for (const v of ['1.0-alpha', '1.0.beta2', '2.0-rc1', '3.0-preview', '1.0-nightly', '5.0-canary', '1.0-dev']) assert.equal(isPrerelease(v), true, v);
    for (const v of ['1.0.0', '2.55.0.5', '10.0.19045', '1.0.0+build5', '4.1.1-final']) assert.equal(isPrerelease(v), false, v);
  });
  it('recognises directory names that look like versions', () => {
    for (const v of ['1', '1.2.3', 'v2.0', '2026.10.13', '1.0.0-beta', '10.0.19045.5000']) assert.equal(looksLikeVersion(v), true, v);
    for (const v of ['Beta', 'Canary', 'EXE', 'latest', 'x64', 'readme.md', '', 'v', 'a1.0', `1${'0'.repeat(80)}`]) assert.equal(looksLikeVersion(v), false, v);
  });
  it('picks the newest stable version, falling back to pre-releases only when nothing else exists', () => {
    assert.deepEqual(pickLatestVersion(['1.9.0', '1.10.0', '1.2.0', 'Beta', '2.0.0-rc1', 'x64']), ['1.10.0', '1.9.0', '1.2.0']);
    assert.deepEqual(pickLatestVersion(['1.0.0-beta', '1.0.0-alpha']), ['1.0.0-beta', '1.0.0-alpha']);
    assert.deepEqual(pickLatestVersion([]), []);
    assert.deepEqual(pickLatestVersion(['Beta', 'Dev']), []);
  });
});

describe('parseIsoDate', () => {
  it('accepts real dates and drops any time part', () => {
    assert.equal(parseIsoDate('2026-10-13'), '2026-10-13');
    assert.equal(parseIsoDate('2026-10-13T03:04:05Z'), '2026-10-13');
    assert.equal(parseIsoDate(' 2026-02-28 '), '2026-02-28');
  });
  it('returns null for impossible, absurd or malformed dates (never a guess)', () => {
    for (const v of ['2026-02-30', '2026-13-01', '2026-00-10', '1989-12-31', '3000-01-01', 'yesterday', '13/10/2026', '20261013', '', null, undefined, 12345]) assert.equal(parseIsoDate(v), null, String(v));
  });
  it('accepts leap days only in leap years', () => { assert.equal(parseIsoDate('2024-02-29'), '2024-02-29'); assert.equal(parseIsoDate('2025-02-29'), null); });
});

describe('cleanText: crawled text is untrusted', () => {
  it('removes markup, control characters and bidirectional overrides, and collapses whitespace', () => {
    assert.equal(cleanText('  Hello <b>world</b>\n\t<script>alert(1)</script> \u202eevil\u0000 text  '), 'Hello world alert(1) evil text');
    assert.equal(cleanText('a\u200bb\u2066c\ufeffd'), 'a b c d');
  });
  it('is bounded and ends with an ellipsis rather than mid-word when it cuts', () => {
    const t = cleanText('word '.repeat(200), 50);
    assert.ok(t.length <= 51 && t.endsWith('\u2026'), t);
    assert.equal(cleanText('short'), 'short');
  });
  it('handles null and non-strings', () => { assert.equal(cleanText(null), ''); assert.equal(cleanText(undefined), ''); assert.equal(cleanText(42), '42'); });
  it('leaves plain angle-bracket maths alone when it is not a tag', () => assert.equal(cleanText('if a < b and c > d'), 'if a < b and c > d'));
  it('firstSentence takes the first sentence of a description', () => {
    assert.equal(firstSentence('Git is a distributed version control system. It is fast. It is free.'), 'Git is a distributed version control system.');
    assert.equal(firstSentence('No full stop here but long enough text'), 'No full stop here but long enough text');
    assert.equal(firstSentence(''), '');
  });
});

describe('parseSha256', () => {
  it('accepts exactly 64 hex digits (either case) and returns lower case', () => {
    assert.equal(parseSha256('A'.repeat(64)), 'a'.repeat(64));
    assert.equal(parseSha256(`  ${'0123456789abcdef'.repeat(4)}\n`), '0123456789abcdef'.repeat(4));
  });
  it('rejects everything else', () => {
    for (const v of ['', null, undefined, 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'sha256:' + 'a'.repeat(64), 'a'.repeat(32), 12345]) assert.equal(parseSha256(v), null, String(v));
  });
});

describe('toHttpsUrl', () => {
  it('keeps https URLs and normalises them', () => assert.equal(toHttpsUrl(' https://Example.com/a b '), 'https://example.com/a%20b'));
  it('rejects http, other schemes, credentials and garbage', () => {
    for (const v of ['http://example.com/', 'ftp://example.com/', 'javascript:alert(1)', 'https://u:p@example.com/', 'not a url', '', null, undefined]) assert.equal(toHttpsUrl(v), null, String(v));
  });
  it('percent-encodes characters that browsers tolerate but RFC 3986 forbids (WinGet installer URLs contain [ and ])', () => {
    assert.equal(toHttpsUrl('https://example.com/dl/app[1].exe'), 'https://example.com/dl/app%5B1%5D.exe');
    assert.equal(toHttpsUrl('https://example.com/a|b^c`d'), 'https://example.com/a%7Cb%5Ec%60d');
    assert.equal(toHttpsUrl('https://example.com/x?f=[1]&g={2}'), 'https://example.com/x?f=%5B1%5D&g=%7B2%7D');
  });
});

describe('canonicalUrl (for de-duplication, never for fetching)', () => {
  it('ignores case, www, trailing slashes, fragments, default ports and tracking parameters', () => {
    const canon = canonicalUrl('https://example.com/app');
    for (const v of ['https://WWW.Example.com/app/', 'https://example.com:443/app#section', 'https://example.com/app?utm_source=x&fbclid=y&gclid=z', 'http://example.com/app', 'https://example.com//app', ' https://example.com/app ']) assert.equal(canonicalUrl(v), canon, v);
  });
  it('keeps meaningful query parameters, sorted', () => {
    assert.equal(canonicalUrl('https://example.com/p?b=2&a=1&utm_campaign=z'), 'https://example.com/p?a=1&b=2');
    assert.notEqual(canonicalUrl('https://example.com/p?id=1'), canonicalUrl('https://example.com/p?id=2'));
  });
  it('different paths and different hosts stay different', () => {
    assert.notEqual(canonicalUrl('https://example.com/a'), canonicalUrl('https://example.com/b'));
    assert.notEqual(canonicalUrl('https://example.com/a'), canonicalUrl('https://example.org/a'));
    assert.notEqual(canonicalUrl('https://example.com/a'), canonicalUrl('https://sub.example.com/a'));
  });
  it('returns null for garbage', () => { assert.equal(canonicalUrl('not a url'), null); assert.equal(canonicalUrl(''), null); });
  it('keeps the root path', () => assert.equal(canonicalUrl('https://example.com/'), 'https://example.com/'));
});

describe('operating systems and architectures', () => {
  it('maps labels to stable keys', () => {
    const cases = { 'Windows XP': 'windows-xp', 'Windows Vista': 'windows-vista', 'Windows 7': 'windows-7', 'Windows 8': 'windows-8', 'Windows 8.1': 'windows-8-1', 'Windows 10': 'windows-10', 'Windows 11': 'windows-11', 'WINDOWS 10 64bit': 'windows-10' };
    for (const [label, key] of Object.entries(cases)) assert.equal(osKeyFromLabel(label), key, label);
    for (const label of ['Linux', 'macOS 14', 'Windows Server 2022', '', 'Windows 95', 'Windows 100']) assert.equal(osKeyFromLabel(label), null, label);
    assert.deepEqual(Object.keys(OS_LABELS).sort(), ['windows-10', 'windows-11', 'windows-7', 'windows-8', 'windows-8-1', 'windows-vista', 'windows-xp']);
  });
  it('parses supported-OS text; an OS without a stated bitness keeps an EMPTY architecture list (unknown, not "all")', () => {
    assert.deepEqual(parseSupportedOs('Windows 10 32 & 64bit, Windows 8.1 32bit, Windows XP'), [
      { os: 'windows-10', architectures: ['x86', 'x64'] }, { os: 'windows-8-1', architectures: ['x86'] }, { os: 'windows-xp', architectures: [] },
    ]);
    assert.deepEqual(parseSupportedOs('Windows 11 64-bit'), [{ os: 'windows-11', architectures: ['x64'] }]);
    assert.deepEqual(parseSupportedOs('Windows 7 x86, Windows 7 x64'), [{ os: 'windows-7', architectures: ['x86', 'x64'] }]);
    assert.deepEqual(parseSupportedOs('Windows 10 32/64'), [{ os: 'windows-10', architectures: ['x86', 'x64'] }]);
    assert.deepEqual(parseSupportedOs('Linux, macOS'), []);
    assert.deepEqual(parseSupportedOs(null), []);
  });
  it('normalises architecture names and rejects unknown ones', () => {
    for (const [raw, key] of [['x64', 'x64'], ['AMD64', 'x64'], ['x86_64', 'x64'], ['x86', 'x86'], ['i386', 'x86'], ['i686', 'x86'], ['arm64', 'arm64'], ['AARCH64', 'arm64'], ['arm', 'arm'], ['neutral', 'neutral']]) assert.equal(normalizeArchitecture(raw), key, raw);
    for (const raw of ['ia64', 'sparc', '', null, undefined, 'x64 and arm64']) assert.equal(normalizeArchitecture(raw), null, String(raw));
  });
});

describe('compatibility is evidence-based (declared by the source, never tested)', () => {
  it('parses Windows version strings', () => {
    assert.deepEqual(buildFromOsVersion('10.0.17763.0'), { major: 10, minor: 0, build: 17763, raw: '10.0.17763.0' });
    assert.deepEqual(buildFromOsVersion('6.1'), { major: 6, minor: 1, build: 0, raw: '6.1' });
    for (const bad of ['', null, 'Windows 10', '10', '10.x', '1.2.3.4.5']) assert.equal(buildFromOsVersion(bad), null, String(bad));
  });
  it('nothing declared means "unknown" for both targets', () => {
    assert.deepEqual(compatibilityFromMinOs([]), { windows10: 'unknown', windows11: 'unknown', min_os_version: null });
    assert.deepEqual(compatibilityFromMinOs(['garbage']), { windows10: 'unknown', windows11: 'unknown', min_os_version: null });
  });
  it('a minimum that the target meets is "declared"; one that is newer is "unsupported"', () => {
    assert.deepEqual(compatibilityFromMinOs(['10.0.17763.0']), { windows10: 'declared', windows11: 'declared', min_os_version: '10.0.17763.0' });
    assert.deepEqual(compatibilityFromMinOs(['10.0.22000.0']), { windows10: 'unsupported', windows11: 'declared', min_os_version: '10.0.22000.0' });
    assert.deepEqual(compatibilityFromMinOs(['10.0.26200.0']), { windows10: 'unsupported', windows11: 'unsupported', min_os_version: '10.0.26200.0' });
    assert.deepEqual(compatibilityFromMinOs(['6.1.7601']), { windows10: 'declared', windows11: 'declared', min_os_version: '6.1.7601' });
    assert.equal(TARGET_BUILDS.windows10 < TARGET_BUILDS.windows11, true);
  });
  it('uses the LOWEST declared minimum across installers (any installer that can run counts)', () => {
    assert.equal(compatibilityFromMinOs(['10.0.22000.0', '10.0.17763.0']).min_os_version, '10.0.17763.0');
    assert.equal(compatibilityFromMinOs(['10.0.22000.0', '10.0.17763.0']).windows10, 'declared');
  });
});

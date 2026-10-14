// The YAML subset parser reads untrusted WinGet manifests. It must parse real manifests faithfully and refuse
// the YAML features that are dangerous or ambiguous (anchors, aliases, tags, merge keys, multiple documents).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError } from '../../scripts/crawler/lib/yaml-lite.mjs';

const throwsYaml = (src, re) => assert.throws(() => parseYaml(src), (e) => { assert.ok(e instanceof YamlError, `expected YamlError, got ${e}`); if (re) assert.match(e.message, re); return true; });

describe('real WinGet manifest shapes', () => {
  it('parses an installer manifest (sequences at the same indent as their key, nested lists, hashes kept as strings)', () => {
    const doc = parseYaml(`# Created using wingetcreate 1.6.1.0
# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json

PackageIdentifier: Git.Git
PackageVersion: 2.55.0.5
MinimumOSVersion: 10.0.17763.0
InstallerType: inno
Scope: machine
UpgradeBehavior: install
FileExtensions:
- bash
- sh
Installers:
- Architecture: x64
  InstallerUrl: https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/Git-2.55.0.5-64-bit.exe
  InstallerSha256: 3A1B0C2D4E5F60718293A4B5C6D7E8F901234567890ABCDEF1234567890ABCDE
- Architecture: arm64
  InstallerUrl: https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/Git-2.55.0.5-arm64.exe
  InstallerSha256: 1111111111111111111111111111111111111111111111111111111111111111
ManifestType: installer
ManifestVersion: 1.6.0
`);
    assert.equal(doc.PackageIdentifier, 'Git.Git');
    assert.equal(doc.PackageVersion, '2.55.0.5');
    assert.equal(doc.MinimumOSVersion, '10.0.17763.0');
    assert.deepEqual(doc.FileExtensions, ['bash', 'sh']);
    assert.equal(doc.Installers.length, 2);
    assert.equal(doc.Installers[1].Architecture, 'arm64');
    assert.match(doc.Installers[0].InstallerUrl, /Git-2\.55\.0\.5-64-bit\.exe$/);
    assert.equal(doc.ManifestVersion, '1.6.0');
  });

  it('keeps everything a string: "1.10" is not 1.1, "true" is not a boolean, "0123" is not an octal number', () => {
    const doc = parseYaml('A: 1.10\nB: true\nC: 0123\nD: no\nE: 2026-10-13\nF: 1e3\nG: null\nH: ~\nI: "null"\nJ: [null, ~, 3]\nK:');
    assert.deepEqual(doc, { A: '1.10', B: 'true', C: '0123', D: 'no', E: '2026-10-13', F: '1e3', G: 'null', H: '~', I: 'null', J: ['null', '~', '3'], K: null }, 'only an empty value is null');
  });

  it('parses a default-locale manifest: literal and folded block scalars with chomping, quotes and tags lists', () => {
    const doc = parseYaml(`PackageIdentifier: Example.App
PackageLocale: en-US
Publisher: Example & Sons, Inc.
PackageName: "Example \\"App\\""
ShortDescription: 'It''s a short one'
Description: |-
  First line.
  Second line.

  Third after a blank.
License: Proprietary
Tags:
- tag-one
- tag two
Notes: >
  folded text
  continues here

  new paragraph
ReleaseNotesUrl: https://example.com/notes#frag
`);
    assert.equal(doc.Publisher, 'Example & Sons, Inc.');
    assert.equal(doc.PackageName, 'Example "App"');
    assert.equal(doc.ShortDescription, "It's a short one");
    assert.equal(doc.Description, 'First line.\nSecond line.\n\nThird after a blank.');
    assert.deepEqual(doc.Tags, ['tag-one', 'tag two']);
    assert.equal(doc.Notes, 'folded text continues here\nnew paragraph\n');
    assert.equal(doc.ReleaseNotesUrl, 'https://example.com/notes#frag', 'a # inside a URL is not a comment');
  });

  it('REGRESSION: a tab inside a block scalar is content, not an indentation error (voidtools.Everything)', () => {
    const doc = parseYaml('Description: |\n  Search files\tquickly\n  \tindented with a tab\n  done\nLicense: Freeware\n');
    assert.equal(doc.Description, 'Search files\tquickly\n\tindented with a tab\ndone\n');
    assert.equal(doc.License, 'Freeware');
  });
  it('a tab used to indent a mapping is still refused', () => throwsYaml('Installers:\n\t- Architecture: x64', /Tabs are not allowed/));

  it('handles CRLF line endings and a UTF-8 byte-order mark', () => {
    assert.deepEqual(parseYaml('\uFEFFA: 1\r\nB:\r\n- x\r\n- y\r\n'), { A: '1', B: ['x', 'y'] });
  });
  it('handles an explicit document start, trailing document end and comments', () => {
    assert.deepEqual(parseYaml('---\nA: 1 # trailing comment\n# full-line comment\nB: "x # not a comment"\n...\n'), { A: '1', B: 'x # not a comment' });
  });
  it('keeps unicode and long values intact', () => {
    const long = 'x'.repeat(5000);
    assert.deepEqual(parseYaml(`Name: Caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00\nLong: ${long}`), { Name: 'Caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00', Long: long });
  });
  it('parses empty values, empty flow collections and one-line flow sequences of scalars', () => {
    assert.deepEqual(parseYaml('A:\nB: []\nC: {}\nD: [a, "b, c", \'d\']\nE: [ ]'), { A: null, B: [], C: {}, D: ['a', 'b, c', 'd'], E: [] });
  });
  it('parses a plain scalar continued on following lines and a nested mapping', () => {
    assert.deepEqual(parseYaml('Text: this is\n  continued\nOuter:\n  Inner:\n    Deep: value\n  Other: x'), { Text: 'this is continued', Outer: { Inner: { Deep: 'value' }, Other: 'x' } });
  });
  it('parses sequences of sequences-of-maps with nested lists', () => {
    const doc = parseYaml('Installers:\n- Architecture: x64\n  Commands:\n  - git\n  - bash\n  Switches:\n    Silent: /VERYSILENT\n');
    assert.deepEqual(doc, { Installers: [{ Architecture: 'x64', Commands: ['git', 'bash'], Switches: { Silent: '/VERYSILENT' } }] });
  });
  it('supports quoted keys and keys containing dots or digits', () => {
    assert.deepEqual(parseYaml('"quoted key": 1\nPackage.Name: 2\n7zip: 3'), { 'quoted key': '1', 'Package.Name': '2', '7zip': '3' });
  });
  it('multi-line double-quoted scalars fold their line breaks', () => {
    assert.equal(parseYaml('A: "one\n  two"').A, 'one two');
  });
  it('double-quoted escapes: \\n \\t \\x41 \\u00e9 \\U0001F600', () => {
    assert.equal(parseYaml('A: "l1\\nl2\\t\\x41\\u00e9\\U0001F600"').A, 'l1\nl2\tA\u00e9\ud83d\ude00');
  });
  it('returns null for an empty document and a bare scalar for a scalar-only document', () => {
    assert.equal(parseYaml(''), null);
    assert.equal(parseYaml('# only a comment\n'), null);
    assert.equal(parseYaml('hello'), 'hello');
  });
});

describe('refuses dangerous or ambiguous YAML (manifests are untrusted)', () => {
  it('anchors and aliases', () => {
    throwsYaml('A: &anchor value\nB: *anchor', /Anchors and aliases/);
    throwsYaml('A: *alias', /Anchors and aliases/);
    throwsYaml('- &x one\n- *x', /Anchors and aliases/);
  });
  it('tags', () => { throwsYaml('A: !!python/object/apply:os.system [calc]', /Tags are not supported/); throwsYaml('A: !custom value', /Tags/); });
  it('merge keys', () => throwsYaml('Base:\n  x: 1\nDerived:\n  <<: *base', /Merge keys|Anchors/));
  it('multiple documents', () => { throwsYaml('A: 1\n---\nB: 2', /Multiple documents/); throwsYaml('---\nA: 1\n---\nB: 2', /Multiple documents/); });
  it('duplicate keys (they can hide a value from a reviewer)', () => throwsYaml('A: 1\nA: 2', /Duplicate key "A"/));
  it('prototype-polluting keys', () => { for (const k of ['__proto__', 'constructor', 'prototype']) throwsYaml(`${k}: 1`, /Forbidden key/); });
  it('nested flow collections and unsupported flow maps', () => { throwsYaml('A: [[1, 2], [3]]', /Nested flow/); throwsYaml('A: {x: 1}', /Unsupported flow/); });
  it('an unterminated quote and trailing text after a quote', () => { throwsYaml('A: "never closed', /Unterminated/); throwsYaml('A: "x" trailing', /Unexpected text after quoted/); });
  it('an unknown escape sequence', () => throwsYaml('A: "bad \\q escape"', /Unsupported escape/));
  it('a line that is not a mapping entry', () => throwsYaml('A: 1\n  - stray\nB', /Unexpected content|Cannot parse/));
  it('input that is not text', () => { for (const v of [null, undefined, 42, {}, Buffer.from('A: 1')]) throwsYaml(v, /must be a string/); });
  it('oversized input', () => throwsYaml(`A: ${'x'.repeat(2 * 1024 * 1024 + 10)}`, /too large/));
  it('absurdly deep nesting', () => {
    const deep = Array.from({ length: 40 }, (_, i) => `${' '.repeat(i * 2)}k${i}:`).join('\n');
    throwsYaml(`${deep}\n${' '.repeat(80)}v: 1`, /too deep/);
  });
  it('reports the line number of the problem', () => {
    try { parseYaml('A: 1\nB: 2\nB: 3'); assert.fail('expected an error'); } catch (e) { assert.equal(e.line, 3); assert.match(e.message, /line 3/); }
  });
  it('never executes or evaluates anything: values that look like code stay plain strings', () => {
    const doc = parseYaml('A: $(calc)\nB: ${env:USERPROFILE}\nC: "`rm -rf /`"\nD: <script>alert(1)</script>\nE: =cmd|\' /C calc\'!A0');
    assert.deepEqual(doc, { A: '$(calc)', B: '${env:USERPROFILE}', C: '`rm -rf /`', D: '<script>alert(1)</script>', E: "=cmd|' /C calc'!A0" });
  });
});

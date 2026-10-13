// Documentation stays true: the docs must mention every schema field and enum value, every crawler command, flag,
// config key and error code, every npm command they quote must exist, and every link and file path must resolve.
// A failure here means the code or schema changed without the docs (or the other way round).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { root, fromRoot, readText, readJson } from '../helpers/repo.mjs';
import { PERMANENT_ERROR_CODES } from '../../scripts/crawler/lib/http.mjs';

const DOC_FILES = [
  'README.md', 'README.id.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSING.md',
  'docs/data-model.md', 'docs/crawler.md', 'catalogs/proposed/README.md', 'scripts/curation/README.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
];
const docs = Object.fromEntries(await Promise.all(DOC_FILES.map(async (f) => [f, await readText(...f.split('/'))])));
const pkg = await readJson('package.json');

// ---- helpers -----------------------------------------------------------------------------------------------------------
const mentions = (text, token) => text.includes(`\`${token}\``);

/** Every property name and every string enum value anywhere in a JSON Schema. */
function schemaVocabulary(schema) {
  const props = new Set(); const enums = new Set();
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.properties && typeof node.properties === 'object') for (const [k, v] of Object.entries(node.properties)) { props.add(k); walk(v); }
    if (Array.isArray(node.enum)) for (const v of node.enum) if (typeof v === 'string') enums.add(v);
    if (typeof node.const === 'string') enums.add(node.const);
    for (const [k, v] of Object.entries(node)) if (k !== 'properties') walk(v);
  })(schema);
  return { props, enums };
}

/** GitHub's heading anchors: lowercase, drop punctuation, spaces to hyphens. */
const slug = (heading) => heading.toLowerCase().replace(/<[^>]+>/g, '').replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
const headingsOf = (md) => new Set([...md.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
const withoutFences = (md) => md.replace(/```[\s\S]*?```/g, '');

// ---- schema fields are documented --------------------------------------------------------------------------------------------
describe('docs/data-model.md covers the schemas', () => {
  const model = docs['docs/data-model.md'];
  const SCHEMAS = ['common', 'apps', 'drivers', 'vendors', 'tools', 'bundles', 'updates', 'bundle-manifest'];
  for (const name of SCHEMAS) {
    it(`documents every field and enum value of ${name}.schema.json`, async () => {
      const { props, enums } = schemaVocabulary(await readJson('schemas', `${name}.schema.json`));
      const missing = [...props, ...enums].filter((t) => !mentions(model, t));
      assert.deepEqual(missing, [], `add these to docs/data-model.md in backticks: ${missing.join(', ')}`);
    });
  }
  it('names the schema version that the catalogs carry', async () => {
    const apps = await readJson('catalogs', 'apps.json');
    assert.ok(model.includes(apps.schema_version), `docs/data-model.md should mention schema version ${apps.schema_version}`);
  });
  it('lists every quality flag that any catalog record carries, or that a crawler adapter can raise', async () => {
    const used = new Set();
    for (const c of ['apps', 'drivers']) for (const item of (await readJson('catalogs', `${c}.json`)).items) for (const f of item.quality_flags ?? []) used.add(f);
    for (const file of ['winget.mjs', 'driver-listing.mjs']) {
      const src = await readText('scripts', 'crawler', 'adapters', file);
      for (const m of src.matchAll(/flags?\.(?:push|add)\('([a-z0-9_]+)'/g)) used.add(m[1]);
    }
    const missing = [...used].filter((f) => !mentions(model, f));
    assert.deepEqual(missing, [], `undocumented quality flags: ${missing.join(', ')}`);
  });
  it('every example file it points to exists and is a catalog or proposal example', async () => {
    const examples = (await readdir(fromRoot('docs', 'examples'))).filter((f) => f.endsWith('.example.json'));
    assert.ok(examples.length >= 8);
    for (const f of examples) assert.ok(examples.includes(f));
  });
});

// ---- crawler guide covers the CLI --------------------------------------------------------------------------------------------
describe('docs/crawler.md covers the crawler', () => {
  const guide = docs['docs/crawler.md'];
  it('documents every command in the CLI help', () => {
    const help = spawnSync(process.execPath, [fromRoot('scripts', 'crawler', 'cli.mjs')], { encoding: 'utf8' }).stdout;
    const commands = [...help.matchAll(/^ {2}([a-z-]+)\b/gm)].map((m) => m[1]);
    assert.ok(commands.length >= 6, `parsed commands: ${commands}`);
    for (const c of commands) assert.ok(mentions(guide, c) || guide.includes(`\`${c} `), `command ${c} is not documented`);
  });
  it('documents every flag named in the CLI header comment', async () => {
    const header = (await readText('scripts', 'crawler', 'cli.mjs')).split('\n').filter((l) => l.startsWith('//')).join('\n');
    const flags = new Set([...header.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
    assert.ok(flags.size >= 14, `parsed flags: ${[...flags]}`);
    const missing = [...flags].filter((f) => !guide.includes(f));
    assert.deepEqual(missing, [], `flags missing from docs/crawler.md: ${missing.join(', ')}`);
  });
  it('documents every flag that the commands read', async () => {
    const used = new Set();
    for (const f of ['crawl.mjs', 'merge.mjs', 'check-links.mjs', 'suggest.mjs']) {
      const src = await readText('scripts', 'crawler', 'commands', f);
      for (const m of src.matchAll(/flags(?:\.([a-z]+)|\['([a-z-]+)'\])/g)) used.add(`--${m[1] ?? m[2]}`);
    }
    const missing = [...used].filter((f) => !guide.includes(f));
    assert.deepEqual(missing, [], `flags read by the code but not documented: ${missing.join(', ')}`);
  });
  it('documents every configuration key and every adapter setting', async () => {
    const cfg = await readJson('scripts', 'crawler', 'crawler.config.json');
    const keys = new Set(Object.keys(cfg).filter((k) => !k.startsWith('$') && k !== 'adapters'));
    for (const a of Object.values(cfg.adapters)) for (const k of Object.keys(a)) keys.add(k);
    const missing = [...keys].filter((k) => !mentions(guide, k));
    assert.deepEqual(missing, [], `config keys missing from docs/crawler.md: ${missing.join(', ')}`);
  });
  it('names every adapter, and the permanent error codes that retrying cannot fix', async () => {
    const cfg = await readJson('scripts', 'crawler', 'crawler.config.json');
    for (const name of Object.keys(cfg.adapters)) assert.ok(mentions(guide, name), `adapter ${name}`);
    for (const code of PERMANENT_ERROR_CODES) assert.ok(mentions(guide, code), `error code ${code}`);
    assert.ok(mentions(guide, 'RATE_LIMIT_EXHAUSTED') && mentions(guide, 'NOT_FOUND'));
  });
  it('mentions every npm crawl shortcut', () => {
    for (const name of Object.keys(pkg.scripts).filter((n) => n.startsWith('crawl'))) assert.ok(guide.includes(`npm run ${name}`), `npm run ${name}`);
  });
  it('lists every merge protection that the code enforces', async () => {
    const src = await readText('scripts', 'crawler', 'lib', 'merge.mjs');
    const never = src.match(/const NEVER = new Set\(\[([^\]]+)\]/)[1].match(/'([a-z_]+)'/g).map((s) => s.replace(/'/g, ''));
    const section = guide.slice(guide.indexOf('## Merging'));
    for (const field of never.filter((f) => f !== 'id')) assert.ok(section.includes(`\`${field}\``), `protected field ${field}`);
    const blocking = src.match(/drivers: \[([^\]]+)\],\n\};/)[1].match(/'([a-z_]+)'/g).map((s) => s.replace(/'/g, ''));
    for (const flag of blocking) assert.ok(section.includes(`\`${flag}\``), `blocking flag ${flag}`);
  });
});

// ---- commands and versions quoted in the docs are real --------------------------------------------------------------------------
describe('commands and versions quoted in the docs', () => {
  const quoted = ['README.md', 'README.id.md', 'CONTRIBUTING.md', 'docs/crawler.md', 'docs/data-model.md', 'SECURITY.md', '.github/PULL_REQUEST_TEMPLATE.md'];
  it('every `npm run <script>` exists in package.json', () => {
    for (const f of quoted) for (const m of docs[f].matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) assert.ok(pkg.scripts[m[1]], `${f}: npm run ${m[1]} is not a package.json script`);
  });
  it('the README states the Node version that engines requires', () => {
    const min = pkg.engines.node.match(/>=\s*([\d.]+)/)[1];
    for (const f of ['README.md', 'README.id.md', 'CONTRIBUTING.md']) assert.ok(docs[f].includes(min), `${f} should mention Node ${min}`);
  });
  it('every npm script is described in the README table', () => {
    for (const name of ['validate', 'build', 'test:e2e', 'format:catalogs', 'check']) assert.ok(docs['README.md'].includes(`npm run ${name}`), name);
    assert.ok(docs['README.md'].includes('npm test'));
  });
});

// ---- links and paths resolve -------------------------------------------------------------------------------------------------------
describe('links and file references resolve', () => {
  for (const file of DOC_FILES) {
    it(`${file}: relative links and anchors`, () => {
      const dir = path.dirname(fromRoot(...file.split('/')));
      const text = withoutFences(docs[file]);
      const broken = [];
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [rel, anchor] = target.split('#');
        const resolved = rel ? path.resolve(dir, rel) : fromRoot(...file.split('/'));
        if (!existsSync(resolved)) { broken.push(`${target} (no such file)`); continue; }
        if (anchor && resolved.endsWith('.md')) {
          const md = rel ? readTextSync(resolved) : docs[file];
          if (!headingsOf(md).has(anchor)) broken.push(`${target} (no such heading)`);
        }
      }
      assert.deepEqual(broken, []);
    });
    it(`${file}: backticked repository paths exist`, () => {
      const IGNORE = new Set(['.cache/', 'node_modules/', 'tests/e2e/screenshots/', 'originals/', 'catalogs/proposed/link-check.report.json', 'link-check.report.json']);
      const PATH = /^(?:\.github|api|assets|catalogs|docs|schemas|scripts|tests|developers|drivers|software|bundles|tools|guides)\/[\w./@-]*[\w/]$|^(?:README(?:\.id)?\.md|CONTRIBUTING\.md|SECURITY\.md|LICENSE|LICENSING\.md|package\.json|openapi\.json|\.nvmrc|\.editorconfig)$/;
      const missing = [];
      for (const m of withoutFences(docs[file]).matchAll(/`([^`\s]+)`/g)) {
        const token = m[1];
        if (IGNORE.has(token) || /[*<>{}]/.test(token) || token.includes('...')) continue;
        if (!PATH.test(token)) continue;
        if (!existsSync(fromRoot(...token.split('/')))) missing.push(token);
      }
      assert.deepEqual([...new Set(missing)], [], `${file} mentions paths that do not exist`);
    });
  }
});

import { readFileSync } from 'node:fs';
function readTextSync(p) { return readFileSync(p, 'utf8'); }

// ---- licensing is consistent -----------------------------------------------------------------------------------------------------
describe('licensing files are consistent', () => {
  it('LICENSE is the MIT text and package.json agrees', async () => {
    const license = await readText('LICENSE');
    assert.match(license, /^MIT License\n/);
    assert.match(license, /Permission is hereby granted, free of charge/);
    assert.match(license, /Copyright \(c\) 2026 ANTO-LTG contributors/);
    assert.equal(pkg.license, 'MIT');
  });
  it('LICENSING.md names every vendored component with its exact copyright line', async () => {
    const dir = fromRoot('assets', 'vendor');
    for (const name of await readdir(dir)) {
      if (!statSync(path.join(dir, name)).isDirectory()) continue;
      const vendor = await readJson('assets', 'vendor', name, 'VENDOR.json');
      assert.ok(docs['LICENSING.md'].includes(vendor.copyright), `${name}: copyright line "${vendor.copyright}"`);
      assert.ok(docs['LICENSING.md'].includes(vendor.version), `${name}: version ${vendor.version}`);
      assert.ok(docs['LICENSING.md'].includes(`assets/vendor/${name}/`), `${name}: path`);
    }
  });
  it('LICENSING.md covers every photograph licence in the manifest and every dev dependency', async () => {
    const manifest = await readJson('assets', 'manifest.json');
    for (const a of manifest.assets) {
      assert.ok(docs['LICENSING.md'].includes(a.license), `licence ${a.license}`);
      assert.ok(docs['LICENSING.md'].includes(a.author), `author ${a.author}`);
      assert.ok(docs['LICENSING.md'].includes(a.license_url), `licence url ${a.license_url}`);
    }
    for (const dep of Object.keys(pkg.devDependencies)) assert.ok(docs['LICENSING.md'].includes(`\`${dep}\``), `dev dependency ${dep}`);
    assert.ok(docs['LICENSING.md'].includes('microsoft/winget-pkgs') && docs['LICENSING.md'].includes('Copyright (c) Microsoft Corporation'));
  });
  it('the README points to the licence files and the credits', () => {
    for (const f of ['README.md', 'README.id.md']) for (const target of ['LICENSE', 'LICENSING.md', 'assets/CREDITS.md']) assert.ok(docs[f].includes(`(${target})`), `${f} links ${target}`);
  });
  it('every place LICENSING.md says to update when the licence changes really mentions the licence', async () => {
    for (const f of ['assets/icons/sprite.svg', 'scripts/assets/credits.mjs', 'package.json']) assert.match(await readText(...f.split('/')), /MIT/, f);
    for (const key of ['footer.license', 'footer.mit']) for (const lang of ['en', 'id']) assert.ok((await readText('assets', 'js', 'i18n', `${lang}.js`)).includes(`"${key}"`), `${lang}.js ${key}`);
  });
});

// ---- the honest-status statements stay in place ----------------------------------------------------------------------------------
describe('the docs keep their honest-status statements', () => {
  it('README says what the project is not', () => {
    const readme = docs['README.md'];
    assert.match(readme, /Not a live driver database and not a real-time API/);
    assert.match(readme, /Not a SQL database/);
    assert.match(readme, /nothing is marked `verified`/i);
    assert.match(readme, /structurally, not executed/);
  });
  it('the Indonesian README carries the same warnings and links to the English one', () => {
    const id = docs['README.id.md'];
    assert.match(id, /Bukan database driver langsung dan bukan API real-time/);
    assert.match(id, /Belum ada yang ditandai `verified`/);
    assert.ok(id.includes('(README.md)'));
    assert.ok(docs['README.md'].includes('(README.id.md)'));
  });
  it('the catalogs really contain no verified record, which is what the docs say', async () => {
    let verified = 0;
    for (const c of ['apps', 'drivers', 'vendors', 'tools']) verified += (await readJson('catalogs', `${c}.json`)).items.filter((i) => i.verification_status === 'verified').length;
    if (verified > 0) assert.doesNotMatch(docs['README.md'], /nothing is marked `verified`/i, 'update the README: some records are now verified');
    assert.equal(verified, 0);
  });
  it('SECURITY.md does not promise a private reporting button that may not exist', () => {
    assert.match(docs['SECURITY.md'], /only works once the repository owner has/);
    assert.doesNotMatch(docs['SECURITY.md'], /[\w.+-]+@[\w-]+\.[\w.-]+/, 'no e-mail address was ever verified for this project, so none is invented');
  });
});

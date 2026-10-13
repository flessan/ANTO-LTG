#!/usr/bin/env node
// Generates the vector icon library from the open icon sets installed as devDependencies, and records every file in
// assets/manifest.json (source package and version, license, owner note, targets, size and SHA-256).
//
//   node scripts/assets/collect-icons.mjs            # (re)write icons and manifest entries
//   node scripts/assets/collect-icons.mjs --check    # exit 1 if the committed files differ from what would be written
//
// Sources (all installed by `npm ci`, nothing is fetched from a CDN):
//   simple-icons@16.35.0        CC0-1.0   brand glyphs (monochrome)     -> icon-map.mjs BRANDS "simple:<slug>"
//   @iconify-json/logos@1.2.16  CC0-1.0   full-colour brand logos       -> icon-map.mjs BRANDS "logos:<name>"
//   @iconify-json/devicon@1.2.71 MIT      developer tool logos           -> icon-map.mjs BRANDS "devicon:<name>"
//   @iconify-json/cib@1.2.3      CC0-1.0  brand logos (CoreUI set)       -> icon-map.mjs BRANDS "cib:<name>"
//   @iconify-json/lucide@1.2.143 ISC      generic glyphs                -> icon-map.mjs GLYPHS / UI_ICONS
//
// Photographs (assets/img) are handled by build-images.mjs and are not touched here.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { BRANDS, GLYPHS, UI_ICONS } from './icon-map.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const CHECK = process.argv.includes('--check');
const RETRIEVED = '2026-10-13';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const SI_VERSION = '16.35.0';
const LOGOS_VERSION = '1.2.16';
const DEVICON_VERSION = '1.2.71';
const CIB_VERSION = '1.2.3';
const LUCIDE_VERSION = '1.2.143';
const GLYPH_STROKE = '#1f5f8f';

const logos = require('@iconify-json/logos/icons.json');
const devicon = require('@iconify-json/devicon/icons.json');
const cib = require('@iconify-json/cib/icons.json');
const lucide = require('@iconify-json/lucide/icons.json');
const simple = await import('simple-icons');
const siBySlug = new Map(Object.values(simple).filter((x) => x && typeof x === 'object' && x.slug && x.path).map((x) => [x.slug, x]));

const files = []; // { abs, rel, svg, entry }
const entries = [];

function svgWrap(viewBox, inner, { attrs = '', title } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${attrs}${title ? ` role="img" aria-label="${title}"` : ' aria-hidden="true" focusable="false"'}>${inner}</svg>\n`;
}

function brandSvg(key) {
  const [src, name] = key.split(':');
  if (src === 'simple') {
    const icon = siBySlug.get(name);
    if (!icon) throw new Error(`simple-icons has no icon "${name}"`);
    return { svg: svgWrap('0 0 24 24', `<path fill="#${icon.hex}" d="${icon.path}"/>`, { title: `${icon.title} logo` }), title: icon.title, upstream: `icons/${name}.svg`, pkg: `simple-icons@${SI_VERSION}`, pkgUrl: `https://www.npmjs.com/package/simple-icons/v/${SI_VERSION}`, license: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' };
  }
  if (src === 'logos') {
    const item = logos.icons[name];
    if (!item) throw new Error(`@iconify-json/logos has no icon "${name}"`);
    const w = item.width ?? logos.width ?? 256; const h = item.height ?? logos.height ?? 256;
    const title = `${titleCase(name)} logo`;
    return { svg: svgWrap(`0 0 ${w} ${h}`, item.body, { title }), title: titleCase(name), upstream: `icons.json#${name}`, pkg: `@iconify-json/logos@${LOGOS_VERSION}`, pkgUrl: `https://www.npmjs.com/package/@iconify-json/logos/v/${LOGOS_VERSION}`, license: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' };
  }
  if (src === 'devicon' || src === 'cib') {
    const set = src === 'devicon' ? devicon : cib;
    const item = set.icons[name];
    if (!item) throw new Error(`@iconify-json/${src} has no icon "${name}"`);
    const w = item.width ?? set.width ?? 128; const h = item.height ?? set.height ?? 128;
    const title = `${titleCase(name)} logo`;
    const pkg = src === 'devicon' ? `@iconify-json/devicon@${DEVICON_VERSION}` : `@iconify-json/cib@${CIB_VERSION}`;
    return { svg: svgWrap(`0 0 ${w} ${h}`, item.body, { title }), title: titleCase(name), upstream: `icons.json#${name}`, pkg, pkgUrl: `https://www.npmjs.com/package/@iconify-json/${src}`, license: src === 'devicon' ? 'MIT' : 'CC0-1.0', licenseUrl: src === 'devicon' ? 'https://opensource.org/license/mit' : 'https://creativecommons.org/publicdomain/zero/1.0/' };
  }
  throw new Error(`unknown brand source ${key}`);
}

function glyphSvg(name, stroke) {
  const item = lucide.icons[name];
  if (!item) throw new Error(`Lucide has no icon "${name}"`);
  const size = item.width ?? lucide.width ?? 24;
  // Lucide bodies carry their own currentColor strokes; replace them so the glyph has a fixed colour in <img> use.
  const body = item.body.replaceAll('currentColor', stroke);
  const attrs = ` fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
  return { svg: svgWrap(`0 0 ${size} ${size}`, body, { attrs }), upstream: `icons.json#${name}`, pkg: `@iconify-json/lucide@${LUCIDE_VERSION}`, pkgUrl: `https://www.npmjs.com/package/@iconify-json/lucide/v/${LUCIDE_VERSION}` };
}

// Hand-drawn glyphs that were migrated into the icon folders by a one-off split of the old sprite (see manifest).
const LEGACY_FILES = new Set();
// Manifest kinds this script owns; everything else in the manifest (photographs, project art) is kept as it is.
const GENERATED_KINDS = new Set(['brand-mark', 'glyph', 'ui-glyph']);

function titleCase(s) { return s.split('-').map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' '); }

function svgSize(svg) {
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  return { width: Number(m[1]), height: Number(m[2]) };
}

// ---- brand marks ------------------------------------------------------------------------------------------------------
for (const [key, spec] of Object.entries(BRANDS)) {
  const b = brandSvg(key);
  const slug = key.split(':')[1];
  const dir = spec.apps?.length ? 'software' : 'vendors';
  const rel = `assets/icons/${dir}/${slug}.svg`;
  const targets = [...(spec.apps ?? []).map((id) => ({ type: 'app', id })), ...(spec.vendors ?? []).map((id) => ({ type: 'vendor', id })), ...(spec.tools ?? []).map((id) => ({ type: 'tool', id }))];
  const entry = {
    id: `brand-${slug}`, kind: 'brand-mark', title: `${b.title} logo`, alt: `${b.title} logo`,
    owner: `${b.title} (trademark of its owner)`,
    owner_note: 'The mark identifies the company or product it depicts. It is not endorsed by ANTO-LTG and remains the property of its owner; see LICENSING.md.',
    source_url: b.pkgUrl, source_path: b.upstream, source_package: b.pkg, license: b.license, license_url: b.licenseUrl,
    retrieved_at: RETRIEVED, modifications: 'Re-encoded as a standalone SVG (viewBox and fill set); the path data is unchanged.',
    used_in: targets.map((t) => `${t.type}:${t.id}`), targets,
  };
  files.push({ rel, svg: b.svg, entry, kind: 'brand' });
}

// ---- generic glyphs (categories, bundles, hardware) and UI icons -----------------------------------------------------
for (const [key, spec] of Object.entries(GLYPHS)) {
  const dirName = spec.dir;
  // Hardware components get a prefix so they cannot collide with the hand-drawn device glyphs (hardware/monitor.svg etc.).
  const fileId = dirName === 'hardware' ? `component-${spec.targets[0][1]}` : spec.targets[0][1];
  const g = glyphSvg(spec.name, GLYPH_STROKE);
  const rel = `assets/icons/${dirName}/${fileId}.svg`;
  const targets = spec.targets.map(([type, id]) => ({ type, id }));
  const entry = {
    id: key, kind: 'glyph', title: `${titleCase(fileId)} glyph`, alt: `${titleCase(fileId)} icon`,
    owner: 'Lucide contributors (ISC)', owner_note: 'Generic glyph used to label a category, bundle or hardware component.',
    source_url: `https://lucide.dev/icons/${spec.name}`, source_path: g.upstream, source_package: g.pkg, license: 'ISC', license_url: 'https://opensource.org/license/isc-license-txt',
    retrieved_at: RETRIEVED, modifications: 'Re-encoded as a standalone SVG with a fixed stroke colour so it renders in <img> elements.',
    used_in: targets.map((t) => `${t.type}:${t.id}`), targets,
  };
  files.push({ rel, svg: g.svg, entry, kind: 'glyph' });
}

for (const [dirName, names] of Object.entries(UI_ICONS)) {
  for (const name of names) {
    const g = glyphSvg(name, 'currentColor');
    const rel = `assets/icons/${dirName}/${name}.svg`;
    const entry = {
      id: `lucide-${name}`, kind: 'ui-glyph', title: `${titleCase(name)} interface icon`, alt: '',
      owner: 'Lucide contributors (ISC)', owner_note: 'Interface glyph. Drawn with currentColor and inlined through the sprite (assets/icons/sprite.svg).',
      source_url: `https://lucide.dev/icons/${name}`, source_path: g.upstream, source_package: g.pkg, license: 'ISC', license_url: 'https://opensource.org/license/isc-license-txt',
      retrieved_at: RETRIEVED, modifications: 'Re-encoded as a standalone SVG with currentColor strokes for the sprite.',
      used_in: [`ui:${name}`], targets: [{ type: 'ui', id: name }],
    };
    files.push({ rel, svg: g.svg, entry, kind: 'ui' });
  }
}

// ---- sprite: one <symbol> per interface glyph; the symbol ID is the file name (used by icon() in assets/js/site.js) ----
const SPRITE_DIRS = ['navigation', 'actions', 'status', 'hardware'];
async function buildSprite() {
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generated by scripts/assets/collect-icons.mjs from assets/icons/{navigation,actions,status,hardware}. Do not edit by hand. Glyphs are MIT (ANTO-LTG) or ISC (Lucide); see LICENSING.md and assets/CREDITS.md. -->\n<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n';
  for (const dir of SPRITE_DIRS) {
    const names = (await readdir(join(root, 'assets', 'icons', dir)).catch(() => [])).filter((n) => n.endsWith('.svg')).sort();
    for (const name of names) {
      const src = await readFile(join(root, 'assets', 'icons', dir, name), 'utf8');
      const m = /<svg([^>]*)>([\s\S]*)<\/svg>/.exec(src);
      if (!m) throw new Error(`assets/icons/${dir}/${name}: not an svg`);
      const vb = /viewBox="([^"]+)"/.exec(m[1])?.[1] ?? '0 0 24 24';
      const extra = m[1].replace(/\s*(xmlns|viewBox|role|aria-label|aria-hidden|focusable)="[^"]*"/g, '').trim();
      out += `<symbol id="${name.replace(/\.svg$/, '')}" viewBox="${vb}"${extra ? ` ${extra}` : ''}>${m[2].trim()}</symbol>\n`;
    }
  }
  return out + '</svg>\n';
}

// ---- write files, then rebuild the manifest ---------------------------------------------------------------------------
const manifestPath = join(root, 'assets', 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const generatedIds = new Set(files.map((f) => f.entry.id));
const kept = manifest.assets.filter((a) => !generatedIds.has(a.id) && !GENERATED_KINDS.has(a.kind));
const problems = [];
const written = [];
for (const f of files) {
  const abs = join(root, f.rel);
  const buf = Buffer.from(f.svg, 'utf8');
  const size = svgSize(f.svg);
  const rec = { path: f.rel, format: 'svg', width: size.width, height: size.height, bytes: buf.length, sha256: sha(buf) };
  f.entry.files = [rec];
  written.push({ abs, buf, rel: f.rel });
  if (CHECK) {
    const current = await readFile(abs).catch(() => null);
    if (!current || !current.equals(buf)) problems.push(`${f.rel}: differs from the generated icon (run node scripts/assets/collect-icons.mjs)`);
  }
}
const expectedRel = new Set(files.map((f) => f.rel));
if (CHECK) {
  // Icons on disk that no mapping produces (other than the hand-drawn glyph set and the sprite) are stale.
  for (const dir of ['software', 'vendors', 'categories', 'hardware']) {
    for (const f of await readdir(join(root, 'assets', 'icons', dir)).catch(() => [])) {
      const rel = `assets/icons/${dir}/${f}`;
      const owned = dir === 'hardware' ? f.startsWith('component-') : true;
      if (owned && !expectedRel.has(rel) && !LEGACY_FILES.has(rel)) problems.push(`${rel}: not produced by icon-map.mjs (remove it or add it to the map)`);
    }
  }
  const sprite = await buildSprite();
  const onDisk = await readFile(join(root, 'assets', 'icons', 'sprite.svg'), 'utf8').catch(() => '');
  if (sprite.replace(/\n/g, '') !== onDisk.replace(/\n/g, '')) problems.push('assets/icons/sprite.svg is out of date (run node scripts/assets/collect-icons.mjs)');
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`icons up to date: ${files.length} generated files`);
  process.exit(0);
}
const seenOut = new Set(kept.flatMap((a) => (a.files ?? []).map((f) => f.path)));
for (const f of files) { if (seenOut.has(f.rel)) throw new Error(`${f.rel}: already provided by another manifest entry (choose a different glyph name)`); seenOut.add(f.rel); }
for (const w of written) { await mkdir(dirname(w.abs), { recursive: true }); await writeFile(w.abs, w.buf); }
const sprite = await buildSprite();
await writeFile(join(root, 'assets', 'icons', 'sprite.svg'), sprite);
manifest.assets = [...kept, ...files.map((f) => f.entry)];
manifest.schema_version = '2.0.0';
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${written.length} icon files; manifest now lists ${manifest.assets.length} assets`);

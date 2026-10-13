// Verifies the image and icon manifest, the generated credits file, the sprite and the vendored 7.css against disk
// and against the catalogs. Used by `npm run validate` (scripts/build.mjs --validate).
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { renderCredits } from '../assets/credits.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export const ASSET_KINDS = ['photo', 'brand-mark', 'glyph', 'ui-glyph', 'project-glyph'];
export const TARGET_TYPES = ['app', 'tool', 'vendor', 'category', 'component', 'bundle', 'page', 'site', 'ui'];
export const PAGE_IDS = ['home', 'software', 'drivers', 'bundles', 'tools', 'guides', 'developers', 'site'];
// Budgets: keep the site light. Photos are the only large files.
export const BUDGET = { svgBytes: 40 * 1024, photoBytes: 700 * 1024, imgDirBytes: 4 * 1024 * 1024 };
// Files under assets/icons that are not in the manifest on purpose: the generated sprite is a build product.
const UNLISTED_ICON_FILES = new Set(['assets/icons/sprite.svg']);

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

// Text of the site code that can reference an icon name: JS modules and page templates/HTML.
async function siteCode(root) {
  const parts = [];
  for (const f of await walk(path.join(root, 'assets', 'js'))) if (f.endsWith('.js')) parts.push(await readFile(f, 'utf8'));
  for (const f of await walk(path.join(root, 'scripts', 'templates'))) parts.push(await readFile(f, 'utf8'));
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.html')) parts.push(await readFile(path.join(root, e.name), 'utf8'));
    if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'assets', 'api', 'catalogs', 'tests', 'scripts', 'docs', 'schemas'].includes(e.name)) {
      const idx = path.join(root, e.name, 'index.html');
      parts.push(await readFile(idx, 'utf8').catch(() => ''));
    }
  }
  return parts.join('\n');
}

export async function checkAssets(root, catalogs = null) {
  const problems = [];
  const manifest = JSON.parse(await readFile(path.join(root, 'assets', 'manifest.json'), 'utf8'));
  const listed = new Set();
  const seenIds = new Set();
  const catalogIds = catalogs ? {
    app: new Set(catalogs.apps.items.map((x) => x.id)),
    tool: new Set(catalogs.tools.items.map((x) => x.id)),
    vendor: new Set(catalogs.vendors.items.map((x) => x.id)),
    category: new Set(catalogs.apps.items.map((x) => x.category).concat(catalogs.tools.items.map((x) => x.category))),
    component: new Set(catalogs.drivers.items.map((x) => x.component)),
    bundle: new Set(catalogs.bundles.items.map((x) => x.id)),
  } : null;

  if (manifest.schema_version !== '2.0.0') problems.push(`assets/manifest.json: schema_version must be 2.0.0 (found ${manifest.schema_version})`);

  for (const a of manifest.assets) {
    const label = `assets/manifest.json "${a.id}"`;
    if (seenIds.has(a.id)) problems.push(`${label}: duplicate id`);
    seenIds.add(a.id);
    for (const k of ['id', 'kind', 'title', 'license', 'license_url', 'retrieved_at', 'modifications', 'source_url']) if (!a[k]) problems.push(`${label}: missing ${k}`);
    if (!ASSET_KINDS.includes(a.kind)) problems.push(`${label}: kind must be one of ${ASSET_KINDS.join(', ')}`);
    const owner = a.kind === 'photo' ? a.author : a.owner;
    if (!owner) problems.push(`${label}: missing ${a.kind === 'photo' ? 'author' : 'owner'}`);
    if (a.kind === 'photo') for (const k of ['author_url', 'published_at']) if (!a[k]) problems.push(`${label}: missing ${k}`);
    if (!/^https:\/\//.test(a.source_url ?? '') || !/^https:\/\//.test(a.license_url ?? '')) problems.push(`${label}: source_url and license_url must be https`);
    // Decorative UI glyphs may have empty alt text (they sit next to a label); every other image needs a description.
    if (a.kind !== 'ui-glyph' && (a.alt ?? '').length < 3) problems.push(`${label}: alt text is missing or too short`);
    if (a.kind === 'photo' && (a.alt ?? '').length < 15) problems.push(`${label}: photo alt text is too short to be useful`);
    if (!a.files?.length) problems.push(`${label}: no files recorded (run the asset build)`);

    // Wiring: every asset must target a record or page that exists, or say why it is intentionally unused.
    if (!a.targets?.length && !a.unused_reason) problems.push(`${label}: not wired to any record or page (add targets, or set unused_reason)`);
    for (const t of a.targets ?? []) {
      if (!TARGET_TYPES.includes(t.type)) problems.push(`${label}: unknown target type "${t.type}"`);
      else if (t.type === 'page' && !PAGE_IDS.includes(t.id)) problems.push(`${label}: unknown page "${t.id}"`);
      else if (catalogIds && catalogIds[t.type] && !catalogIds[t.type].has(t.id)) problems.push(`${label}: target ${t.type}:${t.id} does not exist in the catalogs`);
    }

    for (const f of a.files ?? []) {
      listed.add(f.path);
      try {
        const buf = await readFile(path.join(root, f.path));
        if (buf.length !== f.bytes) problems.push(`${f.path}: size ${buf.length} differs from manifest ${f.bytes}`);
        if (sha(buf) !== f.sha256) problems.push(`${f.path}: SHA-256 differs from manifest`);
        if (f.format === 'svg' && buf.length > BUDGET.svgBytes) problems.push(`${f.path}: ${buf.length} bytes exceeds the SVG budget of ${BUDGET.svgBytes}`);
        if (f.format !== 'svg' && buf.length > BUDGET.photoBytes) problems.push(`${f.path}: ${buf.length} bytes exceeds the image budget of ${BUDGET.photoBytes}`);
        if (f.format === 'svg' && !/<svg[\s>]/.test(buf.toString('utf8', 0, 600))) problems.push(`${f.path}: not an SVG document`);
      } catch { problems.push(`${f.path}: listed in the manifest but missing`); }
    }
  }

  // UI glyphs must be referenced by name in the site code (icon('name'), sprite.svg#name, or a name map entry).
  const uiTargets = manifest.assets.flatMap((a) => (a.targets ?? []).filter((t) => t.type === 'ui').map((t) => t.id));
  if (uiTargets.length) {
    const code = await siteCode(root);
    for (const id of new Set(uiTargets)) {
      if (!code.includes(`'${id}'`) && !code.includes(`"${id}"`) && !code.includes(`\`${id}\``) && !code.includes(`sprite.svg#${id}`)) {
        problems.push(`ui glyph "${id}" is listed in the manifest but not referenced by any page or module (use it or remove the file)`);
      }
    }
  }

  // Every image on disk must be listed; every icon too (except the generated sprite).
  let imgBytes = 0;
  for (const file of await walk(path.join(root, 'assets', 'img'))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    imgBytes += (await stat(file)).size;
    if (!listed.has(rel)) problems.push(`${rel}: not listed in assets/manifest.json (every image needs provenance)`);
  }
  if (imgBytes > BUDGET.imgDirBytes) problems.push(`assets/img totals ${imgBytes} bytes, above the budget of ${BUDGET.imgDirBytes}`);
  for (const file of await walk(path.join(root, 'assets', 'icons'))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (!rel.endsWith('.svg') || UNLISTED_ICON_FILES.has(rel)) continue;
    if (!listed.has(rel)) problems.push(`${rel}: not listed in assets/manifest.json`);
  }

  const credits = await readFile(path.join(root, 'assets', 'CREDITS.md'), 'utf8').catch(() => '');
  if (credits !== renderCredits(manifest)) problems.push('assets/CREDITS.md is out of date with assets/manifest.json (regenerate it with scripts/assets/collect-icons.mjs or scripts/assets/build-images.mjs)');

  const vendor = JSON.parse(await readFile(path.join(root, 'assets', 'vendor', '7.css', 'VENDOR.json'), 'utf8'));
  if (vendor.license !== 'MIT') problems.push('VENDOR.json: 7.css license must be recorded as MIT');
  for (const [name, info] of Object.entries(vendor.files)) {
    const buf = await readFile(path.join(root, 'assets', 'vendor', '7.css', name)).catch(() => null);
    if (!buf) problems.push(`assets/vendor/7.css/${name}: missing`);
    else if (sha(buf) !== info.sha256) problems.push(`assets/vendor/7.css/${name}: modified (SHA-256 differs from VENDOR.json); vendored files must stay unmodified`);
  }
  return problems;
}

#!/usr/bin/env node
// Builds the responsive image variants in assets/img from assets/manifest.json recipes,
// then writes the resulting file list (with sizes and SHA-256) back to the manifest and
// regenerates assets/CREDITS.md.
//
// The originals are NOT stored in the repository. Download each photo from its
// `source_url` / `original_image_url` and save it as <originals>/<id>.jpg, then run:
//
//   npm i --no-save sharp
//   node scripts/assets/build-images.mjs --originals ./originals
//
// `sharp` is intentionally not a dependency of the project: the committed output is what
// the site uses, and CI only verifies that the committed files match the manifest.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { renderCredits } from './credits.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, []),
);

if (!args.originals) {
  console.error('Usage: node scripts/assets/build-images.mjs --originals <dir> [--sharp <path-to-sharp-module>] [--only <asset-id>]');
  process.exit(2);
}

let sharp;
try {
  const require = createRequire(import.meta.url);
  sharp = require(args.sharp ? resolve(String(args.sharp)) : 'sharp');
} catch (err) {
  console.error('Could not load "sharp". Install it with: npm i --no-save sharp\n', err.message);
  process.exit(2);
}

const manifestPath = join(root, 'assets', 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const outDir = join(root, 'assets', 'img');
await mkdir(outDir, { recursive: true });

const ENCODERS = {
  avif: (img) => img.avif({ quality: 50, effort: 4 }),
  webp: (img) => img.webp({ quality: 74, effort: 5 }),
  jpg: (img) => img.jpeg({ quality: 78, mozjpeg: true, progressive: true }),
};

for (const asset of manifest.assets) {
  if (args.only && args.only !== asset.id) continue;
  const srcPath = resolve(String(args.originals), `${asset.id}.jpg`);
  const original = await readFile(srcPath);
  const meta = await sharp(original).metadata();
  const declared = `${meta.width}x${meta.height}`;
  if (declared !== asset.retrieved_size) {
    throw new Error(`${asset.id}: original is ${declared} but the manifest says ${asset.retrieved_size}`);
  }
  const files = [];
  for (const variant of asset.recipe.variants) {
    for (const width of variant.widths) {
      let base = sharp(original).rotate();
      if (variant.crop) base = base.extract(variant.crop);
      if (variant.adjust) base = base.modulate(variant.adjust);
      const resized = base.resize({ width, withoutEnlargement: true });
      for (const format of variant.formats) {
        const file = `${asset.id}-${variant.name}-${width}.${format}`;
        const buf = await ENCODERS[format](resized.clone()).toBuffer({ resolveWithObject: true });
        await writeFile(join(outDir, file), buf.data);
        files.push({
          path: `assets/img/${file}`,
          variant: variant.name,
          format,
          width: buf.info.width,
          height: buf.info.height,
          bytes: buf.data.length,
          sha256: createHash('sha256').update(buf.data).digest('hex'),
        });
      }
    }
  }
  asset.files = files;
  console.log(`${asset.id}: ${files.length} files, ${(files.reduce((n, f) => n + f.bytes, 0) / 1024).toFixed(0)} KB`);
}

await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(root, 'assets', 'CREDITS.md'), renderCredits(manifest));
console.log('manifest and CREDITS.md updated');

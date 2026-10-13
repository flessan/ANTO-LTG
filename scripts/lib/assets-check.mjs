// Verifies the image manifest, the generated credits file and the vendored 7.css against the files on disk.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { renderCredits } from '../assets/credits.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export async function checkAssets(root) {
  const problems = [];
  const manifest = JSON.parse(await readFile(path.join(root, 'assets', 'manifest.json'), 'utf8'));
  const listed = new Set();
  for (const a of manifest.assets) {
    for (const k of ['id', 'title', 'alt', 'source_url', 'author', 'license', 'license_url', 'retrieved_at', 'modifications']) if (!a[k]) problems.push(`assets/manifest.json "${a.id}": missing ${k}`);
    if (!/^https:\/\//.test(a.source_url ?? '') || !/^https:\/\//.test(a.license_url ?? '')) problems.push(`assets/manifest.json "${a.id}": source_url and license_url must be https`);
    if ((a.alt ?? '').length < 15) problems.push(`assets/manifest.json "${a.id}": alt text is too short to be useful`);
    if (!a.files?.length) problems.push(`assets/manifest.json "${a.id}": no files recorded (run scripts/assets/build-images.mjs)`);
    for (const f of a.files ?? []) {
      listed.add(path.basename(f.path));
      try {
        const buf = await readFile(path.join(root, f.path));
        if (buf.length !== f.bytes) problems.push(`${f.path}: size ${buf.length} differs from manifest ${f.bytes}`);
        if (sha(buf) !== f.sha256) problems.push(`${f.path}: SHA-256 differs from manifest`);
      } catch { problems.push(`${f.path}: listed in the manifest but missing`); }
    }
  }
  for (const f of await readdir(path.join(root, 'assets', 'img'))) if (!listed.has(f)) problems.push(`assets/img/${f}: not listed in assets/manifest.json (every image needs provenance)`);
  const credits = await readFile(path.join(root, 'assets', 'CREDITS.md'), 'utf8').catch(() => '');
  if (credits !== renderCredits(manifest)) problems.push('assets/CREDITS.md is out of date with assets/manifest.json (run scripts/assets/build-images.mjs or regenerate credits)');

  const vendor = JSON.parse(await readFile(path.join(root, 'assets', 'vendor', '7.css', 'VENDOR.json'), 'utf8'));
  if (vendor.license !== 'MIT') problems.push('VENDOR.json: 7.css license must be recorded as MIT');
  for (const [name, info] of Object.entries(vendor.files)) {
    const buf = await readFile(path.join(root, 'assets', 'vendor', '7.css', name)).catch(() => null);
    if (!buf) problems.push(`assets/vendor/7.css/${name}: missing`);
    else if (sha(buf) !== info.sha256) problems.push(`assets/vendor/7.css/${name}: modified (SHA-256 differs from VENDOR.json); vendored files must stay unmodified`);
  }
  return problems;
}

// Builds a throw-away copy of the repository so tests can break something on purpose (a catalog, a page, an
// image) and check that the validators notice, without ever touching the real working tree.
import { cp, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { root } from './repo.mjs';

const COPY = ['package.json', 'index.html', 'software', 'drivers', 'bundles', 'tools', 'guides', 'developers', 'support', 'assets', 'scripts', 'schemas', 'catalogs', 'api', 'openapi.json'];

export async function makeSandbox() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anto-ltg-test-'));
  for (const entry of COPY) await cp(path.join(root, entry), path.join(dir, entry), { recursive: true });
  // dependencies are shared, not copied; a junction works on Windows without administrator rights
  await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  return {
    dir,
    file: (...parts) => path.join(dir, ...parts),
    read: (...parts) => readFile(path.join(dir, ...parts), 'utf8'),
    write: (parts, text) => writeFile(path.join(dir, ...parts), text),
    async edit(parts, fn) { const p = path.join(dir, ...parts); const before = await readFile(p, 'utf8'); const after = fn(before); if (after === before) throw new Error(`edit of ${parts.join('/')} changed nothing`); await writeFile(p, after); },
    async editJson(parts, fn) { const p = path.join(dir, ...parts); const doc = JSON.parse(await readFile(p, 'utf8')); fn(doc); await writeFile(p, `${JSON.stringify(doc, null, 2)}\n`); },
    validate: (...flags) => runBuild(dir, flags.length ? flags : ['--validate']),
    destroy: () => rm(dir, { recursive: true, force: true }),
  };
}

export function runBuild(cwd, flags) {
  const r = spawnSync(process.execPath, [path.join(cwd, 'scripts', 'build.mjs'), ...flags], { cwd, encoding: 'utf8', env: { ...process.env, SITE_URL: '' } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// Small helpers shared by the unit and crawler tests.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fromRoot = (...parts) => path.join(root, ...parts);
export const readText = (...parts) => readFile(fromRoot(...parts), 'utf8');
export const readJson = async (...parts) => JSON.parse(await readText(...parts));

export async function listFiles(dir, { ext = null, skip = ['node_modules', '.git', '.cache'] } = {}) {
  const out = [];
  async function walk(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!ext || ext.includes(path.extname(entry.name))) out.push(full);
    }
  }
  await walk(dir);
  return out.sort();
}

/** Removes // and /* *\/ comments from JavaScript source well enough for pattern scanning. */
export function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      // drop a trailing // comment, but not the // inside a string such as 'https://example.org'
      let inString = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inString) { if (c === '\\') i++; else if (c === inString) inString = null; continue; }
        if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
        if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** Loads all six catalogs as { apps, drivers, tools, vendors, bundles, updates }. */
export async function loadCatalogs() {
  const names = ['apps', 'drivers', 'tools', 'vendors', 'bundles', 'updates'];
  const out = {};
  for (const n of names) out[n] = await readJson('catalogs', `${n}.json`);
  return out;
}

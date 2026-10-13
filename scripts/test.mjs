#!/usr/bin/env node
// Cross-platform test runner: `node scripts/test.mjs unit crawler` runs every tests/<suite>/*.test.mjs
// through the built-in Node test runner (no glob support needed from the shell or the Node version).
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suites = process.argv.slice(2);
if (!suites.length) { console.error('Usage: node scripts/test.mjs <suite> [suite...]   (suites live in tests/)'); process.exit(2); }
const files = [];
for (const s of suites) {
  const dir = path.join(root, 'tests', s);
  const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.test.mjs')).sort();
  if (!names.length) { console.error(`No tests found in tests/${s}/`); process.exit(2); }
  files.push(...names.map((n) => path.join(dir, n)));
}
const args = ['--test', '--test-reporter=spec', '--test-concurrency=1', ...(suites.includes('e2e') ? ['--test-timeout=180000'] : []), ...files];
const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: root, env: process.env });
child.on('exit', (code) => process.exit(code ?? 1));

#!/usr/bin/env node
// Minimal static file server for local development, the browser tests and live previews.
// Zero dependencies. Serves the repository root; refuses dotfiles, node_modules and path traversal.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.ps1': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.map': 'application/json; charset=utf-8',
};

export function createServer(root) {
  const base = path.resolve(root);
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }).end('Method Not Allowed'); return; }
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.includes('\0')) throw new Error('bad path');
      let file = path.resolve(base, `.${rel}`);
      if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
      const parts = path.relative(base, file).split(path.sep);
      if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) { res.writeHead(404).end('Not found'); return; }
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        if (!rel.endsWith('/')) { res.writeHead(301, { location: `${rel}/` }).end(); return; }
        file = path.join(file, 'index.html'); info = await stat(file).catch(() => null);
      }
      if (!info?.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': body.length,
        'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(400).end('Bad request'); }
  });
}

// Usage: node scripts/serve.mjs [port] [--port N] [--host H]      (or the PORT / HOST environment variables)
// A flag wins over the environment, which wins over the positional port. Throws on an invalid port.
export function parseServeArgs(argv = [], env = {}) {
  const usage = 'Usage: node scripts/serve.mjs [port] [--port N] [--host H]';
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const value = argv[i + 1];
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`--${name} needs a value. ${usage}`);
    return value;
  };
  const positional = argv.find((a) => /^\d+$/.test(a));
  const raw = String(flag('port') ?? env.PORT ?? positional ?? 8080);
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65535) throw new Error(`Invalid port ${JSON.stringify(raw)}. ${usage}`);
  return { port: Number(raw), host: flag('host') ?? env.HOST ?? '0.0.0.0' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let opts;
  try { opts = parseServeArgs(process.argv.slice(2), process.env); } catch (err) { console.error(err.message); process.exit(2); }
  const { port, host } = opts;
  createServer(root).listen(port, host, () => console.log(`ANTO-LTG: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/  (Ctrl+C to stop)`));
}

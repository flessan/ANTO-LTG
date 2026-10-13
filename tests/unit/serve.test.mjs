// The development server must serve the site and nothing else: no path traversal, no dotfiles, no node_modules.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../scripts/serve.mjs';
import { root } from '../helpers/repo.mjs';

let server; let port;
// node:http sends the path exactly as given (fetch() would normalise "/../" away before sending).
const get = (rawPath, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end();
});

describe('static server', () => {
  before(async () => { server = createServer(root); await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port; });
  after(() => new Promise((r) => server.close(r)));

  it('serves the home page with safe headers', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.body, /<title>ANTO-LTG/);
  });
  it('serves directory index pages and redirects a missing trailing slash', async () => {
    assert.equal((await get('/software/')).status, 200);
    const redirect = await get('/software');
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, '/software/');
  });
  it('serves JSON, CSS, JS and SVG with the right types', async () => {
    const types = { '/api/v1/apps.json': /application\/json/, '/assets/css/aero.css': /text\/css/, '/assets/js/site.js': /text\/javascript/, '/assets/icons/favicon.svg': /image\/svg\+xml/ };
    for (const [p, re] of Object.entries(types)) { const r = await get(p); assert.equal(r.status, 200, p); assert.match(r.headers['content-type'], re, p); }
  });
  it('answers HEAD without a body and rejects other methods', async () => {
    const head = await get('/', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) { const r = await get('/', m); assert.equal(r.status, 405, m); assert.equal(r.headers.allow, 'GET, HEAD'); }
  });
  it('never serves a file outside the site root, however the path is spelled', async () => {
    // layout:  <tmp>/secret.txt   <tmp>/site/index.html   (the server is rooted at <tmp>/site)
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'anto-ltg-serve-'));
    await mkdir(path.join(tmp, 'site'));
    await writeFile(path.join(tmp, 'secret.txt'), 'TOP-SECRET-OUTSIDE-THE-ROOT');
    await writeFile(path.join(tmp, 'site', 'index.html'), '<!doctype html><title>inside</title>');
    const jail = createServer(path.join(tmp, 'site'));
    await new Promise((r) => jail.listen(0, '127.0.0.1', r));
    const jailPort = jail.address().port;
    const fetchRaw = (rawPath) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: jailPort, path: rawPath }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
    });
    try {
      const attempts = ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/a/../../secret.txt', '/..%5csecret.txt', '/....//secret.txt', '//secret.txt', '/%252e%252e/secret.txt', '/..%2f..%2f..%2f..%2fetc/passwd', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/..;/secret.txt'];
      for (const p of attempts) {
        const r = await fetchRaw(p);
        assert.doesNotMatch(r.body, /TOP-SECRET|root:x:/, `${p} leaked a file`);
        // "//secret.txt" is parsed as a scheme-relative URL whose path is "/", so the site's own index may answer
        if (r.status === 200) assert.match(r.body, /<title>inside<\/title>/, `${p}: a 200 may only be the site's own page`);
        else assert.ok([301, 400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
      }
      assert.equal((await fetchRaw('/')).status, 200, 'the site itself is still served');
    } finally { await new Promise((r) => jail.close(r)); await rm(tmp, { recursive: true, force: true }); }
  });
  it('a request that climbs above the root is clamped to the root, never beyond it', async () => {
    const r = await get('/../index.html');
    assert.equal(r.status, 200);
    assert.match(r.body, /<title>ANTO-LTG/);
  });
  it('refuses a NUL byte and malformed escapes', async () => {
    for (const p of ['/%00', '/index.html%00.png', '/%zz', '/%E0%A4%A']) assert.ok([400, 404].includes((await get(p)).status), p);
  });
  it('never serves dotfiles, the .git directory or node_modules', async () => {
    for (const p of ['/.git/config', '/.git/HEAD', '/.gitignore', '/.env', '/.github/workflows/validate.yml', '/node_modules/ajv/package.json', '/assets/../.git/config']) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.body, /\[core\]|repositoryformatversion|ref: refs/);
    }
  });
  it('returns 404 for unknown files and does not list directories', async () => {
    assert.equal((await get('/nope.html')).status, 404);
    const dir = await get('/scripts/');
    assert.equal(dir.status, 404, 'a directory without index.html is not listed');
  });
});

// An in-memory stand-in for the parts of the GitHub REST API the winget adapter uses:
//   GET /repos/{repo}/contents/{path}?ref=   directory listing (JSON) or raw file (Accept: ...raw+json)
//   GET /repos/{repo}/git/trees/{sha}        full tree (the adapter's fallback for listings of 1000+ entries)
//   GET /repos/{repo}/commits/{ref}          head commit SHA (Accept: ...sha)
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export function fakeGithub(files, { head = 'a'.repeat(40), repo = 'microsoft/winget-pkgs', failures = {} } = {}) {
  const paths = Object.keys(files);
  const treeSha = (dir) => sha1(`tree:${dir}`);
  const byTreeSha = new Map();

  function listDir(dir) {
    const prefix = dir ? `${dir}/` : '';
    const entries = new Map();
    for (const p of paths) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const [first, ...tail] = rest.split('/');
      if (entries.has(first)) continue;
      const isDir = tail.length > 0;
      const full = `${prefix}${first}`;
      if (isDir) byTreeSha.set(treeSha(full), full);
      entries.set(first, { name: first, path: full, type: isDir ? 'dir' : 'file', sha: isDir ? treeSha(full) : sha1(files[p]) });
    }
    return entries.size ? [...entries.values()] : null;
  }

  const calls = [];
  const handler = (req) => {
    const url = new URL(req.url);
    calls.push({ url: req.url, accept: req.headers.accept });
    if (url.hostname !== 'api.github.com') return { status: 404, headers: {}, body: 'not the API' };
    const m = url.pathname.match(new RegExp(`^/repos/${repo}/(contents|git/trees|commits)/(.*)$`));
    if (!m) return { status: 404, headers: { 'content-type': 'application/json' }, body: '{"message":"Not Found"}' };
    const [, kind, rawRest] = m;
    const rest = decodeURIComponent(rawRest).replace(/\/$/, '');
    for (const [needle, status] of Object.entries(failures)) if (rest.includes(needle)) return { status, headers: { 'content-type': 'application/json' }, body: '{"message":"scripted failure"}' };
    if (kind === 'commits') return (req.headers.accept ?? '').includes('sha') ? { status: 200, headers: { 'content-type': 'text/plain' }, body: head } : { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: head }) };
    if (kind === 'git/trees') {
      const dir = byTreeSha.get(rest);
      const entries = dir ? listDir(dir) : null;
      if (!entries) return { status: 404, headers: { 'content-type': 'application/json' }, body: '{"message":"Not Found"}' };
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: rest, tree: entries.map((e) => ({ path: e.name, type: e.type === 'dir' ? 'tree' : 'blob', sha: e.sha })), truncated: false }) };
    }
    if (rest in files) {
      if ((req.headers.accept ?? '').includes('raw')) return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: files[rest] };
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: rest.split('/').pop(), path: rest, type: 'file', sha: sha1(files[rest]) }) };
    }
    const entries = listDir(rest);
    if (!entries) return { status: 404, headers: { 'content-type': 'application/json' }, body: '{"message":"Not Found"}' };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(entries.slice(0, 1000)) }; // GitHub silently truncates at 1000
  };
  return { handler, calls, files, treeSha };
}

/** The three manifests of a WinGet package version, as YAML text. */
export function manifestFiles({ id, version, publisher = 'Example Publisher', name = 'Example App', description = 'An example application for testing the crawler.', installers, locale = {}, versionExtra = '', installerExtra = '' }) {
  const [p1, ...rest] = id.split('.');
  const dir = `manifests/${id[0].toLowerCase()}/${id.split('.').join('/')}/${version}`;
  const defaultInstallers = installers ?? [{ Architecture: 'x64', InstallerUrl: `https://example.com/dl/${id}-${version}-x64.exe`, InstallerSha256: 'A'.repeat(64) }];
  const installerYaml = defaultInstallers.map((i) => `- ${Object.entries(i).map(([k, v], idx) => `${idx ? '  ' : ''}${k}: ${v}`).join('\n')}`).join('\n');
  const localeYaml = Object.entries({
    PackageIdentifier: id, PackageVersion: version, PackageLocale: 'en-US', Publisher: publisher, PublisherUrl: `https://example.com/${p1}`, PackageName: name, PackageUrl: `https://example.com/${rest.join('/') || p1}`,
    License: 'MIT', LicenseUrl: 'https://example.com/license', ShortDescription: description, ...locale,
  }).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => (Array.isArray(v) ? `${k}:\n${v.map((x) => `- ${x}`).join('\n')}` : `${k}: ${v}`)).join('\n');
  return {
    [`${dir}/${id}.yaml`]: `PackageIdentifier: ${id}\nPackageVersion: ${version}\nDefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.6.0\n${versionExtra}`,
    [`${dir}/${id}.installer.yaml`]: `PackageIdentifier: ${id}\nPackageVersion: ${version}\nInstallerType: inno\nScope: machine\nMinimumOSVersion: 10.0.17763.0\nReleaseDate: 2026-09-30\n${installerExtra}Installers:\n${installerYaml}\nManifestType: installer\nManifestVersion: 1.6.0\n`,
    [`${dir}/${id}.locale.en-US.yaml`]: `${localeYaml}\nManifestType: defaultLocale\nManifestVersion: 1.6.0\n`,
  };
}

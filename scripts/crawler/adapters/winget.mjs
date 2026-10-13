// Adapter: microsoft/winget-pkgs (the community WinGet repository) through the GitHub REST API.
//
// Why the API and not scraping: it is the documented, rate-limited, authenticated interface to
// the manifests, and WinGet manifests are structured data. Package IDs are only ever taken from
// the seed file and then PROVEN to exist by locating their manifest directory; a missing ID is
// reported as an error, never invented or "fixed".
//
// Output: one proposal per package, shaped like an apps.json record plus crawl metadata.
// Every record is "not_reviewed" (no human review) and carries a machine-computed publication state;
// this adapter has no way to produce "verified".
import { readFile } from 'node:fs/promises';
import { parseYaml } from '../lib/yaml-lite.mjs';
import {
  slugify, pickLatestVersion, parseIsoDate, cleanText, firstSentence, parseSha256, toHttpsUrl,
  normalizeArchitecture, compatibilityFromMinOs,
} from '../lib/normalize.mjs';
import { classifyUrl } from '../lib/classify-url.mjs';
import { runPool } from '../lib/pool.mjs';
import { isRetryableError } from '../lib/http.mjs';
import { publicationFor } from '../../lib/publication.mjs';

// Flags worth showing to users are copied into the catalog record; the rest stay in the proposal.
export const PERSISTED_FLAGS = ['manifest_older_than_2_years', 'no_https_publisher_url', 'installer_without_sha256', 'installer_url_not_https'];

export const WINGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

// RegExp.test() coerces its argument (null -> "null" would match), so the type is checked first.
const isValidId = (id) => typeof id === 'string' && WINGET_ID_RE.test(id);

export function manifestDirFor(id) {
  if (!isValidId(id)) throw new Error(`Refusing malformed WinGet package identifier: ${JSON.stringify(id)}`);
  return `manifests/${id[0].toLowerCase()}/${id.split('.').join('/')}`;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

function makeApi(ctx, cfg) {
  const base = cfg.api_base ?? 'https://api.github.com';
  const repo = cfg.repo ?? 'microsoft/winget-pkgs';
  const ref = cfg.branch ?? 'master';
  return {
    repo, ref,
    async contents(path) {
      const url = `${base}/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
      return ctx.client.fetch(url, { accept: 'application/vnd.github+json', robots: false });
    },
    async raw(path) {
      const url = `${base}/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
      return ctx.client.fetch(url, { accept: 'application/vnd.github.raw+json', robots: false });
    },
    async tree(sha) {
      return ctx.client.fetch(`${base}/repos/${repo}/git/trees/${sha}`, { accept: 'application/vnd.github+json', robots: false });
    },
    async headSha() {
      const res = await ctx.client.fetch(`${base}/repos/${repo}/commits/${encodeURIComponent(ref)}`, { accept: 'application/vnd.github.sha', robots: false, cache: false });
      const sha = res.status === 200 ? res.text().trim() : null;
      return /^[0-9a-f]{40}$/.test(sha ?? '') ? sha : null;
    },
    treeUrl(path) { return `https://github.com/${repo}/tree/${ref}/${path}`; },
    blobUrl(path) { return `https://github.com/${repo}/blob/${ref}/${path}`; },
  };
}

// Lists the entries of a directory. GitHub's contents API silently truncates at 1000 entries,
// so a full listing falls back to the git trees API (via the parent directory's entry SHA).
async function listDir(api, path) {
  const res = await api.contents(path);
  if (res.status === 404) return { status: 404, entries: [] };
  if (res.status !== 200) return { status: res.status, entries: [] };
  const entries = res.json();
  if (!Array.isArray(entries)) return { status: 422, entries: [] };
  if (entries.length < 1000) return { status: 200, entries };
  const parentPath = path.split('/').slice(0, -1).join('/');
  const name = path.split('/').pop();
  const parent = await api.contents(parentPath);
  const sha = parent.status === 200 ? parent.json().find((e) => e.name === name)?.sha : null;
  if (!sha) return { status: 200, entries, truncated: true };
  const tree = await api.tree(sha);
  if (tree.status !== 200) return { status: 200, entries, truncated: true };
  const body = tree.json();
  return {
    status: 200,
    entries: body.tree.map((t) => ({ name: t.path, type: t.type === 'tree' ? 'dir' : 'file', sha: t.sha })),
    truncated: Boolean(body.truncated),
    viaTree: true,
  };
}

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// Merge the manifest-level defaults into each installer entry.
function effectiveInstallers(installerDoc) {
  const topLevel = { ...installerDoc };
  delete topLevel.Installers;
  return asList(installerDoc.Installers).map((inst) => ({ ...topLevel, ...inst }));
}

function pickDownloads(installers, retrievedAt) {
  const seen = new Set();
  const out = [];
  for (const inst of installers) {
    const url = toHttpsUrl(inst.InstallerUrl);
    const arch = normalizeArchitecture(inst.Architecture);
    if (!url || !arch) continue;
    const type = (inst.InstallerType ?? inst.NestedInstallerType ?? 'unknown').toLowerCase();
    const key = `${arch}|${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pattern = classifyUrl(url);
    out.push({
      kind: 'direct_binary',
      url,
      architecture: arch,
      installer_type: type,
      ...(inst.Scope ? { scope: String(inst.Scope).toLowerCase() } : {}),
      sha256: parseSha256(inst.InstallerSha256),
      sha256_source: parseSha256(inst.InstallerSha256) ? 'winget-pkgs installer manifest' : null,
      evidence: 'InstallerUrl listed in a winget-pkgs manifest (hash-pinned by the WinGet validation pipeline)',
      stability: pattern.stability === 'unknown' ? 'versioned' : pattern.stability,
      link_check: { status: 'unchecked' },
    });
    if (out.length >= 8) break;
  }
  return out;
}

export function buildAppProposal({ id, versionDoc, installerDoc, localeDoc, versionName, paths, api, headSha, retrievedAt, seed }) {
  const flags = [];
  const installers = effectiveInstallers(installerDoc ?? {});
  const downloads = pickDownloads(installers, retrievedAt);
  const architectures = [...new Set(installers.map((i) => normalizeArchitecture(i.Architecture)).filter(Boolean))];
  const installerTypes = [...new Set(installers.map((i) => String(i.InstallerType ?? i.NestedInstallerType ?? '').toLowerCase()).filter(Boolean))];
  const scopes = [...new Set(installers.map((i) => i.Scope).filter(Boolean).map((s) => String(s).toLowerCase()))];
  const minOs = installers.map((i) => i.MinimumOSVersion ?? null).filter(Boolean);
  const compat = compatibilityFromMinOs(minOs);
  if (compat.min_os_version === null) flags.push('min_os_not_declared');
  const elevation = [...new Set(installers.map((i) => i.ElevationRequirement).filter(Boolean))];

  const name = cleanText(localeDoc?.PackageName, 120) || id.split('.').pop();
  const publisher = cleanText(localeDoc?.Publisher, 120) || id.split('.')[0];
  const description = cleanText(localeDoc?.ShortDescription, 300) || firstSentence(localeDoc?.Description, 300);
  if (!description) flags.push('no_description');

  // Prefer the package's own page; fall back to the publisher's site, then to the package index.
  const publisherUrl = toHttpsUrl(localeDoc?.PublisherUrl);
  const packageUrl = toHttpsUrl(localeDoc?.PackageUrl);
  let sourceUrl = packageUrl ?? publisherUrl;
  let sourceKind = packageUrl ? 'official_project_site' : 'publisher_page';
  if (!sourceUrl) {
    sourceUrl = api.treeUrl(paths.versionDir);
    sourceKind = 'package_index';
    flags.push('no_https_publisher_url');
  }
  const licenseUrl = toHttpsUrl(localeDoc?.LicenseUrl);
  const releaseDate = parseIsoDate(installerDoc?.ReleaseDate);
  if (releaseDate && (Date.now() - Date.parse(releaseDate)) / 86400000 > 730) flags.push('manifest_older_than_2_years');
  if (installers.some((i) => i.InstallerUrl && !toHttpsUrl(i.InstallerUrl))) flags.push('installer_url_not_https');
  if (installers.some((i) => !parseSha256(i.InstallerSha256))) flags.push('installer_without_sha256');

  const tags = [...new Set(asList(localeDoc?.Tags).map((t) => cleanText(t, 30).toLowerCase()).filter((t) => /^[\p{L}\p{N}][\p{L}\p{N} ._+#-]*$/u.test(t)))].slice(0, 8);
  const fields = ['name', 'publisher', 'description', 'license', 'license_url', 'version', 'release_date', 'architectures', 'compatibility', 'downloads', 'installer_types', 'installer_scopes', 'elevation', 'portable', 'tags'];

  const record = {
    id: seed?.id ?? slugify(name),
    name,
    publisher,
    category: seed?.category ?? 'utilities',
    description,
    source_url: sourceUrl,
    source_kind: sourceKind,
    verification_status: 'not_reviewed',
    windows_compatibility: 'not_reviewed',
    architectures,
    license: cleanText(localeDoc?.License, 80) || 'Unknown',
    notes: '',
    winget_id: id,
    ...(licenseUrl ? { license_url: licenseUrl } : {}),
    version: cleanText(versionDoc?.PackageVersion ?? installerDoc?.PackageVersion ?? versionName, 64) || null,
    release_date: releaseDate,
    compatibility: { ...compat, basis: 'winget-pkgs MinimumOSVersion', note: 'Declared by the package manifest; not tested by ANTO-LTG.' },
    installer_types: installerTypes,
    ...(scopes.length ? { installer_scopes: scopes } : {}),
    ...(elevation.length ? { elevation } : {}),
    portable: installerTypes.includes('portable'),
    downloads,
    tags: [...new Set([...(seed?.tags ?? []), ...tags])].slice(0, 10),
    ...(flags.some((f) => PERSISTED_FLAGS.includes(f)) ? { quality_flags: flags.filter((f) => PERSISTED_FLAGS.includes(f)) } : {}),
    sources: [{
      id: 'winget-pkgs',
      kind: 'package_index',
      url: api.treeUrl(paths.versionDir),
      ref: `${api.repo}@${headSha ?? api.ref}`,
      retrieved_at: retrievedAt,
      fields,
    }],
  };
  record.publication = publicationFor('apps', record, { now: retrievedAt });
  return { record, flags };
}

async function crawlPackage({ id, ctx, api, cfg, seed, headSha }) {
  const retrievedAt = ctx.now();
  const dir = manifestDirFor(id);
  const listing = await listDir(api, dir);
  if (listing.status === 404) return { error: { target: id, code: 'NOT_FOUND', message: `No manifest directory ${dir} in ${api.repo}`, retryable: false } };
  if (listing.status !== 200) return { error: { target: id, code: `HTTP_${listing.status}`, message: `Listing ${dir} returned HTTP ${listing.status}`, retryable: true } };

  const versionDirs = listing.entries.filter((e) => e.type === 'dir').map((e) => e.name);
  const candidates = pickLatestVersion(versionDirs).slice(0, 4);
  if (!candidates.length) return { error: { target: id, code: 'NO_VERSION', message: `No version-like directory under ${dir}`, retryable: false } };

  const flagsFromListing = listing.truncated ? ['version_listing_truncated'] : [];
  for (const versionName of candidates) {
    const versionDir = `${dir}/${versionName}`;
    const files = await listDir(api, versionDir);
    if (files.status !== 200) continue;
    const names = files.entries.filter((e) => e.type === 'file').map((e) => e.name);
    const installerName = `${id}.installer.yaml`;
    const versionFile = `${id}.yaml`;
    const hasSplit = names.includes(installerName);
    const hasSingleton = !hasSplit && names.includes(versionFile);
    if (!hasSplit && !hasSingleton) continue; // a sub-package directory, not a version directory

    // Git blob SHAs of the manifest files identify their exact content, so an unchanged
    // fingerprint lets an incremental run skip downloading and re-parsing them.
    const fingerprint = files.entries.filter((e) => e.type === 'file').map((e) => `${e.name}:${e.sha}`).sort().join('|');
    if (ctx.incremental && ctx.previous?.[id]?.fingerprint === fingerprint && ctx.previous?.[id]?.status === 'ok') {
      return { unchanged: true, fingerprint };
    }

    const readYaml = async (name) => {
      const res = await api.raw(`${versionDir}/${name}`);
      if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${name}`);
      return parseYaml(res.text());
    };

    let installerDoc; let localeDoc; let versionDoc;
    if (hasSingleton) {
      const single = await readYaml(versionFile);
      installerDoc = single; localeDoc = single; versionDoc = single;
    } else {
      versionDoc = names.includes(versionFile) ? await readYaml(versionFile) : {};
      installerDoc = await readYaml(installerName);
      const defaultLocale = versionDoc?.DefaultLocale ?? cfg.default_locale ?? 'en-US';
      const localeName = names.includes(`${id}.locale.${defaultLocale}.yaml`)
        ? `${id}.locale.${defaultLocale}.yaml`
        : names.find((n) => n.startsWith(`${id}.locale.`) && n.endsWith('.yaml'));
      localeDoc = localeName ? await readYaml(localeName) : {};
    }

    const { record, flags } = buildAppProposal({
      id, versionDoc, installerDoc, localeDoc, versionName,
      paths: { versionDir }, api, headSha, retrievedAt, seed,
    });
    if (versionName !== candidates[0]) flags.push('newest_version_directory_unusable');
    return {
      proposal: {
        target: id,
        key: `winget:${id.toLowerCase()}`,
        record,
        meta: {
          adapter: 'winget',
          crawled_at: retrievedAt,
          source_ref: `${api.repo}@${headSha ?? api.ref}`,
          manifest_version: versionName,
          manifest_files: names.length,
          fingerprint,
          quality_flags: [...flagsFromListing, ...flags],
        },
      },
    };
  }
  return { error: { target: id, code: 'NO_MANIFEST', message: `None of the newest ${candidates.length} version directories under ${dir} contained a usable manifest`, retryable: false } };
}

export async function loadSeeds(seedFile) {
  const doc = JSON.parse(await readFile(seedFile, 'utf8'));
  const out = new Map();
  for (const [category, ids] of Object.entries(doc.categories ?? {})) {
    for (const entry of ids) {
      const spec = typeof entry === 'string' ? { winget_id: entry } : entry;
      if (!isValidId(spec.winget_id)) throw new Error(`Seed file contains an invalid WinGet ID: ${JSON.stringify(spec.winget_id)}`);
      if (out.has(spec.winget_id)) throw new Error(`Seed file lists ${spec.winget_id} twice`);
      out.set(spec.winget_id, { category, id: spec.id, tags: spec.tags ?? [] });
    }
  }
  return out;
}

export default {
  id: 'winget',
  describe: 'Package metadata from microsoft/winget-pkgs (official GitHub REST API; no HTML scraping).',
  async run({ cfg, ctx }) {
    const seeds = await loadSeeds(new URL(cfg.seed_file, ctx.rootUrl));
    const wanted = ctx.targets?.length ? ctx.targets : [...seeds.keys()];
    const targets = cfg.limit ? wanted.slice(0, cfg.limit) : wanted;
    const api = makeApi(ctx, cfg);
    const headSha = await api.headSha().catch(() => null);
    const proposals = []; const errors = []; const unchanged = [];
    let done = 0;
    const results = await runPool(targets, ctx.concurrency ?? 4, async (id) => {
      const seed = seeds.get(id) ?? (ctx.targets?.length ? {} : undefined);
      if (!seed) throw new Error(`${id} is not in the seed file`);
      try { return await crawlPackage({ id, ctx, api, cfg, seed, headSha }); }
      finally { ctx.onProgress?.(++done, targets.length, id); }
    });
    results.forEach((r, i) => {
      const id = targets[i];
      if (r.error) errors.push({ target: id, code: r.error.code ?? 'EXCEPTION', message: String(r.error.message ?? r.error), retryable: isRetryableError(r.error.code ?? 'EXCEPTION') });
      else if (r.value.error) errors.push(r.value.error);
      else if (r.value.unchanged) unchanged.push(id);
      else proposals.push(r.value.proposal);
    });
    return {
      proposals, errors, unchanged, attempted: targets,
      source: { id: 'winget-pkgs', repo: api.repo, ref: api.ref, commit: headSha },
      stats: { targets: targets.length, proposed: proposals.length, unchanged: unchanged.length, failed: errors.length },
    };
  },
};

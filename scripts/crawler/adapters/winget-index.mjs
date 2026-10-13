// Adapter: microsoft/winget-pkgs read as a git repository (blob-less clone + sparse checkout).
//
// Why git and not the REST API: the full index of ~15,000 package IDs is one tree listing (a few
// seconds), and the manifests for the packages we use are fetched in one batch. The REST API
// adapter (winget.mjs) needs several requests per package and runs into the 5,000-per-hour limit.
//
// Two ways a package enters the run:
//   * seeds/winget.json: IDs curated by category. Each one must exist in the index, or it is
//     reported as NOT_FOUND. Nothing is guessed.
//   * discovery (crawler.config.json -> discovery.rules): every ID in the index that matches a
//     category rule, skipping excluded prerelease channels. Discovered IDs go through exactly the
//     same proposal builder and publication rules as seeded ones.
//
// Only https://github.com/<owner>/<repo>.git is accepted. git runs without a shell, with
// GIT_TERMINAL_PROMPT=0, and no credential is ever passed to it. Nothing is executed from the
// repository: manifests are read as text and parsed as data.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseYaml } from '../lib/yaml-lite.mjs';
import { pickLatestVersion } from '../lib/normalize.mjs';
import { runPool } from '../lib/pool.mjs';
import { buildAppProposal, loadSeeds, manifestDirFor, WINGET_ID_RE } from './winget.mjs';

const exec = promisify(execFile);
const MAX_BUFFER = 512 * 1024 * 1024;
const REPO_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/;

export function assertRepoUrl(url) {
  if (!REPO_URL_RE.test(url)) throw new Error(`Refusing a git remote that is not a public GitHub repository: ${url}`);
  return url;
}

async function git(args, cwd) {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' } });
  return stdout;
}

// "<mode> <type> <sha>\t<path>" lines -> Map(packageDir -> Map(versionDir -> Map(fileName -> blobSha)))
export function indexManifests(lsTreeOutput) {
  const index = new Map();
  for (const line of lsTreeOutput.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [, type, sha] = line.slice(0, tab).split(' ');
    const p = line.slice(tab + 1);
    if (type !== 'blob') continue;
    const parts = p.split('/');
    if (parts.length < 4 || parts[0] !== 'manifests') continue;
    const file = parts[parts.length - 1];
    const version = parts[parts.length - 2];
    const pkgDir = parts.slice(0, -2).join('/');
    if (!index.has(pkgDir)) index.set(pkgDir, new Map());
    const versions = index.get(pkgDir);
    if (!versions.has(version)) versions.set(version, new Map());
    versions.get(version).set(file, { sha, path: p });
  }
  return index;
}

// Which version directories hold a usable manifest for this ID (a split manifest with an installer
// file, or a singleton manifest), newest stable version first.
export function candidateVersions(index, id) {
  const versions = index.get(manifestDirFor(id));
  if (!versions) return [];
  const usable = [...versions.entries()].filter(([, files]) => files.has(`${id}.installer.yaml`) || files.has(`${id}.yaml`)).map(([v]) => v);
  return pickLatestVersion(usable).map((v) => ({ version: v, files: versions.get(v) }));
}

// Quoted, literal pathspecs so that no package or version name can act as a glob.
const literal = (p) => `:(literal)${p}`;

// Discovery: category rules applied to the index. Returns [{ id, category }] in id order.
// The cap is PER CATEGORY (maxPerCategory), so one large family (developer tools has hundreds of
// matching IDs) cannot crowd out every other category. Within a category the IDs are taken in
// alphabetical order: that is deterministic and reproducible, not a quality ranking.
export function discoverIds(allIds, { rules = [], exclude = [], max_per_category: maxPerCategory = Infinity }, seeded = new Set()) {
  // Exclusions are case-sensitive on purpose: locale suffixes are lower-case ("Mozilla.Firefox.de"),
  // and an insensitive match would also drop real IDs such as "Git.Git".
  const excludeRes = exclude.map((s) => new RegExp(s));
  const compiled = rules.map((r) => ({ category: r.category, re: new RegExp(r.match, 'i') }));
  const taken = new Map();
  const out = [];
  for (const id of [...allIds].sort()) {
    if (seeded.has(id) || !WINGET_ID_RE.test(id)) continue;
    if (excludeRes.some((re) => re.test(id))) continue;
    const rule = compiled.find((r) => r.re.test(id));
    if (!rule) continue;
    const n = taken.get(rule.category) ?? 0;
    if (n >= maxPerCategory) continue;
    taken.set(rule.category, n + 1);
    out.push({ id, category: rule.category });
  }
  return out;
}

export function allPackageIds(index) {
  const ids = new Set();
  for (const [pkgDir, versions] of index) {
    for (const files of versions.values()) {
      for (const f of files.keys()) {
        const m = f.match(/^(.+)\.installer\.yaml$/) ?? f.match(/^(.+)\.yaml$/);
        if (!m || /\.locale\./.test(f)) continue;
        const id = m[1];
        // Only accept the ID when it lives in the directory its name predicts.
        if (WINGET_ID_RE.test(id) && manifestDirFor(id) === pkgDir) ids.add(id);
      }
    }
  }
  return ids;
}

function readDoc(text) { return parseYaml(text); }

async function readVersionDocs(root, id, versionDir, files, cfg) {
  const names = [...files.keys()];
  const installerName = `${id}.installer.yaml`;
  const versionFile = `${id}.yaml`;
  const hasSplit = names.includes(installerName);
  const hasSingleton = !hasSplit && names.includes(versionFile);
  if (!hasSplit && !hasSingleton) return null;
  const read = async (name) => readDoc(await readFile(path.join(root, files.get(name).path), 'utf8'));
  if (hasSingleton) {
    const single = await read(versionFile);
    return { installerDoc: single, localeDoc: single, versionDoc: single };
  }
  const versionDoc = names.includes(versionFile) ? await read(versionFile) : {};
  const installerDoc = await read(installerName);
  const defaultLocale = versionDoc?.DefaultLocale ?? cfg.default_locale ?? 'en-US';
  const localeName = names.includes(`${id}.locale.${defaultLocale}.yaml`) ? `${id}.locale.${defaultLocale}.yaml` : names.find((n) => n.startsWith(`${id}.locale.`) && n.endsWith('.yaml'));
  const localeDoc = localeName ? await read(localeName) : {};
  return { installerDoc, localeDoc, versionDoc };
}

function fingerprintOf(files) {
  return [...files.entries()].map(([name, f]) => `${name}:${f.sha}`).sort().join('|');
}

export default {
  id: 'winget-index',
  describe: 'Package metadata from microsoft/winget-pkgs read as a public git repository (blob-less clone, sparse checkout).',
  async run({ cfg, ctx }) {
    const repoUrl = assertRepoUrl(cfg.repo_url ?? 'https://github.com/microsoft/winget-pkgs.git');
    const branch = cfg.branch ?? 'master';
    const seeds = await loadSeeds(new URL(cfg.seed_file, ctx.rootUrl));
    const workBase = cfg.work_dir ? path.resolve(cfg.work_dir) : path.join(process.cwd(), '.cache', 'crawler');
    await mkdir(workBase, { recursive: true });
    const work = await mkdtemp(path.join(workBase, 'winget-index-'));
    const proposals = []; const errors = []; const unchanged = []; const attempted = [];
    let commit = null;
    try {
      await git(['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--depth', '1', '--single-branch', '--branch', branch, repoUrl, work], process.cwd());
      commit = (await git(['rev-parse', 'HEAD'], work)).trim();
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('git did not report a commit');
      const index = indexManifests(await git(['ls-tree', '-r', 'HEAD', '--', 'manifests'], work));
      const allIds = allPackageIds(index);

      // Targets: explicit --ids, otherwise the seeds plus discovery.
      const targets = new Map();
      if (ctx.targets?.length) {
        for (const id of ctx.targets) targets.set(id, { category: 'utilities', tags: [] });
      } else {
        for (const [id, seed] of seeds) targets.set(id, { category: seed.category, id: seed.id, tags: seed.tags });
        if (cfg.discovery?.enabled) {
          for (const d of discoverIds(allIds, cfg.discovery, new Set(seeds.keys()))) targets.set(d.id, { category: d.category, tags: [], discovered: true });
        }
      }
      let ids = [...targets.keys()];
      if (cfg.limit) ids = ids.slice(0, Number(cfg.limit));
      const selected = ids.map((id) => ({ id, spec: targets.get(id) }));
      for (const { id } of selected) if (!WINGET_ID_RE.test(id)) errors.push({ target: id, code: 'INVALID_ID', message: 'Refusing malformed WinGet package identifier', retryable: false });

      // Resolve versions from the index first, so only the needed manifests are checked out.
      const plan = [];
      for (const { id, spec } of selected) {
        if (!WINGET_ID_RE.test(id)) continue;
        attempted.push(id);
        if (!allIds.has(id)) { errors.push({ target: id, code: 'NOT_FOUND', message: `No manifest directory ${manifestDirFor(id)} in ${repoUrl.replace(/\.git$/, '')} (${branch} @ ${commit.slice(0, 7)})`, retryable: false }); continue; }
        const cands = candidateVersions(index, id).slice(0, 2);
        if (!cands.length) { errors.push({ target: id, code: 'NO_MANIFEST', message: `No version directory with a manifest under ${manifestDirFor(id)}`, retryable: false }); continue; }
        plan.push({ id, spec, cands });
      }

      const pathspecs = [...new Set(plan.flatMap((p) => p.cands.map((c) => literal(path.posix.dirname([...c.files.values()][0].path)))))];
      for (let i = 0; i < pathspecs.length; i += 400) {
        await git(['checkout', '--quiet', 'HEAD', '--', ...pathspecs.slice(i, i + 400)], work);
      }

      const retrievedAt = ctx.now();
      const fakeApi = { repo: 'microsoft/winget-pkgs', ref: branch, treeUrl: (p) => `https://github.com/microsoft/winget-pkgs/tree/${branch}/${p}` };
      const results = await runPool(plan, ctx.concurrency ?? 4, async ({ id, spec, cands }) => {
        let lastErr = null;
        for (const cand of cands) {
          const versionDir = path.posix.dirname([...cand.files.values()][0].path);
          const fingerprint = fingerprintOf(cand.files);
          if (ctx.incremental && ctx.previous?.[id]?.fingerprint === fingerprint && ctx.previous?.[id]?.status === 'ok') return { unchanged: true, id };
          try {
            const docs = await readVersionDocs(work, id, versionDir, cand.files, cfg);
            if (!docs) continue;
            const { record, flags } = buildAppProposal({
              id, versionDoc: docs.versionDoc, installerDoc: docs.installerDoc, localeDoc: docs.localeDoc,
              versionName: cand.version, paths: { versionDir }, api: fakeApi, headSha: commit, retrievedAt,
              seed: spec.discovered ? { category: spec.category, tags: spec.tags } : { id: spec.id, category: spec.category, tags: spec.tags },
            });
            if (cand !== cands[0]) flags.push('newest_version_directory_unusable');
            const quality = [...new Set(flags)];
            return {
              proposal: {
                target: id,
                key: `winget:${id.toLowerCase()}`,
                record,
                meta: {
                  adapter: 'winget-index',
                  crawled_at: retrievedAt,
                  source_ref: `microsoft/winget-pkgs@${commit}`,
                  manifest_version: cand.version,
                  manifest_files: cand.files.size,
                  fingerprint,
                  discovered: Boolean(spec.discovered),
                  quality_flags: quality,
                },
              },
            };
          } catch (e) {
            lastErr = e;
          }
        }
        return { error: { target: id, code: 'PARSE_ERROR', message: String(lastErr?.message ?? 'no usable manifest in the newest version directories'), retryable: false } };
      });
      results.forEach((r, i) => {
        const id = plan[i].id;
        if (r.error) errors.push({ target: id, code: r.error.code ?? 'EXCEPTION', message: String(r.error.message ?? r.error), retryable: false });
        else if (r.value?.error) errors.push(r.value.error);
        else if (r.value?.unchanged) unchanged.push(id);
        else if (r.value?.proposal) proposals.push(r.value.proposal);
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    return {
      proposals, errors, unchanged, attempted,
      source: { id: 'winget-pkgs', repo: 'microsoft/winget-pkgs', ref: cfg.branch ?? 'master', commit },
      stats: { targets: attempted.length, proposed: proposals.length, unchanged: unchanged.length, failed: errors.length, discovered: proposals.filter((p) => p.meta.discovered).length },
    };
  },
};


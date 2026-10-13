import path from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { repoRoot, loadConfig } from '../lib/config.mjs';
import { planMerge, summarize } from '../lib/merge.mjs';
import { readCatalog, writeCatalog, CATALOGS, canonicalizeDoc } from '../../lib/catalog-io.mjs';
import { loadSchemas, createValidators } from '../../lib/schema.mjs';
import { checkSemantics } from '../../lib/semantic.mjs';

const CATALOG_FOR_ADAPTER = { winget: 'apps', 'driver-listings': 'drivers', 'vendor-pages': 'drivers' };

export async function merge({ flags, log = console.log }) {
  const cfg = await loadConfig();
  const dir = path.resolve(repoRoot, cfg.output_dir);
  const apply = Boolean(flags.apply);
  const today = new Date().toISOString().slice(0, 10);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.proposals.json')).filter((f) => !flags.adapter || f.startsWith(`${flags.adapter}.`));
  if (!files.length) { log('No proposal files found. Run `npm run crawl` first.'); return 0; }

  const catalogs = Object.fromEntries(await Promise.all(CATALOGS.map(async (n) => [n, await readCatalog(repoRoot, n)])));
  const validators = createValidators(await loadSchemas(path.join(repoRoot, 'schemas')));
  const report = [];
  const remaining = {};

  for (const file of files) {
    const doc = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    const catalog = CATALOG_FOR_ADAPTER[doc.adapter];
    if (!catalog) { log(`Skipping ${file}: no catalog mapping for adapter ${doc.adapter}`); continue; }
    const { doc: next, actions } = planMerge({ catalog, doc: catalogs[catalog], proposals: doc.proposals, today, allowFlagged: Boolean(flags['allow-flagged']) });
    catalogs[catalog] = next;
    const counts = summarize(actions);
    log(`${file} -> ${catalog}.json: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing to do'}`);
    for (const a of actions.filter((x) => x.type === 'drift')) log(`  DRIFT (verified record, not changed): ${a.id}: ${a.fields.join(', ')}`);
    for (const a of actions.filter((x) => x.type === 'skip')) log(`  skipped ${a.target}: ${a.reason} ${a.flags?.join(',') ?? ''}`);
    report.push({ file, catalog, counts });
    // After a successful apply only unmerged proposals stay in the proposals file.
    const mergedTargets = new Set(actions.filter((a) => ['add', 'update', 'unchanged'].includes(a.type)).map((a) => a.target));
    remaining[file] = { ...doc, proposals: doc.proposals.filter((p) => !mergedTargets.has(p.target)) };
  }

  // Never write anything that would not pass validation.
  const canon = Object.fromEntries(CATALOGS.map((n) => [n, canonicalizeDoc(n, catalogs[n])]));
  const problems = [];
  for (const n of CATALOGS) { const r = validators.validate(n, canon[n]); if (!r.ok) problems.push(...r.errors.slice(0, 20).map((e) => `${n}.json ${e}`)); }
  problems.push(...checkSemantics(canon));
  if (problems.length) {
    log(`\nThe merged catalogs would NOT validate (${problems.length} problem(s)); nothing was written:`);
    for (const p of problems.slice(0, 40)) log(`  - ${p}`);
    return 1;
  }
  if (!apply) { log('\nDry run. Re-run with --apply to write the merged catalogs and prune merged proposals.'); return 0; }
  for (const n of CATALOGS) await writeCatalog(repoRoot, n, canon[n]);
  for (const [file, doc] of Object.entries(remaining)) await writeFile(path.join(dir, file), JSON.stringify(doc, null, 2) + '\n');
  log('\nMerged. Review the diff with `git diff catalogs/`, then run `npm run build`.');
  return 0;
}

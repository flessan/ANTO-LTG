#!/usr/bin/env node
// ANTO-LTG catalog crawler. Everything it produces is a *proposal* for human review.
//
//   node scripts/crawler/cli.mjs crawl [adapter...] [--ids a,b] [--retry-failed] [--incremental]
//                                       [--dry-run] [--plan] [--offline] [--refresh] [--limit N]
//                                       [--concurrency N] [--allow-aggregators] [--verbose]
//   node scripts/crawler/cli.mjs merge  [--apply] [--adapter name] [--allow-flagged]
//   node scripts/crawler/cli.mjs check-links [--catalog apps|drivers] [--hosts a,b] [--limit N] [--apply]
//   node scripts/crawler/cli.mjs adapters
//   node scripts/crawler/cli.mjs classify <url>
import { fileURLToPath } from 'node:url';

export function parseArgs(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && VALUE_FLAGS.has(a.slice(2))) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}
const VALUE_FLAGS = new Set(['ids', 'limit', 'concurrency', 'out', 'config', 'adapter', 'catalog', 'hosts', 'only']);

const HELP = `ANTO-LTG crawler

Commands:
  crawl [adapter...]   Fetch sources and write reviewable proposals to catalogs/proposed/
  merge                Show (and with --apply, perform) the merge of proposals into catalogs/
  check-links          Probe catalog download URLs with header-only requests and record the result
  suggest <id>...      Look up real WinGet IDs close to a name that was NOT_FOUND (prints only)
  adapters             List configured adapters and their allowed hosts
  classify <url>       Classify a URL offline (direct binary, redirect, landing page, ...)

Safety: respects robots.txt for web pages, rate limits per host, never downloads binaries,
never marks anything "verified". See docs/crawler.md.`;

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  switch (command) {
    case 'crawl': {
      const { crawl } = await import('./commands/crawl.mjs');
      const report = await crawl({ flags, positional });
      const failed = report.adapters.reduce((n, a) => n + (a.stats?.failed ?? 0), 0);
      console.error(`Finished. ${failed} target(s) failed (see catalogs/proposed/report.md).`);
      return 0;
    }
    case 'merge': {
      const { merge } = await import('./commands/merge.mjs');
      return merge({ flags, positional });
    }
    case 'check-links': {
      const { checkLinks } = await import('./commands/check-links.mjs');
      return checkLinks({ flags, positional });
    }
    case 'suggest': {
      const { suggest } = await import('./commands/suggest.mjs');
      await suggest({ flags, positional });
      return 0;
    }
    case 'adapters': {
      const { loadConfig } = await import('./lib/config.mjs');
      const cfg = await loadConfig();
      for (const [name, a] of Object.entries(cfg.adapters)) console.log(`${name.padEnd(16)} ${a.enabled ? 'enabled ' : 'disabled'} robots=${a.robots.padEnd(14)} hosts=${a.hosts.join(', ')}`);
      return 0;
    }
    case 'classify': {
      const { classifyUrl } = await import('./lib/classify-url.mjs');
      console.log(JSON.stringify(classifyUrl(positional[0]), null, 2));
      return 0;
    }
    default:
      console.log(HELP);
      return command ? 2 : 0;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((err) => { console.error(err.stack ?? err); process.exitCode = 1; });
}

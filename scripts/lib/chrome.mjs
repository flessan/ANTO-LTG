// Shared page chrome (head essentials, taskbar, footer) is generated into every HTML page between
// marker comments, so security headers, navigation and the footer cannot drift between pages.
// `npm run build` rewrites the blocks; `npm run validate` fails if a page is out of date.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PAGES = [
  { key: 'home', file: 'index.html', route: '/', icon: 'home', nav: false },
  { key: 'software', file: 'software/index.html', route: '/software/', icon: 'software', nav: true },
  { key: 'drivers', file: 'drivers/index.html', route: '/drivers/', icon: 'chip', nav: true },
  { key: 'bundles', file: 'bundles/index.html', route: '/bundles/', icon: 'bundle', nav: true },
  { key: 'tools', file: 'tools/index.html', route: '/tools/', icon: 'wrench', nav: true },
  { key: 'guides', file: 'guides/index.html', route: '/guides/', icon: 'book', nav: true },
  { key: 'developers', file: 'developers/index.html', route: '/developers/', icon: 'code', nav: true },
];
const LABELS = { home: 'Home', software: 'Software', drivers: 'Drivers', bundles: 'Bundles', tools: 'Tools', guides: 'Guides', developers: 'Developers' };

const rootFor = (file) => (file.includes('/') ? '../'.repeat(file.split('/').length - 1) : '');
const BLOCKS = ['head', 'header', 'footer'];
const marker = (name, edge) => `<!--chrome:${name}:${edge}-->`;

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

export async function renderBlocks(templatesDir, page) {
  const root = rootFor(page.file);
  const read = (n) => readFile(path.join(templatesDir, `${n}.html`), 'utf8');
  const nav = PAGES.filter((p) => p.nav).map((p) => {
    const href = `${root}${p.route.slice(1)}`;
    const current = p.key === page.key ? ' aria-current="page"' : '';
    return `    <a href="${href}"${current}><svg class="ic" aria-hidden="true" focusable="false"><use href="${root}assets/icons/sprite.svg#${p.icon}"></use></svg><span data-i18n="nav.${p.key}">${LABELS[p.key]}</span></a>`;
  }).join('\n');
  const out = {};
  for (const name of BLOCKS) out[name] = render((await read(name)).trimEnd(), { root, nav, page: page.key });
  return out;
}

export function applyBlocks(html, blocks) {
  let out = html;
  for (const name of BLOCKS) {
    const start = marker(name, 'start'); const end = marker(name, 'end');
    const a = out.indexOf(start); const b = out.indexOf(end);
    if (a === -1 || b === -1 || b < a) throw new Error(`missing ${start} ... ${end} markers`);
    out = `${out.slice(0, a + start.length)}\n${blocks[name]}\n${out.slice(b)}`;
  }
  return out;
}

export async function syncPages(rootDir, { write }) {
  const stale = []; const problems = [];
  for (const page of PAGES) {
    const file = path.join(rootDir, page.file);
    let html;
    try { html = await readFile(file, 'utf8'); } catch { problems.push(`${page.file}: page is missing`); continue; }
    try {
      const next = applyBlocks(html, await renderBlocks(path.join(rootDir, 'scripts', 'templates'), page));
      if (next !== html) { stale.push(page.file); if (write) await writeFile(file, next); }
    } catch (e) { problems.push(`${page.file}: ${e.message}`); }
  }
  return { stale, problems };
}

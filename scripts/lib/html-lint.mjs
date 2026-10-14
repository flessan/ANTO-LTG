// Structural checks for the static pages: accessibility basics, CSP compatibility and link integrity.
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { PAGES } from './chrome.mjs';

const exists = (p) => access(p).then(() => true, () => false);

export async function lintPages(root) {
  const problems = [];
  const hrefCache = new Map();
  for (const page of PAGES) {
    const file = path.join(root, page.file);
    let html;
    try { html = await readFile(file, 'utf8'); } catch { problems.push(`${page.file}: missing`); continue; }
    const where = (m) => `${page.file}: ${m}`;
    if (!/<html[^>]*\blang="[a-z]{2}"/i.test(html)) problems.push(where('<html> needs a lang attribute'));
    if (!/<title>[^<]{3,}<\/title>/i.test(html)) problems.push(where('missing or empty <title>'));
    if (!/<meta name="description" content="[^"]{20,}"/i.test(html)) problems.push(where('missing meta description (20+ characters)'));
    const h1 = (html.match(/<h1[\s>]/gi) ?? []).length;
    if (h1 !== 1) problems.push(where(`expected exactly one <h1>, found ${h1}`));
    if (!/<main[^>]*\bid="main"/i.test(html)) problems.push(where('missing <main id="main"> landmark'));
    if (/\son[a-z]+\s*=\s*["']/i.test(html)) problems.push(where('inline event handler attribute (blocked by CSP)'));
    if (/\sstyle\s*=\s*["']/i.test(html)) problems.push(where('inline style attribute (blocked by CSP); use a class'));
    if (/<style[\s>]/i.test(html)) problems.push(where('<style> element (blocked by CSP); use a stylesheet'));
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) if (!/\bsrc=/.test(m[1])) problems.push(where('inline <script> (blocked by CSP)'));
    if (/href\s*=\s*["']\s*javascript:/i.test(html)) problems.push(where('javascript: URL'));
    for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
      if (!/\balt=/.test(m[1])) problems.push(where('<img> without alt'));
      if (!/\bwidth=/.test(m[1]) || !/\bheight=/.test(m[1])) problems.push(where('<img> without width and height (layout shift)'));
    }
    for (const m of html.matchAll(/<a\b([^>]*)>/gi)) if (/target="_blank"/.test(m[1]) && !/rel="[^"]*noopener/.test(m[1])) problems.push(where('target=_blank link without rel="noopener noreferrer"'));
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) problems.push(where(`duplicate id(s): ${[...new Set(dup)].join(', ')}`));
    for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const ref = m[1];
      if (/^(https?:|mailto:|#|data:|ms-)/i.test(ref) || ref.includes('{{')) continue;
      const clean = ref.split('#')[0].split('?')[0];
      if (!clean) continue;
      let target = path.resolve(path.dirname(file), clean);
      if (clean.endsWith('/')) target = path.join(target, 'index.html');
      const key = target;
      if (!hrefCache.has(key)) hrefCache.set(key, await exists(target));
      if (!hrefCache.get(key)) problems.push(where(`broken internal reference "${ref}"`));
    }
  }
  return problems;
}

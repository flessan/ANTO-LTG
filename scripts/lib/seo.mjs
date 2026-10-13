// sitemap.xml, robots.txt and feed.xml, generated only when SITE_URL is set (they are not committed).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PAGES } from './chrome.mjs';

const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export async function writeSeo(root, siteUrlRaw, updates) {
  let url;
  try { url = new URL(siteUrlRaw); if (url.protocol !== 'https:') throw new Error('SITE_URL must use HTTPS'); } catch (e) { return { error: `Invalid SITE_URL: ${e.message}` }; }
  const base = url.origin.replace(/\/$/, '');
  const entries = PAGES.map((p) => `  <url><loc>${base}${p.route}</loc></url>`).join('\n');
  await writeFile(path.join(root, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`);
  await writeFile(path.join(root, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
  const items = updates.items.map((item) => {
    const link = `${base}${String(item.path || '/').replace(/^\/?/, '/')}`;
    return `    <item><title>${xml(item.title)}</title><link>${xml(link)}</link><guid>${xml(`${link}#${item.id}`)}</guid><pubDate>${xml(new Date(item.published_at).toUTCString())}</pubDate><description>${xml(item.description)}</description></item>`;
  }).join('\n');
  await writeFile(path.join(root, 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>ANTO-LTG Updates</title><link>${base}/</link><description>Catalog and project updates for ANTO-LTG.</description><language>en</language>\n${items}\n</channel></rss>\n`);
  return { base };
}

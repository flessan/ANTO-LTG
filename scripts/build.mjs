import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const isBuild = process.argv.includes('--build');
const catalogsDir = path.join(root, 'catalogs');
const apiDir = path.join(root, 'api', 'v1');
const errors = [];
const catalogNames = ['apps', 'drivers', 'bundles', 'tools', 'updates'];
const idsByCatalog = {};

function fail(message) { errors.push(message); }
function validId(id) { return typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id); }
function httpsUrl(value, where) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') fail(`${where}: source_url must use HTTPS`);
  } catch { fail(`${where}: invalid source_url`); }
}

for (const name of catalogNames) {
  const file = path.join(catalogsDir, `${name}.json`);
  let doc;
  try { doc = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { fail(`${name}.json: cannot parse JSON (${e.message})`); continue; }
  if (doc.schema_version !== '1.0.0') fail(`${name}.json: schema_version must be "1.0.0"`);
  if (!Array.isArray(doc.items)) { fail(`${name}.json: items must be an array`); continue; }
  if (doc.updated_at !== null && doc.updated_at !== undefined && Number.isNaN(Date.parse(doc.updated_at))) {
    fail(`${name}.json: updated_at must be an ISO date-time or null`);
  }
  const ids = new Set();
  for (const [index, item] of doc.items.entries()) {
    const where = `${name}.json items[${index}]`;
    if (!validId(item.id)) fail(`${where}: id must be lowercase kebab-case`);
    if (ids.has(item.id)) fail(`${where}: duplicate id "${item.id}"`);
    ids.add(item.id);
    const required = name === 'updates'
      ? ['title', 'description', 'path', 'published_at']
      : ['name', 'description'];
    for (const field of required) {
      if (typeof item[field] !== 'string' || !item[field].trim()) fail(`${where}: ${field} is required`);
    }
    if (name === 'updates') {
      if (!item.path?.startsWith('/') || item.path.startsWith('//')) fail(`${where}: path must be a site-relative path beginning with one slash`);
      if (Number.isNaN(Date.parse(item.published_at))) fail(`${where}: published_at must be a valid date-time`);
    }
    if (['apps', 'drivers', 'tools'].includes(name)) {
      if (typeof item.category !== 'string' || !item.category.trim()) fail(`${where}: category is required`);
      if (typeof item.publisher !== 'string' || !item.publisher.trim()) fail(`${where}: publisher is required`);
      if (typeof item.source_url !== 'string') fail(`${where}: source_url is required`);
      else httpsUrl(item.source_url, where);
      if (!['publisher_page', 'manufacturer_support_page', 'official_project_site'].includes(item.source_kind)) fail(`${where}: invalid source_kind`);
      if (!['pending_review', 'verified', 'withdrawn'].includes(item.verification_status)) fail(`${where}: invalid verification_status`);
      if (item.verification_status === 'verified') {
        if (typeof item.reviewed_at !== 'string' || Number.isNaN(Date.parse(item.reviewed_at))) fail(`${where}: verified items require reviewed_at`);
        if (typeof item.review_notes !== 'string' || !item.review_notes.trim()) fail(`${where}: verified items require review_notes`);
        if (typeof item.evidence_url !== 'string') fail(`${where}: verified items require evidence_url`);
        else httpsUrl(item.evidence_url, where + ' evidence_url');
      }
      if (name === 'apps') {
        if (!['not_reviewed', 'supported', 'unsupported', 'partial'].includes(item.windows_compatibility)) fail(`${where}: invalid windows_compatibility`);
        if (!Array.isArray(item.architectures)) fail(`${where}: architectures must be an array`);
        if (typeof item.license !== 'string') fail(`${where}: license is required`);
        if (typeof item.notes !== 'string') fail(`${where}: notes is required`);
      }
      if (name === 'drivers') {
        for (const field of ['manufacturer', 'model', 'component', 'notes']) {
          if (typeof item[field] !== 'string' || !item[field].trim()) fail(`${where}: ${field} is required`);
        }
        if (!Array.isArray(item.windows_versions)) fail(`${where}: windows_versions must be an array`);
        if (!Array.isArray(item.architectures)) fail(`${where}: architectures must be an array`);
      }
      if (name === 'tools' && !['yes', 'no', 'not_reviewed'].includes(item.requires_admin)) fail(`${where}: requires_admin must be yes, no, or not_reviewed`);
    }
    if (name === 'bundles') {
      if (!Array.isArray(item.app_ids)) fail(`${where}: app_ids must be an array`);
      if (!['draft', 'published', 'withdrawn'].includes(item.status)) fail(`${where}: invalid status`);
    }
  }
  idsByCatalog[name] = ids;
  if (isBuild) {
    await mkdir(apiDir, { recursive: true });
    await copyFile(file, path.join(apiDir, `${name}.json`));
  }
}

const bundleDoc = JSON.parse(await readFile(path.join(catalogsDir, 'bundles.json'), 'utf8'));
for (const [index, bundle] of bundleDoc.items.entries()) {
  for (const appId of (Array.isArray(bundle.app_ids) ? bundle.app_ids : [])) {
    if (!idsByCatalog.apps?.has(appId)) fail(`bundles.json items[${index}]: unknown app id "${appId}"`);
  }
}

if (errors.length) {
  console.error('ANTO-LTG catalog validation failed:\n- ' + errors.join('\n- '));
  process.exitCode = 1;
} else {
  console.log('ANTO-LTG catalogs validated successfully.');
}

if (isBuild && errors.length === 0) {
  const siteUrlRaw = process.env.SITE_URL;
  if (!siteUrlRaw) {
    console.warn('SITE_URL is not set; sitemap.xml and robots.txt were not generated. Set SITE_URL to the canonical HTTPS site origin and rebuild.');
  } else {
    let siteUrl;
    try {
      siteUrl = new URL(siteUrlRaw);
      if (siteUrl.protocol !== 'https:') throw new Error('SITE_URL must use HTTPS');
    } catch (e) {
      console.error(`Invalid SITE_URL: ${e.message}`);
      process.exitCode = 1;
    }
    if (siteUrl && !process.exitCode) {
      const base = siteUrl.origin.replace(/\/$/, '');
      const routes = ['/', '/drivers/', '/software/', '/bundles/', '/tools/', '/guides/', '/developers/'];
      const entries = routes.map(route => `  <url><loc>${base}${route}</loc></url>`).join('\n');
      await writeFile(path.join(root, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`);
      await writeFile(path.join(root, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
      const updates = JSON.parse(await readFile(path.join(catalogsDir, 'updates.json'), 'utf8'));
      const items = updates.items.map(item => {
        const link = `${base}${String(item.path || '/updates/') .replace(/^\/?/, '/')}`;
        const pubDate = item.published_at ? new Date(item.published_at).toUTCString() : new Date(0).toUTCString();
        return `    <item><title>${xml(item.title || 'ANTO-LTG update')}</title><link>${xml(link)}</link><guid>${xml(link)}</guid><pubDate>${xml(pubDate)}</pubDate><description>${xml(item.description || '')}</description></item>`;
      }).join('\n');
      await writeFile(path.join(root, 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>ANTO-LTG Updates</title><link>${base}/</link><description>Pembaruan katalog dan proyek ANTO-LTG.</description><language>id-ID</language>\n${items}\n</channel></rss>\n`);
      console.log(`Generated sitemap.xml, robots.txt, and feed.xml for ${base}`);
    }
  }
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

// Generates openapi.json from the JSON Schemas so the API description cannot drift from the data model.
const CATALOGS = [
  ['apps', 'Apps', 'Software that technicians commonly install, with sourced versions, hash-pinned installer URLs and declared compatibility.'],
  ['drivers', 'Drivers', 'Driver source records: official packages, vendor tools, support portals and clearly labelled third-party leads.'],
  ['vendors', 'Vendors', 'Official driver and support entry points per manufacturer, plus the domains that count as official for each.'],
  ['tools', 'Tools', 'Scenario notes for technician tools.'],
  ['bundles', 'Bundles', 'Curated starting selections of apps.'],
  ['updates', 'Updates', 'Project and catalog update notes (also published as an RSS feed when SITE_URL is set).'],
];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function rewriteRefs(node, schemaName) {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, schemaName));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        const m = v.match(/^(?:urn:anto-ltg:schema:([a-z-]+))?#\/\$defs\/(.+)$/);
        out[k] = m ? `#/components/schemas/${cap(m[1] ?? schemaName).replace(/-(\w)/g, (_, c) => c.toUpperCase())}_${m[2]}` : v;
      } else if (k === '$schema' || k === '$id') continue;
      else out[k] = rewriteRefs(v, schemaName);
    }
    return out;
  }
  return node;
}

export function buildOpenApi({ schemas, version, counts }) {
  const components = {};
  const rootName = (name) => (name === 'proposals' ? 'Proposals' : name === 'bundle-manifest' ? 'BundleManifest' : `${cap(name)}Catalog`);
  for (const [name, schema] of Object.entries(schemas)) {
    const { $defs = {}, ...root } = schema;
    for (const [defName, def] of Object.entries($defs)) components[`${cap(name).replace(/-(\w)/g, (_, c) => c.toUpperCase())}_${defName}`] = rewriteRefs(def, name);
    if (name !== 'common') components[rootName(name)] = rewriteRefs(root, name);
  }
  const paths = {};
  const ok = (ref, description) => ({ get: { operationId: `get${ref}`, summary: description, responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } } } } });
  for (const [name, title, description] of CATALOGS) {
    const op = ok(`${title}Catalog`, `${title} catalog`);
    op.get.description = `${description} The file currently holds ${counts[name]} items.`;
    op.get.tags = ['catalogs'];
    paths[`/api/v1/${name}.json`] = op;
  }
  paths['/api/v1/index.json'] = { get: { operationId: 'getApiIndex', tags: ['meta'], summary: 'Endpoint index with counts and SHA-256 of every file', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiIndex' } } } } } } };
  paths['/api/v1/visuals.json'] = { get: { operationId: 'getVisuals', tags: ['meta'], summary: 'Local image for every catalog record', description: 'Format anto-ltg.visuals/1. Maps each app, tool, driver, vendor, bundle and category ID to a file in assets/ and the fallback level that was used (brand, component, category, glyph or bundled). Photos are listed once with their responsive variants. Built from catalogs/ and assets/manifest.json; the files it points to are static.', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/VisualsCatalog' } } } } } } };
  paths['/api/v1/search-index.json'] = { get: { operationId: 'getSearchIndex', tags: ['meta'], summary: 'Inverted search index built at build time', description: 'Format anto-ltg.search-index/1. `docs` lists the searchable items, `tokens` is a sorted token list and `postings[i]` is a flat [docIndex, weight, ...] list for tokens[i].', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchIndex' } } } } } } };
  components.ApiIndex = {
    type: 'object', required: ['api_version', 'schema_version', 'endpoints'],
    properties: {
      api_version: { const: 'v1' }, schema_version: { type: 'string' }, note: { type: 'string' },
      endpoints: { type: 'array', items: { type: 'object', required: ['name', 'path', 'count', 'sha256'], properties: { name: { type: 'string' }, path: { type: 'string' }, count: { type: 'integer' }, updated_at: { type: ['string', 'null'] }, sha256: { type: 'string' } } } },
      stats: { type: 'object' },
    },
  };
  components.SearchIndex = {
    type: 'object', required: ['format', 'docs', 'tokens', 'postings'],
    properties: {
      format: { const: 'anto-ltg.search-index/1' },
      docs: { type: 'array', items: { type: 'object', required: ['type', 'id', 'title', 'url'], properties: { type: { enum: ['app', 'driver', 'vendor', 'tool', 'bundle', 'page'] }, id: { type: 'string' }, title: { type: 'string' }, subtitle: { type: 'string' }, url: { type: 'string' }, norm: { type: 'string' } } } },
      tokens: { type: 'array', items: { type: 'string' } },
      postings: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
    },
  };
  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'ANTO-LTG Catalog API', version,
      description: 'Static, read-only JSON files generated from catalogs/ by `npm run build`. This is a research index: statuses, sources and retrieval dates must be read before a record is used in a critical workflow. It is not a live driver database and not a real-time API.',
      license: { name: 'MIT (code); see LICENSING.md for data and third-party notices', url: 'https://github.com/flessan/ANTO-LTG/blob/main/LICENSE' },
    },
    servers: [{ url: '/', description: 'Current site origin' }],
    tags: [{ name: 'catalogs', description: 'Catalog files' }, { name: 'meta', description: 'Index and search files' }],
    paths,
    components: { schemas: Object.fromEntries(Object.entries(components).sort(([a], [b]) => (a < b ? -1 : 1))) },
  };
}

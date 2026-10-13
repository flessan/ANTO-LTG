import { fetchJson, icon, h, clear, t } from './site.js';

const endpoints = document.getElementById('endpoints'); const pick = document.getElementById('schema-pick'); const rows = document.getElementById('schema-rows');

async function loadEndpoints() {
  try {
    const [api, index] = await Promise.all([fetchJson('openapi.json'), fetchJson('api/v1/index.json')]);
    clear(endpoints);
    const meta = new Map(index.endpoints.map((e) => [e.path, e]));
    for (const [path, op] of Object.entries(api.paths)) {
      const get = op.get; const m = meta.get(path);
      endpoints.append(h('tr', {}, h('td', {}, h('a', { href: `..${path}` }, h('code', {}, `GET ${path}`))), h('td', {}, get.description ?? get.summary), h('td', {}, m ? String(m.count) : '-'), h('td', {}, m ? h('span', { class: 'hash' }, m.sha256.slice(0, 16)) : '-')));
    }
  } catch (err) { clear(endpoints); endpoints.append(h('tr', {}, h('td', { colspan: '4' }, h('span', { class: 'notice error' }, icon('warn'), `${t('common.load_error')} ${err.message}`)))); }
}

const typeOf = (s) => (s.$ref ? s.$ref.split('/').pop() : s.enum ? `enum(${s.enum.join(' | ')})` : s.const !== undefined ? `const ${JSON.stringify(s.const)}` : s.oneOf ? s.oneOf.map(typeOf).join(' or ') : Array.isArray(s.type) ? s.type.join(' or ') : s.type === 'array' ? `array of ${s.items ? typeOf(s.items) : 'any'}` : s.type ?? 'any');
async function loadSchema() {
  clear(rows);
  try {
    const schema = await fetchJson(`schemas/${pick.value}.schema.json`);
    const def = Object.values(schema.$defs ?? {}).find((d) => d.properties && d.type === 'object' && d.required) ?? null;
    if (!def) return;
    for (const [name, prop] of Object.entries(def.properties)) {
      rows.append(h('tr', {}, h('td', {}, h('code', {}, name)), h('td', {}, typeOf(prop)), h('td', {}, def.required.includes(name) ? 'yes' : ''), h('td', {}, prop.description ?? '')));
    }
  } catch (err) { rows.append(h('tr', {}, h('td', { colspan: '4' }, err.message))); }
}
pick.addEventListener('change', loadSchema);
loadEndpoints(); loadSchema();

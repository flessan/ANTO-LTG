// Turns the catalogs into the documents that go into the build-time search index.
import { CATEGORY_BY_ID, COMPONENTS, installMethods } from '../../assets/js/lib/model.js';
import { PAGES } from './chrome.mjs';

const both = (map, id) => (map[id] ? [map[id].en ?? map[id].label?.en, map[id].id ?? map[id].label?.id].filter(Boolean) : [id]);

export function buildSearchDocs(c) {
  const docs = [];
  for (const a of c.apps.items) {
    const m = installMethods(a);
    docs.push({
      type: 'app', id: a.id, title: a.name, subtitle: `${a.publisher} - ${CATEGORY_BY_ID[a.category]?.label.en ?? a.category}`, url: `software/#app=${a.id}`,
      fields: {
        name: a.name, ids: [a.id, a.winget_id].filter(Boolean), publisher: a.publisher, category: both(CATEGORY_BY_ID, a.category), tags: a.tags ?? [],
        description: [a.description, a.description_id].filter(Boolean), extra: [m.primary, ...(a.portable ? ['portable'] : []), ...(m.unavailable ? ['unavailable discontinued'] : [])],
      },
    });
  }
  for (const d of c.drivers.items) {
    docs.push({
      type: 'driver', id: d.id, title: d.name, subtitle: `${d.manufacturer} - ${COMPONENTS[d.component]?.en ?? d.component}${d.version ? ` - ${d.version}` : ''}`, url: `drivers/#d=${d.id}`,
      fields: {
        name: d.name, publisher: [d.publisher, d.manufacturer], model: [d.model, d.hardware_family].filter(Boolean), component: both(COMPONENTS, d.component),
        hardware_ids: d.hardware_ids ?? [], ids: [d.id, d.version].filter(Boolean), tags: d.tags ?? [], description: [d.description, d.description_id].filter(Boolean),
        extra: [...(d.windows_versions ?? []), d.source_kind === 'third_party_aggregator' ? 'aggregator lead' : 'official'],
      },
    });
  }
  for (const v of c.vendors.items) {
    docs.push({
      type: 'vendor', id: v.id, title: v.name, subtitle: `Vendor - ${v.kind.replace(/_/g, ' ')}`, url: `drivers/#vendor=${v.id}`,
      fields: { name: v.name, ids: [v.id, ...(v.pci_vendor_ids ?? []), ...(v.usb_vendor_ids ?? [])], hardware_ids: [...(v.pci_vendor_ids ?? []).map((i) => `VEN_${i}`), ...(v.usb_vendor_ids ?? []).map((i) => `VID_${i}`)], description: [v.notes, ...(v.instructions ?? [])].filter(Boolean), tags: [v.kind] },
    });
  }
  for (const t of c.tools.items) {
    docs.push({ type: 'tool', id: t.id, title: t.name, subtitle: `Tool - ${CATEGORY_BY_ID[t.category]?.label.en ?? t.category}`, url: `tools/#${t.id}`, fields: { name: t.name, ids: [t.id, t.app_id].filter(Boolean), publisher: t.publisher, category: both(CATEGORY_BY_ID, t.category), tags: t.tags ?? [], description: [t.description, t.description_id, ...(t.use_cases ?? []), ...(t.use_cases_id ?? [])].filter(Boolean) } });
  }
  for (const b of c.bundles.items.filter((x) => x.status === 'published')) {
    docs.push({ type: 'bundle', id: b.id, title: b.name, subtitle: `Bundle - ${b.app_ids.length} apps`, url: `bundles/#${b.id}`, fields: { name: [b.name, b.name_id].filter(Boolean), ids: [b.id], tags: b.tags ?? [], description: [b.description, b.description_id].filter(Boolean) } });
  }
  const pageText = { home: 'Home overview search', software: 'Software Center install apps WinGet script Ninite quick pick', drivers: 'Drivers finder vendors OEM hardware ID', bundles: 'Bundles starter kits', tools: 'Technician tools diagnostics recovery', guides: 'Guides how to', developers: 'Developers API schemas crawler contributing' };
  for (const p of PAGES) docs.push({ type: 'page', id: p.key, title: p.key[0].toUpperCase() + p.key.slice(1), subtitle: 'Page', url: p.file.replace(/index\.html$/, ''), fields: { name: p.key, description: pageText[p.key] } });
  return docs;
}

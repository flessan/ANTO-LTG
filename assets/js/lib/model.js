// Pure data-model helpers shared by the build, the browser UI and the tests.

// `rank` is the install order used by generated scripts: runtimes first (other programs may need
// them), games last. Within a category, apps are ordered by name.
export const CATEGORIES = [
  { id: 'runtimes', rank: 10, label: { en: 'Runtimes and redistributables', id: 'Runtime dan redistributable' } },
  { id: 'system-tools', rank: 20, label: { en: 'System utilities', id: 'Utilitas sistem' } },
  { id: 'utilities', rank: 30, label: { en: 'Files and archives', id: 'Berkas dan arsip' } },
  { id: 'security', rank: 35, label: { en: 'Security and privacy', id: 'Keamanan dan privasi' } },
  { id: 'browsers', rank: 40, label: { en: 'Browsers', id: 'Peramban' } },
  { id: 'communication', rank: 45, label: { en: 'Communication', id: 'Komunikasi' } },
  { id: 'office', rank: 50, label: { en: 'Office and documents', id: 'Perkantoran dan dokumen' } },
  { id: 'media', rank: 55, label: { en: 'Media and creative', id: 'Media dan kreatif' } },
  { id: 'developer-tools', rank: 60, label: { en: 'Developer tools', id: 'Alat pengembang' } },
  { id: 'network-remote', rank: 65, label: { en: 'Network and remote support', id: 'Jaringan dan dukungan jarak jauh' } },
  { id: 'diagnostics', rank: 70, label: { en: 'Hardware diagnostics', id: 'Diagnostik perangkat keras' } },
  { id: 'storage', rank: 72, label: { en: 'Disk, backup and recovery', id: 'Disk, cadangan, dan pemulihan' } },
  { id: 'boot-media', rank: 74, label: { en: 'Boot media and imaging', id: 'Media boot dan imaging' } },
  { id: 'vendor-tools', rank: 80, label: { en: 'Vendor and driver utilities', id: 'Utilitas vendor dan driver' } },
  { id: 'gaming', rank: 90, label: { en: 'Gaming', id: 'Game' } },
];
export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
// Browsing order (most commonly wanted first); `rank` above is the install order used by scripts.
export const DISPLAY_ORDER = ['browsers', 'communication', 'media', 'office', 'utilities', 'developer-tools', 'security', 'network-remote', 'diagnostics', 'storage', 'boot-media', 'system-tools', 'runtimes', 'vendor-tools', 'gaming'];
export const displayRank = (id) => { const i = DISPLAY_ORDER.indexOf(id); return i === -1 ? 99 : i; };
export const categoryLabel = (id, lang = 'en') => CATEGORY_BY_ID[id]?.label[lang] ?? CATEGORY_BY_ID[id]?.label.en ?? id;

export const COMPONENTS = {
  graphics: { en: 'Graphics', id: 'Grafis' }, audio: { en: 'Audio', id: 'Audio' }, 'network-ethernet': { en: 'Ethernet', id: 'Ethernet' },
  'network-wifi': { en: 'Wi-Fi', id: 'Wi-Fi' }, bluetooth: { en: 'Bluetooth', id: 'Bluetooth' }, chipset: { en: 'Chipset', id: 'Chipset' },
  storage: { en: 'Storage', id: 'Penyimpanan' }, usb: { en: 'USB', id: 'USB' }, input: { en: 'Input devices', id: 'Perangkat input' },
  camera: { en: 'Camera', id: 'Kamera' }, 'card-reader': { en: 'Card reader', id: 'Pembaca kartu' }, firmware: { en: 'Firmware / BIOS', id: 'Firmware / BIOS' },
  'serial-adapter': { en: 'USB-serial adapter', id: 'Adapter USB-serial' }, 'printer-scanner': { en: 'Printer / scanner', id: 'Printer / pemindai' },
  'system-management': { en: 'System management', id: 'Manajemen sistem' }, other: { en: 'Other / portal', id: 'Lainnya / portal' },
};
export const componentLabel = (id, lang = 'en') => COMPONENTS[id]?.[lang] ?? id;

export function isUnavailable(app) {
  return app.availability?.status === 'unavailable';
}

// What can a technician actually do with this app?
//   winget  - the package exists in the winget source (proven by a crawler source)
//   direct  - a direct_binary download is listed
//   redirect- a redirector link to the current installer is listed
//   page    - only the publisher / project page is known
// `primary` is the best method; "unavailable" apps have no method at all.
export function installMethods(app) {
  if (isUnavailable(app)) return { unavailable: true, winget: false, direct: false, redirect: false, page: false, primary: 'unavailable', list: [] };
  const downloads = app.downloads ?? [];
  const m = {
    unavailable: false,
    winget: Boolean(app.winget_id),
    direct: downloads.some((d) => d.kind === 'direct_binary'),
    redirect: downloads.some((d) => d.kind === 'redirect'),
    page: Boolean(app.source_url),
  };
  m.primary = m.winget ? 'winget' : m.direct ? 'direct' : m.redirect ? 'redirect' : m.page ? 'page' : 'unavailable';
  m.list = ['winget', 'direct', 'redirect', 'page'].filter((k) => m[k]);
  return m;
}

// Windows 7, 8 and 8.1 get the download kit only (no WinGet). Compatibility is shown as not declared for them.
export const OS_TARGETS = { windows11: 'Windows 11', windows10: 'Windows 10', windows81: 'Windows 8.1', windows8: 'Windows 8', windows7: 'Windows 7' };
export const OS_IDS = Object.keys(OS_TARGETS);
export const WINGET_OS = new Set(['windows10', 'windows11']);
export const normalizeOs = (v) => (OS_IDS.includes(v) ? v : 'windows11');

// 'declared' | 'unsupported' | 'unknown' for a target OS, from the source-declared compatibility only.
export function compatFor(app, os) {
  return app.compatibility?.[os] ?? 'unknown';
}

export function pickDownload(app, arch) {
  const list = (app.downloads ?? []).filter((d) => d.kind === 'direct_binary');
  return list.find((d) => d.architecture === arch) ?? list.find((d) => d.architecture === 'neutral') ?? list.find((d) => !d.architecture) ?? null;
}

export function sortForInstall(apps) {
  return [...apps].sort((a, b) => (CATEGORY_BY_ID[a.category]?.rank ?? 99) - (CATEGORY_BY_ID[b.category]?.rank ?? 99) || a.name.localeCompare(b.name, 'en'));
}

// A version is shown only when a recorded source supplied it (provenance), with that source's date.
export function versionInfo(item) {
  if (!item.version) return null;
  const source = (item.sources ?? []).find((s) => s.fields?.includes('version'));
  if (!source) return null;
  return { value: item.version, released: item.release_date ?? null, source: source.id, retrieved_at: String(source.retrieved_at).slice(0, 10), url: source.url };
}

export function daysSince(dateText, now = Date.now()) {
  const t = Date.parse(dateText);
  return Number.isNaN(t) ? null : Math.floor((now - t) / 86_400_000);
}

export function localized(item, field, lang) {
  return (lang === 'id' && item[`${field}_id`]) || item[field] || '';
}

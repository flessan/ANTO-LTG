// Local image resolution for the UI. The build writes api/v1/visuals.json (scripts/lib/visuals.mjs decides which file
// each record gets). This module only reads that map and renders it, so every image is a file on this site: no
// third-party image server is ever requested.
//
// Fallback chain (same as the build): brand mark -> component / category / bundle glyph -> bundled vector.
// If a file fails to load in the browser, the image swaps once to the bundled vector for its group. Photos fall back
// to the bundled vector of their group when they fail, so a broken image never leaves an empty box.
import { fetchJson, sitePath, h } from '../site.js';

// Bundled vectors. These match `BUNDLED` in scripts/lib/visuals.mjs and are used before visuals.json has loaded.
export const DEFAULT_VECTORS = {
  software: 'assets/icons/navigation/software.svg',
  tool: 'assets/icons/navigation/wrench.svg',
  driver: 'assets/icons/hardware/card.svg',
  vendor: 'assets/icons/navigation/chip.svg',
  category: 'assets/icons/navigation/folder.svg',
  bundle: 'assets/icons/navigation/bundle.svg',
};
const GROUP_KIND = { apps: 'software', tools: 'tool', drivers: 'driver', vendors: 'vendor', bundles: 'bundle', categories: 'category' };

let state = { items: {}, photos: {}, pages: {}, bundled: {}, ready: false };
let pending = null;

/** Loads api/v1/visuals.json once. Resolves even when the file is missing, so the UI always renders. */
export function loadVisuals() {
  pending ??= fetchJson('api/v1/visuals.json')
    .then((doc) => { state = { ...doc, ready: true }; return state; })
    .catch(() => { state = { ...state, ready: false }; return state; });
  return pending;
}

/** The bundled vector used for a catalog group when a record has no better image. */
export function bundledSrc(group) {
  const kind = GROUP_KIND[group] ?? 'software';
  return state.bundled?.[kind] ?? DEFAULT_VECTORS[kind];
}

/** The resolved entry for a record: { level, src, alt, asset }. */
export function visualEntry(group, id) {
  const entry = state.items?.[group]?.[id];
  if (entry?.src) return entry;
  return { level: 'bundled', src: bundledSrc(group), alt: '', asset: null };
}

/** Page-level photo for a role, e.g. pagePhotoId('software', 'banner'). */
export function pagePhotoId(page, role) {
  return state.pages?.[page]?.[role] ?? null;
}

/**
 * A square image for a record. Decorative by default (the name is shown next to it). Pass `alt` when the image is
 * the only label.
 */
export function visualImg(group, id, { size = 32, alt = '', cls = '', eager = false } = {}) {
  const entry = visualEntry(group, id);
  const fallback = bundledSrc(group);
  const img = h('img', {
    class: `vis${cls ? ` ${cls}` : ''}`,
    src: sitePath(entry.src),
    width: size,
    height: size,
    alt,
    loading: eager ? 'eager' : 'lazy',
    decoding: 'async',
    dataset: { level: entry.level },
  });
  if (alt === '') img.setAttribute('aria-hidden', 'true');
  img.addEventListener('error', () => {
    if (img.dataset.swapped) return;
    img.dataset.swapped = '1';
    img.src = sitePath(fallback);
  }, { once: false });
  return img;
}

/**
 * A responsive photo: AVIF and WebP sources with a JPEG fallback, explicit intrinsic size, and lazy loading unless it
 * is the hero (eager). The `sizes` attribute tells the browser how wide the image is on the page.
 */
export function photoPicture(photoId, { sizes = '100vw', alt, cls = '', eager = false, fallbackGroup = 'apps', fallbackId = '' } = {}) {
  const photo = state.photos?.[photoId];
  if (!photo) return visualImg(fallbackGroup, fallbackId, { size: 48, alt: alt ?? '', cls });
  const byFormat = (format) => photo.variants.filter((v) => v.format === format).sort((a, b) => a.width - b.width);
  const srcset = (list) => list.map((v) => `${sitePath(v.src)} ${v.width}w`).join(', ');
  const jpgs = byFormat('jpg');
  const base = jpgs.find((v) => v.width >= 1280) ?? jpgs[jpgs.length - 1];
  const picture = h('picture', { class: `photo${cls ? ` ${cls}` : ''}` });
  for (const format of ['avif', 'webp']) {
    const list = byFormat(format);
    if (list.length) picture.append(h('source', { type: `image/${format}`, srcset: srcset(list), sizes }));
  }
  const img = h('img', {
    src: sitePath(base.src),
    srcset: srcset(jpgs),
    sizes,
    width: base.width,
    height: base.height,
    alt: alt ?? photo.alt,
    loading: eager ? 'eager' : 'lazy',
    decoding: 'async',
    fetchpriority: eager ? 'high' : undefined,
  });
  img.addEventListener('error', () => {
    // A failed photo is replaced by the bundled vector, never left as a broken image.
    const swap = visualImg(fallbackGroup, fallbackId, { size: 48, alt: alt ?? '', cls: 'photo-fallback' });
    picture.replaceWith(swap);
  }, { once: true });
  picture.append(img);
  return picture;
}

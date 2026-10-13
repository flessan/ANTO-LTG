// Tiny i18n layer: English is the default; Indonesian is chosen automatically for id* browsers or by the
// EN/ID switch in the taskbar tray. Text is applied through textContent/attributes only (never innerHTML).
import en from './i18n/en.js';
import id from './i18n/id.js';
import { KEYS } from './lib/storage.js';

export const STRINGS = { en, id };
export const LANGS = ['en', 'id'];
let current = 'en';

export function pickLang({ stored, languages = [] } = {}) {
  if (LANGS.includes(stored)) return stored;
  for (const l of languages) { const base = String(l).toLowerCase().split('-')[0]; if (base === 'id' || base === 'in') return 'id'; if (base === 'en') return 'en'; }
  return 'en';
}

export function format(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

export function translate(lang, key, params) {
  const s = STRINGS[lang]?.[key] ?? STRINGS.en[key];
  return s === undefined ? key : format(s, params);
}
export const t = (key, params) => translate(current, key, params);
// Count-aware: uses key.one / key.other.
export const tn = (key, n, params = {}) => translate(current, `${key}.${n === 1 ? 'one' : 'other'}`, { n, ...params });
export const getLang = () => current;

const ATTRS = [['aria-label', 'data-i18n-aria-label'], ['placeholder', 'data-i18n-placeholder'], ['title', 'data-i18n-title'], ['alt', 'data-i18n-alt']];
// Long prose lives in two sibling blocks (<div data-lang-block="en"> / "id"); only the active one is shown.
export function applyLangBlocks(root = document) {
  for (const el of root.querySelectorAll('[data-lang-block]')) el.hidden = el.dataset.langBlock !== current;
}

export function applyI18n(root = document) {
  applyLangBlocks(root);
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const [attr, data] of ATTRS) for (const el of root.querySelectorAll(`[${data}]`)) el.setAttribute(attr, t(el.getAttribute(data)));
}

export function setLang(lang, { persist = true } = {}) {
  current = LANGS.includes(lang) ? lang : 'en';
  document.documentElement.lang = current;
  if (persist) { try { localStorage.setItem(KEYS.lang, JSON.stringify(current)); } catch { /* private mode */ } }
  for (const b of document.querySelectorAll('.lang-switch [data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === current));
  applyI18n(document);
  document.dispatchEvent(new CustomEvent('anto:lang', { detail: { lang: current } }));
  return current;
}

export function initLang() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(KEYS.lang) ?? 'null'); } catch { stored = null; }
  setLang(pickLang({ stored, languages: navigator.languages ?? [navigator.language] }), { persist: false });
}

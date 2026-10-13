// Shell behaviour shared by every page: language, taskbar menu, clock, working window controls,
// dialogs and toasts. Page scripts import helpers from here.
import { initLang, setLang, t, tn, getLang, applyI18n } from './i18n.js';
import { h, clear } from './lib/html.js';
import { initBackdrop } from './lib/backdrop.js';

export { t, tn, getLang, applyI18n, h, clear };
export const rootUrl = new URL('../../', import.meta.url);
const cache = new Map();

export async function fetchJson(path) {
  const url = new URL(path, rootUrl);
  if (cache.has(url.href)) return cache.get(url.href);
  const promise = fetch(url, { credentials: 'omit', headers: { accept: 'application/json' } }).then(async (res) => {
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  });
  cache.set(url.href, promise);
  promise.catch(() => cache.delete(url.href));
  return promise;
}
export const loadCatalog = (name) => fetchJson(`api/v1/${name}.json`);
export const sitePath = (p) => new URL(p, rootUrl).pathname;

// ---- toasts -------------------------------------------------------------------------------------------
let region = null;
export function toast(message, { type = 'info', ms = 4500 } = {}) {
  if (!region) { region = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' }); document.body.append(region); }
  const el = h('div', { class: `toast ${type}` }, message);
  region.append(el);
  setTimeout(() => el.remove(), ms);
}

// ---- dialogs (native <dialog>, styled as a 7.css window) -----------------------------------------------------
export function openDialog({ title, icon: iconName = 'info', body, actions = [], narrow = false, onClose }) {
  const dlg = document.createElement('dialog');
  dlg.className = `window glass active${narrow ? ' narrow' : ''}`;
  const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`;
  dlg.setAttribute('aria-labelledby', titleId);
  const closeBtn = h('button', { type: 'button', class: 'is-close', 'aria-label': t('win.close'), title: t('win.close'), onclick: () => dlg.close() });
  dlg.append(
    h('div', { class: 'title-bar' }, h('div', { class: 'title-bar-text', id: titleId }, icon(iconName), title), h('div', { class: 'title-bar-controls' }, closeBtn)),
    h('div', { class: 'window-body has-space' }, body, actions.length ? h('div', { class: 'dialog-actions' }, ...actions) : null),
  );
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

export function confirmDialog({ title, message, confirmLabel, cancelLabel, danger = false, icon = 'warn' }) {
  return new Promise((resolve) => {
    let answer = false;
    const ok = h('button', { type: 'button', class: `${danger ? '' : 'default'}`, onclick: () => { answer = true; dlg.close(); } }, confirmLabel ?? t('common.confirm'));
    const cancel = h('button', { type: 'button', class: '', onclick: () => dlg.close() }, cancelLabel ?? t('common.cancel'));
    const dlg = openDialog({ title, icon, narrow: true, body: h('p', {}, message), actions: [cancel, ok], onClose: () => resolve(answer) });
    cancel.focus();
  });
}

// ---- download / copy helpers (the browser never runs anything it generates) --------------------------------------
export function downloadText(filename, text, type = 'text/plain', { bom = false } = {}) {
  const blob = new Blob([bom ? `\uFEFF${text}` : text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; // a blob: URL created by this page from text it generated itself
  a.setAttribute('download', filename);
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = h('textarea', { 'aria-hidden': 'true', readonly: true }); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove(); return ok;
  }
}

export function icon(name, extra = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `ic ${extra}`.trim()); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${sitePath('assets/icons/sprite.svg')}#${name}`);
  svg.append(use);
  return svg;
}

// ---- window controls: minimize collapses, maximize gives focus mode, help opens the docs ---------------------------
function wireWindows() {
  for (const win of document.querySelectorAll('.window[data-window]')) {
    const controls = win.querySelector(':scope > .title-bar .title-bar-controls');
    if (!controls || controls.dataset.wired) continue;
    controls.dataset.wired = '1';
    const bar = win.querySelector(':scope > .title-bar');
    const label = (b, key) => { b.setAttribute('aria-label', t(key)); b.title = t(key); };
    const min = controls.querySelector('[data-win="minimize"]'); const max = controls.querySelector('[data-win="maximize"]'); const help = controls.querySelector('[data-win="help"]');
    const refresh = () => {
      if (min) { label(min, win.classList.contains('is-collapsed') ? 'win.restore' : 'win.minimize'); min.setAttribute('aria-expanded', String(!win.classList.contains('is-collapsed'))); }
      if (max) { const on = win.classList.contains('is-focus'); label(max, on ? 'win.restore' : 'win.maximize'); max.setAttribute('aria-pressed', String(on)); max.classList.toggle('is-restore', on); max.classList.toggle('is-maximize', !on); }
      if (help) label(help, 'win.help');
    };
    min?.addEventListener('click', () => { win.classList.toggle('is-collapsed'); refresh(); });
    max?.addEventListener('click', () => {
      const on = win.classList.toggle('is-focus');
      document.body.classList.toggle('has-focus-window', on);
      win.classList.remove('is-collapsed'); refresh();
      if (on) win.querySelector('.window-body')?.focus?.();
    });
    help?.addEventListener('click', () => { const href = win.dataset.help; if (href) window.location.assign(new URL(href, rootUrl)); });
    bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button') && max) max.click(); });
    document.addEventListener('anto:lang', refresh);
    refresh();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const focused = document.querySelector('.window.is-focus');
    if (focused && !document.querySelector('dialog[open]')) { focused.querySelector('[data-win="maximize"]')?.click(); }
  });
}

function wireTaskbar() {
  const toggle = document.querySelector('.taskbar-toggle');
  toggle?.addEventListener('click', () => toggle.setAttribute('aria-expanded', String(toggle.getAttribute('aria-expanded') !== 'true')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && toggle?.getAttribute('aria-expanded') === 'true') { toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); } });
  for (const b of document.querySelectorAll('.lang-switch [data-lang]')) b.addEventListener('click', () => setLang(b.dataset.lang));
  const clock = document.getElementById('tray-clock');
  if (clock) {
    const tick = () => { const d = new Date(); clock.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); clock.dateTime = d.toISOString(); clock.title = d.toLocaleDateString(getLang() === 'id' ? 'id-ID' : 'en-US', { dateStyle: 'full' }); };
    tick(); setInterval(tick, 30_000);
  }
}

function boot() {
  initLang();
  initBackdrop();
  wireTaskbar();
  wireWindows();
  document.documentElement.dataset.ready = 'true';
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

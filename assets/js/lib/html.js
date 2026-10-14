// Safe DOM construction and URL validation.
//
// The UI never assigns catalog or user-supplied strings to innerHTML. Elements are built with
// h(), which writes text through text nodes, validates every URL attribute, refuses inline
// event-handler strings and `style` attributes, and adds rel="noopener noreferrer" to links
// that open a new tab. tests/unit/security.test.mjs enforces "no innerHTML" across assets/js.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);
}

// Removes control characters and bidirectional/zero-width controls that can disguise text.
export function sanitizeText(value, maxLen = 2000) {
  const s = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
    .trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// Returns a normalised absolute URL string when `value` is a plain, public https (or optionally
// http) URL; otherwise null. Rejects javascript:, data:, blob:, file:, vbscript:, credentials,
// control characters, backslashes and private/local hosts.
export function safeHttpUrl(value, { allowHttp = false } = {}) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 2048) return null;
  if (/[\u0000-\u001f\u007f\\\s]/.test(raw)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i.test(host)) return null; // numeric IPv4 spellings
  if (host.includes(':')) return null; // IPv6 literals are never expected in a catalog
  return url.href;
}

// Same-site relative paths used by the UI itself (never data from the catalog).
export function safeSitePath(value) {
  if (typeof value !== 'string') return null;
  if (!/^(?:\.{0,2}\/)?[A-Za-z0-9._~\-\/]*(?:[?#][A-Za-z0-9._~\-\/=&%+,:@!$'()*;]*)?$/.test(value)) return null;
  if (value.startsWith('//') || /(^|\/)\.\.\/\.\.\/\.\./.test(value)) return null;
  return value;
}

const BOOLEAN_ATTRS = new Set(['checked', 'disabled', 'hidden', 'open', 'selected', 'readonly', 'required', 'multiple', 'download', 'autofocus']);
const PLAIN_ATTRS = new Set([
  'id', 'type', 'value', 'name', 'for', 'title', 'alt', 'placeholder', 'role', 'tabindex', 'min', 'max', 'step',
  'maxlength', 'minlength', 'autocomplete', 'spellcheck', 'inputmode', 'rows', 'cols', 'width', 'height', 'loading',
  'decoding', 'sizes', 'lang', 'dir', 'colspan', 'rowspan', 'scope', 'label', 'list', 'pattern', 'accept', 'media', 'fetchpriority',
]);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [key, val] of Object.entries(attrs)) {
      if (val === null || val === undefined || val === false) continue;
      if (key === 'class') el.className = String(val);
      else if (key === 'dataset') { for (const [k, v] of Object.entries(val)) if (/^[a-z][a-zA-Z0-9]*$/.test(k)) el.dataset[k] = String(v); }
      else if (key === 'vars') { for (const [k, v] of Object.entries(val)) if (/^--[a-z0-9-]+$/.test(k)) el.style.setProperty(k, String(v)); }
      else if (key.startsWith('on')) {
        if (typeof val !== 'function') throw new TypeError(`Event handler "${key}" must be a function, not a string`);
        el.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (key === 'style') throw new TypeError('Inline style attributes are not allowed; use class names or the "vars" option');
      else if (key === 'href') {
        const href = typeof val === 'string' && /^(\.{0,2}\/|#|[A-Za-z0-9._~\-]+(\/|$|\?|#))/.test(val) && safeSitePath(val) ? val : safeHttpUrl(val);
        if (href) el.setAttribute('href', href);
      } else if (key === 'src') {
        const src = safeSitePath(String(val));
        if (src) el.setAttribute('src', src);
      } else if (key === 'srcset') {
        const ok = String(val).split(',').every((part) => safeSitePath(part.trim().split(/\s+/)[0]));
        if (ok) el.setAttribute('srcset', String(val));
      } else if (key === 'target') {
        if (val === '_blank') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      } else if (key === 'rel') {
        if (!(el.getAttribute('target') === '_blank')) el.setAttribute('rel', String(val).replace(/[^a-z\s-]/gi, ''));
      } else if (key.startsWith('aria-') && /^aria-[a-z]+$/.test(key)) el.setAttribute(key, String(val));
      else if (BOOLEAN_ATTRS.has(key)) { if (val) el.setAttribute(key, ''); }
      else if (PLAIN_ATTRS.has(key)) el.setAttribute(key, String(val));
      else throw new TypeError(`Attribute "${key}" is not allowed by h()`);
    }
  } else if (attrs !== undefined && attrs !== null) {
    children.unshift(attrs);
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replaceChildren(el, ...children) {
  clear(el);
  appendChildren(el, children);
  return el;
}

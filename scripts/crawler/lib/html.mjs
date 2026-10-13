// A small, defensive HTML tokenizer for crawled pages. It never builds a DOM, never executes or
// evaluates anything, skips <script>/<style> bodies and comments, caps the input size and decodes
// entities. Crawled HTML is untrusted: this module only extracts text, links, tables and metadata.

const MAX_HTML = 4 * 1024 * 1024;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '(c)', reg: '(R)', trade: '(TM)', ndash: '-', mdash: '-', hellip: '...' };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' ';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export function* tokenize(html) {
  const src = String(html).slice(0, MAX_HTML);
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { yield { type: 'text', text: decodeEntities(src.slice(i)) }; return; }
    if (lt > i) yield { type: 'text', text: decodeEntities(src.slice(i, lt)) };
    if (src.startsWith('<!--', lt)) { const end = src.indexOf('-->', lt + 4); i = end === -1 ? src.length : end + 3; continue; }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') { const end = src.indexOf('>', lt); i = end === -1 ? src.length : end + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(src.slice(lt, lt + 8192));
    if (!m) { yield { type: 'text', text: '<' }; i = lt + 1; continue; }
    const name = m[2].toLowerCase();
    i = lt + m[0].length;
    if (m[1]) { yield { type: 'end', name }; continue; }
    const selfClosing = /\/\s*$/.test(m[3]) || VOID.has(name);
    yield { type: 'start', name, attrs: parseAttrs(m[3]), selfClosing };
    if (RAW_TEXT.has(name) && !selfClosing) {
      const close = new RegExp(`</${name}\\s*>`, 'i').exec(src.slice(i));
      const body = close ? src.slice(i, i + close.index) : src.slice(i);
      if (name === 'title' || name === 'textarea') yield { type: 'text', text: decodeEntities(body) };
      else yield { type: 'rawtext', name, text: body };
      i += close ? close.index + close[0].length : body.length;
      yield { type: 'end', name };
    }
  }
}

const clean = (s) => s.replace(/\s+/g, ' ').trim();

export function visibleText(html) {
  const lines = []; let cur = '';
  const BLOCK = new Set(['p', 'div', 'br', 'li', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'ul', 'ol', 'dl', 'dt', 'dd', 'pre', 'header', 'footer', 'nav']);
  const flush = () => { const t = clean(cur); if (t) lines.push(t); cur = ''; };
  for (const tok of tokenize(html)) {
    if (tok.type === 'text') cur += tok.text;
    else if ((tok.type === 'start' || tok.type === 'end') && BLOCK.has(tok.name)) flush();
    else if ((tok.type === 'start' || tok.type === 'end') && (tok.name === 'td' || tok.name === 'th')) cur += ' ';
  }
  flush();
  return lines.join('\n');
}

export function extractLinks(html) {
  const links = []; let open = null;
  for (const tok of tokenize(html)) {
    if (tok.type === 'start' && tok.name === 'a' && tok.attrs.href) open = { href: tok.attrs.href, text: '' };
    else if (tok.type === 'text' && open) open.text += tok.text;
    else if (tok.type === 'end' && tok.name === 'a' && open) { open.text = clean(open.text); links.push(open); open = null; }
  }
  return links;
}

// Returns tables as arrays of rows of cells: { text, links: [{ href, text }] }.
// `after` is the first link following the table (used to find a table's "Download" button).
export function extractTables(html) {
  const tables = []; const stack = [];
  let link = null;
  const current = () => stack[stack.length - 1];
  for (const tok of tokenize(html)) {
    if (tok.type === 'start') {
      if (tok.name === 'table') stack.push({ rows: [], row: null, cell: null, after: null });
      else if (current()) {
        const t = current();
        if (tok.name === 'tr') t.row = [];
        else if ((tok.name === 'td' || tok.name === 'th') && t.row) t.cell = { text: '', links: [] };
        else if (tok.name === 'a' && tok.attrs.href) link = { href: tok.attrs.href, text: '' };
        else if (tok.name === 'br' && t.cell) t.cell.text += ' ';
      } else if (tok.name === 'a' && tok.attrs.href) link = { href: tok.attrs.href, text: '' };
    } else if (tok.type === 'text') {
      const t = current();
      if (link) link.text += tok.text;
      if (t?.cell) t.cell.text += tok.text;
    } else if (tok.type === 'end') {
      if (tok.name === 'a' && link) {
        link.text = clean(link.text);
        const t = current();
        if (t?.cell) t.cell.links.push(link);
        for (const done of tables) if (!done.after) done.after = link;
        link = null;
      } else if ((tok.name === 'td' || tok.name === 'th') && current()?.cell) {
        const t = current(); t.cell.text = clean(t.cell.text); t.row.push(t.cell); t.cell = null;
      } else if (tok.name === 'tr' && current()?.row) {
        const t = current(); if (t.row.length) t.rows.push(t.row); t.row = null;
      } else if (tok.name === 'table' && stack.length) {
        const t = stack.pop(); tables.push({ rows: t.rows, after: null });
      }
    }
  }
  return tables;
}

export function extractMeta(html) {
  const meta = { title: '', description: '', canonical: '', og: {}, jsonld: [] };
  let inTitle = false;
  for (const tok of tokenize(html)) {
    if (tok.type === 'start' && tok.name === 'title') inTitle = true;
    else if (tok.type === 'text' && inTitle) meta.title += tok.text;
    else if (tok.type === 'end' && tok.name === 'title') inTitle = false;
    else if (tok.type === 'start' && tok.name === 'meta') {
      const key = (tok.attrs.name ?? tok.attrs.property ?? '').toLowerCase();
      if (key === 'description') meta.description = clean(tok.attrs.content ?? '');
      if (key.startsWith('og:')) meta.og[key.slice(3)] = clean(tok.attrs.content ?? '');
    } else if (tok.type === 'start' && tok.name === 'link' && tok.attrs.rel === 'canonical') meta.canonical = tok.attrs.href ?? '';
    else if (tok.type === 'start' && tok.name === 'script' && /ld\+json/i.test(tok.attrs.type ?? '')) meta._ld = true;
    else if (tok.type === 'rawtext' && tok.name === 'script' && meta._ld) {
      try { meta.jsonld.push(JSON.parse(tok.text)); } catch { /* ignore malformed JSON-LD */ }
      meta._ld = false;
    }
  }
  delete meta._ld;
  meta.title = clean(meta.title);
  return meta;
}

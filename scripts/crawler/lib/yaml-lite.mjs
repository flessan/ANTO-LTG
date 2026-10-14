// A deliberately small YAML-subset parser, sufficient for WinGet manifests.
//
// Safety properties (manifests are untrusted input):
//  * no anchors, aliases, tags, merge keys, complex keys or multiple documents - they throw;
//  * every scalar is returned as a string (no implicit typing, so "1.10" stays "1.10");
//  * nesting depth and input size are bounded.
//
// Supported: block mappings, block sequences (including sequences indented at the same
// level as their parent key), plain / single-quoted / double-quoted scalars (also multi-line),
// literal (|) and folded (>) block scalars with chomping indicators, empty flow collections,
// simple one-line flow sequences of scalars, comments and a leading "---".

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 24;

function indentOf(line) {
  let n = 0;
  while (line[n] === ' ') n++;
  if (line[n] === '\t') throw new YamlError('Tabs are not allowed for indentation');
  return n;
}

// Indentation for lines that belong to a scalar: only spaces count, a tab is content.
function contentIndent(line) {
  let n = 0;
  while (line[n] === ' ') n++;
  return n;
}

function stripComment(text) {
  let inS = false; let inD = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS && text[i - 1] !== '\\') inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function unescapeDouble(body, lineNo) {
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, esc) => {
    switch (esc[0]) {
      case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r'; case '0': return '\0';
      case '"': return '"'; case '\\': return '\\'; case '/': return '/'; case ' ': return ' ';
      case 'x': case 'u': case 'U': return String.fromCodePoint(parseInt(esc.slice(1), 16));
      default: throw new YamlError(`Unsupported escape \\${esc}`, lineNo);
    }
  });
}

function rejectUnsupportedScalar(text, lineNo) {
  if (/^[&*]/.test(text)) throw new YamlError('Anchors and aliases are not supported', lineNo);
  if (/^!/.test(text)) throw new YamlError('Tags are not supported', lineNo);
}

function splitFlow(inner, lineNo) {
  const items = [];
  let cur = ''; let inS = false; let inD = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS && inner[i - 1] !== '\\') inD = !inD;
    if ((c === '[' || c === '{') && !inS && !inD) throw new YamlError('Nested flow collections are not supported', lineNo);
    if (c === ',' && !inS && !inD) { items.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim() !== '' || items.length) items.push(cur);
  return items.map((s) => scalarFromText(s.trim(), lineNo));
}

function scalarFromText(text, lineNo) {
  rejectUnsupportedScalar(text, lineNo);
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return unescapeDouble(text.slice(1, -1), lineNo);
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'");
  return text; // plain scalars stay strings ("null" and "~" included); only an empty value becomes null
}

export function parseYaml(source) {
  if (typeof source !== 'string') throw new YamlError('Input must be a string');
  if (Buffer.byteLength(source) > MAX_BYTES) throw new YamlError('Input is too large');
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  let pos = 0;
  let sawDocStart = false;

  const isBlank = (l) => l.trim() === '';
  const isComment = (l) => l.trimStart().startsWith('#');

  function skipInsignificant() {
    while (pos < lines.length && (isBlank(lines[pos]) || isComment(lines[pos]))) pos++;
  }

  function peekSignificant() {
    skipInsignificant();
    if (pos >= lines.length) return null;
    const raw = lines[pos];
    if (raw.startsWith('---')) {
      if (sawDocStart || pos > 0 && lines.slice(0, pos).some((l) => !isBlank(l) && !isComment(l))) throw new YamlError('Multiple documents are not supported', pos + 1);
      sawDocStart = true;
      const rest = raw.slice(3).trim();
      pos++;
      if (rest && !rest.startsWith('#')) { lines.splice(pos, 0, rest); }
      return peekSignificant();
    }
    if (raw.startsWith('...')) { pos = lines.length; return null; }
    return { indent: indentOf(raw), text: raw.trimStart(), lineNo: pos + 1 };
  }

  function parseNode(minIndent, depth) {
    if (depth > MAX_DEPTH) throw new YamlError('Nesting is too deep', pos + 1);
    const first = peekSignificant();
    if (!first || first.indent < minIndent) return null;
    if (first.text === '-' || first.text.startsWith('- ')) return parseSequence(first.indent, depth + 1);
    if (/^(?:"[^"]*"|'[^']*'|[^\s#'"\[\]{}&*!|>%@`,-][^:]*?|-[^\s][^:]*?)\s*:(?:\s|$)/.test(first.text)) return parseMapping(first.indent, depth + 1);
    // top-level scalar
    pos++;
    return scalarFromText(stripComment(first.text), first.lineNo);
  }

  function parseSequence(indent, depth) {
    const out = [];
    for (;;) {
      const line = peekSignificant();
      if (!line || line.indent !== indent || !(line.text === '-' || line.text.startsWith('- '))) break;
      const afterDash = line.text === '-' ? '' : line.text.slice(2);
      if (afterDash.trim() === '' || afterDash.trim().startsWith('#')) {
        pos++;
        out.push(parseNode(indent + 1, depth));
        continue;
      }
      // Re-write the current line so the item content becomes its own (indented) line.
      const contentIndent = indent + 2 + (afterDash.length - afterDash.trimStart().length);
      lines[pos] = ' '.repeat(contentIndent) + afterDash.trimStart();
      const item = parseNode(contentIndent, depth);
      out.push(item);
    }
    return out;
  }

  function parseMapping(indent, depth) {
    const out = {};
    for (;;) {
      const line = peekSignificant();
      if (!line || line.indent !== indent) break;
      if (line.text === '-' || line.text.startsWith('- ')) break;
      const m = line.text.match(/^("[^"]*"|'[^']*'|[^\s#'"\[\]{}&*!|>%@`,-][^:]*?|-[^\s][^:]*?)\s*:(?:\s+(.*))?$/);
      if (!m) throw new YamlError(`Cannot parse mapping entry: ${line.text.slice(0, 60)}`, line.lineNo);
      let key = m[1];
      if (key === '<<') throw new YamlError('Merge keys are not supported', line.lineNo);
      if (key.startsWith('"') || key.startsWith("'")) key = scalarFromText(key, line.lineNo);
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`Duplicate key "${key}"`, line.lineNo);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new YamlError(`Forbidden key "${key}"`, line.lineNo);
      let rest = m[2] === undefined ? '' : m[2];
      const startPos = pos;
      pos++;
      rest = rest.trim();
      const bare = stripComment(rest);

      if (bare === '') {
        // nested block, or sequence at the same indentation, or null
        const next = peekSignificant();
        if (next && (next.indent > indent || (next.indent === indent && (next.text === '-' || next.text.startsWith('- '))))) {
          out[key] = next.indent === indent ? parseSequence(indent, depth) : parseNode(indent + 1, depth);
        } else {
          out[key] = null;
        }
        continue;
      }
      if (/^[|>][+\-0-9]*$/.test(bare)) { out[key] = readBlockScalar(bare, indent); continue; }
      rejectUnsupportedScalar(bare, line.lineNo);
      if (bare.startsWith('[') && bare.endsWith(']')) { out[key] = splitFlow(bare.slice(1, -1), line.lineNo); continue; }
      if (bare === '{}') { out[key] = {}; continue; }
      if (bare.startsWith('{') || bare.startsWith('[')) throw new YamlError('Unsupported flow collection', line.lineNo);
      if (bare.startsWith('"') || bare.startsWith("'")) { out[key] = readQuoted(bare, indent, startPos); continue; }
      // plain scalar with optional continuation lines
      let value = bare;
      for (;;) {
        if (pos >= lines.length) break;
        const raw = lines[pos];
        if (isBlank(raw)) {
          // a blank line only continues the scalar if more-indented text follows
          let j = pos; while (j < lines.length && isBlank(lines[j])) j++;
          if (j < lines.length && !isComment(lines[j]) && contentIndent(lines[j]) > indent) { value += '\n'; pos = j; continue; }
          break;
        }
        if (isComment(raw) || contentIndent(raw) <= indent) break;
        value += (value.endsWith('\n') ? '' : ' ') + stripComment(raw.trim());
        pos++;
      }
      out[key] = value;
    }
    return out;
  }

  function readBlockScalar(header, parentIndent) {
    const folded = header[0] === '>';
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const collected = [];
    let blockIndent = null;
    while (pos < lines.length) {
      const raw = lines[pos];
      if (isBlank(raw)) { collected.push(''); pos++; continue; }
      const ind = contentIndent(raw);
      if (ind <= parentIndent) break;
      if (blockIndent === null) blockIndent = ind;
      if (ind < blockIndent) break;
      collected.push(raw.slice(blockIndent));
      pos++;
    }
    let trailingBlanks = 0;
    while (collected.length && collected[collected.length - 1] === '') { collected.pop(); trailingBlanks++; }
    let text;
    if (!folded) text = collected.join('\n');
    else {
      text = '';
      for (let i = 0; i < collected.length; i++) {
        const cur = collected[i];
        if (i === 0) { text = cur; continue; }
        const prev = collected[i - 1];
        if (cur === '') text += '\n';
        else if (prev === '') text += cur;
        else text += ' ' + cur;
      }
    }
    if (chomp === 'strip') return text;
    if (chomp === 'keep') return text + '\n'.repeat(Math.max(1, trailingBlanks + 1));
    return collected.length ? text + '\n' : '';
  }

  function readQuoted(start, indent, startPos) {
    const quote = start[0];
    let buf = start;
    const closes = (s) => {
      for (let i = 1; i < s.length; i++) {
        if (quote === '"' && s[i] === '\\') { i++; continue; }
        if (s[i] === quote) {
          if (quote === "'" && s[i + 1] === "'") { i++; continue; }
          return i;
        }
      }
      return -1;
    };
    let end = closes(buf);
    while (end === -1) {
      if (pos >= lines.length) throw new YamlError('Unterminated quoted scalar', startPos + 1);
      const raw = lines[pos++];
      buf += isBlank(raw) ? '\n' : (buf.endsWith('\n') ? '' : ' ') + raw.trim();
      end = closes(buf);
    }
    const trailing = buf.slice(end + 1).trim();
    if (trailing && !trailing.startsWith('#')) throw new YamlError('Unexpected text after quoted scalar', startPos + 1);
    const body = buf.slice(1, end);
    return quote === '"' ? unescapeDouble(body, startPos + 1) : body.replace(/''/g, "'");
  }

  const value = parseNode(0, 0);
  const tail = peekSignificant();
  if (tail) throw new YamlError(`Unexpected content: ${tail.text.slice(0, 60)}`, tail.lineNo);
  return value;
}

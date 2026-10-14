// Tokenisation and normalisation shared by the build-time search index (Node) and the
// browser-side searcher, so the index and the queries always agree.

const SPECIAL = [
  [/c\+\+/gi, ' cpp cplusplus '],
  [/c#/gi, ' csharp '],
  [/\.net\b/gi, ' dotnet '],
  [/node\.js/gi, ' nodejs node js '],
  [/\+/g, ' plus '],
];

export function normalizeText(value) {
  let s = String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const [re, rep] of SPECIAL) s = s.replace(re, rep);
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}

export function tokenize(value) {
  const base = normalizeText(value);
  if (!base) return [];
  const parts = base.split(' ').filter(Boolean);
  const out = new Set(parts);
  // "7-Zip" => 7 zip + the joined form "7zip"; "Notepad++" => notepad plus + "notepadplusplus"
  if (parts.length > 1 && parts.length <= 5) out.add(parts.join(''));
  return [...out];
}

export function editDistanceAtMostOne(a, b) {
  if (a === b) return true;
  const la = a.length; const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; } // transposition
    else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

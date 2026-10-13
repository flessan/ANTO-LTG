// Structural helpers for checking generated PowerShell WITHOUT running PowerShell.
//
// The strongest property we can test without an interpreter is "skeleton invariance": once comments and
// string literals are blanked out, a script generated from hostile input must be byte-identical to one
// generated from benign input. If user text could ever escape its string literal (or a comment) and
// become code, the skeleton would change.

/** Replaces every single-quoted literal with '' and drops comment-only lines. One line at a time. */
export function skeleton(script) {
  return String(script)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line
      .replace(/'(?:[^']|'')*'/g, "''")
      .replace(/"(?:[^"`]|`.)*"/g, '""')
      .replace(/\s+$/, ''))
    .join('\n');
}

/** Counts unbalanced brackets in the skeleton (a cheap syntax sanity check). */
export function bracketBalance(script) {
  const code = skeleton(script);
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (const ch of code) {
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === ')' || ch === ']' || ch === '}') { if (stack.pop() !== ch) return { ok: false, reason: `unexpected ${ch}` }; }
  }
  return stack.length ? { ok: false, reason: `unclosed ${stack.join('')}` } : { ok: true };
}

/** Every single-quoted literal in the code lines of a script (content only, with '' collapsed to '). */
export function literals(script) {
  return String(script).split('\n').filter((line) => !/^\s*#/.test(line))
    .flatMap((line) => [...line.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'")));
}

/** Verb-Noun command names used by the code (strings and comments are blanked first). */
export function commandsUsed(script) {
  const code = skeleton(script);
  return [...new Set([...code.matchAll(/(?<![\w.$-])([A-Z][a-z]+-[A-Z][A-Za-z]+)\b/g)].map((m) => m[1]))].sort();
}

/** Small seeded PRNG so fuzz tests are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const HOSTILE_PIECES = [
  "'", "''", '"', '`', '$', '$(', ')', '(', '{', '}', '[', ']', ';', '|', '&', '&&', '||', '>', '<', '\n', '\r', '\r\n', '\u2028', '\u2029', '\u0085',
  '\u2018', '\u2019', '\u201a', '\u201b', '\u201c', '\u201d', '<#', '#>', '#', "@'", "'@", '@"', '"@', '\u0000', '\u0007', '\u202e', '\u200b', '\ufeff',
  'Remove-Item C:\\ -Recurse', 'Invoke-Expression', 'iex', 'Start-Process', '-ExecutionPolicy Bypass', '..\\..\\', '%PATH%', '{0}', '{1,-17}', '$env:USERPROFILE',
  'a', 'B', '7', ' ', '  ', '\t', '\u00e9', '\u65e5\u672c', '\ud83d\ude00', '\u00a0', '\u3000',
];

export function hostileString(rand, maxPieces = 14) {
  const n = 1 + Math.floor(rand() * maxPieces);
  let out = '';
  for (let i = 0; i < n; i++) out += HOSTILE_PIECES[Math.floor(rand() * HOSTILE_PIECES.length)];
  return out;
}

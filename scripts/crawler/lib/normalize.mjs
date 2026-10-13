// Normalisation helpers shared by crawler adapters and merge logic.
// Rule of thumb: when a value cannot be parsed with confidence, return null - never guess.

export function slugify(text, maxLen = 64) {
  const base = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  let out = base.slice(0, maxLen).replace(/-+$/g, '');
  // collapse "plus-plus" runs produced by "++" into a stable form
  out = out.replace(/(?:^|-)plus-plus(?=-|$)/g, (m) => `${m.startsWith('-') ? '-' : ''}plus-plus`);
  return out;
}

const PRERELEASE = /(?:^|[.\-_+])(alpha|beta|rc|pre|preview|nightly|dev|canary|insiders?|snapshot|unstable|test|experimental)(?:[.\-_+\d]|$)/i;

export function isPrerelease(version) {
  return PRERELEASE.test(String(version));
}

// Compares versions the way WinGet roughly does: dot-separated parts, numeric when both are
// numeric, missing parts count as 0, pre-release markers sort below the plain release.
export function compareVersions(a, b) {
  const tok = (v) => String(v).replace(/^v/i, '').split(/[.\-_+]/).filter((s) => s !== '');
  const pa = tok(a); const pb = tok(b);
  const preA = isPrerelease(a); const preB = isPrerelease(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? '0'; const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x); const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = BigInt(x) - BigInt(y);
      if (d !== 0n) return d > 0n ? 1 : -1;
    } else if (nx !== ny) {
      // a numeric part outranks a textual one (1.0.1 > 1.0.beta)
      return nx ? 1 : -1;
    } else if (x !== y) {
      if (PRERELEASE.test(`.${x}.`) !== PRERELEASE.test(`.${y}.`)) return PRERELEASE.test(`.${x}.`) ? -1 : 1;
      return x < y ? -1 : 1;
    }
  }
  if (preA !== preB) return preA ? -1 : 1;
  return 0;
}

export function looksLikeVersion(name) {
  return /^v?\d[\w.+\-]*$/.test(name) && name.length <= 64;
}

export function pickLatestVersion(names) {
  const candidates = names.filter(looksLikeVersion);
  const stable = candidates.filter((n) => !isPrerelease(n));
  const pool = stable.length ? stable : candidates;
  return [...pool].sort(compareVersions).reverse();
}

export function parseIsoDate(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1990 || y > new Date().getUTCFullYear() + 1) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function cleanText(raw, maxLen = 400) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw)
    // strip control characters (keeping nothing but spaces), zero-width and bidi override characters
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/<\/?[a-zA-Z!][^>]{0,200}>/g, ' ') // crawled text is untrusted: drop anything that looks like markup
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) {
    s = s.slice(0, maxLen - 1);
    const cut = s.lastIndexOf(' ');
    if (cut > maxLen * 0.6) s = s.slice(0, cut);
    s = s.replace(/[\s,;:.\-]+$/, '') + '…';
  }
  return s;
}

export function firstSentence(raw, maxLen = 300) {
  const t = cleanText(raw, 2000);
  const m = t.match(/^(.{20,}?[.!?])(\s|$)/);
  return cleanText(m ? m[1] : t, maxLen);
}

export function parseSha256(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(s) ? s : null;
}

// Characters that browsers tolerate in paths but that are not valid in an RFC 3986 URI.
// Percent-encoding them yields the same resource and keeps catalog URLs strictly valid.
const RFC3986_ILLEGAL = /[\[\]{}|^`"<>\\]/g;

export function toHttpsUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    u.pathname = u.pathname.replace(RFC3986_ILLEGAL, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
    u.search = u.search.replace(RFC3986_ILLEGAL, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
    return u.href;
  } catch { return null; }
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|msclkid|mc_cid|mc_eid|ref|ref_src|_hsenc|_hsmi|igshid)$/i;

// Canonical form used for de-duplication and comparisons (never for fetching).
export function canonicalUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  let p = u.pathname.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/$/, '');
  u.pathname = p;
  const protocol = u.protocol === 'http:' ? 'https:' : u.protocol; // treat http/https as the same resource for dedupe
  return `${protocol}//${u.host}${u.pathname}${u.search}`;
}

// ---- operating systems and architectures ---------------------------------------------------

export const OS_LABELS = {
  'windows-xp': 'Windows XP',
  'windows-vista': 'Windows Vista',
  'windows-7': 'Windows 7',
  'windows-8': 'Windows 8',
  'windows-8-1': 'Windows 8.1',
  'windows-10': 'Windows 10',
  'windows-11': 'Windows 11',
};

export function osKeyFromLabel(label) {
  const l = String(label).toLowerCase();
  if (/\bxp\b/.test(l)) return 'windows-xp';
  if (/vista/.test(l)) return 'windows-vista';
  if (/\b8\.1\b/.test(l)) return 'windows-8-1';
  if (/windows\s*8\b/.test(l)) return 'windows-8';
  if (/windows\s*7\b/.test(l)) return 'windows-7';
  if (/windows\s*10\b/.test(l)) return 'windows-10';
  if (/windows\s*11\b/.test(l)) return 'windows-11';
  return null;
}

// "Windows 10 32 & 64bit, Windows 8.1 32bit, Windows XP" ->
//   [{ os: "windows-10", architectures: ["x86","x64"] }, { os: "windows-8-1", architectures: ["x86"] },
//    { os: "windows-xp", architectures: [] }]
// An OS entry without a stated bitness keeps an empty architecture list (unknown, not "all").
export function parseSupportedOs(text) {
  const out = [];
  for (const part of String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const os = osKeyFromLabel(part);
    if (!os) continue;
    const archs = [];
    if (/32\s*(&|and)\s*64|32\/64|32-bit\s*and\s*64-bit/i.test(part)) archs.push('x86', 'x64');
    else if (/\b32\s*-?\s*bit\b|\b32bit\b|\bx86\b/i.test(part)) archs.push('x86');
    else if (/\b64\s*-?\s*bit\b|\b64bit\b|\bx64\b|amd64/i.test(part)) archs.push('x64');
    const existing = out.find((e) => e.os === os);
    if (existing) existing.architectures = [...new Set([...existing.architectures, ...archs])];
    else out.push({ os, architectures: archs });
  }
  return out;
}

export function normalizeArchitecture(raw) {
  const a = String(raw ?? '').toLowerCase();
  if (['x64', 'amd64', 'x86_64'].includes(a)) return 'x64';
  if (['x86', 'i386', 'i686'].includes(a)) return 'x86';
  if (['arm64', 'aarch64'].includes(a)) return 'arm64';
  if (a === 'arm') return 'arm';
  if (a === 'neutral') return 'neutral';
  return null;
}

// Windows build numbers used to turn a declared MinimumOSVersion into a compatibility claim.
export const TARGET_BUILDS = { windows10: 19045, windows11: 26100 };

export function buildFromOsVersion(raw) {
  const m = String(raw ?? '').trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return null;
  const major = Number(m[1]); const minor = Number(m[2]); const build = Number(m[3] ?? 0);
  return { major, minor, build, raw: String(raw).trim() };
}

// Evidence-based compatibility from a set of declared minimum OS versions (null = not declared).
//   declared    : the package declares a minimum OS that the target meets (not a test result)
//   unsupported : every declared minimum is newer than the target
//   unknown     : no minimum OS is declared, so nothing can be claimed
export function compatibilityFromMinOs(minOsVersions) {
  const parsed = minOsVersions.map(buildFromOsVersion).filter(Boolean);
  const out = { windows10: 'unknown', windows11: 'unknown', min_os_version: null };
  if (!parsed.length) return out;
  const lowest = parsed.reduce((a, b) => (b.major * 1e9 + b.minor * 1e6 + b.build < a.major * 1e9 + a.minor * 1e6 + a.build ? b : a));
  out.min_os_version = lowest.raw;
  const meets = (target) => lowest.major < 10 || (lowest.major === 10 && lowest.minor === 0 && lowest.build <= target) || (lowest.major === 10 && lowest.minor > 0);
  out.windows10 = meets(TARGET_BUILDS.windows10) ? 'declared' : 'unsupported';
  out.windows11 = meets(TARGET_BUILDS.windows11) ? 'declared' : 'unsupported';
  return out;
}

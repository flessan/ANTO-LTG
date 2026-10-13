// URL and host safety checks shared by the crawler and the build validators.
import net from 'node:net';

const PRIVATE_V4 = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0a80000, 16],
  [0xc6120000, 15], [0xe0000000, 4], [0xf0000000, 4],
];

function v4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0);
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return ((n & mask) >>> 0) === ((base & mask) >>> 0);
    });
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique local
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

export function isPrivateHostname(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  if (net.isIP(h)) return isPrivateAddress(h);
  // Decimal / hex / octal IPv4 spellings such as http://2130706433/ or http://0x7f.1
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i.test(h)) return true;
  return false;
}

export function hostMatches(hostname, patterns) {
  const h = hostname.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
    return h === p;
  });
}

// Validates a URL that will be stored in a catalog or opened from the UI.
// Returns { ok, url?, reason? }.
export function checkPublicHttpsUrl(value, { allowHttp = false } = {}) {
  let url;
  try { url = new URL(String(value)); } catch { return { ok: false, reason: 'not a valid absolute URL' }; }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return { ok: false, reason: `protocol "${url.protocol}" is not allowed` };
  if (url.username || url.password) return { ok: false, reason: 'URL must not contain credentials' };
  if (isPrivateHostname(url.hostname)) return { ok: false, reason: 'host is private, local or an IP-literal spelling' };
  if (/[\u0000-\u001f\u007f]/.test(String(value))) return { ok: false, reason: 'URL contains control characters' };
  return { ok: true, url };
}

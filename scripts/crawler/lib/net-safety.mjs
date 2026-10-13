// URL and host safety checks shared by the crawler and the build validators.
import net from 'node:net';

// Address ranges that must never be contacted or stored as a public link. node:net's BlockList does the
// matching, which matters for IPv6: it checks an IPv4-mapped address against the IPv4 rules in both spellings
// ("::ffff:127.0.0.1" and the "::ffff:7f00:1" that the URL parser rewrites it to), so mapped loopback and private
// addresses are caught by the IPv4 list. DO NOT add ::ffff:0:0/96 below: BlockList maps every IPv4 address into
// that range when it checks IPv6 rules, so it would block the whole IPv4 internet (tests/crawler/net-safety.test.mjs).
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const BLOCKED_V6 = [
  ['::', 128], ['::1', 128],
  ['::', 96], // deprecated IPv4-compatible (not the same range as IPv4-mapped ::ffff:0:0/96)
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], // NAT64: embeds an IPv4 address that could be internal
  ['100::', 64], // discard-only
  ['2001::', 32], ['2002::', 16], // Teredo and 6to4 tunnels embed IPv4 addresses
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], // unique-local, link-local, site-local, multicast
];
const BLOCKED = new net.BlockList();
for (const [address, prefix] of BLOCKED_V4) BLOCKED.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of BLOCKED_V6) BLOCKED.addSubnet(address, prefix, 'ipv6');

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return BLOCKED.check(ip, 'ipv4');
  if (net.isIPv6(ip)) return BLOCKED.check(ip, 'ipv6');
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

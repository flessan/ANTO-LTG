// SSRF guard and URL validation shared by the crawler and the catalog validator.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, isPrivateHostname, hostMatches, checkPublicHttpsUrl } from '../../scripts/crawler/lib/net-safety.mjs';

describe('isPrivateAddress', () => {
  const PUBLIC = [
    '93.184.216.34', '8.8.8.8', '1.1.1.1', '140.82.112.5', '20.205.243.166', '151.101.1.69',
    // just outside the private ranges
    '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.1.1', '169.255.0.1', '198.17.255.255', '198.20.0.1', '11.0.0.1', '9.255.255.255', '126.255.255.255', '128.0.0.1',
    '2606:4700:4700::1111', '2a00:1450:4009:81f::200e', '2001:4860:4860::8888', '2620:fe::fe',
    // a PUBLIC IPv4 address in mapped notation is still public
    '::ffff:8.8.8.8', '::ffff:808:808',
  ];
  const PRIVATE = [
    '127.0.0.1', '127.255.255.254', '10.0.0.0', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '198.18.0.1', '198.19.255.255', '192.0.0.1', '192.0.2.1', '198.51.100.7', '203.0.113.9',
    '::1', '::', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456:789a::1', 'ff02::1', 'fec0::1',
    // IPv4-mapped IPv6: both spellings, because the URL parser rewrites the dotted one to hex
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:192.168.1.1', '::ffff:c0a8:101', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe',
    // transition mechanisms that embed an IPv4 address
    '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::', '2002:c0a8:101::1', '2001::1', '2001:db8::1', '100::1',
  ];
  for (const ip of PUBLIC) it(`public: ${ip}`, () => assert.equal(isPrivateAddress(ip), false));
  for (const ip of PRIVATE) it(`private: ${ip}`, () => assert.equal(isPrivateAddress(ip), true));

  it('REGRESSION: the IPv6 rules must not swallow the whole IPv4 internet (BlockList maps IPv4 into ::ffff:0:0/96)', () => {
    for (let a = 1; a < 224; a++) {
      if ([10, 100, 127, 169, 172, 192, 198, 203].includes(a)) continue;
      assert.equal(isPrivateAddress(`${a}.8.8.8`), false, `${a}.8.8.8 is an ordinary public address`);
    }
  });
  it('anything that is not an IP address is not classified here (hostnames are handled separately)', () => {
    for (const v of ['example.com', '', 'localhost', '999.1.1.1', '1.2.3', 'abc::zzz']) assert.equal(isPrivateAddress(v), false, v);
  });
});

describe('isPrivateHostname', () => {
  it('blocks local names, reserved suffixes and every IP spelling the URL parser understands', () => {
    const hosts = ['localhost', 'LOCALHOST', 'app.localhost', 'printer.local', 'db.internal', 'nas.lan', 'router.home.arpa', 'localhost.', '127.0.0.1', '10.1.1.1', '[::1]', '::1', '[fe80::1]', '[::ffff:7f00:1]', '2130706433', '0x7f000001', '0x7f.1', '017700000001', '127.1', '', '.'];
    for (const h of hosts) assert.equal(isPrivateHostname(h), true, JSON.stringify(h));
  });
  it('allows ordinary public names and addresses', () => {
    for (const h of ['example.com', 'api.github.com', 'learn.microsoft.com', 'www.intel.com', 'downloadmirror.intel.com', '8.8.8.8', '[2606:4700:4700::1111]', 'localhost.example.com', 'notlocalhost.com', 'internal.example.com']) assert.equal(isPrivateHostname(h), false, h);
  });
  it('agrees with what the WHATWG URL parser produces for disguised hosts', () => {
    for (const raw of ['https://127.1/', 'https://0x7f.0.0.1/', 'https://2130706433/', 'https://017700000001/', 'https://[::ffff:127.0.0.1]/', 'https://\uff11\uff12\uff17.0.0.1/', 'https://127.0.0.1./']) {
      assert.equal(isPrivateHostname(new URL(raw).hostname), true, `${raw} -> ${new URL(raw).hostname}`);
    }
  });
});

describe('hostMatches', () => {
  it('matches exact names and *.domain wildcards (which include the bare domain), case-insensitively', () => {
    assert.equal(hostMatches('API.GitHub.com', ['api.github.com']), true);
    assert.equal(hostMatches('www.intel.com', ['*.intel.com']), true);
    assert.equal(hostMatches('intel.com', ['*.intel.com']), true);
    assert.equal(hostMatches('a.b.intel.com', ['*.intel.com']), true);
  });
  it('does not match look-alikes, suffix tricks or parents', () => {
    for (const h of ['notintel.com', 'intel.com.evil.example', 'evilintel.com', 'intel.co', 'com']) assert.equal(hostMatches(h, ['*.intel.com']), false, h);
    assert.equal(hostMatches('www.intel.com', ['intel.com']), false, 'a plain entry means exactly that host');
    assert.equal(hostMatches('example.com', []), false);
  });
});

describe('checkPublicHttpsUrl', () => {
  const ok = (u, o) => assert.equal(checkPublicHttpsUrl(u, o).ok, true, u);
  const bad = (u, re, o) => { const r = checkPublicHttpsUrl(u, o); assert.equal(r.ok, false, u); assert.match(r.reason, re, u); };
  it('accepts normal public https URLs', () => {
    for (const u of ['https://www.intel.com/content/www/us/en/download-center/home.html', 'https://github.com/microsoft/winget-pkgs/tree/master/manifests/g/Git/Git/2.55.0', 'https://learn.microsoft.com/sysinternals/downloads/sysinternals-suite', 'https://example.com:8443/a?b=c#d']) ok(u);
  });
  it('rejects other schemes, credentials, private hosts and control characters', () => {
    bad('http://example.com/', /protocol "http:"/);
    bad('javascript:alert(1)', /protocol/);
    bad('data:text/html,hi', /protocol/);
    bad('file:///etc/passwd', /protocol/);
    bad('ftp://example.com/', /protocol/);
    bad('https://user:pw@example.com/', /credentials/);
    bad('https://localhost/', /private/);
    bad('https://[::ffff:7f00:1]/', /private/);
    bad('https://2130706433/', /private/);
    bad('not a url', /valid absolute URL/);
    bad('', /valid absolute URL/);
    bad('https://example.com/\u0001', /control/);
  });
  it('can allow http for tests that need it', () => { ok('http://example.com/', { allowHttp: true }); bad('http://localhost/', /private/, { allowHttp: true }); });
  it('returns the parsed URL', () => assert.equal(checkPublicHttpsUrl('https://Example.com/A').url.href, 'https://example.com/A'));
});

// robots.txt parser and matcher (RFC 9309 semantics).
//
//  * Groups are selected by the longest matching product token in a User-agent line
//    (case-insensitive), falling back to "*".
//  * Allow / Disallow rules support "*" wildcards and the "$" end anchor. The rule with the
//    longest pattern wins; on a tie, Allow wins.
//  * Crawl-delay is not part of RFC 9309 but is honoured when present.
//  * 2xx => parse; 4xx => no restrictions; 5xx / network error => treat as "disallow all"
//    (the safe choice when the policy cannot be read).

export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap') {
      sitemaps.push(value);
    } else if (current && (field === 'allow' || field === 'disallow')) {
      current.rules.push({ type: field, pattern: value });
    } else if (current && field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return { groups, sitemaps };
}

function normalizePath(p) {
  // Normalise percent-encoding so "%7e" and "~" compare equal, and upper-case escapes.
  return p.replace(/%[0-9a-fA-F]{2}/g, (m) => {
    const ch = String.fromCharCode(parseInt(m.slice(1), 16));
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : m.toUpperCase();
  });
}

function patternToRegExp(pattern) {
  let anchored = false;
  let p = pattern;
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
  const source = p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + source + (anchored ? '$' : ''));
}

export function selectGroup(parsed, productToken) {
  const token = productToken.toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const group of parsed.groups) {
    for (const agent of group.agents) {
      if (agent === '*') {
        if (bestLen < 0 && !best) { best = group; bestLen = 0; }
      } else if (token.includes(agent) || agent.includes(token)) {
        if (agent.length > bestLen) { best = group; bestLen = agent.length; }
      }
    }
  }
  return best;
}

export function isAllowed(parsed, productToken, pathAndQuery) {
  const group = selectGroup(parsed, productToken);
  if (!group) return { allowed: true, rule: null, crawlDelay: null };
  const target = normalizePath(pathAndQuery || '/');
  let winner = null;
  for (const rule of group.rules) {
    if (rule.pattern === '') continue; // "Disallow:" with no value allows everything
    const re = patternToRegExp(normalizePath(rule.pattern));
    if (!re.test(target)) continue;
    const len = rule.pattern.length;
    if (!winner || len > winner.len || (len === winner.len && rule.type === 'allow' && winner.type !== 'allow')) {
      winner = { ...rule, len };
    }
  }
  return {
    allowed: !winner || winner.type === 'allow',
    rule: winner ? `${winner.type}: ${winner.pattern}` : null,
    crawlDelay: group.crawlDelay,
  };
}

// Fetches and caches robots.txt per origin through the supplied HTTP client.
export class RobotsChecker {
  constructor({ client, productToken, ttlMs = 3600_000, now = () => Date.now() }) {
    this.client = client;
    this.productToken = productToken;
    this.ttlMs = ttlMs;
    this.now = now;
    this.cache = new Map();
  }

  async policyFor(origin) {
    const hit = this.cache.get(origin);
    if (hit && this.now() - hit.at < this.ttlMs) return hit;
    let entry;
    try {
      const res = await this.client.fetch(`${origin}/robots.txt`, { robots: false, accept: 'text/plain,*/*;q=0.1', maxBytes: 512 * 1024 });
      if (res.status >= 200 && res.status < 300) {
        entry = { kind: 'parsed', parsed: parseRobots(res.text()), status: res.status };
      } else if (res.status >= 400 && res.status < 500) {
        entry = { kind: 'none', status: res.status };
      } else {
        entry = { kind: 'unreachable', status: res.status };
      }
    } catch (err) {
      entry = { kind: 'unreachable', error: String(err.message || err) };
    }
    entry.at = this.now();
    this.cache.set(origin, entry);
    return entry;
  }

  async check(urlString) {
    const url = new URL(urlString);
    const policy = await this.policyFor(url.origin);
    if (policy.kind === 'none') return { allowed: true, reason: `robots.txt not found (HTTP ${policy.status})`, crawlDelay: null };
    if (policy.kind === 'unreachable') {
      return { allowed: false, reason: `robots.txt unreachable (${policy.status ?? policy.error}); treated as disallow-all`, crawlDelay: null };
    }
    const verdict = isAllowed(policy.parsed, this.productToken, url.pathname + url.search);
    return {
      allowed: verdict.allowed,
      reason: verdict.rule ? `matched robots.txt rule "${verdict.rule}"` : 'no matching robots.txt rule',
      crawlDelay: verdict.crawlDelay,
    };
  }
}

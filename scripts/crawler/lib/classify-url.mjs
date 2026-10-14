// Decides what a URL actually is. A "download" link in a catalog is only trusted as a direct
// binary when the evidence supports it; everything else is labelled honestly.
//
//   direct_binary    - serves an installer/archive/ISO (by file extension, known release-asset host,
//                      or - after a probe - by content type / Content-Disposition)
//   redirect         - a redirector such as aka.ms/... that forwards somewhere else
//   landing_page     - an HTML page (download page, product page, support portal)
//   download_form    - a page that gates the file behind a form, login, captcha or serial number
//   signed_temporary - a time-limited / signed URL that must not be stored as a permanent link
//   unknown          - not enough evidence
//
// `stability`: versioned (file name or tag pins a version), evergreen ("latest" alias),
// ephemeral (signed/session bound) or unknown.

const BINARY_EXT = /\.(exe|msi|msix|msixbundle|appx|appxbundle|msp|msu|cab|zip|7z|rar|iso|img|bin|dmg|pkg|deb|rpm|appimage|tar\.gz|tgz|tar\.xz|jar)$/i;
const REDIRECTOR_HOSTS = new Set(['aka.ms', 'go.microsoft.com', 'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'download.mozilla.org']);
const SIGNED_PARAMS = /^(x-amz-signature|x-amz-credential|x-amz-security-token|signature|sig|se|sv|sp|sr|token|expires|hdnts|__token__|googleaccessid|x-goog-signature|policy|key-pair-id|st|exp|hmac|auth|access_token)$/i;
const BINARY_TYPES = /^(application\/(octet-stream|x-msdownload|x-msi|x-ms-installer|vnd\.microsoft\.portable-executable|zip|x-zip-compressed|x-7z-compressed|x-rar-compressed|vnd\.rar|x-iso9660-image|x-apple-diskimage|vnd\.ms-cab-compressed|x-bittorrent|x-msdos-program|java-archive|gzip|x-gzip|x-tar|x-xz)|binary\/octet-stream)/i;

export function classifyUrl(raw) {
  const reasons = [];
  let url;
  try { url = new URL(raw); } catch { return { kind: 'unknown', stability: 'unknown', confidence: 'none', reasons: ['not a valid URL'] }; }
  if (url.protocol !== 'https:') reasons.push(`protocol ${url.protocol} (not HTTPS)`);

  const signed = [...url.searchParams.keys()].some((k) => SIGNED_PARAMS.test(k));
  if (signed) {
    return { kind: 'signed_temporary', stability: 'ephemeral', confidence: 'url_pattern', reasons: [...reasons, 'query string carries a signature/expiry/token parameter'] };
  }

  const host = url.hostname.toLowerCase();
  const path = decodeURIComponent(url.pathname);
  const base = path.split('/').pop() ?? '';

  if (host === 'github.com') {
    if (/^\/[^/]+\/[^/]+\/releases\/download\//.test(path)) {
      return { kind: 'direct_binary', stability: 'versioned', confidence: 'url_pattern', reasons: [...reasons, 'GitHub release asset path (pinned to a tag)'] };
    }
    if (/^\/[^/]+\/[^/]+\/releases\/latest\/download\//.test(path)) {
      return { kind: 'direct_binary', stability: 'evergreen', confidence: 'url_pattern', reasons: [...reasons, 'GitHub "latest" release asset alias'] };
    }
    if (/^\/[^/]+\/[^/]+\/releases(\/latest|\/tag\/.+)?\/?$/.test(path)) {
      return { kind: 'landing_page', stability: 'unknown', confidence: 'url_pattern', reasons: [...reasons, 'GitHub releases page'] };
    }
  }
  if (REDIRECTOR_HOSTS.has(host) || (host.endsWith('microsoft.com') && /\/fwlink\/?$/i.test(path))) {
    return { kind: 'redirect', stability: 'evergreen', confidence: 'url_pattern', reasons: [...reasons, `redirector host ${host}`] };
  }
  if (BINARY_EXT.test(base)) {
    const pinned = /\d/.test(base);
    return { kind: 'direct_binary', stability: pinned ? 'versioned' : 'evergreen', confidence: 'url_pattern', reasons: [...reasons, `file extension of "${base}"`] };
  }
  if (/\/(download|downloads|get|latest)\/?$/i.test(path) || path === '/' || path === '') {
    return { kind: 'landing_page', stability: 'unknown', confidence: 'url_pattern', reasons: [...reasons, 'path looks like a download or home page'] };
  }
  if (/\.(html?|aspx?|php|jsp)$/i.test(base)) {
    return { kind: 'landing_page', stability: 'unknown', confidence: 'url_pattern', reasons: [...reasons, 'page file extension'] };
  }
  return { kind: 'unknown', stability: 'unknown', confidence: 'none', reasons: [...reasons, 'no file extension and no known pattern'] };
}

// Refines a URL-pattern classification with what a header-only probe returned.
// `probe` is the object from http.probe().
export function refineWithProbe(base, probe) {
  const reasons = [...base.reasons];
  const result = { ...base, confidence: 'http_probe', http_status: probe.status, content_type: probe.contentType, final_url: probe.finalUrl };
  if (probe.redirectBlocked) {
    return { ...result, kind: 'redirect', reasons: [...reasons, `redirects to ${probe.redirectBlocked.location}, which the crawler does not follow (${probe.redirectBlocked.code ?? 'blocked'})`] };
  }
  if (probe.redirects?.length) reasons.push(`${probe.redirects.length} redirect hop(s) followed`);
  if (probe.status >= 400) return { ...result, kind: 'unknown', reasons: [...reasons, `HTTP ${probe.status}`], broken: true };
  const type = probe.contentType ?? '';
  const disposition = probe.contentDisposition ?? '';
  if (/attachment/i.test(disposition) || BINARY_TYPES.test(type) || probe.binary) {
    const finalSigned = (() => { try { return [...new URL(probe.finalUrl).searchParams.keys()].some((k) => SIGNED_PARAMS.test(k)); } catch { return false; } })();
    return {
      ...result,
      kind: finalSigned && base.kind !== 'direct_binary' ? 'signed_temporary' : 'direct_binary',
      stability: finalSigned ? 'ephemeral' : base.stability,
      reasons: [...reasons, `server responded with ${type || 'a binary type'}${disposition ? ' and Content-Disposition attachment' : ''}`],
      size_bytes: probe.contentLength,
    };
  }
  if (/text\/html|application\/xhtml/i.test(type)) {
    return { ...result, kind: 'landing_page', stability: 'unknown', reasons: [...reasons, 'server responded with an HTML page, not a file'] };
  }
  return { ...result, reasons: [...reasons, `unclassified content type ${type || '(none)'}`] };
}

export function classifyHtmlPage(html) {
  // A landing page that hides the file behind a form / login / captcha is a download_form.
  const text = String(html).slice(0, 200_000).toLowerCase();
  const gates = [];
  if (/verification code|captcha|recaptcha|hcaptcha|i am not a robot|cf-turnstile/.test(text)) gates.push('captcha or verification code');
  if (/<input[^>]+type=["']?password/.test(text) || /sign in to download|log in to download|login required/.test(text)) gates.push('login');
  if (/serial number|service tag|enter your (product|model)/.test(text)) gates.push('serial number or product lookup');
  if (/<form[^>]*>[\s\S]{0,1500}type=["']?email/.test(text)) gates.push('email form');
  return gates.length ? { kind: 'download_form', gates } : { kind: 'landing_page', gates: [] };
}

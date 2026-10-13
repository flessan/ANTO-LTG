// Support page: donation and Discord destinations. Only real https URLs are used. While a destination is null,
// its button stays disabled and the page says the link is not published yet, instead of linking nowhere.
// The maintainers set the two values below when the destinations exist. Nothing else on the site depends on them.
export const SUPPORT_LINKS = Object.freeze({ donate: null, discord: null });

const HTTPS_URL = /^https:\/\/[^\s"'<>]+$/;

export function usableUrl(value) {
  return typeof value === 'string' && HTTPS_URL.test(value) ? value : null;
}

function wire(kind, links = SUPPORT_LINKS) {
  const button = document.querySelector(`[data-support="${kind}"]`);
  const pending = document.querySelector(`[data-support-pending="${kind}"]`);
  if (!button) return;
  const url = usableUrl(links[kind]);
  button.disabled = !url;
  if (pending) pending.hidden = Boolean(url);
  if (url) button.addEventListener('click', () => window.open(url, '_blank', 'noopener,noreferrer'));
}

export function initSupport(links = SUPPORT_LINKS) {
  wire('donate', links);
  wire('discord', links);
}

if (typeof document !== 'undefined' && document.body?.dataset.page === 'support') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initSupport());
  else initSupport();
}

// Support page: donation, sponsorship and community destinations. Only real https URLs are used. A destination
// whose value is null stays disabled and the page says it is not published yet, instead of linking nowhere.
export const SUPPORT_LINKS = Object.freeze({
  donate: 'https://sociabuzz.com/flessan/tribe',
  sponsors: 'https://github.com/sponsors/flessan',
  discord: null,
});

const HTTPS_URL = /^https:\/\/[^\s"'<>]+$/;

export function usableUrl(value) {
  return typeof value === 'string' && HTTPS_URL.test(value) ? value : null;
}

// Decorative bubbles rising behind a card. Positions are fixed so the layout is the same on every visit.
const BUBBLES = [[8, 22, 30, -6, 0.35], [24, 12, 24, -14, 0.3], [42, 30, 36, -20, 0.25], [62, 16, 28, -3, 0.3], [80, 26, 34, -11, 0.28], [93, 12, 22, -17, 0.32]];
function addBubbles(card) {
  if (card.querySelector('.bubble-field')) return;
  const field = document.createElement('div');
  field.className = 'bubble-field';
  field.setAttribute('aria-hidden', 'true');
  for (const [x, size, rise, delay, opacity] of BUBBLES) {
    const b = document.createElement('span');
    b.className = 'bubble';
    b.style.setProperty('--x', `${x}%`);
    b.style.setProperty('--s', `${size}px`);
    b.style.setProperty('--rise', `${rise}s`);
    b.style.setProperty('--delay', `${delay}s`);
    b.style.setProperty('--o', String(opacity));
    field.append(b);
  }
  card.prepend(field);
}

function wire(kind, links = SUPPORT_LINKS) {
  const button = document.querySelector(`[data-support="${kind}"]`);
  if (!button) return;
  const url = usableUrl(links[kind]);
  const pending = document.querySelector(`[data-support-pending="${kind}"]`);
  button.disabled = !url;
  if (pending) pending.hidden = Boolean(url);
  if (url) button.addEventListener('click', () => window.open(url, '_blank', 'noopener,noreferrer'));
}

export function initSupport(links = SUPPORT_LINKS) {
  for (const card of document.querySelectorAll('.support-donate, .support-sponsors')) addBubbles(card);
  wire('donate', links);
  wire('sponsors', links);
  wire('discord', links);
}

if (typeof document !== 'undefined' && document.body?.dataset.page === 'support') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initSupport());
  else initSupport();
}

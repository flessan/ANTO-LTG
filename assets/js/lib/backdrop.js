// The desktop backdrop: four licensed local photographs that cross-fade every five seconds, and a few faint
// bubbles that drift upward. Everything here is decorative (aria-hidden, no text). Reduced motion keeps one still
// photograph and no bubbles; a hidden tab pauses the cycle. Photos are the local banners in assets/img/.
const SLIDES = ['sky-meadow-horizon', 'leaf-droplets-banner', 'ocean-aerial-banner', 'forest-canopy-banner'];
const WIDTHS = [640, 1280, 1920];
const CYCLE_MS = 9000; // long enough to read the slow zoom; the zoom itself runs in CSS
const BUBBLES = [
  // [left %, diameter px, rise seconds, delay seconds (negative = already part-way up), opacity]
  [6, 44, 46, -4, 0.34], [17, 18, 38, -20, 0.3], [28, 30, 52, -11, 0.26], [41, 64, 60, -30, 0.2],
  [55, 22, 41, -8, 0.32], [66, 36, 49, -25, 0.24], [79, 52, 57, -15, 0.2], [91, 16, 36, -2, 0.34],
];

function slideEl(base, index) {
  const figure = document.createElement('div');
  // Each photograph drifts slowly in or out (alternating), so the backdrop is never a still image.
  figure.className = `wall-slide ${index % 2 ? 'zoom-out' : 'zoom-in'}`;
  figure.setAttribute('aria-hidden', 'true');
  const picture = document.createElement('picture');
  const srcset = (ext) => WIDTHS.map((w) => `${new URL(`../../img/${base}-${w}.${ext}`, import.meta.url).pathname} ${w}w`).join(', ');
  const webp = document.createElement('source');
  webp.type = 'image/webp'; webp.srcset = srcset('webp'); webp.sizes = '100vw';
  const img = document.createElement('img');
  img.src = new URL(`../../img/${base}-1280.jpg`, import.meta.url).pathname;
  img.srcset = srcset('jpg'); img.sizes = '100vw';
  img.alt = '';
  img.decoding = 'async';
  img.loading = index === 0 ? 'eager' : 'lazy';
  picture.append(webp, img);
  figure.append(picture);
  return figure;
}

function bubbleLayer() {
  const layer = document.createElement('div');
  layer.className = 'bubble-layer';
  for (const [x, size, rise, delay, opacity] of BUBBLES) {
    const b = document.createElement('span');
    b.className = 'bubble';
    b.style.setProperty('--x', `${x}%`);
    b.style.setProperty('--s', `${size}px`);
    b.style.setProperty('--rise', `${rise}s`);
    b.style.setProperty('--delay', `${delay}s`);
    b.style.setProperty('--o', String(opacity));
    layer.append(b);
  }
  return layer;
}

export function initBackdrop() {
  const root = document.querySelector('.desktop-wallpaper');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = 'true';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const slides = SLIDES.map((base, i) => slideEl(base, i));
  slides[0].classList.add('is-on');
  root.append(...slides);
  if (reduce.matches) return; // one still photograph, no bubbles, no cycling
  root.append(bubbleLayer());

  let current = 0;
  const step = () => {
    if (document.hidden) return; // a hidden tab does not need to cycle
    slides[current].classList.remove('is-on');
    current = (current + 1) % slides.length;
    slides[current].classList.add('is-on');
  };
  setInterval(step, CYCLE_MS);
}

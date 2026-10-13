// Legibility comes before glass effects: this measures WCAG contrast on the colours actually written in
// assets/css/aero.css (not on hard-coded copies), including the text band of the glossy button gradients.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readText } from '../helpers/repo.mjs';

const css = await readText('assets', 'css', 'aero.css');
const pagesCss = await readText('assets', 'css', 'pages.css');

// ---- colour maths (WCAG 2.x relative luminance) ---------------------------------------------------
const hex = (h) => { let x = h.replace('#', ''); if (x.length === 3) x = [...x].map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); };
const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// ---- tiny CSS reading helpers ---------------------------------------------------------------------
const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
const vars = Object.fromEntries([...rootBlock.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const color = (value) => {
  const v = String(value).trim();
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/);
  if (ref) { assert.ok(vars[ref[1]], `undefined variable ${ref[1]}`); return color(vars[ref[1]]); }
  assert.match(v, /^#[0-9a-f]{3}([0-9a-f]{3})?$/i, `expected a plain hex colour, got "${v}"`);
  return hex(v);
};
const rules = (source) => [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim().replace(/^@media[^)]*\)\s*/, '')), body: m[2] }));
const prop = (body, name) => body.match(new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+)`))?.[1].trim();
const ruleFor = (source, selector) => rules(source).filter((r) => r.selectors.includes(selector));

function gradientStops(text) {
  const raw = [...text.matchAll(/(#[0-9a-f]{3,6})(?:\s+([\d.]+)%)?/gi)];
  return raw.map((m, i) => ({ c: hex(m[1]), p: m[2] !== undefined ? Number(m[2]) : (i / (raw.length - 1)) * 100 }));
}
const colourAt = (stops, p) => {
  for (let i = 1; i < stops.length; i++) if (p <= stops[i].p) { const a = stops[i - 1]; const b = stops[i]; const t = (p - a.p) / (b.p - a.p || 1); return a.c.map((v, k) => v + (b.c[k] - v) * t); }
  return stops.at(-1).c;
};
/** Worst contrast of `ink` against a vertical gradient over the band where button text is drawn (28%-75% of the height). */
const worstOverBand = (stops, ink, from = 28, to = 75) => { let worst = Infinity; for (let p = from; p <= to; p++) worst = Math.min(worst, ratio(colourAt(stops, p), ink)); return worst; };

const AA = 4.5;
const AAA = 7;

describe('body text on the light surfaces', () => {
  const pairs = [
    ['--ink', '--paper', AAA], ['--ink', '--paper-2', AAA], ['--ink', '--paper-3', AAA], ['--ink-soft', '--paper', AAA], ['--ink-soft', '--paper-2', AA], ['--ink-soft', '--paper-3', AA],
    ['--ink-muted', '--paper', AA], ['--ink-muted', '--paper-2', AA], ['--ink-muted', '--paper-3', AA], ['--sky-900', '--paper', AAA], ['--sky-800', '--paper-2', AAA],
    ['--w7-link-c', '--paper', AA], ['--w7-link-c', '--paper-2', AA], ['--w7-link-c', '--paper-3', AA], ['--w7-title-c', '--paper', AAA],
    ['--warn-ink', '--warn-bg', AAA], ['--danger', '--danger-bg', AA], ['--ok-ink', '--ok-bg', AAA],
  ];
  for (const [fg, bg, min] of pairs) {
    it(`${fg} on ${bg} is at least ${min}:1`, () => {
      const r = ratio(color(`var(${fg})`), color(`var(${bg})`));
      assert.ok(r >= min, `${fg} on ${bg}: ${r.toFixed(2)}:1`);
    });
  }
  it('white is also fine as a background for ink and links', () => {
    for (const fg of ['--ink', '--ink-soft', '--ink-muted', '--w7-link-c', '--sky-900', '--danger']) assert.ok(ratio(color(`var(${fg})`), [255, 255, 255]) >= AA, fg);
  });
});

describe('glossy buttons keep their text legible across the whole text band', () => {
  const variants = [
    ['.btn-aero', null], ['.btn-aero.green', null], ['.btn-aero.danger', null], ['.btn-aero.ghost', null],
  ];
  const base = ruleFor(css, '.btn-aero')[0].body;
  for (const [selector] of variants) {
    it(`${selector}: text is at least ${AA}:1 from 28% to 75% of the button height`, () => {
      const body = ruleFor(css, selector).find((r) => prop(r.body, '--btn-bg'))?.body ?? base;
      const stops = gradientStops(prop(body, '--btn-bg'));
      assert.ok(stops.length >= 3, 'parsed the gradient stops');
      const inkText = prop(body, '--btn-ink') ?? prop(base, '--btn-ink');
      const worst = worstOverBand(stops, color(inkText));
      assert.ok(worst >= AA, `${selector}: worst case ${worst.toFixed(2)}:1`);
    });
  }
  it('hover does not brighten the button (that would erode the contrast); it adds a glow instead', () => {
    const hover = ruleFor(css, '.btn-aero:hover')[0].body;
    const filter = prop(hover, 'filter') ?? '';
    const brightness = Number(filter.match(/brightness\(([\d.]+)\)/)?.[1] ?? 1);
    assert.ok(brightness <= 1, `hover filter: ${filter}`);
    assert.match(hover, /box-shadow/);
  });
  it('disabled buttons stay readable', () => {
    const disabled = ruleFor(css, 'button.btn-aero:disabled')[0].body;
    assert.ok(ratio(color(prop(disabled, 'color')), color(prop(disabled, 'background-color'))) >= AA);
  });
  it('the pressed "chip button" and the skip link are readable', () => {
    const pressed = ruleFor(css, '.chip-btn[aria-pressed="true"]')[0].body;
    assert.ok(ratio(color(prop(pressed, 'color')), color(prop(pressed, 'background'))) >= AAA);
    const skip = ruleFor(css, '.skip-link')[0].body;
    assert.ok(ratio(color(prop(skip, 'color')), color(prop(skip, 'background'))) >= AAA);
  });
});

describe('status chips and notices', () => {
  const chipRules = rules(css).filter((r) => r.selectors.some((s) => /^\.chip\.[a-z]+$/.test(s)) && prop(r.body, 'background') && prop(r.body, 'color'));
  it('finds the chip variants in the stylesheet', () => assert.ok(chipRules.length >= 10, `only ${chipRules.length} chip variants parsed`));
  for (const r of chipRules) {
    const name = r.selectors.find((s) => /^\.chip\.[a-z]+$/.test(s));
    it(`${name} text is at least ${AA}:1 on its background`, () => {
      const rr = ratio(color(prop(r.body, 'color')), color(prop(r.body, 'background')));
      assert.ok(rr >= AA, `${name}: ${rr.toFixed(2)}:1`);
    });
  }
  for (const name of ['.notice.warn', '.notice.error', '.notice.ok']) {
    it(`${name} text is readable on its background`, () => {
      const body = ruleFor(css, name)[0].body;
      assert.ok(ratio(color(prop(body, 'color')), color(prop(body, 'background'))) >= AAA, name);
    });
  }
  it('the default chip and notice use ink on a pale surface', () => {
    for (const sel of ['.chip', '.notice']) {
      const body = ruleFor(css, sel)[0].body;
      const fg = prop(body, 'color') ?? 'var(--ink)';
      assert.ok(ratio(color(fg), color(prop(body, 'background'))) >= AAA, sel);
    }
  });
});

describe('code blocks, focus and print', () => {
  it('code samples have strong contrast', () => {
    const pre = ruleFor(css, 'pre').find((r) => prop(r.body, 'background')).body;
    assert.ok(ratio(color(prop(pre, 'color')), color(prop(pre, 'background'))) >= AAA);
  });
  it('the focus ring contrasts with the surfaces it sits on (3:1 for non-text)', () => {
    for (const bg of ['--paper', '--paper-2', '--paper-3']) assert.ok(ratio(color('var(--focus-ring)'), color(`var(${bg})`)) >= 3, bg);
    assert.match(css, /:focus-visible/);
    assert.match(css, /outline[^;]*var\(--focus-ring\)/);
  });
  it('honours the user preferences for motion, transparency, contrast and forced colors', () => {
    for (const q of ['prefers-reduced-motion: reduce', 'prefers-reduced-transparency: reduce', 'prefers-contrast: more', 'forced-colors: active']) assert.ok(css.includes(`@media (${q})`), q);
  });
  it('the page stylesheet does not introduce inline-only tricks the CSP would block', () => {
    assert.doesNotMatch(css + pagesCss, /@import\s+url\(\s*['"]?https?:/i, 'no remote @import');
    assert.doesNotMatch(css + pagesCss, /url\(\s*['"]?https?:/i, 'no remote url() in CSS');
  });
});

describe('palette: restrained blue, white, cyan/turquoise and natural green', () => {
  const hue = ([r, g, b]) => {
    const [x, y, z] = [r / 255, g / 255, b / 255];
    const max = Math.max(x, y, z); const min = Math.min(x, y, z); const d = max - min;
    if (d === 0) return { h: null, s: 0, l: (max + min) / 2 };
    const h = max === x ? ((y - z) / d) % 6 : max === y ? (z - x) / d + 2 : (x - y) / d + 4;
    return { h: (h * 60 + 360) % 360, s: d / (1 - Math.abs(max + min - 1)), l: (max + min) / 2 };
  };
  it('no named brand colour (sky, aqua, teal, leaf, ink, paper) is purple, magenta or pink', () => {
    for (const [name, value] of Object.entries(vars).filter(([n]) => /^--(sky|aqua|teal|leaf|ink|paper)/.test(n))) {
      const { h, s } = hue(color(value));
      if (h === null || s < 0.12) continue; // greys and near-whites carry no hue
      assert.ok(h >= 90 && h <= 235, `${name} ${value} has hue ${Math.round(h)} (expected green..blue: 90-235)`);
    }
  });
  it('every hex colour in the stylesheets avoids the purple/magenta band when it is saturated', () => {
    const offenders = [];
    for (const m of (css + pagesCss).matchAll(/#[0-9a-f]{6}\b/gi)) {
      const { h, s, l } = hue(hex(m[0]));
      if (h !== null && s > 0.25 && l > 0.08 && l < 0.95 && h >= 255 && h <= 345) offenders.push(`${m[0]} (hue ${Math.round(h)})`);
    }
    assert.deepEqual([...new Set(offenders)], []);
  });
  it('no neon: the generated app icon tiles keep to hues 150-215 with moderate saturation', async () => {
    const { iconHue } = await import('../../assets/js/lib/apps-filter.js');
    for (let i = 0; i < 500; i++) { const h = iconHue(`app-${i}`); assert.ok(h >= 150 && h <= 215, String(h)); }
  });
});

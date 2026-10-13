// Renders assets/CREDITS.md from assets/manifest.json (kept separate so the validator can
// verify that the committed file is up to date without needing `sharp`).
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderCredits(manifest) {
  const photos = manifest.assets.filter((a) => a.kind === 'photo');
  const icons = manifest.assets.filter((a) => a.kind !== 'photo');
  const lines = [
    '# Image and icon credits',
    '',
    'This file is generated from [`manifest.json`](manifest.json); do not edit it by hand.',
    '',
    '- **Photographs** are third-party works used under their own licenses (Unsplash License). They are **not**',
    '  covered by the MIT license that applies to this project\'s original code, and this project does not relicense them.',
    '- **Brand marks** are trademarks of their owners. They identify the company or product they depict; they are not',
    '  endorsements. Only the exact product or company is shown. See [LICENSING.md](../LICENSING.md).',
    '- **Interface glyphs and project glyphs** are open-licensed icon sets (Lucide, ISC) or original glyphs of this project (MIT).',
    '',
    `Totals: ${photos.length} photographs, ${icons.length} icon and logo assets.`,
    '',
    '## Photographs',
    '',
  ];
  for (const a of photos) {
    lines.push(`### ${a.title}`, '');
    lines.push(`- **Author:** [${a.author}](${a.author_url})`);
    lines.push(`- **Source page:** <${a.source_url}>`);
    lines.push(`- **License:** [${a.license}](${a.license_url})`);
    lines.push(`- **Retrieved:** ${a.retrieved_at} (published ${a.published_at})`);
    lines.push(`- **Used in:** ${(a.used_in ?? []).join('; ')}`);
    lines.push(`- **Modifications:** ${a.modifications}`);
    lines.push(`- **Local files:** ${(a.files ?? []).map((f) => `\`${f.path.replace('assets/', '')}\``).join(', ') || '_not built yet_'}`);
    lines.push(`- **Alt text used on the site:** ${a.alt}`);
    lines.push('');
  }
  const groups = [
    ['brand-mark', 'Brand marks (software, vendors)'],
    ['glyph', 'Category, component and bundle glyphs'],
    ['ui-glyph', 'Interface glyphs (navigation, actions, status)'],
    ['project-glyph', 'Project glyphs (original, MIT)'],
  ];
  for (const [kind, heading] of groups) {
    const rows = icons.filter((a) => a.kind === kind);
    if (!rows.length) continue;
    lines.push(`## ${heading}`, '');
    lines.push('| Asset | Local file | Owner | License | Source | Retrieved |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const a of rows) {
      const file = (a.files ?? []).map((f) => `\`${f.path.replace('assets/', '')}\``).join(', ');
      lines.push(`| ${esc(a.title)} | ${file} | ${esc(a.owner)} | [${esc(a.license)}](${a.license_url}) | <${a.source_url}> | ${a.retrieved_at} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

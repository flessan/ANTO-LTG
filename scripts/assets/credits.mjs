// Renders assets/CREDITS.md from assets/manifest.json (kept separate so the build can
// verify that the committed file is up to date without needing `sharp`).
export function renderCredits(manifest) {
  const lines = [
    '# Image credits',
    '',
    'All photographs below are third-party works used under their own licenses. They are **not**',
    'covered by the MIT license that applies to this project\'s original code, and this project does',
    'not relicense them. This file is generated from [`manifest.json`](manifest.json); do not edit it by hand.',
    '',
  ];
  for (const a of manifest.assets) {
    lines.push(`## ${a.title}`, '');
    lines.push(`- **Author:** [${a.author}](${a.author_url})`);
    lines.push(`- **Source page:** <${a.source_url}>`);
    lines.push(`- **License:** [${a.license}](${a.license_url})`);
    lines.push(`- **Retrieved:** ${a.retrieved_at} (published ${a.published_at})`);
    lines.push(`- **Used in:** ${a.used_in.join('; ')}`);
    lines.push(`- **Modifications:** ${a.modifications}`);
    lines.push(`- **Local files:** ${(a.files ?? []).map((f) => `\`${f.path.replace('assets/', '')}\``).join(', ') || '_not built yet_'}`);
    lines.push(`- **Alt text used on the site:** ${a.alt}`);
    lines.push('');
  }
  return lines.join('\n');
}

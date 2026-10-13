// Builds the human- and machine-readable crawl report.
export function buildReport({ startedAt, finishedAt, args, adapters }) {
  return {
    schema: 'anto-ltg.crawl-report/1',
    started_at: startedAt,
    finished_at: finishedAt,
    duration_seconds: Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 100) / 10,
    arguments: args,
    adapters,
    note: 'Everything listed here is a proposal. Nothing is verified, nothing was downloaded or executed, and no binary was mirrored.',
  };
}

export function flagHistogram(proposals) {
  const hist = {};
  for (const p of proposals) for (const f of p.meta?.quality_flags ?? []) hist[f] = (hist[f] ?? 0) + 1;
  return Object.fromEntries(Object.entries(hist).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function renderMarkdown(report) {
  const lines = ['# Crawl report', '', `- Started: ${report.started_at}`, `- Finished: ${report.finished_at} (${report.duration_seconds}s)`, `- Arguments: \`${JSON.stringify(report.arguments)}\``, '', `> ${report.note}`, ''];
  for (const a of report.adapters) {
    lines.push(`## Adapter \`${a.id}\``, '');
    if (a.skipped) { lines.push(`Skipped: ${a.skipped}`, ''); continue; }
    lines.push(`- Source: ${a.source ? `${a.source.repo ?? a.source.id}${a.source.commit ? ` @ \`${a.source.commit}\`` : ''}` : 'n/a'}`);
    lines.push(`- Targets: ${a.stats.targets} · proposed: ${a.stats.proposed} · unchanged: ${a.stats.unchanged ?? 0} · failed: ${a.stats.failed}`);
    if (a.http) lines.push(`- HTTP: ${a.http.requests} requests, ${a.http.cacheHits} cache hits, ${a.http.notModified} not-modified, ${a.http.retries} retries, ${a.http.blocked} blocked`);
    if (Object.keys(a.quality_flags ?? {}).length) {
      lines.push('', '| Quality flag | Records |', '| --- | ---: |');
      for (const [k, v] of Object.entries(a.quality_flags)) lines.push(`| ${k} | ${v} |`);
    }
    if (a.errors.length) {
      lines.push('', '### Errors', '', '| Target | Code | Message |', '| --- | --- | --- |');
      for (const e of a.errors) lines.push(`| \`${e.target}\` | ${e.code} | ${String(e.message).replace(/\|/g, '\\|').slice(0, 160)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

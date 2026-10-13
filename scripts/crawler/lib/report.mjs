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

// Error messages and targets can contain text from a remote server, so they are flattened to one line and
// stripped of anything that could break a table cell, open a code span or inject markup into the report.
export function mdCell(value, max = 160) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max)
    .replace(/\\/g, '/').replace(/`/g, "'").replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\[/g, '(').replace(/\]/g, ')');
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
      for (const e of a.errors) lines.push(`| \`${mdCell(e.target, 100)}\` | ${mdCell(e.code, 40)} | ${mdCell(e.message)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

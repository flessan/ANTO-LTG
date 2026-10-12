(() => {
  const root = document.documentElement.dataset.root || './';
  const form = document.querySelector('[data-global-search-form]');
  const input = document.querySelector('[data-global-search]');
  const results = document.querySelector('[data-global-results]');
  const summary = document.querySelector('[data-global-summary]');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let entries = [];
  Promise.all(['apps', 'drivers', 'tools', 'bundles'].map(async type => {
    const response = await fetch(`${root}api/v1/${type}.json`);
    if (!response.ok) throw new Error('catalog unavailable');
    const data = await response.json();
    return (data.items || []).map(item => ({...item, _type: type}));
  })).then(groups => { entries = groups.flat(); if (input?.value.trim()) runSearch(input.value); }).catch(() => {
    if (summary) summary.textContent = 'Pencarian katalog sementara tidak tersedia.';
  });

  function runSearch(query) {
    const q = query.trim().toLowerCase();
    results.hidden = !q;
    if (!q) { results.innerHTML = ''; summary.textContent = 'Cari berdasarkan nama, produsen, kategori, atau model perangkat.'; return; }
    const matches = entries.filter(item => [item.name, item.description, item.publisher, item.category, item.id].join(' ').toLowerCase().includes(q)).slice(0, 8);
    summary.textContent = matches.length ? `${matches.length} hasil teratas` : 'Belum ada hasil yang cocok.';
    results.innerHTML = matches.map(item => {
      const page = {apps:'software/', drivers:'drivers/', tools:'tools/', bundles:'bundles/'}[item._type];
      const status = item.verification_status === 'verified' ? 'Tinjau selesai' : item.status === 'published' ? 'Dipublikasikan' : 'Menunggu tinjauan';
      return `<a class="search-result" href="${root + page}"><span class="search-result__mark">${item._type === 'apps' ? 'S' : item._type === 'drivers' ? 'D' : item._type === 'tools' ? 'T' : 'B'}</span><span class="search-result__copy"><strong>${esc(item.name)}</strong><small>${esc(item.publisher || item.description)} · ${esc(status)}</small></span><span aria-hidden="true">↗</span></a>`;
    }).join('');
  }
  form?.addEventListener('submit', event => { event.preventDefault(); runSearch(input.value); });
  input?.addEventListener('input', () => runSearch(input.value));
  document.querySelectorAll('[data-search-shortcut]').forEach(button => button.addEventListener('click', () => {
    input.value = button.dataset.searchShortcut;
    runSearch(input.value);
    input.focus();
  }));
})();

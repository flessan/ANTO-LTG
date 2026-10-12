(() => {
  const root = document.documentElement.dataset.root || './';
  const config = {
    software: { endpoint: 'apps', title: 'Katalog software', noun: 'aplikasi', rootLink: 'software/' },
    drivers: { endpoint: 'drivers', title: 'Driver Center', noun: 'driver', rootLink: 'drivers/' },
    tools: { endpoint: 'tools', title: 'Technician Toolbox', noun: 'tools', rootLink: 'tools/' },
    bundles: { endpoint: 'bundles', title: 'Software Bundles', noun: 'bundle', rootLink: 'bundles/' }
  };
  const page = document.body.dataset.page;
  const conf = config[page];
  if (!conf) return;

  const list = document.querySelector('[data-catalog-list]');
  const search = document.querySelector('[data-catalog-search]');
  const statusFilter = document.querySelector('[data-status-filter]');
  const count = document.querySelector('[data-catalog-count]');
  const empty = document.querySelector('[data-catalog-empty]');
  const message = document.querySelector('[data-catalog-message]');
  let items = [];

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const statusLabel = status => ({ pending_review: 'Menunggu tinjauan', verified: 'Tinjau selesai', withdrawn: 'Ditarik', draft: 'Draft', published: 'Dipublikasikan' }[status] || 'Belum ditinjau');
  const glyph = page === 'drivers' ? 'D' : page === 'software' ? 'S' : page === 'tools' ? 'T' : 'B';

  function searchable(item) {
    return [item.name, item.description, item.publisher, item.category, ...(item.architectures || []), ...(item.app_ids || [])].join(' ').toLowerCase();
  }
  function renderCard(item) {
    const isBundle = page === 'bundles';
    const status = isBundle ? item.status : item.verification_status;
    const isVerified = status === 'verified' || status === 'published';
    const meta = isBundle ? `${(item.app_ids || []).length} aplikasi` : (item.publisher || 'Sumber belum dicatat');
    const category = (item.category || 'Umum').replaceAll('-', ' ');
    const action = !isBundle && item.source_url
      ? `<a class="text-link" href="${esc(item.source_url)}" target="_blank" rel="noopener noreferrer">Buka halaman sumber <span aria-hidden="true">↗</span></a>`
      : '<span class="text-muted small">Belum tersedia</span>';
    return `<article class="catalog-card">
      <div class="card-mark" aria-hidden="true">${glyph}</div>
      <div class="catalog-card__body">
        <div class="card-meta-row"><span class="eyebrow">${esc(category)}</span><span class="status-pill ${isVerified ? 'status-pill--verified' : 'status-pill--pending'}">${esc(statusLabel(status))}</span></div>
        <h2>${esc(item.name)}</h2>
        <p>${esc(item.description)}</p>
        <div class="publisher-line">${esc(meta)}</div>
        ${item.notes ? `<p class="card-note">${esc(item.notes)}</p>` : ''}
        <div class="catalog-card__footer">${action}</div>
      </div>
    </article>`;
  }
  function update() {
    const q = (search?.value || '').trim().toLowerCase();
    const status = statusFilter?.value || 'all';
    const filtered = items.filter(item => {
      const itemStatus = page === 'bundles' ? item.status : item.verification_status;
      return (!q || searchable(item).includes(q)) && (status === 'all' || itemStatus === status);
    });
    list.innerHTML = filtered.map(renderCard).join('');
    count.textContent = `${filtered.length} dari ${items.length} ${conf.noun}`;
    empty.hidden = filtered.length > 0;
    list.hidden = filtered.length === 0;
  }

  fetch(`${root}api/v1/${conf.endpoint}.json`)
    .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
    .then(data => {
      items = Array.isArray(data.items) ? data.items : [];
      if (message) message.textContent = page === 'drivers' && !items.length
        ? 'Katalog driver belum berisi entri yang diverifikasi. Kirim kontribusi dengan sumber produsen resmi dan detail model yang tepat.'
        : page === 'bundles' && !items.length
        ? 'Belum ada bundle yang dipublikasikan. Tahap awal ini hanya menyiapkan katalog; installer satu-klik belum diaktifkan.'
        : 'Entri berstatus “Menunggu tinjauan” belum disahkan kompatibilitas atau keamanannya oleh ANTO-LTG.';
      update();
    })
    .catch(() => {
      items = [];
      message.textContent = 'Katalog tidak dapat dimuat. Coba muat ulang halaman atau laporkan masalahnya.';
      update();
    });
  search?.addEventListener('input', update);
  statusFilter?.addEventListener('change', update);
})();

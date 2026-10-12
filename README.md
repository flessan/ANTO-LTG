# ANTO-LTG

**All-in-one technician toolkit** — katalog software, referensi driver, utilitas teknisi, panduan servis, serta data publik yang ramah developer.

> Status: MVP starter. Entri katalog contoh masih berstatus `pending_review`. Ini bukan pernyataan bahwa program tersebut aman, kompatibel dengan setiap Windows, atau telah diaudit oleh ANTO-LTG.

## Fokus MVP

- Website statis yang cepat dan mudah di-host di Cloudflare Pages atau layanan static hosting lain.
- Katalog berbasis JSON dengan endpoint `/api/v1/*.json`.
- Pencarian katalog di browser.
- Spesifikasi OpenAPI awal di `/openapi.json`.
- Validasi data otomatis pada pull request.
- Pembuatan sitemap, RSS, dan `robots.txt` ketika `SITE_URL` ditetapkan.
- Halaman panduan teknisi dan dokumentasi developer.

## Teknologi

HTML, CSS, JavaScript native, JSON, dan Node.js built-in APIs. Tidak ada framework runtime atau dependency eksternal dalam baseline ini.

## Jalankan lokal

Memerlukan Node.js 20 atau lebih baru.

```bash
npm run validate
SITE_URL=https://domain-kamu.example npm run build
```

Untuk melihat website lokal, jalankan static server dari root repository, misalnya:

```bash
npx serve .
```

`npm run build` menyalin `catalogs/*.json` ke `api/v1/*.json`, lalu menghasilkan `sitemap.xml`, `robots.txt`, dan `feed.xml` jika `SITE_URL` diisi. Gunakan domain produksi yang benar, bukan domain contoh di atas.

## Deploy ke Cloudflare Pages

- Framework preset: None
- Build command: `npm run build`
- Build output directory: `.`
- Environment variable: `SITE_URL=https://domain-produksi-kamu`

Jika nanti custom domain atau strategi build berubah, perbarui variabel `SITE_URL` dan dokumentasi ini.

## Struktur penting

- `catalogs/` — sumber data katalog yang diedit kontributor.
- `api/v1/` — snapshot endpoint JSON yang siap disajikan static host.
- `schemas/` — skema data yang terdokumentasi.
- `scripts/build.mjs` — validasi katalog dan pembuatan aset web.
- `developers/` — dokumentasi API dan kontribusi.
- `.github/workflows/validate.yml` — pemeriksaan JSON otomatis saat push dan pull request.

## Status fitur

| Fitur | Status MVP |
|---|---|
| Home dan pencarian katalog | Implementasi awal |
| Software catalog | Metadata dan tautan halaman penerbit; perlu review manusia |
| Driver catalog | Kerangka tersedia; belum ada driver yang terverifikasi |
| Technician toolbox | Metadata awal; perlu review manusia |
| App bundler | Pemilih aplikasi dan generator skrip PowerShell WinGet untuk Windows 10/11; ID paket dan kompatibilitas masih perlu tinjauan manusia |
| API JSON statis | Implementasi awal |
| RSS dan sitemap | Dibangkitkan saat build jika `SITE_URL` ditetapkan |
| Installer pendamping untuk Windows | Belum dibuat |

## Prinsip keamanan

ANTO-LTG tidak boleh menyamakan URL HTTPS, checksum, atau label komunitas dengan bukti bahwa file aman. Prioritaskan sumber vendor, catat bukti tinjauan, jangan mendistribusikan ulang binari tanpa izin, dan beri status `pending_review` sampai kompatibilitas diperiksa. Lihat [SECURITY.md](SECURITY.md).

## Roadmap teknis

1. Tentukan nama domain, repository URL, aturan kontribusi, serta penanggung jawab review.
2. Isi katalog driver secara bertahap dengan model dan sumber OEM yang tepat.
3. Tinjau dan perbarui WinGet ID serta kompatibilitas aplikasi; jalankan `npm run validate` sebelum rilis.
4. Kembangkan launcher pendamping bila diperlukan; bundler MVP menghasilkan skrip PowerShell lokal yang dapat diperiksa terlebih dahulu.
5. Tambahkan pemeriksaan versi, checksum, tanda tangan digital, dan laporan status sumber.


## Lisensi repository

Lisensi kode dan data belum dipilih. Tentukan dan tambahkan file lisensi sebelum menerima kontribusi publik; jangan menganggap metadata katalog atau software pihak ketiga otomatis boleh didistribusikan ulang.

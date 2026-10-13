# ANTO-LTG (Bahasa Indonesia)

**Platform teknisi bergaya Frutiger Aero.** Katalog software dengan pembuat skrip WinGet, pencari *sumber* driver,
bundel awal, catatan alat teknisi, panduan, API JSON statis terbuka, dan crawler yang sopan yang hanya mengusulkan
data untuk ditinjau manusia. Dibangun dengan HTML, CSS, JavaScript native, dan JSON, dengan skrip Node untuk build.
Tanpa framework, tanpa dependency runtime, tanpa CDN.

> **Status: alpha.** Semua entri katalog berstatus `pending_review`. **Belum ada yang ditandai `verified`**, karena
> verifikasi adalah pekerjaan manusia yang belum dilakukan. Entri katalog bukan pernyataan bahwa program aman,
> kompatibel dengan semua Windows, atau telah diaudit oleh ANTO-LTG.
>
> Dokumentasi lengkap ada dalam bahasa Inggris: [README.md](README.md).

## Isi

- **Software Center** (`software/`): cari berdasarkan nama, penerbit, kategori, deskripsi, atau ID paket; saring
  berdasarkan kategori, versi Windows, arsitektur, metode instalasi, dan status tinjauan. Pilih banyak aplikasi
  sekaligus (pilihan tetap tersimpan saat filter berubah dan saat halaman dimuat ulang), lihat rencana instalasi,
  salin atau unduh **skrip PowerShell WinGet**, ekspor atau impor manifes JSON, simpan bundel di browser, atau
  bagikan tautan.
- **Pencari sumber driver** (`drivers/`): cari berdasarkan produsen, model, motherboard, komponen, versi, tanggal
  rilis, atau ID perangkat. Setiap hasil menampilkan sumber resmi, bukti, dan status tinjauan; tautan langsung hanya
  ditampilkan jika resmi dan stabil. Direktori OEM/vendor menautkan ke Acer, ASUS, Dell, HP, Lenovo, MSI, GIGABYTE,
  Intel, AMD, NVIDIA, Realtek, Microsoft Update Catalog, dan lainnya.
- **Bundel**, **Alat**, **Panduan**, dan **Developers** (API, model data, skema, crawler, model keamanan).
- Antarmuka berbahasa Inggris secara bawaan dengan tombol **EN / ID**.

## Yang bukan

- Bukan database driver langsung dan bukan API real-time: ini indeks riset yang menunjuk ke sumber resmi. File JSON
  adalah snapshot statis yang dibuat ulang oleh `npm run build`.
- Bukan database SQL dan bukan host software: tidak ada installer, driver, atau firmware yang disimpan, dan browser
  tidak pernah menjalankan installer.
- Bukan audit: HTTPS, checksum, atau nama vendor bukan bukti bahwa sebuah file aman.

## Menjalankan secara lokal

Memerlukan Node.js **22.12 atau lebih baru**.

```bash
git clone https://github.com/flessan/ANTO-LTG.git
cd ANTO-LTG
npm ci
npm run serve        # http://localhost:8080
```

| Perintah | Fungsi |
| --- | --- |
| `npm run validate` | Memeriksa skema, aturan kebijakan, file hasil build, aset, dan HTML. |
| `npm test` | Tes unit dan crawler (tanpa jaringan dan tanpa browser). |
| `npm run test:e2e` | Tes browser (Chrome headless; atur `CHROME_PATH`). |
| `npm run build` | Membuat ulang `api/v1/*`, indeks pencarian, `openapi.json`, dan kredit gambar. Isi `SITE_URL` untuk membuat `sitemap.xml`, `robots.txt`, dan `feed.xml`. |
| `npm run check` | validate + test + build, dan gagal jika build mengubah file yang sudah di-commit. |

## Prinsip data

- Setiap entri mencantumkan sumbernya (`sources[]`). Yang tidak diketahui tetap ditulis tidak diketahui: versi,
  tanggal, ukuran, hash, atau kompatibilitas tidak pernah ditebak.
- Hash hanya disalin dari penerbit, tidak pernah dihitung sendiri. Kompatibilitas hanya yang *dinyatakan* sumber.
- Crawler hanya membuat usulan `pending_review`; hanya manusia yang boleh menandai `verified`, dengan bukti.

## Keamanan

CSP yang ketat, DOM dibangun tanpa `innerHTML`, ID paket divalidasi, skrip PowerShell memakai
`winget install --id <ID> --exact --source winget`, meminta konfirmasi `YES`, tidak memakai
`-ExecutionPolicy Bypass`, dan tidak menaikkan hak akses sendiri. Detail dan cara melapor: [SECURITY.md](SECURITY.md).

## Keterbatasan yang perlu diketahui

- Skrip PowerShell yang dihasilkan diuji secara **struktural**, tidak dijalankan (tidak ada PowerShell di CI).
- Tautan katalog belum diperiksa (`unchecked`): robots.txt GitHub melarang pemeriksaan URL unduhan rilis.
- Belum ada entri yang diverifikasi secara independen.

## Berkontribusi dan lisensi

Lihat [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [LICENSE](LICENSE) (MIT untuk kode, dokumentasi,
dan teks katalog asli), dan [LICENSING.md](LICENSING.md) (lisensi pihak ketiga: 7.css, metadata winget-pkgs, foto,
merek dagang). Foto **bukan** MIT; lihat [assets/CREDITS.md](assets/CREDITS.md).

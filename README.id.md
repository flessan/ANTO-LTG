# ANTO-LTG (Bahasa Indonesia)

**Platform teknisi bergaya Frutiger Aero.** Katalog software dengan pembuat skrip WinGet, pencari *sumber* driver,
bundel awal, catatan alat teknisi, panduan, API JSON statis terbuka, dan crawler yang sopan yang hanya mengusulkan
data untuk ditinjau manusia. Dibangun dengan HTML, CSS, JavaScript native, dan JSON, dengan skrip Node untuk build.
Tanpa framework, tanpa dependency runtime, tanpa CDN.

> **Status: publikasi otomatis.** Sebuah entri dipublikasikan ketika aturan mesin di
> [`scripts/lib/publication.mjs`](scripts/lib/publication.mjs) lolos; tidak ada persetujuan manusia untuk langkah itu.
> Publikasi dan tinjauan manusia ditampilkan terpisah. **Belum ada yang ditandai `verified`**: belum ada pengelola yang
> memeriksa entri terhadap sumber resminya. Entri katalog bukan pernyataan bahwa program aman, kompatibel dengan semua
> Windows, atau telah diaudit oleh ANTO-LTG.
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

## Windows lama (7, 8 dan 8.1)

Katalog perangkat lunak dapat ditargetkan untuk Windows 7, Windows 8 dan Windows 8.1, selain Windows 10 dan 11.
WinGet hanya ada di Windows 10 1809 ke atas, jadi untuk sistem lama Pusat Perangkat Lunak membuat **paket unduhan**:
skrip yang kompatibel dengan PowerShell 2.0, mengunduh setiap berkas resmi melalui HTTPS, memeriksa SHA-256 yang
dipublikasikan, dan menghapus berkas yang tidak cocok. Skrip tidak pernah menjalankan atau memasang apa pun yang diunduh.
Windows 7 memerlukan .NET Framework 4.5 atau lebih baru untuk unduhan aman (TLS 1.2); skrip akan memberi tahu jika TLS 1.2 tidak bisa diaktifkan.

Tidak ada sumber katalog yang menyatakan kompatibilitas dengan Windows 7, 8 atau 8.1, sehingga sistem tersebut
ditampilkan sebagai "belum dinyatakan", bukan "didukung". Periksa persyaratan setiap penerbit sebelum memasang.
Laporan perangkat keras (`assets/scripts/Get-AntoHardwareReport.ps1`) berjalan di PowerShell 2.0 ke atas.
Windows XP dan Vista tidak didukung.

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
- Crawler hanya membuat usulan. `merge` mempublikasikan entri secara otomatis ketika aturan mesin lolos, dan tidak pernah menandai `verified`; hanya manusia yang boleh menandai `verified`, dengan bukti.

## Keamanan

CSP yang ketat, DOM dibangun tanpa `innerHTML`, ID paket divalidasi, skrip PowerShell memakai
`winget install --id <ID> --exact --source winget`, meminta konfirmasi `YES`, tidak memakai
`-ExecutionPolicy Bypass`, dan tidak menaikkan hak akses sendiri. Detail dan cara melapor: [SECURITY.md](SECURITY.md).

## Keterbatasan yang perlu diketahui

- Skrip PowerShell yang dihasilkan diuji secara **struktural**, tidak dijalankan (tidak ada PowerShell di CI).
- Tautan katalog belum diperiksa (`unchecked`): robots.txt GitHub melarang pemeriksaan URL unduhan rilis.
- Belum ada entri yang diverifikasi oleh pengelola. Publikasi bersifat otomatis; tinjauan tidak.
- Data driver masih terbatas. Daftar driver pihak ketiga hanya petunjuk dan tidak pernah dipublikasikan.

## Dukungan

[Halaman Dukungan](support/) menawarkan dua cara membantu, plus tautan komunitas:

- **Donasi** lewat [Sociabuzz](https://sociabuzz.com/flessan/tribe): sekali, dengan komentar opsional dan banyak metode pembayaran, terutama di Indonesia.
- **GitHub Sponsors** di [github.com/sponsors/flessan](https://github.com/sponsors/flessan): sekali atau bulanan.
- **Discord** belum dipublikasikan; sampai itu terjadi, tombolnya tetap nonaktif dan halaman menjelaskannya. Laporan bug dan data yang keliru dikirim ke [GitHub Issues](https://github.com/flessan/ANTO-LTG/issues).

Dukungan tidak pernah mengubah data katalog, status tinjauan, atau peringkat.

## Berkontribusi dan lisensi

Lihat [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [LICENSE](LICENSE) (MIT untuk kode, dokumentasi,
dan teks katalog asli), dan [LICENSING.md](LICENSING.md) (lisensi pihak ketiga: 7.css, metadata winget-pkgs, foto,
merek dagang). Foto **bukan** MIT; lihat [assets/CREDITS.md](assets/CREDITS.md).

# Kebijakan keamanan

## Melaporkan masalah

Untuk saat ini, jangan publikasikan detail eksploitasi atau file berbahaya dalam issue publik. Hubungi maintainer repository melalui kanal kontak keamanan yang akan ditambahkan setelah repository resmi dibuat. Sampai kontak itu tersedia, laporkan masalah secara privat kepada pemilik repository sebelum membuka issue yang berisi detail sensitif.

## Prinsip katalog

- Tautan HTTPS saja; HTTPS tidak berarti file otomatis aman.
- Utamakan halaman resmi vendor atau proyek sumber.
- Jangan mirror atau mengemas ulang binary kecuali lisensi dan izin distribusi mengizinkan.
- Jangan menyimpan installer, firmware, kredensial, token, atau data personal di katalog.
- `pending_review` adalah status default. `verified` memerlukan pemeriksaan manusia dan bukti yang dapat dirujuk.
- Simpan tanggal pemeriksaan, versi yang diuji, OS/arsitektur, hasil pemeriksaan tanda tangan/hash bila tersedia, dan sumber bukti ketika membuat sistem review penuh.
- Checksum membantu mendeteksi perubahan dari nilai yang dipercaya, tetapi tidak membuktikan bahwa file bebas malware.
- Instalasi dan update driver/firmware dengan hak administrator adalah tindakan berisiko; tampilkan sumber, tujuan, dan izin secara transparan.

## Batas validator

CI saat ini menguji JSON, ID, field wajib, status, dan penggunaan HTTPS. Validator tidak mengunduh atau memindai binary, tidak menguji reputasi domain, dan tidak membuktikan klaim kompatibilitas.

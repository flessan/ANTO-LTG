# Berkontribusi ke ANTO-LTG

Terima kasih sudah membantu menjaga katalog teknisi tetap berguna dan bisa diperiksa.

## Tambah atau ubah data

1. Fork repository dan buat branch khusus.
2. Edit file di `catalogs/`—jangan edit output otomatis di `api/v1/`.
3. Gunakan ID lowercase-kebab-case yang stabil dan unik.
4. Isi deskripsi yang faktual. Jangan menyebut software “aman”, “terbaru”, atau mendukung Windows tertentu tanpa bukti.
5. Gunakan tautan HTTPS yang mengarah ke halaman penerbit/OEM/proyek resmi. Jangan tambahkan file binari, URL unduhan tidak jelas, token, atau data pelanggan.
6. Biarkan `verification_status` bernilai `pending_review` sampai peninjau memeriksa sumber dan klaim.
7. Jalankan `npm run validate` lalu ajukan pull request.

## Apa yang perlu disertakan pada PR?

- URL sumber dan identitas penerbit yang bisa diperiksa.
- Model perangkat, hardware ID, versi OS, arsitektur, atau versi software yang tepat bila relevan.
- Tanggal pemeriksaan dan bukti kompatibilitas untuk perubahan status menjadi `verified`.
- Catatan lisensi/distribusi bila kontribusi menyangkut bundling atau mirror.

## Driver

Driver wajib memiliki produsen, model/komponen yang jelas, sistem operasi yang diuji, dan sumber dukungan resmi. Jangan menyimpulkan driver kompatibel hanya dari nama perangkat atau nomor versi yang mirip. BIOS/firmware membutuhkan peninjauan khusus.

## Review dan perilaku

Pull request dapat ditolak jika sumber meragukan, metadata tidak lengkap, klaim tidak didukung, atau melanggar lisensi. Validator memeriksa format dasar saja; kelulusan CI bukan audit keamanan.

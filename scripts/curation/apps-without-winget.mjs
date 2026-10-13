#!/usr/bin/env node
// Adds curated app records that have NO WinGet package, so the catalog exercises every install
// state: official direct download, redirect, publisher landing page only, and unavailable.
// Every fact below was read from the cited official page on 2026-10-13 (see each `sources`
// entry). Hashes are copied from the publisher's own checksum file / download page; where the
// publisher states none, sha256 is null - it is never computed or guessed here.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalog, writeCatalog } from '../lib/catalog-io.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAY = '2026-10-13';
const base = { verification_status: 'pending_review', windows_compatibility: 'not_reviewed', added_at: DAY, notes: '' };
const dl = (kind, url, extra = {}) => ({ kind, url, link_check: { status: 'unchecked' }, ...extra });
const unknownCompat = { windows10: 'unknown', windows11: 'unknown', min_os_version: null, basis: 'The source page does not state a minimum Windows version', note: 'Not declared by the source; not tested by ANTO-LTG.' };

const records = [
  {
    ...base, id: 'sysinternals-suite', name: 'Sysinternals Suite', publisher: 'Microsoft', category: 'system-tools',
    description: 'The Sysinternals troubleshooting utilities (Process Explorer, Process Monitor, Autoruns, PsTools and more) bundled in one ZIP.',
    description_id: 'Kumpulan utilitas pemecahan masalah Sysinternals (Process Explorer, Process Monitor, Autoruns, PsTools, dan lainnya) dalam satu berkas ZIP.',
    source_url: 'https://learn.microsoft.com/sysinternals/downloads/sysinternals-suite', source_kind: 'publisher_page',
    compatibility: unknownCompat, architectures: ['arm64', 'neutral'], license: 'Freeware', portable: true, installer_types: ['zip'],
    tags: ['sysinternals', 'troubleshooting', 'portable'],
    downloads: [
      dl('direct_binary', 'https://download.sysinternals.com/files/SysinternalsSuite.zip', { architecture: 'neutral', installer_type: 'zip', size_bytes: null, sha256: null, sha256_source: null, stability: 'evergreen', evidence: 'Download link on the official Sysinternals Suite page (stated size 192.2 MB). The page publishes no checksum.' }),
      dl('direct_binary', 'https://download.sysinternals.com/files/SysinternalsSuite-ARM64.zip', { architecture: 'arm64', installer_type: 'zip', sha256: null, sha256_source: null, stability: 'evergreen', evidence: 'ARM64 download link on the official Sysinternals Suite page (stated size 21.3 MB). The page publishes no checksum.' }),
    ],
    sources: [{ id: 'microsoft-learn-sysinternals', kind: 'vendor_page', url: 'https://learn.microsoft.com/sysinternals/downloads/sysinternals-suite', retrieved_at: DAY, fields: ['name', 'publisher', 'description', 'downloads', 'source_url', 'architectures', 'portable', 'installer_types'], note: 'Page states "Updated: September 10, 2026"; no version number is published, so version stays unknown.' }],
  },
  {
    ...base, id: 'memtest86-plus', name: 'Memtest86+', publisher: 'Martin Whitaker and Sam Demeulemeester', category: 'diagnostics',
    description: 'Free, open-source, stand-alone memory tester that boots from a USB drive or CD and checks RAM more thoroughly than BIOS tests.',
    description_id: 'Penguji memori mandiri yang gratis dan open source; dijalankan dari USB atau CD dan memeriksa RAM lebih teliti daripada uji BIOS.',
    source_url: 'https://www.memtest.org/', source_kind: 'official_project_site',
    compatibility: unknownCompat, architectures: [], license: 'GPL-2.0', portable: false, installer_types: ['exe', 'iso', 'zip'],
    version: 'v8.10', release_date: '2026-05-16', tags: ['ram', 'memory-test', 'bootable', 'open-source'],
    notes: 'Not an edition of PassMark MemTest86. The binary is not signed by Microsoft, so Secure Boot must be disabled temporarily to boot it (stated by the project).',
    notes_id: 'Bukan edisi dari PassMark MemTest86. Biner tidak ditandatangani Microsoft, sehingga Secure Boot perlu dinonaktifkan sementara untuk boot (menurut proyek).',
    downloads: [
      dl('direct_binary', 'https://www.memtest.org/download/v8.10/mt86plus_8.10_USB_Installer.exe', { installer_type: 'exe', sha256: '9c1cccb8d81b41188d4e6da620703b4cde5cce92d9098eb162c21228bf4aa0ad', sha256_source: 'memtest.org sha256sum.txt for v8.10', stability: 'versioned', evidence: 'Windows USB Installer (32/64 bit) listed on the project download section; hash copied from the project checksum file.' }),
      dl('direct_binary', 'https://www.memtest.org/download/v8.10/mt86plus_8.10_x86_64.iso.zip', { architecture: 'x64', installer_type: 'iso', sha256: '93530005d6ac6a85aa2a49c68604a43c25794ecccf796c4f8849a73a8001be9a', sha256_source: 'memtest.org sha256sum.txt for v8.10', stability: 'versioned', evidence: 'Linux ISO (64 bit) zip listed on the project download section; hash copied from the project checksum file.' }),
      dl('direct_binary', 'https://www.memtest.org/download/v8.10/mt86plus_8.10_i586.iso.zip', { architecture: 'x86', installer_type: 'iso', sha256: 'a55c3a12b6c4d4f444df3e5213aa85045f2629eb0d56e98a06cc31ef1cda51b9', sha256_source: 'memtest.org sha256sum.txt for v8.10', stability: 'versioned', evidence: 'Linux ISO (32 bit) zip listed on the project download section; hash copied from the project checksum file.' }),
    ],
    sources: [
      { id: 'memtest-org', kind: 'vendor_page', url: 'https://www.memtest.org/', retrieved_at: DAY, fields: ['name', 'publisher', 'description', 'license', 'version', 'release_date', 'downloads', 'source_url', 'notes', 'installer_types'] },
      { id: 'memtest-org-sha256', kind: 'vendor_page', url: 'https://www.memtest.org/download/v8.10/sha256sum.txt', retrieved_at: DAY, fields: ['downloads'], note: 'Source of the SHA-256 values.' },
    ],
  },
  {
    ...base, id: 'memtest86', name: 'MemTest86 (Free edition)', publisher: 'PassMark Software', category: 'diagnostics',
    description: 'Stand-alone RAM tester from PassMark that runs from bootable USB media; the Free edition has fewer features than the paid Pro edition.',
    description_id: 'Penguji RAM mandiri dari PassMark yang dijalankan dari media USB bootable; edisi Free memiliki fitur lebih sedikit daripada edisi Pro berbayar.',
    source_url: 'https://www.memtest86.com/download.htm', source_kind: 'publisher_page',
    compatibility: unknownCompat, architectures: ['arm64', 'x64', 'x86'], license: 'Freeware (Pro edition is paid)', portable: false, installer_types: ['zip'],
    version: '11.7 build 1000', tags: ['ram', 'memory-test', 'bootable', 'uefi'],
    notes: 'Version 11.7 boots on UEFI firmware only; the older V4 release is offered on the same page for legacy BIOS PCs. The page publishes no checksum.',
    notes_id: 'Versi 11.7 hanya boot pada firmware UEFI; rilis V4 yang lebih lama tersedia di halaman yang sama untuk PC BIOS lawas. Halaman tidak mencantumkan checksum.',
    downloads: [dl('direct_binary', 'https://www.memtest86.com/downloads/memtest86-usb.zip', { installer_type: 'zip', size_bytes: null, sha256: null, sha256_source: null, stability: 'evergreen', evidence: 'Free edition download link on the official download page (stated size 12.1 MB; x86, x86-64 and ARM64 images). The page publishes no checksum.' })],
    sources: [{ id: 'memtest86-com', kind: 'vendor_page', url: 'https://www.memtest86.com/download.htm', retrieved_at: DAY, fields: ['name', 'publisher', 'description', 'license', 'version', 'downloads', 'architectures', 'source_url', 'notes', 'installer_types'] }],
  },
  {
    ...base, id: 'hirens-bootcd-pe', name: "Hiren's BootCD PE", publisher: "Hiren's BootCD PE contributors", category: 'boot-media',
    description: 'A bootable Windows PE rescue disc (x64) bundling dozens of diagnostic, recovery, imaging and partitioning tools.',
    description_id: 'Cakram penyelamat Windows PE bootable (x64) yang memuat puluhan alat diagnostik, pemulihan, imaging, dan partisi.',
    source_url: 'https://www.hirensbootcd.org/download/', source_kind: 'official_project_site',
    compatibility: unknownCompat, architectures: ['x64'], license: 'Mixed (bundled third-party tools)', portable: false, installer_types: ['iso'],
    version: 'v1.0.8', tags: ['rescue', 'winpe', 'bootable', 'recovery'],
    notes: 'The ISO bundles third-party tools under their own licenses (some are trial or commercial); check licensing before using it commercially. The hash applies to the ISO listed on the page at retrieval time.',
    notes_id: 'ISO memuat alat pihak ketiga dengan lisensinya masing-masing (sebagian trial atau komersial); periksa lisensi sebelum penggunaan komersial. Hash berlaku untuk ISO yang tercantum pada halaman saat diambil.',
    downloads: [dl('direct_binary', 'https://www.hirensbootcd.org/files/HBCD_PE_x64.iso', { architecture: 'x64', installer_type: 'iso', size_bytes: 3291686912, sha256: '8c4c670c9c84d6c4b5a9c32e0aa5a55d8c23de851d259207d54679ea774c2498', sha256_source: 'hirensbootcd.org download page', stability: 'evergreen', evidence: 'ISO link, exact size and SHA-256 published on the official download page (HBCD_PE_x64.iso, 3.06 GB).' })],
    sources: [{ id: 'hirensbootcd-download', kind: 'vendor_page', url: 'https://www.hirensbootcd.org/download/', retrieved_at: DAY, fields: ['name', 'description', 'version', 'downloads', 'architectures', 'source_url', 'notes', 'installer_types'] }],
  },
  {
    ...base, id: 'windows-11-installation-assistant', name: 'Windows 11 Installation Assistant', publisher: 'Microsoft', category: 'boot-media',
    description: "Microsoft's official tool for upgrading the PC you are using to Windows 11 (x64 only; not for Arm PCs).",
    description_id: 'Alat resmi Microsoft untuk memperbarui PC yang sedang dipakai ke Windows 11 (hanya x64; tidak untuk PC Arm).',
    source_url: 'https://www.microsoft.com/en-us/software-download/windows11', source_kind: 'publisher_page',
    compatibility: { windows10: 'declared', windows11: 'declared', min_os_version: '10.0.19041.0', basis: 'Microsoft download page: the PC must run Windows 10 version 2004 or later', note: 'Declared by the source; not tested by ANTO-LTG.' },
    architectures: ['x64'], license: 'Proprietary (Microsoft)', portable: false, installer_types: ['exe'], tags: ['windows-11', 'upgrade'],
    notes: 'Needs administrator rights and about 9 GB of free disk space (as stated on the page). The link is a Microsoft fwlink redirect that always points at the current tool.',
    notes_id: 'Perlu hak administrator dan sekitar 9 GB ruang disk kosong (menurut halaman). Tautan adalah pengalihan fwlink Microsoft yang selalu menuju alat terbaru.',
    downloads: [dl('redirect', 'https://go.microsoft.com/fwlink/?linkid=2171764', { installer_type: 'exe', sha256: null, sha256_source: null, stability: 'evergreen', evidence: '"Download Now" link under Windows 11 Installation Assistant on the official page; it is a redirector, not a file URL.' })],
    sources: [{ id: 'microsoft-windows11-download', kind: 'vendor_page', url: 'https://www.microsoft.com/en-us/software-download/windows11', retrieved_at: DAY, fields: ['name', 'publisher', 'description', 'compatibility', 'architectures', 'downloads', 'source_url', 'notes', 'installer_types'] }],
  },
  {
    ...base, id: 'windows-11-media-creation-tool', name: 'Windows 11 Media Creation Tool', publisher: 'Microsoft', category: 'boot-media',
    description: 'Official page for creating Windows 11 installation media (bootable USB or ISO) for a clean install or reinstall; x64 only.',
    description_id: 'Halaman resmi untuk membuat media instalasi Windows 11 (USB bootable atau ISO) untuk instal bersih atau instal ulang; hanya x64.',
    source_url: 'https://www.microsoft.com/en-us/software-download/windows11', source_kind: 'publisher_page',
    compatibility: unknownCompat, architectures: ['x64'], license: 'Proprietary (Microsoft)', portable: false, installer_types: [], tags: ['windows-11', 'usb', 'iso', 'clean-install'],
    notes: 'Use the official page and pick "Create Windows 11 Installation Media". Needs administrator rights and a blank USB drive of at least 8 GB; its contents are erased.',
    notes_id: 'Gunakan halaman resmi dan pilih "Create Windows 11 Installation Media". Perlu hak administrator dan USB kosong minimal 8 GB; isinya akan terhapus.',
    downloads: [],
    sources: [{ id: 'microsoft-windows11-download', kind: 'vendor_page', url: 'https://www.microsoft.com/en-us/software-download/windows11', retrieved_at: DAY, fields: ['name', 'publisher', 'description', 'architectures', 'source_url', 'notes'] }],
  },
  {
    ...base, id: 'microsoft-security-essentials', name: 'Microsoft Security Essentials', publisher: 'Microsoft', category: 'security',
    description: "Microsoft's free antivirus for Windows 7 and earlier. It is no longer offered as a download.",
    description_id: 'Antivirus gratis Microsoft untuk Windows 7 dan sebelumnya. Sudah tidak ditawarkan sebagai unduhan.',
    source_url: 'https://support.microsoft.com/en-us/security/what-is-microsoft-security-essentials', source_kind: 'publisher_page',
    compatibility: unknownCompat, architectures: [], license: 'Proprietary (Microsoft)', portable: false, installer_types: [], tags: ['legacy', 'windows-7', 'discontinued'],
    availability: { status: 'unavailable', reason: 'Microsoft states that Security Essentials reached end of service on 14 January 2020 and is no longer available as a download.', since: '2020-01-14', evidence_url: 'https://support.microsoft.com/en-us/security/what-is-microsoft-security-essentials' },
    notes: 'Use Microsoft Defender Antivirus on supported Windows versions.',
    notes_id: 'Gunakan Microsoft Defender Antivirus pada versi Windows yang masih didukung.',
    downloads: [],
    sources: [{ id: 'microsoft-support-mse', kind: 'vendor_page', url: 'https://support.microsoft.com/en-us/security/what-is-microsoft-security-essentials', retrieved_at: DAY, fields: ['name', 'publisher', 'description', 'availability', 'source_url'] }],
  },
  {
    ...base, id: 'adobe-flash-player', name: 'Adobe Flash Player', publisher: 'Adobe', category: 'browsers',
    description: 'Retired browser plug-in. Adobe ended support on 31 December 2020, removed its download pages and blocks Flash content from running.',
    description_id: 'Plug-in peramban yang telah dihentikan. Adobe mengakhiri dukungan pada 31 Desember 2020, menghapus halaman unduhan, dan memblokir konten Flash.',
    source_url: 'https://www.adobe.com/products/flashplayer/end-of-life-alternative.html', source_kind: 'publisher_page',
    compatibility: unknownCompat, architectures: [], license: 'Proprietary (Adobe)', portable: false, installer_types: [], tags: ['legacy', 'discontinued', 'uninstall'],
    availability: { status: 'unavailable', reason: 'Adobe states that Flash Player is no longer supported or distributed, that it removed the download pages, and that it blocks Flash content from running since 12 January 2021.', since: '2020-12-31', evidence_url: 'https://www.adobe.com/products/flashplayer/end-of-life-alternative.html' },
    notes: 'Adobe recommends uninstalling Flash Player; the same page links its uninstall instructions.',
    notes_id: 'Adobe menyarankan untuk menghapus Flash Player; halaman yang sama memuat petunjuk penghapusan.',
    downloads: [],
    sources: [{ id: 'adobe-flash-eol', kind: 'vendor_page', url: 'https://www.adobe.com/products/flashplayer/end-of-life-alternative.html', retrieved_at: DAY, fields: ['name', 'publisher', 'description', 'availability', 'source_url', 'notes'] }],
  },
];

const apps = await readCatalog(root, 'apps');
let added = 0;
for (const rec of records) {
  if (apps.items.some((a) => a.id === rec.id)) { console.log(`skip ${rec.id} (exists)`); continue; }
  apps.items.push(rec); added++;
}
apps.updated_at = `${DAY}T00:00:00.000Z`;
await writeCatalog(root, 'apps', apps);
console.log(`added ${added} curated records`);

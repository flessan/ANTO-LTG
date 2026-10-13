#!/usr/bin/env node
// Vendor / OEM directory. Every portal URL below was opened on 2026-10-13 and the portal's own
// wording is summarised in `instructions`. `domains` is the allow-list that validation uses to
// decide whether a driver's official_source / direct link really belongs to that vendor.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalog, writeCatalog } from '../lib/catalog-io.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAY = '2026-10-13';
const base = { source_kind: 'manufacturer_support_page', verification_status: 'not_reviewed' };
const src = (id, url, fields, note) => [{ id, kind: 'vendor_page', url, retrieved_at: DAY, fields, ...(note ? { note } : {}) }];
const F = ['name', 'homepage_url', 'driver_search_url', 'domains', 'instructions', 'requires'];

export const vendors = [
  {
    ...base, id: 'intel', name: 'Intel', kind: 'component_vendor', homepage_url: 'https://www.intel.com/',
    driver_search_url: 'https://www.intel.com/content/www/us/en/download-center/home.html',
    detection_tool: { name: 'Intel Driver & Support Assistant', url: 'https://www.intel.com/content/www/us/en/support/detect.html', winget_id: 'Intel.IntelDriverAndSupportAssistant' },
    domains: ['intel.com', '*.intel.com'], pci_vendor_ids: ['8086'], usb_vendor_ids: ['8087'], requires: ['eula', 'auto_detect_tool'],
    instructions: ['Search the Download Center by product name, or run Intel Driver & Support Assistant to detect your Intel hardware.', 'Intel notes that your computer maker may have customised the driver; check the maker\'s site first, because Intel\'s generic driver can overwrite it.', 'Accept the license agreement to start the download, then compare the file hash with the value on the page.'],
    instructions_id: ['Cari di Download Center berdasarkan nama produk, atau jalankan Intel Driver & Support Assistant untuk mendeteksi perangkat keras Intel Anda.', 'Intel mencatat bahwa pabrikan komputer mungkin sudah menyesuaikan driver; periksa situs pabrikan terlebih dahulu karena driver generik Intel dapat menimpanya.', 'Setujui perjanjian lisensi untuk memulai unduhan, lalu bandingkan hash berkas dengan nilai di halaman.'],
    notes: 'Download pages show the SHA-256 (or SHA-512) of each file. Direct file links are not stored because Intel gates them behind a license acceptance and they change per version.',
    notes_id: 'Halaman unduhan menampilkan SHA-256 (atau SHA-512) tiap berkas. Tautan berkas langsung tidak disimpan karena Intel menempatkannya di balik persetujuan lisensi dan berubah pada tiap versi.',
    sources: src('intel-download-center', 'https://www.intel.com/content/www/us/en/download-center/home.html', F, 'Download Center and Driver & Support Assistant pages read on the retrieval date.'),
  },
  {
    ...base, id: 'nvidia', name: 'NVIDIA', kind: 'component_vendor', homepage_url: 'https://www.nvidia.com/',
    driver_search_url: 'https://www.nvidia.com/en-us/drivers/',
    detection_tool: { name: 'NVIDIA App', url: 'https://www.nvidia.com/en-us/software/nvidia-app/' },
    domains: ['nvidia.com', '*.nvidia.com'], pci_vendor_ids: ['10DE'], requires: ['product_selection', 'auto_detect_tool'],
    instructions: ['Use the NVIDIA App for automatic driver updates, or the manual driver search (product category, series, product, operating system, DCH/Standard, Game Ready/Studio).', 'On laptops the notebook maker provides certified drivers for the specific model; NVIDIA\'s generic drivers can usually be installed but check the maker first.'],
    instructions_id: ['Gunakan NVIDIA App untuk pembaruan driver otomatis, atau pencarian driver manual (kategori produk, seri, produk, sistem operasi, DCH/Standard, Game Ready/Studio).', 'Pada laptop, pabrikan menyediakan driver tersertifikasi untuk model tertentu; driver generik NVIDIA biasanya dapat dipasang, tetapi periksa pabrikan terlebih dahulu.'],
    notes: 'The driver pages are rendered by script, so ANTO-LTG does not scrape or state a "latest" version.',
    notes_id: 'Halaman driver dirender dengan skrip, sehingga ANTO-LTG tidak mengambil data maupun menyebut versi "terbaru".',
    sources: src('nvidia-drivers', 'https://www.nvidia.com/en-us/drivers/', F, 'Driver search page read on the retrieval date; its version fields are template placeholders when fetched without a browser.'),
  },
  {
    ...base, id: 'amd', name: 'AMD', kind: 'component_vendor', homepage_url: 'https://www.amd.com/',
    driver_search_url: 'https://www.amd.com/en/support/download/drivers.html',
    detection_tool: { name: 'AMD auto-detect and install (Windows)', url: 'https://www.amd.com/en/support/download/drivers.html' },
    domains: ['amd.com', '*.amd.com'], pci_vendor_ids: ['1002', '1022'], requires: ['product_selection', 'auto_detect_tool'],
    instructions: ['Use "Download Windows Drivers" to auto-detect and install Radeon graphics and Ryzen chipset drivers (Windows 11 or Windows 10 64-bit 1809 and later, per the page).', 'Or search by product (for example a Ryzen CPU or Radeon GPU) to get drivers and support for it.'],
    instructions_id: ['Gunakan "Download Windows Drivers" untuk mendeteksi dan memasang driver grafis Radeon dan chipset Ryzen secara otomatis (Windows 11 atau Windows 10 64-bit 1809 ke atas, menurut halaman).', 'Atau cari berdasarkan produk (misalnya CPU Ryzen atau GPU Radeon) untuk mendapatkan driver dan dukungannya.'],
    notes: 'The page links a web installer whose file name carries the Adrenalin version; that link changes with each release.',
    notes_id: 'Halaman menautkan penginstal web yang nama berkasnya memuat versi Adrenalin; tautan itu berubah pada setiap rilis.',
    sources: src('amd-drivers', 'https://www.amd.com/en/support/download/drivers.html', F),
  },
  {
    ...base, id: 'realtek', name: 'Realtek', kind: 'component_vendor', homepage_url: 'https://www.realtek.com/',
    driver_search_url: 'https://www.realtek.com/Download/List?cate_id=584',
    domains: ['realtek.com', '*.realtek.com'], pci_vendor_ids: ['10EC'], usb_vendor_ids: ['0BDA'], requires: ['product_selection', 'eula'],
    instructions: ['Pick the controller family list (PCIe Ethernet: cate_id=584, USB Ethernet: cate_id=585, HD Audio codecs: cate_id=593) and choose the row for your Windows version.', 'The audio downloads ask you to accept a license first; the Ethernet downloads start directly.', 'Laptops and motherboards often ship customised Realtek drivers: prefer your computer or board maker\'s package and use Realtek\'s generic one when that is unavailable.'],
    instructions_id: ['Pilih daftar keluarga pengendali (Ethernet PCIe: cate_id=584, Ethernet USB: cate_id=585, codec HD Audio: cate_id=593) lalu pilih baris untuk versi Windows Anda.', 'Unduhan audio meminta Anda menyetujui lisensi terlebih dahulu; unduhan Ethernet langsung dimulai.', 'Laptop dan motherboard sering membawa driver Realtek yang sudah disesuaikan: utamakan paket dari pabrikan komputer atau papan, dan gunakan paket generik Realtek bila tidak tersedia.'],
    notes: 'The lists include Windows Vista, 7, 8/8.1 and XP packages with their dates, which makes them useful for older PCs.',
    notes_id: 'Daftar mencakup paket Windows Vista, 7, 8/8.1, dan XP beserta tanggalnya, sehingga berguna untuk PC lama.',
    sources: src('realtek-download-lists', 'https://www.realtek.com/Download/List?cate_id=584', F, 'Lists for cate_id 583, 584, 585 and 593 were read on the retrieval date.'),
  },
  {
    ...base, id: 'microsoft-update-catalog', name: 'Microsoft Update Catalog', kind: 'catalog', homepage_url: 'https://www.catalog.update.microsoft.com/Home.aspx',
    driver_search_url: 'https://www.catalog.update.microsoft.com/Home.aspx',
    domains: ['catalog.update.microsoft.com', '*.catalog.update.microsoft.com'], requires: ['product_selection'],
    instructions: ['Search by driver name or by a hardware ID copied from Device Manager (Properties > Details > Hardware Ids).', 'Add the matching update to the basket and download it; driver packages arrive as CAB files that you extract and install through Device Manager.'],
    instructions_id: ['Cari berdasarkan nama driver atau ID perangkat keras yang disalin dari Device Manager (Properties > Details > Hardware Ids).', 'Tambahkan pembaruan yang cocok ke keranjang lalu unduh; paket driver berupa berkas CAB yang diekstrak dan dipasang melalui Device Manager.'],
    notes: 'Microsoft\'s own catalog of updates and driver packages. The page itself only offers a search box and a download basket.',
    notes_id: 'Katalog pembaruan dan paket driver milik Microsoft. Halamannya hanya menyediakan kotak pencarian dan keranjang unduhan.',
    sources: src('microsoft-update-catalog', 'https://www.catalog.update.microsoft.com/Home.aspx', ['name', 'homepage_url', 'driver_search_url', 'domains', 'notes']),
  },
  {
    ...base, id: 'microsoft-surface', name: 'Microsoft Surface', kind: 'oem', homepage_url: 'https://support.microsoft.com/en-us/surface/drivers-firmware/download-drivers-and-firmware-for-surface',
    support_url: 'https://support.microsoft.com/en-us/surface/drivers-firmware/download-drivers-and-firmware-for-surface',
    driver_search_url: 'https://support.microsoft.com/en-us/surface/drivers-firmware/download-drivers-and-firmware-for-surface',
    detection_tool: { name: 'Surface app (Microsoft Store)', url: 'https://www.microsoft.com/store/productId/9WZDNCRFJB8P' },
    domains: ['microsoft.com', '*.microsoft.com'], usb_vendor_ids: ['045E'], requires: ['product_selection', 'auto_detect_tool'],
    instructions: ['Check driver and firmware status in the Surface app (Help & support), then use Windows Update to install what it finds (recommended).', 'To update manually, choose your Surface model on the support page and follow the links it shows.', 'Each Surface model receives driver and firmware updates until its end-of-servicing date (see Microsoft\'s lifecycle page).'],
    instructions_id: ['Periksa status driver dan firmware di aplikasi Surface (Help & support), lalu gunakan Windows Update untuk memasang yang ditemukan (disarankan).', 'Untuk pembaruan manual, pilih model Surface Anda di halaman dukungan lalu ikuti tautan yang ditampilkan.', 'Tiap model Surface menerima pembaruan driver dan firmware sampai tanggal akhir layanannya (lihat halaman siklus hidup Microsoft).'],
    notes: 'Lifecycle dates: https://learn.microsoft.com/surface/surface-driver-firmware-lifecycle-support',
    sources: src('microsoft-surface-drivers', 'https://support.microsoft.com/en-us/surface/drivers-firmware/download-drivers-and-firmware-for-surface', F),
  },
  {
    ...base, id: 'dell', name: 'Dell', kind: 'oem', homepage_url: 'https://www.dell.com/',
    support_url: 'https://www.dell.com/support/home/en-us', driver_search_url: 'https://www.dell.com/support/home/en-us?app=drivers',
    domains: ['dell.com', '*.dell.com'], usb_vendor_ids: ['413C'], requires: ['serial_number', 'product_selection'],
    instructions: ['Open Drivers & Downloads and identify the product by Service Tag, Dell EMC Product ID or model.', 'Pick your operating system and category, then download the package; each driver page lists its file hashes.'],
    instructions_id: ['Buka Drivers & Downloads dan identifikasi produk berdasarkan Service Tag, Dell EMC Product ID, atau model.', 'Pilih sistem operasi dan kategori, lalu unduh paketnya; setiap halaman driver mencantumkan hash berkasnya.'],
    notes: 'Service Tag is printed on the device and shown in the BIOS.',
    notes_id: 'Service Tag tercetak pada perangkat dan ditampilkan di BIOS.',
    sources: src('dell-drivers', 'https://www.dell.com/support/home/en-us?app=drivers', F),
  },
  {
    ...base, id: 'hp', name: 'HP', kind: 'oem', homepage_url: 'https://www.hp.com/',
    support_url: 'https://support.hp.com/us-en', driver_search_url: 'https://support.hp.com/us-en/drivers',
    detection_tool: { name: 'HP Image Assistant', url: 'https://ftp.hp.com/pub/caps-softpaq/cmit/HPIA.html' },
    domains: ['hp.com', '*.hp.com'], usb_vendor_ids: ['03F0'], requires: ['product_selection', 'auto_detect_tool'],
    instructions: ['Open Software and Drivers, choose Laptop, Desktop, Printer or Other, then identify the product (Identify, Download, Install).', 'IT staff can use HP Image Assistant to analyse an HP PC and recommend driver, BIOS and software updates.'],
    instructions_id: ['Buka Software and Drivers, pilih Laptop, Desktop, Printer, atau Other, lalu identifikasi produk (Identify, Download, Install).', 'Staf TI dapat memakai HP Image Assistant untuk menganalisis PC HP dan merekomendasikan pembaruan driver, BIOS, dan perangkat lunak.'],
    notes: 'Signing in to an HP account is optional on the page.',
    sources: src('hp-drivers', 'https://support.hp.com/us-en/drivers', F),
  },
  {
    ...base, id: 'lenovo', name: 'Lenovo', kind: 'oem', homepage_url: 'https://www.lenovo.com/',
    support_url: 'https://support.lenovo.com/', driver_search_url: 'https://pcsupport.lenovo.com/',
    domains: ['lenovo.com', '*.lenovo.com'], usb_vendor_ids: ['17EF'], requires: ['serial_number', 'product_selection'],
    instructions: ['Open Lenovo PC Support and enter the product name or serial number, scan the QR code on the palm rest, or browse the catalog.', 'Open Drivers & Software for the identified product and download the package for your Windows version.'],
    instructions_id: ['Buka Lenovo PC Support lalu masukkan nama produk atau nomor seri, pindai kode QR pada palm rest, atau telusuri katalog.', 'Buka Drivers & Software untuk produk yang teridentifikasi lalu unduh paket untuk versi Windows Anda.'],
    notes: 'The portal redirects to your country or region site.',
    notes_id: 'Portal mengalihkan ke situs negara atau wilayah Anda.',
    sources: src('lenovo-pcsupport', 'https://pcsupport.lenovo.com/', F),
  },
  {
    ...base, id: 'asus', name: 'ASUS', kind: 'oem', homepage_url: 'https://www.asus.com/',
    support_url: 'https://www.asus.com/support/', driver_search_url: 'https://www.asus.com/support/download-center/',
    detection_tool: { name: 'MyASUS for Windows', url: 'https://www.asus.com/support/FAQ/1039718' },
    domains: ['asus.com', '*.asus.com'], usb_vendor_ids: ['0B05'], requires: ['serial_number', 'product_selection', 'auto_detect_tool'],
    instructions: ['Open the Download Center and enter the model or serial number, or select the product type, series and model.', 'On laptops, MyASUS can download drivers directly; the page can also detect this computer\'s serial number after you agree to share it.'],
    instructions_id: ['Buka Download Center lalu masukkan model atau nomor seri, atau pilih tipe produk, seri, dan model.', 'Pada laptop, MyASUS dapat mengunduh driver secara langsung; halaman juga dapat mendeteksi nomor seri komputer ini setelah Anda setuju membagikannya.'],
    notes: 'The model name is printed on the device; ASUS has an article on how to find it.',
    sources: src('asus-download-center', 'https://www.asus.com/support/download-center/', F),
  },
  {
    ...base, id: 'msi', name: 'MSI', kind: 'oem', homepage_url: 'https://www.msi.com/',
    support_url: 'https://www.msi.com/support/contact', driver_search_url: 'https://www.msi.com/support/download/',
    domains: ['msi.com', '*.msi.com'], requires: ['product_selection'],
    instructions: ['Open Download, select the product line (laptops, desktops, motherboards, graphics cards ...), type and model.', 'MSI suggests using Chrome or Edge to download BIOS and drivers.'],
    instructions_id: ['Buka Download, pilih lini produk (laptop, desktop, motherboard, kartu grafis ...), tipe, dan model.', 'MSI menyarankan memakai Chrome atau Edge untuk mengunduh BIOS dan driver.'],
    notes: 'The global site offers a switch to your local MSI site.',
    sources: src('msi-download', 'https://www.msi.com/support/download/', F),
  },
  {
    ...base, id: 'acer', name: 'Acer', kind: 'oem', homepage_url: 'https://www.acer.com/',
    support_url: 'https://www.acer.com/us-en/support/contact-acer', driver_search_url: 'https://www.acer.com/us-en/support/drivers-and-manuals',
    detection_tool: { name: 'Acer serial number detection utility (Windows only)', url: 'https://www.acer.com/us-en/support/drivers-and-manuals' },
    domains: ['acer.com', '*.acer.com'], requires: ['serial_number', 'auto_detect_tool'],
    instructions: ['Open Drivers and Manuals and enter the serial number, SNID or part number (P/N), or type keywords.', 'On Windows you can download Acer\'s serial number detection utility from that page to read the number for you.'],
    instructions_id: ['Buka Drivers and Manuals lalu masukkan nomor seri, SNID, atau part number (P/N), atau ketik kata kunci.', 'Di Windows Anda dapat mengunduh utilitas deteksi nomor seri Acer dari halaman itu untuk membacakan nomornya.'],
    notes: 'The detection utility is offered on the page for Windows operating systems only.',
    sources: src('acer-drivers', 'https://www.acer.com/us-en/support/drivers-and-manuals', F),
  },
  {
    ...base, id: 'gigabyte', name: 'GIGABYTE', kind: 'oem', homepage_url: 'https://www.gigabyte.com/',
    support_url: 'https://www.gigabyte.com/Support', driver_search_url: 'https://www.gigabyte.com/Support/Consumer/Download',
    detection_tool: { name: 'GIGABYTE Control Center', url: 'https://www.gigabyte.com/Consumer/Software/GIGABYTE-Control-Center' },
    domains: ['gigabyte.com', '*.gigabyte.com'], requires: ['product_selection', 'serial_number'],
    instructions: ['Open the Download Center and enter your product model or serial number, or select product line, series, category and model.', 'GIGABYTE Control Center is linked from the page for managing supported GIGABYTE and AORUS products.'],
    instructions_id: ['Buka Download Center lalu masukkan model atau nomor seri produk, atau pilih lini produk, seri, kategori, dan model.', 'GIGABYTE Control Center ditautkan dari halaman untuk mengelola produk GIGABYTE dan AORUS yang didukung.'],
    notes: 'The page also links an article on how to find the product serial number.',
    sources: src('gigabyte-download-center', 'https://www.gigabyte.com/Support/Consumer/Download', F),
  },
  {
    ...base, id: 'asrock', name: 'ASRock', kind: 'component_vendor', homepage_url: 'https://www.asrock.com/',
    support_url: 'https://www.asrock.com/support/index.asp', driver_search_url: 'https://www.asrock.com/support/index.asp?cat=Drivers',
    domains: ['asrock.com', '*.asrock.com'], requires: ['product_selection'],
    instructions: ['Open the Support Center, find your motherboard by model name, then use its Download tab for drivers, BIOS and utilities.', 'The Support Center also explains how to find the serial number and the BIOS version.'],
    instructions_id: ['Buka Support Center, temukan motherboard Anda dengan nama model, lalu gunakan tab Download untuk driver, BIOS, dan utilitas.', 'Support Center juga menjelaskan cara menemukan nomor seri dan versi BIOS.'],
    sources: src('asrock-support', 'https://www.asrock.com/support/index.asp', F),
  },
  {
    ...base, id: 'samsung-storage', name: 'Samsung (consumer storage)', kind: 'component_vendor', homepage_url: 'https://semiconductor.samsung.com/consumer-storage/',
    support_url: 'https://semiconductor.samsung.com/consumer-storage/support/tools/', driver_search_url: 'https://semiconductor.samsung.com/consumer-storage/support/tools/',
    domains: ['samsung.com', '*.samsung.com'], pci_vendor_ids: ['144D'], usb_vendor_ids: ['04E8'], requires: ['product_selection'],
    instructions: ['Open Tools & Software to get Samsung Magician (Windows, macOS, Android) and SSD firmware images by model.', 'Read the firmware release note for your exact model before updating, and back up first.'],
    instructions_id: ['Buka Tools & Software untuk mendapatkan Samsung Magician (Windows, macOS, Android) dan citra firmware SSD berdasarkan model.', 'Baca catatan rilis firmware untuk model Anda sebelum memperbarui, dan lakukan pencadangan terlebih dahulu.'],
    notes: 'Firmware is device specific; ANTO-LTG lists the portal only and never individual firmware files.',
    notes_id: 'Firmware bersifat khusus perangkat; ANTO-LTG hanya mendaftarkan portalnya dan tidak pernah berkas firmware individual.',
    sources: src('samsung-storage-tools', 'https://semiconductor.samsung.com/consumer-storage/support/tools/', F),
  },
  {
    ...base, id: 'ftdi', name: 'FTDI', kind: 'component_vendor', homepage_url: 'https://ftdichip.com/',
    driver_search_url: 'https://ftdichip.com/drivers/vcp-drivers/', domains: ['ftdichip.com', '*.ftdichip.com'], usb_vendor_ids: ['0403'], requires: [],
    instructions: ['Download the VCP (virtual COM port) driver package for your Windows version and processor architecture from the table.', 'FTDI states its drivers may be used only with products based on FTDI parts.'],
    instructions_id: ['Unduh paket driver VCP (virtual COM port) untuk versi Windows dan arsitektur prosesor Anda dari tabel.', 'FTDI menyatakan drivernya hanya boleh dipakai dengan produk berbasis komponen FTDI.'],
    notes: 'The page also lists no-longer-supported releases for Windows XP, Vista and 2000.',
    sources: src('ftdi-vcp-drivers', 'https://ftdichip.com/drivers/vcp-drivers/', F),
  },
  {
    ...base, id: 'silicon-labs', name: 'Silicon Labs', kind: 'component_vendor', homepage_url: 'https://www.silabs.com/',
    driver_search_url: 'https://www.silabs.com/software-and-tools/usb-to-uart-bridge-vcp-drivers', domains: ['silabs.com', '*.silabs.com'], usb_vendor_ids: ['10C4'], requires: [],
    instructions: ['Download the CP210x Universal Windows Driver (or a legacy package if you run an old Windows) from the Downloads tab.', 'Release notes are linked on the Tech Docs tab.'],
    instructions_id: ['Unduh CP210x Universal Windows Driver (atau paket lawas bila Windows Anda sudah tua) dari tab Downloads.', 'Catatan rilis ditautkan pada tab Tech Docs.'],
    sources: src('silabs-cp210x', 'https://www.silabs.com/software-and-tools/usb-to-uart-bridge-vcp-drivers', F),
  },
  {
    ...base, id: 'wch', name: 'WCH (Nanjing Qinheng Microelectronics)', kind: 'component_vendor', homepage_url: 'https://www.wch-ic.com/',
    driver_search_url: 'https://www.wch-ic.com/downloads/CH341SER_EXE.html', domains: ['wch-ic.com', '*.wch-ic.com', 'wch.cn', '*.wch.cn'], usb_vendor_ids: ['1A86'], requires: [],
    instructions: ['Open the CH341SER.EXE page (CH340/CH341 USB-to-serial driver) and use its Download button.', 'The page states WHQL certification and lists the supported Windows versions and chips.'],
    instructions_id: ['Buka halaman CH341SER.EXE (driver USB ke serial CH340/CH341) lalu gunakan tombol Download-nya.', 'Halaman menyatakan sertifikasi WHQL dan mencantumkan versi Windows serta chip yang didukung.'],
    sources: src('wch-ch341ser', 'https://www.wch-ic.com/downloads/CH341SER_EXE.html', F),
  },
  ...[
    ['qualcomm', 'Qualcomm', 'https://www.qualcomm.com/', ['168C', '17CB'], ['0CF3']],
    ['broadcom', 'Broadcom', 'https://www.broadcom.com/', ['14E4'], ['0A5C']],
    ['mediatek', 'MediaTek', 'https://www.mediatek.com/', ['14C3'], ['0E8D']],
  ].map(([id, name, home, pci, usb]) => ({
    ...base, source_kind: 'official_project_site', id, name, kind: 'component_vendor', homepage_url: home, domains: [new URL(home).hostname.replace(/^www\./, ''), `*.${new URL(home).hostname.replace(/^www\./, '')}`], pci_vendor_ids: pci, usb_vendor_ids: usb, requires: [],
    instructions: [`${name} makes Wi-Fi/Bluetooth/network chips. Start at the website of the company that made your laptop or motherboard, and use the hardware ID to confirm the chip.`],
    instructions_id: [`${name} membuat chip Wi-Fi/Bluetooth/jaringan. Mulailah dari situs perusahaan yang membuat laptop atau motherboard Anda, dan gunakan ID perangkat keras untuk memastikan chipnya.`],
    notes: 'Listed so that hardware IDs can be matched to a chip vendor. Only the vendor homepage is recorded; no driver portal was verified.',
    notes_id: 'Didaftarkan agar ID perangkat keras dapat dicocokkan dengan vendor chip. Hanya beranda vendor yang dicatat; tidak ada portal driver yang diverifikasi.',
    sources: [{ id: `${id}-homepage`, kind: 'curated', url: home, retrieved_at: DAY, fields: ['name', 'homepage_url', 'domains', 'pci_vendor_ids', 'usb_vendor_ids'], note: 'Vendor IDs follow the public PCI and USB ID registries; the homepage was not crawled.' }],
  })),
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const doc = await readCatalog(root, 'vendors');
  let added = 0;
  for (const v of vendors) if (!doc.items.some((i) => i.id === v.id)) { doc.items.push(v); added++; }
  doc.updated_at = `${DAY}T00:00:00.000Z`;
  await writeCatalog(root, 'vendors', doc);
  console.log(`vendors: added ${added}, total ${doc.items.length}`);
}

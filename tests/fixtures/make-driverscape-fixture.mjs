// Rebuilds tests/fixtures/driverscape-online-125322.html.
//
// IMPORTANT - this is a RECONSTRUCTION, not a byte-for-byte capture. curl could not reach the site
// from the authoring sandbox (outbound allow-list), so the page text was read through a page-to-
// markdown fetch tool on 2026-10-13 and each row below was transcribed from that text. The HTML
// mirrors the structure seen there (a 4-column table per driver with the labels Device Name:, Driver
// Date, File Size:, Driver Version:, Vendor:, Supported OS: and a "Download" link after it).
import { writeFile } from 'node:fs/promises';

const O = {
  xp32: 'Windows XP 32bit', xp64: 'Windows XP 64bit',
  w7_64_v64: 'Windows 7 64bit, Windows Vista 64bit',
  w10_32_81_7: 'Windows 10 32 bit, Windows 8.1 32bit, Windows 7 32bit',
  w10_32_81_7_v: 'Windows 10 32 bit, Windows 8.1 32bit, Windows 7 32bit, Windows Vista 32bit',
  w10_32_81_7_v_xp: 'Windows 10 32 bit, Windows 8.1 32bit, Windows 7 32bit, Windows Vista 32bit, Windows XP',
  w10_64_81_8: 'Windows 10 64 bit, Windows 8.1 64bit, Windows 8 64bit',
  w10_64_81_7_v_xp64: 'Windows 10 64 bit, Windows 8.1 64bit, Windows 7 64bit, Windows Vista 64bit, Windows XP 64bit',
  w10_64_81_7_v: 'Windows 10 64 bit, Windows 8.1 64bit, Windows 7 64bit, Windows Vista 64bit',
  all_v_xp: 'Windows 10 32 & 64bit, Windows 8.1 32 & 64bit, Windows 7 32 & 64bit, Windows Vista 32 & 64bit, Windows XP',
  all_v: 'Windows 10 32 & 64bit, Windows 8.1 32 & 64bit, Windows 7 32 & 64bit, Windows Vista 32 & 64bit',
};
const VGA = 'Video Controller (VGA Compatible)';
const GBE = 'Realtek PCIe GBE Family Controller';
const HDA = 'Dispositivo de High Definition Audio';
const DA = 'Intel(R) Display-Audio';
const SMB = 'Intel(R) 6 Series/C200 Series Chipset Family SMBus Controller - 1C22';
const MEI = 'Intel(R) 6 Series/C200 Series Management Engine Interface - 1C3A';
const MULTI = [
  '2nd Generation Intel(R) Core(TM) Processor Family DRAM Controller - 0100',
  'Intel(R) 6 Series/C200 Series Chipset Family 2 port Serial ATA Storage Controller - 1C08',
  'Intel(R) 6 Series/C200 Series Chipset Family 4 port Serial ATA Storage Controller - 1C00',
  'Intel(R) 6 Series/C200 Series Chipset Family PCI Express Root Port 1 - 1C10',
  'Intel(R) 6 Series/C200 Series Chipset Family PCI Express Root Port 6 - 1C1A',
  'Intel(R) 6 Series/C200 Series Chipset Family USB Enhanced Host Controller - 1C26',
  'Intel(R) 6 Series/C200 Series Chipset Family USB Enhanced Host Controller - 1C2D',
  'Intel(R) H61 Express Chipset Family LPC Interface Controller - 1C5C',
  'Xeon E3-1200/2nd Generation Intel(R) Core(TM) Processor Family PCI Express Root Port - 0101',
];
// [category, device(s), date, size, version, vendor, supported OS, file path]
const ROWS = [
  ['Graphics Drivers', VGA, '2013-02-04', '23.09M', '6.14.10.5437', 'Intel', O.xp32, '/files/display/intel_HD_Graphics_winxp_145111.zip'],
  [null, VGA, '2013-02-04', '29.67M', '6.14.10.5437', 'Intel', O.xp64, '/files/display/intel_HD_Graphics_winxp64_145111.zip'],
  [null, VGA, '2012-07-31', '83.36M', '8.15.10.2827', 'Intel', O.w7_64_v64, '/files/display/intel_HD_Graphics_152257-w7-64.exe'],
  [null, VGA, '2012-05-29', '126.69M', '9.17.10.2770', 'Intel', O.w10_32_81_7, '/files/display/Intel_HD_Graphics_win8_32_15280b2.zip'],
  [null, VGA, '2012-07-31', '72.72M', '8.15.10.2827', 'Intel', O.w10_32_81_7_v, '/files/display/intel_HD_Graphics_152257-w7-32.exe'],
  [null, VGA, '2015-01-30', '96.5M', '9.17.10.4101', 'Intel', O.w10_32_81_7_v_xp, '/files/misc/intel_hd_graphics_win32_152823.zip'],
  [null, VGA, '2012-05-29', '166.73M', '9.17.10.2770', 'Intel', O.w10_64_81_8, '/files/display/Intel_HD_Graphics_win8_64_15280b2.zip'],
  [null, VGA, '2014-03-20', '139.28M', '9.17.10.3517', 'Intel', O.w10_64_81_7_v_xp64, '/files/misc/intel_hd_grahpics_driver_win7_8_8.1_64_15.28.22.3517.zip'],
  ['Network & Wireless Drivers', GBE, '2014-12-04', '5.73M', '5.830.1204.2014', 'Realtek', 'Windows XP', '/files/misc/Realtek_Ethernet_WinXP_5830_12152014.zip'],
  [null, GBE, '2015-01-15', '5.88M', '106.13.0115.2015', 'Realtek', 'Windows Vista 32 & 64bit', '/files/misc/Realtek_Ethernet_Vista_10613_05202015.zip'],
  [null, GBE, '2015-01-15', '5.93M', '7.092.0115.2015', 'Realtek', 'Windows 7 32 & 64bit', '/files/misc/Realtek_Ethernet_Win7_7092_05202015.zip'],
  [null, GBE, '2015-01-15', '5.84M', '8.038.0115.2015', 'Realtek', 'Windows 8.1 32 & 64bit, Windows 8 32 & 64bit', '/files/misc/Realtek_Ethernet_Win8_8.1_8038_05202015.zip'],
  [null, GBE, '2014-06-17', '5.79M', '8.034.0617.2014', 'Realtek', 'Windows 10 32 & 64bit, Windows 8.1 32 & 64bit, Windows 8 32 & 64bit', '/files/misc/Realtek_Ethernet_Win8_8.1_8034_07242014.zip'],
  ['Audio Drivers', HDA, '2015-06-18', '100.74M', '6.0.1.7541', 'Realtek', O.w10_32_81_7_v, '/files/misc/Realtek_High_Definition_Audio_32bit_Win7_Win8_Win81_Win10_R279.exe'],
  [null, HDA, '2015-06-18', '125.4M', '6.0.1.7541', 'Realtek', O.w10_64_81_7_v, '/files/misc/Realtek_High_Definition_Audio_64bit_Win7_Win8_Win81_Win10_R279.exe'],
  [null, HDA, '2014-06-01', '216.84M', '6.0.1.7259', 'Realtek', O.all_v, '/files/2014/sound/realtek_hd_audio_7259_win.zip'],
  [null, HDA, '2013-12-10', '238.34M', '5.10.0.7111', 'Realtek', O.all_v_xp, '/files/misc/Realtek_Audio_Win8.1_Win8_Win7_6.0.1.7240.zip'],
  [null, DA, '2011-12-06', '18.3M', '5.14.00.3090', 'Intel(R)', O.xp32, '/files/display/Intel_GFX_XP32_6.14.10.5398_PV.exe'],
  [null, DA, '2011-12-06', '23.04M', '5.14.00.3090', 'Intel(R)', O.xp64, '/files/display/Intel_GFX_XP64_6.14.10.5398_PV.exe'],
  [null, DA, '2014-09-09', '69.09M', '6.16.00.3154', 'Intel(R)', O.w10_32_81_7_v, '/files/misc/Intel_hd_grahpics_win32_153332.zip'],
  [null, DA, '2014-09-09', '124.05M', '6.16.00.3154', 'Intel(R)', O.w10_64_81_7_v, '/files/misc/Intel_hd_graphics_win64_153332.zip'],
  [null, DA, '2010-12-29', '82.29M', '7.2.7000.4', 'Intel(R)', O.all_v_xp, '/files/sound/Realtek_HD_Audio_Realtek_Home_Theater_v4.zip'],
  ['System & Chipset Drivers', MULTI, '2013-07-31', '5.1M', '9.2.0.1036', 'Intel', O.all_v_xp, '/files/misc/INF_allOS_9.4.0.1027.exe'],
  [null, 'High Definition Audio Denetleyicisi', '2004-03-05', '218M', '5.10.00.5010', 'Intel', O.w10_32_81_7_v_xp, '/files/misc/AUD_Win8.1_Win8_Win7_XP_6.0.1.7040.zip'],
  [null, 'High Definition Audio Denetleyicisi', '2010-11-24', '2.55M', '9.2.0.1016', 'Intel', O.all_v, '/files/board/intel_inf_9201016pv.zip'],
  [null, SMB, '2012-11-09', '1.42M', '16.2.16.4', 'Synaptics', O.w10_32_81_7, '/files/share/9c8aef21c242fc11db16f52de0cd9053.zip'],
  [null, SMB, '2013-03-04', '1.4M', '16.3.15.2', 'Synaptics', O.w10_32_81_7_v_xp, '/files/share/1ad3825cab54fbd2d51bed0e160e5aac.zip'],
  [null, SMB, '2012-09-27', '64.26M', '16.2.16.2', 'Synaptics', O.w10_64_81_8, '/files/notebook/synaptics_touchpad_16.2.16.2.zip'],
  [null, SMB, '2014-10-01', '83.48M', '18.1.22.5', 'Synaptics', O.w10_64_81_7_v_xp64, '/files/2014/notebook/synaptics_touchpad_18_1_22_5.zip'],
  [null, SMB, '2014-11-05', '122.61M', '17.0.6.23', 'Synaptics', 'Windows 10 32 & 64bit, Windows 8.1 32 & 64bit, Windows 8 32 & 64bit', '/files/2015/notebook/synaptics_touchpad_acer_17_0_6_23_driver.zip'],
  [null, SMB, '2012-09-19', '125.88M', '16.2.10.20', 'Synaptics', 'Windows 10 32 & 64bit, Windows 8.1 32 & 64bit, Windows 7 32bit', '/files/notebook/synaptics_touchpad_16.2.10.20-allos.zip'],
  [null, SMB, '2014-12-04', '171.8M', '18.1.42.2', 'Synaptics', O.all_v_xp, '/files/2015/notebook/synaptics_touchpad_hp_18_1_42_2.zip'],
  [null, MEI, '2014-01-02', '1.92M', '1.2.3.2005', 'Intel', O.w10_64_81_7_v_xp64, '/files/2014/board/intel_chipset_device_10_0_beta_driver.zip'],
  [null, MEI, '2014-08-05', '73.23M', '10.0.27.1012', 'Intel', O.all_v_xp, '/files/2014/board/intel_mei_10_0_27_1012_15m_driver.zip'],
  [null, 'PCI standard PCI-to-PCI bridge', '2010-10-27', '97.23K', '1.3.4.61', 'Matrox Graphics', O.w10_32_81_7_v_xp.replace('Windows XP', 'Windows XP 32bit'), '/files/share/b6daaa28e2454743997583dfcec2b31c.zip'],
];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (s) => encodeURIComponent(s.toLowerCase().replace(/[^a-z0-9()]+/g, '-'));
let body = '';
for (const [cat, dev, date, size, ver, vendor, os, file] of ROWS) {
  if (cat) body += `<h3>${esc(cat)}</h3>\n`;
  const devices = Array.isArray(dev) ? dev : [dev];
  const links = devices.map((d) => `<a href="https://www.driverscape.com/download/${slug(d)}">${esc(d)}</a>`).join('<br>');
  body += `<table>
<tr><td>Device Name:</td><td>${links}</td></tr>
<tr><td>Driver Date</td><td>${date}</td><td>File Size:</td><td>${size}</td></tr>
<tr><td>Driver Version:</td><td>${ver}</td><td>Vendor:</td><td>${esc(vendor)}</td></tr>
<tr><td>Supported OS:</td><td>${esc(os)}</td></tr>
</table>
<p>Please enter verification code, then click the download button.</p>
<a href="https://www.driverscape.com/files${file.replace(/^\/files/, '')}" title="Left-click to start download.">Download</a>
`;
}
const html = `<!doctype html>
<!-- RECONSTRUCTED FIXTURE: transcribed on 2026-10-13 from a page-to-markdown rendering of
     https://www.driverscape.com/manufacturers/online/laptops-desktops/online/125322 (35 driver rows).
     Not a byte-for-byte capture; curl was blocked in the authoring sandbox. -->
<html><head><title>Online Online Drivers Download for Windows 10, 8.1, 7, Vista, XP</title></head><body>
<h2>Online Online Drivers Download</h2>
<p>This page contains the list of device drivers for Online Online.</p>
${body}</body></html>
`;
await writeFile(new URL('./driverscape-online-125322.html', import.meta.url), html);
await writeFile(new URL('./driverscape-robots.txt', import.meta.url), `# RECONSTRUCTED from notes taken on 2026-10-13 when https://www.driverscape.com/robots.txt was read.
# Only the rules that matter for this project are reproduced.
User-agent: *
Disallow: /files/
Disallow: /privacy

User-agent: spbot
Crawl-delay: 30

User-agent: MJ12bot
Disallow: /
`);
console.log(`wrote fixture with ${ROWS.length} rows`);

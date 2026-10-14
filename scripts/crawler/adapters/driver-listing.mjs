// Adapter: third-party driver LISTING pages (aggregators such as DriverScape).
//
// Policy ("lead only"): an aggregator is never an official source. This adapter
//   * reads only the listing page (robots.txt must allow it) and never requests the file links;
//   * records the listing facts (device, vendor, version, date, size, OS) as not_reviewed leads
//     labelled third_party_aggregator, with download.kind = "none";
//   * maps each lead to the matching vendor's official portal so a reader can confirm it there;
//   * raises quality flags for inconsistencies (vendor/device mismatch, filename/version mismatch,
//     localised or generic device names, multi-device rows ...). Flagged leads are held back by the
//     merge step unless a human allows them.
// Parsing is label driven ("Device Name:", "Driver Version:" ...), so layout changes that keep the
// labels do not break it, and an unrecognised table is skipped rather than guessed.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extractTables } from '../lib/html.mjs';
import { cleanText, parseIsoDate, parseSupportedOs, slugify, OS_LABELS } from '../lib/normalize.mjs';
import { parseRobots, isAllowed } from '../lib/robots.mjs';
import { isRetryableError } from '../lib/http.mjs';
import { publicationFor } from '../../lib/publication.mjs';

const LABELS = { 'device name:': 'device', 'driver date': 'date', 'driver date:': 'date', 'file size:': 'size', 'driver version:': 'version', 'vendor:': 'vendor', 'supported os:': 'os' };
const VENDOR_TOKENS = { intel: /\bintel\b/i, realtek: /\brealtek\b/i, nvidia: /\bnvidia\b/i, amd: /\b(amd|ati)\b/i, synaptics: /\bsynaptics\b/i, broadcom: /\bbroadcom\b/i, qualcomm: /\b(qualcomm|atheros)\b/i, matrox: /\bmatrox\b/i, via: /\bvia\b/i, elan: /\belan\b/i, alps: /\balps\b/i };
const NON_ENGLISH = /(\b(dispositivo|denetleyicisi|controlador|contr[oô]leur|p[ée]riph[ée]rique|ger[äa]t|dispositif|adaptador|aygıt|устройство)\b)|[^\u0000-\u024f]/i;
const GENERIC = /^(pci standard|standard (sata|pci|usb|ide)|generic|unknown device|microsoft basic)/i;

const vendorKey = (text) => Object.entries(VENDOR_TOKENS).find(([, re]) => re.test(text ?? ''))?.[0] ?? null;

export function inferComponent(device) {
  const d = device.toLowerCase();
  if (/audio|sound|hdmi|high definition audio/.test(d)) return 'audio';
  if (/video|graphics|display|vga/.test(d)) return 'graphics';
  if (/ethernet|gbe|network|nic\b|lan\b/.test(d)) return 'network-ethernet';
  if (/wireless|wi-?fi|wlan/.test(d)) return 'network-wifi';
  if (/bluetooth/.test(d)) return 'bluetooth';
  if (/sata|storage|nvme|ahci|raid/.test(d)) return 'storage';
  if (/usb/.test(d)) return 'usb';
  if (/touchpad|mouse|keyboard|hid/.test(d)) return 'input';
  if (/chipset|smbus|management engine|pci express|lpc|dram|bridge|host/.test(d)) return 'chipset';
  return 'other';
}

// Version-like tokens inside a file name. Dotted versions (15.28.22.3517) win; underscore-joined ones
// (10_0_27_1012) are only considered when no dotted version exists, and OS words such as "Win8_8.1"
// or build stamps such as 05202015 are not mistaken for versions (parts are short, boundaries strict).
function versionTokens(fileName) {
  const dotted = [...fileName.matchAll(/(?<![A-Za-z0-9])(\d{1,5}(?:\.\d{1,5}){2,})(?![A-Za-z0-9])/g)].map((m) => m[1]);
  if (dotted.length) return dotted;
  return [...fileName.matchAll(/(?<![A-Za-z0-9])(\d{1,4}(?:_\d{1,4}){2,})(?![A-Za-z0-9])/g)].map((m) => m[1].replace(/_/g, '.'));
}

export function qualityFlags({ devices, vendor, version, date, osText, osParsed, fileName }) {
  const flags = new Set();
  const deviceText = devices.join(' ');
  if (devices.length > 1) flags.add('multi_device_row');
  if (devices.some((d) => NON_ENGLISH.test(d))) flags.add('non_english_name');
  if (devices.every((d) => GENERIC.test(d))) flags.add('generic_device_name');
  const dv = vendorKey(deviceText); const lv = vendorKey(vendor);
  if (dv && lv && dv !== lv) flags.add('vendor_device_mismatch');
  const fv = vendorKey((fileName ?? '').replace(/[_\-.]+/g, ' '));
  if (fv && lv && fv !== lv) flags.add('filename_vendor_mismatch');
  const tokens = versionTokens(fileName ?? '');
  if (tokens.length && !tokens.some((t) => t === version)) flags.add('filename_version_mismatch');
  if (date && Number(date.slice(0, 4)) < 2006 && osParsed.some((o) => ['windows-7', 'windows-8', 'windows-8-1', 'windows-10', 'windows-11'].includes(o.os))) flags.add('date_inconsistent');
  const newest = osParsed.map((o) => o.os);
  if (!newest.some((o) => ['windows-10', 'windows-11'].includes(o))) flags.add('legacy_os_only');
  if (newest.some((o) => ['windows-xp', 'windows-vista', 'windows-7', 'windows-8', 'windows-8-1'].includes(o))) flags.add('lists_end_of_support_os');
  if (osParsed.some((o) => !o.architectures.length)) flags.add('architecture_not_stated');
  return [...flags].sort();
}

export async function parseListing(html, { url, observedAt, vendors, robotsFor }) {
  const proposals = []; const errors = []; let row = 0;
  for (const table of extractTables(html)) {
    const cells = table.rows.flat();
    const fields = {};
    for (let i = 0; i < cells.length - 1; i++) {
      const key = LABELS[cells[i].text.toLowerCase()];
      if (key && !(key in fields)) fields[key] = cells[i + 1];
    }
    if (!fields.device || !fields.version || !fields.os) continue; // not a driver row
    row++;
    const devices = (fields.device.links.length ? fields.device.links.map((l) => l.text) : [fields.device.text]).map((t) => cleanText(t, 160)).filter(Boolean);
    const vendor = cleanText(fields.vendor?.text ?? '', 80);
    const version = cleanText(fields.version.text, 64);
    const date = parseIsoDate(fields.date?.text);
    const osParsed = parseSupportedOs(fields.os.text);
    const downloadLink = table.after && /download/i.test(table.after.text) ? table.after : null;
    let filePath = null; let fileName = null; let fileRobots = 'unknown';
    if (downloadLink) {
      try {
        const abs = new URL(downloadLink.href, url);
        filePath = abs.pathname; fileName = decodeURIComponent(abs.pathname.split('/').pop() ?? '');
        const verdict = await robotsFor(abs);
        fileRobots = verdict === null ? 'unknown' : verdict ? 'allowed' : 'disallowed';
      } catch { /* ignore a malformed link */ }
    }
    const flags = qualityFlags({ devices, vendor, version, date, osText: fields.os.text, osParsed, fileName });
    if (fileRobots === 'disallowed') flags.push('download_path_robots_disallowed');
    flags.push('download_gated_by_verification_code');
    flags.sort();

    const osTag = osParsed.map((o) => `${o.os}-${o.architectures.join('')}`).join(' ');
    const uniq = createHash('sha1').update(`${fileName ?? ''}|${osTag}|${version}|${devices.join('|')}`).digest('hex').slice(0, 6);
    const target = `${slugify(`${devices[0]} ${version}`, 50)}-${uniq}`;
    const ownerKey = vendorKey(devices.join(' ')) ?? vendorKey(vendor);
    const owner = vendors.find((v) => v.id === ownerKey && v.driver_search_url);
    if (!owner) { errors.push({ target, code: 'NO_OFFICIAL_MAPPING', message: `No official vendor portal in vendors.json for "${vendor || devices[0]}"; a lead without an official source is not proposed.`, retryable: false }); continue; }

    const component = inferComponent(devices.join(' '));
    const windowsVersions = [...new Set(osParsed.map((o) => OS_LABELS[o.os]))];
    const hardwareIds = ownerKey === 'intel' ? [...new Set(devices.map((d) => d.match(/ - ([0-9A-F]{4})$/i)?.[1]).filter(Boolean).map((id) => `PCI\\VEN_8086&DEV_${id.toUpperCase()}`))] : [];
    const fieldsFrom = ['name', 'description', 'manufacturer', 'model', 'version', 'release_date', 'file_size_text', 'os_support', 'windows_versions', 'architectures', ...(hardwareIds.length ? ['hardware_ids'] : [])];
    const shortName = devices.length > 1 ? `${devices[0].replace(/ - [0-9A-F]{4}$/i, '')} and ${devices.length - 1} more devices` : devices[0];
    const record = {
      id: `${slugify(`lead ${devices[0]} ${version}`, 72)}-${uniq}`,
      name: cleanText(`${shortName} - ${version} (aggregator listing)`, 160),
      description: cleanText(`Third-party listing of a ${component} driver "${shortName}" version ${version}${date ? ` dated ${date}` : ''} for ${windowsVersions.join(', ')}. It is a lead to check on the vendor's official page, not a verified package.`, 480),
      publisher: owner.name, manufacturer: owner.name, vendor_id: owner.id, model: devices.length > 1 ? `${devices.length} devices (see evidence)` : devices[0], component, kind: 'catalog_entry',
      source_url: url, source_kind: 'third_party_aggregator',
      official_source: { url: owner.driver_search_url, vendor_id: owner.id, type: 'support_portal', stable: true },
      verification_status: 'not_reviewed', windows_versions: windowsVersions, os_support: osParsed,
      architectures: [...new Set(osParsed.flatMap((o) => o.architectures))],
      version, release_date: date, file_size_text: fields.size ? cleanText(fields.size.text, 32) : null,
      ...(hardwareIds.length ? { hardware_ids: hardwareIds } : {}),
      download: { kind: 'none', requires: ['captcha'] },
      install_instructions: ['Do not use the aggregator\'s file. Open the official vendor portal linked as the official source.', 'Search for the device name or hardware ID and compare the vendor\'s version and date with this lead.', 'Download only from the vendor\'s own page.'],
      install_instructions_id: ['Jangan memakai berkas dari agregator. Buka portal vendor resmi yang ditautkan sebagai sumber resmi.', 'Cari nama perangkat atau ID perangkat keras lalu bandingkan versi dan tanggal dari vendor dengan lead ini.', 'Unduh hanya dari halaman milik vendor.'],
      evidence: [{ type: 'aggregator_listing', url, retrieved_at: observedAt, note: cleanText(`Listing row ${row}: device "${devices.join('; ')}", vendor "${vendor}", date ${fields.date?.text ?? '?'}, size ${fields.size?.text ?? '?'}, version ${version}, OS "${fields.os.text}". The listing asks for a verification code and its file path is ${fileRobots === 'disallowed' ? 'disallowed by the site\'s robots.txt' : 'not checked'}; the file was never requested.`, 500) }],
      quality_flags: flags,
      notes: 'Aggregator lead only. No download link is stored: the listing\'s file path sits behind a verification code and, per the site\'s robots.txt, is not for crawlers. Confirm this version and date on the vendor\'s official page before relying on it.',
      notes_id: 'Hanya lead dari agregator. Tidak ada tautan unduhan yang disimpan: jalur berkas pada listing berada di balik kode verifikasi dan, menurut robots.txt situs, tidak untuk crawler. Konfirmasi versi dan tanggal ini di halaman resmi vendor sebelum diandalkan.',
      tags: ['aggregator-lead', ...(flags.includes('legacy_os_only') ? ['legacy'] : [])],
      sources: [{ id: 'driverscape-online-125322', kind: 'aggregator_listing', url, retrieved_at: observedAt, fields: fieldsFrom, note: 'Third-party aggregator listing; parsed by the label-driven driver-listing adapter.' }],
    };
    record.publication = publicationFor('drivers', record, { now: observedAt });
    proposals.push({
      target, key: `listing:${slugify(url, 60)}:${row}`, catalog: 'drivers', record,
      meta: { adapter: 'driver-listings', crawled_at: `${observedAt}T00:00:00.000Z`, quality_flags: flags, listing: { url, row, vendor_listed: vendor, devices, file_name: fileName, download_path_robots: fileRobots } },
    });
  }
  return { proposals, errors, rows: row };
}

export default {
  id: 'driver-listings',
  describe: 'Label-driven parsing of third-party driver listings into lead-only proposals.',
  async run({ cfg, ctx }) {
    const seeds = JSON.parse(await readFile(new URL(cfg.targets_file, ctx.rootUrl), 'utf8'));
    const targets = ctx.targets?.length ? seeds.targets.filter((t) => ctx.targets.includes(t.id)) : seeds.targets;
    const proposals = []; const errors = []; const attempted = []; const sources = [];
    for (const t of targets) {
      attempted.push(t.id);
      try {
        let html; let robotsFor; let observedAt = ctx.now();
        if (ctx.fixtures?.[t.id]) {
          html = await readFile(ctx.fixtures[t.id].html, 'utf8');
          const robots = ctx.fixtures[t.id].robots ? parseRobots(await readFile(ctx.fixtures[t.id].robots, 'utf8')) : null;
          robotsFor = async (abs) => (robots ? isAllowed(robots, ctx.productToken ?? 'ANTO-LTG-Crawler', abs.pathname + abs.search).allowed : null);
          observedAt = t.observed_at ?? observedAt;
          sources.push({ id: t.id, mode: 'fixture', fixture: ctx.fixtures[t.id].label ?? 'fixture', observed_at: observedAt });
        } else {
          const res = await ctx.client.fetch(t.url, { accept: 'text/html' });
          if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status}`), { code: `HTTP_${res.status}` });
          html = res.text();
          robotsFor = async (abs) => (ctx.client.config.robots ? (await ctx.client.config.robots.check(abs.href)).allowed : null);
          sources.push({ id: t.id, mode: 'live', url: t.url, observed_at: observedAt });
        }
        const result = await parseListing(html, { url: t.url, observedAt: String(observedAt).slice(0, 10), vendors: ctx.vendors ?? [], robotsFor });
        proposals.push(...result.proposals);
        errors.push(...result.errors);
        if (!result.rows) errors.push({ target: t.id, code: 'NO_ROWS', message: 'No driver rows were recognised on the page; the layout may have changed.', retryable: false });
      } catch (err) {
        errors.push({ target: t.id, code: err.code ?? 'EXCEPTION', message: String(err.message ?? err), retryable: isRetryableError(err.code ?? 'EXCEPTION') });
      }
    }
    return { proposals, errors, attempted, source: { id: 'driver-listings', targets: sources }, stats: { targets: targets.length, proposed: proposals.length, failed: errors.length } };
  },
};

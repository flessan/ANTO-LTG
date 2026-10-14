// Hardware-ID parsing and matching (Device Manager > Properties > Details > Hardware Ids).
// Only vendor-level lookups use the vendor directory; device-level matches require a hardware ID that a
// record's own source states. Nothing is inferred about a chip from its device ID alone.
const HWID_RE = /\b(PCI|USB|HDAUDIO|ACPI|BTHENUM|BTH|SCSI|HID)\\(?:FUNC_[0-9A-F]{2}&)?(VEN|VID)_([0-9A-F]{4})(?:&(?:DEV|PID)_([0-9A-F]{4}))?/gi;

export function parseHardwareIds(text) {
  const out = []; const seen = new Set();
  for (const m of String(text ?? '').slice(0, 400_000).matchAll(HWID_RE)) {
    const bus = m[1].toUpperCase(); const vendor = m[3].toUpperCase(); const device = m[4]?.toUpperCase() ?? null;
    const key = `${bus}|${vendor}|${device}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ bus, vendor, device, normalized: `${bus}\\${bus === 'USB' ? 'VID' : 'VEN'}_${vendor}${device ? `&${bus === 'USB' ? 'PID' : 'DEV'}_${device}` : ''}` });
  }
  return out;
}

export function lookupVendor(vendors, parsed) {
  const field = parsed.bus === 'USB' ? 'usb_vendor_ids' : 'pci_vendor_ids';
  return vendors.find((v) => (v[field] ?? []).includes(parsed.vendor)) ?? null;
}

export function matchDriversByHardwareId(drivers, parsed) {
  const exact = []; const sameVendor = [];
  for (const d of drivers) {
    const ids = d.hardware_ids ?? [];
    if (parsed.device && ids.some((id) => id.toUpperCase() === parsed.normalized)) exact.push(d);
    else if (ids.some((id) => id.toUpperCase().startsWith(`${parsed.bus}\\${parsed.bus === 'USB' ? 'VID' : 'VEN'}_${parsed.vendor}`))) sameVendor.push(d);
  }
  return { exact, sameVendor };
}

// Report written by assets/scripts/Get-AntoHardwareReport.ps1 (read-only; no serial numbers, no host name).
export function parseHardwareReport(text) {
  if (typeof text !== 'string' || text.length > 400_000) return { ok: false, error: 'The report is empty or too large.' };
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, error: 'The text is not valid JSON.' }; }
  if (doc?.format !== 'anto-ltg.hardware-report' || doc.format_version !== 1) return { ok: false, error: 'This is not an ANTO-LTG hardware report.' };
  const str = (v, n = 120) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, n) : '');
  const devices = (Array.isArray(doc.devices) ? doc.devices : []).slice(0, 600).map((d) => ({
    name: str(d?.name, 160), problem: Number(d?.problem_code) > 0, problemCode: Number(d?.problem_code) || 0,
    ids: parseHardwareIds((Array.isArray(d?.hardware_ids) ? d.hardware_ids : []).filter((x) => typeof x === 'string').slice(0, 12).join('\n')),
  })).filter((d) => d.ids.length);
  return {
    ok: true,
    report: {
      manufacturer: str(doc.manufacturer), model: str(doc.model), baseboard: str(doc.baseboard),
      os: { caption: str(doc.os?.caption), build: Number(doc.os?.build) || null, arch: str(doc.os?.arch, 20) },
      devices,
    },
  };
}

export function osKeyFromBuild(build) {
  if (!build) return '';
  return build >= 22000 ? 'windows-11' : build >= 10240 ? 'windows-10' : '';
}
export function archFromReport(arch) {
  const a = String(arch).toUpperCase();
  return a === 'AMD64' || a === 'X64' ? 'x64' : a === 'ARM64' ? 'arm64' : a === 'X86' ? 'x86' : '';
}

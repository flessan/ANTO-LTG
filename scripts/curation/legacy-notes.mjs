#!/usr/bin/env node
// The first catalog (before schema 1.1.0) stored its short notes in Indonesian only. The migration moved
// them to `notes_id` and left `notes` empty, so English readers saw nothing. This script adds the English
// side as a plain translation of the same sentences - it adds no new claims. Idempotent: it only fills
// `notes` when it is empty and `notes_id` is exactly one of the known legacy sentences.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalog, writeCatalog } from '../lib/catalog-io.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const LEGACY_NOTES = {
  'Periksa detail versi dan dukungan OS pada halaman penerbit.': 'Check the version details and OS support on the publisher\'s page.',
  'WinGet ID dicatat sebagai metadata awal; paket, versi dan kompatibilitas belum diverifikasi oleh ANTO-LTG.': 'The WinGet ID is recorded as starting metadata; the package, version and compatibility have not been verified by ANTO-LTG.',
  'Periksa versi yang masih didukung dan persyaratan OS di situs penerbit.': 'Check which versions are still supported and the OS requirements on the publisher\'s site.',
  'Tautan menuju halaman penerbit; kompatibilitas versi Windows belum ditinjau oleh ANTO-LTG.': 'Links to the publisher\'s page; Windows version compatibility has not been reviewed by ANTO-LTG.',
  'Gunakan halaman download resmi untuk memilih paket yang sesuai.': 'Use the official download page to choose the right package.',
  'Pastikan ISO yang digunakan berasal dari sumber yang tepercaya.': 'Make sure the ISO you use comes from a trusted source.',
  'Tautan menuju halaman proyek resmi; kompatibilitas belum disahkan oleh katalog ini.': 'Links to the official project page; compatibility has not been confirmed by this catalog.',
  'Periksa paket, iklan bundel, dan kompatibilitas sebelum mendistribusikan.': 'Check the package, bundled offers and compatibility before distributing it.',
  'Periksa edisi gratis/berbayar dan petunjuk resmi sebelum penggunaan.': 'Check the free/paid edition and the official instructions before use.',
};

let changed = 0;
for (const name of ['apps', 'tools']) {
  const doc = await readCatalog(root, name);
  for (const item of doc.items) {
    if (!item.notes && item.notes_id && LEGACY_NOTES[item.notes_id]) { item.notes = LEGACY_NOTES[item.notes_id]; changed++; }
  }
  await writeCatalog(root, name, doc);
}
console.log(`English notes filled in for ${changed} record(s).`);

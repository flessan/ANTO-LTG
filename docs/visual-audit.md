# Visual audit and asset plan

This document records what the visual layer looked like before the overhaul, what was changed, and what is still
missing. The machine-readable record is [`assets/manifest.json`](../assets/manifest.json); the human-readable credits are
in [`assets/CREDITS.md`](../assets/CREDITS.md). The data model is described in [data-model.md](data-model.md).

## Inventory (before)

| Area | Found | Problem |
| --- | --- | --- |
| Software cards and tiles | Letter tiles built from the app name and a hash colour | Not app identity; looked like placeholder text |
| Driver cards | Generic component orb (one icon per component type) | Same look for every record of a component; no vendor identity |
| Vendor cards | Generic orb (folder or globe) | No brand marks for 21 vendors |
| Bundles | Generic bundle orb, no cover | Ten-second scan showed nothing about the bundle |
| Tools | Wrench or disc orb | No tool identity |
| Search results (home) | Type icon in an orb | Same icon for every app |
| Navigation and actions | Hand-drawn sprite (52 symbols) | Mixed styles; some symbols unused |
| Photos | 5 Unsplash / Pexels photos, all in banners | Used decoratively; no cover or entry images |
| Icons on disk | `sprite.svg`, `favicon.svg` only | No brand or category icon library |

No images were broken. No console errors or CSS background images for meaningful content were found on the main
pages. Two issues were introduced during this work and fixed: a Lucide glyph overwrote a hand-drawn glyph (restored from
the committed sprite), and an image-element attribute was rejected by the `h()` helper (`data-level`, now `dataset`).

## What was changed

- **Brand marks.** 186 software records and 3 tools carry an exact-product mark from Simple Icons (CC0) or the Iconify
  `logos` set (CC0). 15 vendors have a brand mark. Marks are recorded per target in the manifest.
- **Category and component glyphs.** Lucide (ISC) glyphs for 15 software categories, 9 bundles and 10 hardware components,
  plus 5 interface glyphs (file down and up, link, and two status marks). Every software record without an exact mark falls back to its category glyph.
- **Interface glyphs.** The 50 hand-drawn sprite symbols that the site uses were split into individual files
  (`assets/icons/{navigation,actions,status,hardware}/`) and kept under their original names. Two unused symbols were
  removed. `sprite.svg` is generated from those folders by `scripts/assets/collect-icons.mjs`.
- **Photos.** The five photos are reused across roles and each one is recorded with its targets: page banners, the home
  hero, the desktop wallpaper, and bundle covers. No photo was added, to avoid copying unrelated imagery.
- **Runtime.** `assets/js/lib/visuals.js` reads `api/v1/visuals.json` and renders every card with the fallback chain.
  If an image fails to load, it swaps once to the bundled vector for its group. Photos use `<picture>` with AVIF and
  WebP sources and a JPEG fallback, explicit dimensions and `sizes`.
- **Pages wired.** Software (app tiles, search rows), Drivers (driver and vendor cards), Bundles (cover and chips),
  Tools (tool header), Home (search results), and the status chips and action buttons on Software.

## Fallback chain

Software, tools and vendors: brand mark, then category glyph (or the vendor chip glyph), then bundled vector.
Drivers: vendor brand mark, then component glyph, then the bundled card glyph. Bundles: cover photo, then bundle glyph.
The chain is resolved at build time (`scripts/lib/visuals.mjs`) and repeated in the browser for load failures.

## Coverage (generated from `api/v1/visuals.json`)

| Group | Records | Exact brand mark | Category / component / glyph | Bundled vector only |
| --- | ---: | ---: | ---: | ---: |
| Software apps | 394 | 186 | 208 | 0 |
| Tools | 26 | 3 | 23 | 0 |
| Drivers | 44 | 21 (vendor mark) | 23 (component) | 0 |
| Vendors | 21 | 15 | 0 | 6 |
| Bundles | 9 | cover photo on all 9 | glyph on all 9 | 0 |
| Categories | 15 | n/a | 15 | 0 |

## Known gaps (honest)

- **Most software has no exact brand mark (208 of 394).** Simple Icons and the Iconify logos set do not contain marks for
  most small Windows utilities. Those records show a category glyph, which is a fallback, not an app identity. The
  next step is official artwork from each publisher's site, which could not be fetched from the build environment.
- **No driver product photographs.** Vendor sites were unreachable from the build environment, and driver product images
  would have to be licensed and downloaded from those sites. Driver cards therefore show the manufacturer mark or a
  component glyph. No product image is fabricated.
- **Six vendors have no mark:** ASRock, FTDI, GIGABYTE, Realtek, Silicon Labs and WCH. They show the chip glyph.
- **No app screenshots.** None were collected, so none are shown. The detail view does not invent one.
- **Five photographs only.** The library was not expanded; the existing licensed photos are reused across roles.
- **Alt text is English.** Photo and brand alt text is written in English. Interface strings are translated in English
  and Indonesian.

## Verification

- `npm run validate`: exit 0 (asset manifest, wiring, budgets, credits, visual map schema, generated files, HTML lint).
- Unit and crawler tests: 1146 pass, 0 fail (includes 7 new visual-map tests).
- End-to-end smoke (`E2E_REQUIRED=1 node scripts/test.mjs e2e`): 16 pass, 0 fail, exit 0. The browser was
  `@sparticuz/chromium` (installed with `--no-save`).
- Screenshots at 1440, 820 and 390 px for home, software, drivers, bundles, tools and developers: no horizontal overflow,
  no broken images, no console errors.

## Asset budgets

- SVG icons: 40 KB each at most (largest brand mark is well under this).
- Photo files: 700 KB each at most.
- `assets/img` total: 4 MB at most (currently 3.6 MB).
- `assets/icons` total: about 1.1 MB, all SVG.

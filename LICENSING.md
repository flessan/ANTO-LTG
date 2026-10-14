# Licensing and third-party notices

This file separates what the project's own license covers from what it does not.
The short version: **original code, documentation and original catalog text are MIT** ([`LICENSE`](LICENSE));
**everything listed under "Third-party material" keeps its own license.**

> The choice of MIT for the original work is a recommendation made when this repository was prepared for open-source
> use (it is permissive, simple, widely understood, and what `package.json`, the icon sprite and the image credits
> already assumed). The repository owner decides: if you change it, update the places listed at the end of this file.

## Summary

| Material | License | Where |
| --- | --- | --- |
| ANTO-LTG original code (`assets/js`, `assets/css/aero.css`, `assets/css/pages.css`, `scripts/`, `tests/`, workflows) | MIT | `LICENSE` |
| Documentation (`README*`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/`) | MIT | `LICENSE` |
| Original icon glyphs (`assets/icons/`) | MIT (drawn for this project) | `LICENSE` |
| Catalog text written by contributors (curated records, notes, `*_id` translations, tool notes, bundles) | MIT | `LICENSE` |
| Catalog facts and text derived from `microsoft/winget-pkgs` manifests | MIT, Copyright (c) Microsoft Corporation | below |
| 7.css 0.21.1 (`assets/vendor/7.css/`) | MIT, Copyright (c) 2021 Khang Nguyen Duy | `assets/vendor/7.css/LICENSE` |
| Photographs (`assets/img/`) | **Not MIT.** Unsplash License or Pexels License, per photo | `assets/CREDITS.md`, `assets/manifest.json` |
| Development dependencies (`ajv`, `ajv-formats`, `puppeteer-core`) | MIT, MIT, Apache-2.0 | `package-lock.json` |
| Third-party software and drivers that the catalog *describes* | Their own licenses; **not redistributed here** | the record's `license` field |

## Third-party material

### 7.css (vendored)

Window and control components come from [7.css](https://github.com/khang-nd/7.css) 0.21.1 by Khang Nguyen Duy, MIT
license, Copyright (c) 2021 Khang Nguyen Duy. The files in `assets/vendor/7.css/` are **unmodified** copies from the
npm package, with the original `LICENSE` and `README.md`; `VENDOR.json` records the version, source commit, the
registry integrity value that was verified, and the SHA-256 of each file (`npm run validate` re-checks them).
ANTO-LTG's own styling lives in `assets/css/aero.css` and overrides 7.css only through the cascade.
7.css is loaded from this repository, never from a CDN.

### WinGet package metadata (`microsoft/winget-pkgs`)

Most app records were generated from manifests in [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)
through its public GitHub API: package identifiers, names, publishers, short descriptions, license names and URLs,
versions, release dates, installer URLs, installer types and the publisher-supplied SHA-256 values, together with the
pinned commit in each record's `sources[]`. That repository is licensed as follows, and this notice is reproduced to
satisfy it:

```text
MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Package descriptions were written by manifest authors and are used only to identify the software. They do not make
ANTO-LTG a licensor of that software, and the `license` field of a record describes the *software's* license as stated
by its manifest, for information.

### Photographs

All photographs are third-party works used under the license of the site they came from. Each photo's author,
source page, license, retrieval date, modifications and alt text are in [`assets/manifest.json`](assets/manifest.json)
and, in readable form, in [`assets/CREDITS.md`](assets/CREDITS.md) (generated; do not edit it by hand).

| Photo | Author | License |
| --- | --- | --- |
| Green grass hill under a blue sky | Se. Tsuchiya | [Unsplash License](https://unsplash.com/license) |
| Water droplets on a green leaf | Mark Olsen | [Unsplash License](https://unsplash.com/license) |
| Sunlight through a forest canopy | Haberdoedas | [Unsplash License](https://unsplash.com/license) |
| Aerial view of turquoise ocean water | Iain | [Unsplash License](https://unsplash.com/license) |
| Aircraft wing under a blue sky | Trippy Clicker | [Pexels License](https://www.pexels.com/license/) |

These licenses are not open-source licenses and the images are **not** relicensed under MIT. They are used here as page
banners, the desktop wallpaper, the home hero and bundle covers. If you fork the project, keep the credits, and read those licenses before reusing the images on their own.
The photographs were resized, cropped and re-encoded (and for some, lightly brightened); the originals are not stored in
the repository.

### Icons and brand marks

Icons and logos are stored in `assets/icons/` and are served from this site (no CDN). Each file's source package,
version, license and owner are recorded in [`assets/manifest.json`](assets/manifest.json) and listed in
[`assets/CREDITS.md`](assets/CREDITS.md). The source sets are copied in at build time by
`scripts/assets/collect-icons.mjs`:

| Set | Used for | License |
| --- | --- | --- |
| `simple-icons` (npm, version pinned in `package.json`) | Monochrome brand marks for software and vendors | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) for the icon files; the marks themselves remain their owners' trademarks |
| `@iconify-json/logos` (npm, version pinned) | Full-colour brand logos where the simple set has none (for example Slack, Visual Studio Code) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) for the icon files; trademarks remain their owners' |
| `@iconify-json/devicon` (npm, version pinned) | Logos of developer tools with exact product matches (for example PowerShell, PuTTY, TortoiseGit) | [MIT](https://opensource.org/license/mit) for the icon files; trademarks remain their owners' |
| `@iconify-json/cib` (npm, version pinned) | Brand logos with exact product matches (for example AdGuard) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) for the icon files; trademarks remain their owners' |
| `@iconify-json/lucide` (npm, version pinned) | Category, bundle, component and interface glyphs | [ISC](https://opensource.org/license/isc-license-txt) |
| ANTO-LTG glyphs and favicon (`assets/icons/navigation`, `actions`, `status`, `hardware`, `favicon.svg`) | Original hand-drawn interface glyphs and the favicon | MIT, as part of this project |

A brand mark is used only for the exact product or company it depicts, to identify it. It is not an endorsement, and
records without an exact mark show a category, component or bundled glyph instead. No driver product photographs are
included; driver cards show the manufacturer mark or a component glyph.

### Development dependencies

`ajv` and `ajv-formats` (JSON Schema validation, MIT) and `puppeteer-core` (browser tests, Apache-2.0) are used only by
the build, tests and developer tools. The icon sets `simple-icons`, `@iconify-json/logos`, `@iconify-json/devicon`, `@iconify-json/cib` and `@iconify-json/lucide` are
dev-only too: their files are copied into the repository, and the packages are not shipped to browsers. They are installed
with `npm ci` from `package-lock.json`. The site has no runtime dependencies.

### Software and drivers described by the catalog

The catalog links to software and drivers; it does **not** host or redistribute them. Each program or driver remains
under its publisher's license and terms, and some downloads are gated by an agreement (EULA) that the person
installing must accept. The generated WinGet script passes `--accept-package-agreements` and
`--accept-source-agreements` only when the person leaves that option on, and says so in the script and in the UI.
Do not contribute installers, firmware or driver binaries to this repository unless their license explicitly allows
redistribution, and say so in the pull request.

### Trademarks and affiliation

Product, vendor and operating-system names (Windows, WinGet, Intel, NVIDIA, AMD, Realtek, Dell, HP, Lenovo, ASUS, MSI,
Acer, GIGABYTE, Samsung and others) are trademarks of their owners. They are used only to identify the products and
sources that records point to. **ANTO-LTG is not affiliated with, endorsed by or sponsored by any of them.**
"Frutiger Aero" and the Windows Vista/7 "Aero" look are used as a visual style reference. The look is produced by 7.css
and ANTO-LTG's own CSS. The project does not include any Microsoft fonts, Windows wallpapers or Windows artwork. The
brand marks above are included only to identify products.

## Where the project license is referenced

If the owner changes the license of the original work, update: `LICENSE`, the `license` field in `package.json`, the
header comment of `assets/icons/sprite.svg`, the sentence in `scripts/assets/credits.mjs` (then run `npm run build` to
regenerate `assets/CREDITS.md`), the license mentions on the site (`footer.license` and `footer.mit` in
`assets/js/i18n/en.js` and `id.js`, and the "Licensing" section of `developers/index.html`), and the License parts of
`README.md`, `README.id.md` and `CONTRIBUTING.md`.

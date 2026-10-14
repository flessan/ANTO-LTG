// Locates a Chrome/Chromium binary for the headless-browser tests.
// Order: CHROME_PATH, well-known install locations, then the optional @sparticuz/chromium package.
// Set E2E_REQUIRED=1 (CI does) to fail instead of skipping when no browser can be found.
import { existsSync } from 'node:fs';

const CANDIDATES = [
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

export async function findBrowser() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) throw new Error(`CHROME_PATH does not exist: ${process.env.CHROME_PATH}`);
    return { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox', '--disable-gpu'], source: 'CHROME_PATH' };
  }
  for (const c of CANDIDATES) if (existsSync(c)) return { executablePath: c, args: ['--no-sandbox', '--disable-gpu'], source: c };
  try {
    process.env.AWS_EXECUTION_ENV ??= 'AWS_Lambda_nodejs22.x'; // makes @sparticuz/chromium unpack the shared libraries it needs
    const mod = await import('@sparticuz/chromium');
    const chromium = mod.default;
    // Drop flags that would weaken or distort the tests: --single-process breaks separate browser contexts, and the
    // web-security / isolation switches would hide the CSP and CORS behaviour the suite checks.
    const UNSAFE = new Set(['--single-process', '--disable-web-security', '--allow-running-insecure-content', '--disable-site-isolation-trials']);
    const args = chromium.args.filter((a) => !UNSAFE.has(a));
    return { executablePath: await chromium.executablePath(), args: [...args, '--no-sandbox'], source: '@sparticuz/chromium' };
  } catch { return null; }
}

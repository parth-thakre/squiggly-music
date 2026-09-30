import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The website's download buttons (site/), served from disk with a mocked GitHub release. Each case
// sets what the browser says about itself before the page's script runs.

const SITE = join(process.cwd(), 'site');
const ORIGIN = 'https://squiggly.test';
const RELEASE_PAGE = 'https://github.com/parth-thakre/squiggly-music/releases/latest';
const url = (name: string) => `https://github.com/parth-thakre/squiggly-music/releases/download/v9.9.9/${name}`;
const ARM = url('Squiggly-Music-9.9.9-macos-arm64.zip');
const INTEL = url('Squiggly-Music-9.9.9-macos-x64.zip');
const SETUP = url('Squiggly-Music-9.9.9-windows-x64-setup.exe');
const RELEASE = {
  tag_name: 'v9.9.9',
  assets: [
    { name: 'Squiggly-Music-9.9.9-windows-x64-setup.exe', size: 90_000_000, browser_download_url: SETUP },
    { name: 'Squiggly-Music-9.9.9-macos-arm64.zip', size: 110_000_000, browser_download_url: ARM },
    { name: 'Squiggly-Music-9.9.9-macos-x64.zip', size: 115_000_000, browser_download_url: INTEL },
  ],
};

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2',
};

const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// What the browser reports. `hints` is the answer to getHighEntropyValues: an architecture, 'reject'
// for a browser that refuses, or null for one without navigator.userAgentData at all.
type Browser = { userAgent: string; platform: string; hints: string | 'reject' | null };

async function open(page: Page, browser: Browser) {
  await page.addInitScript(({ userAgent, platform, hints }) => {
    const define = (name: string, value: unknown) =>
      Object.defineProperty(Navigator.prototype, name, { configurable: true, get: () => value });
    define('userAgent', userAgent);
    define('platform', platform);
    define('maxTouchPoints', 0);
    define('userAgentData', hints === null ? undefined : {
      platform: /Win/.test(platform) ? 'Windows' : 'macOS',
      getHighEntropyValues: () => hints === 'reject'
        ? Promise.reject(new Error('NotAllowedError'))
        : Promise.resolve({ architecture: hints }),
    });
  }, browser);
  await page.route('https://api.github.com/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RELEASE) }));
  await page.route(`${ORIGIN}/**`, async route => {
    const path = normalize(new URL(route.request().url()).pathname);
    const file = join(SITE, path === '/' ? 'index.html' : path);
    if (!file.startsWith(SITE)) return route.fulfill({ status: 404 });
    try {
      await route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: await readFile(file) });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  await page.goto(`${ORIGIN}/`);
  // The release has been read once the version shows.
  await expect(page.locator('[data-version]').first()).toHaveText('9.9.9');
}

const hero = (page: Page) => page.locator('[data-cta]').first();
const download = (page: Page) => page.locator('#download [data-cta]');

for (const [name, browser] of [
  ['Safari', { userAgent: SAFARI, platform: 'MacIntel', hints: null }],
  ['Firefox', { userAgent: FIREFOX, platform: 'MacIntel', hints: null }],
  ['a Chromium browser that refuses the CPU hint', { userAgent: CHROME_MAC, platform: 'MacIntel', hints: 'reject' }],
  ['a Chromium browser with an empty CPU hint', { userAgent: CHROME_MAC, platform: 'MacIntel', hints: '' }],
] as const) {
  test(`a Mac on ${name} gets a button for each CPU`, async ({ page }) => {
    await open(page, browser);
    for (const cta of [hero(page), download(page)]) {
      await expect(cta.getByRole('link', { name: 'Download for Apple silicon' })).toHaveAttribute('href', ARM);
      await expect(cta.getByRole('link', { name: 'Download for Intel' })).toHaveAttribute('href', INTEL);
      await expect(cta.getByRole('link', { name: 'Download for macOS' })).toHaveCount(0);
      await expect(cta.getByText('About This Mac lists a Chip on Apple silicon and a Processor on Intel.')).toBeVisible();
    }
  });
}

for (const [name, hints, href] of [['Intel', 'x86', INTEL], ['Apple silicon', 'arm', ARM]] as const) {
  test(`a Mac whose Chromium browser says ${name} gets that zip`, async ({ page }) => {
    await open(page, { userAgent: CHROME_MAC, platform: 'MacIntel', hints });
    for (const cta of [hero(page), download(page)]) {
      await expect(cta.getByRole('link', { name: 'Download for macOS' })).toHaveAttribute('href', href);
      await expect(cta.getByRole('link', { name: /Apple silicon|Intel/ })).toHaveCount(0);
    }
    await expect(page.locator('.files dt a').first()).toHaveText(name === 'Intel' ? 'macOS, Intel' : 'macOS, Apple silicon');
  });
}

test('another system offers macOS through the release page, which lists both zips', async ({ page }) => {
  await open(page, { userAgent: CHROME_WIN, platform: 'Win32', hints: 'x86' });
  await expect(hero(page).getByRole('link', { name: 'Download for Windows' })).toHaveAttribute('href', SETUP);
  await expect(hero(page).locator('.also').getByRole('link', { name: 'macOS' })).toHaveAttribute('href', RELEASE_PAGE);
});

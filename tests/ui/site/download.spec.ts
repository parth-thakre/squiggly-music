import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The website's download buttons and list (site/), served from disk under a made-up origin with
// GitHub's latest-release answer faked. Each case sets what the browser says about itself before
// the page's script runs.

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
    'Squiggly-Music-9.9.9-windows-x64-setup.exe', 'Squiggly-Music-9.9.9-windows-x64-portable.exe',
    'Squiggly-Music-9.9.9-macos-arm64.zip', 'Squiggly-Music-9.9.9-macos-x64.zip', 'squiggly-music-9.9.9.x86_64.rpm',
    'squiggly-music_9.9.9_amd64.deb', 'Squiggly-Music-9.9.9-x86_64.AppImage', 'Squiggly-Music-9.9.9-android.apk', 'SHA256SUMS',
  ].map(name => ({ name, size: 120_000_000, browser_download_url: url(name) })),
};

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2',
};

const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CHROME_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// What the browser reports. `hints` is the answer to getHighEntropyValues: an architecture, 'reject'
// for a browser that refuses, or null for one without navigator.userAgentData at all.
type Browser = { userAgent: string; platform: string; hints: string | 'reject' | null };

// `offline` makes GitHub unreachable, so the list keeps what the page itself says.
async function open(page: Page, browser: Browser, answer: 'release' | 'offline' = 'release') {
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
  await page.route('https://api.github.com/**', route => answer === 'offline'
    ? route.abort()
    : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RELEASE) }));
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
  if (answer === 'release') await expect(page.locator('[data-version]').first()).toHaveText('9.9.9');
}

const hero = (page: Page) => page.locator('[data-cta]').first();
const download = (page: Page) => page.locator('#download [data-cta]');
const row = (page: Page, name: string) => page.locator('.files > div').filter({ has: page.getByRole('link', { name, exact: true }) });

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

// Chrome doesn't name the distribution, so on Linux the button is the AppImage.
const LINUX: Browser = { userAgent: CHROME_LINUX, platform: 'Linux x86_64', hints: null };

for (const answer of ['release', 'offline'] as const) {
  test(`the AppImage still says it needs libmpv, and where to read how, ${answer === 'release' ? 'once the release fills the list' : 'when GitHub can\'t be reached'}`, async ({ page }) => {
    await open(page, LINUX, answer);
    const appImage = row(page, 'Linux AppImage');
    if (answer === 'release') {
      await expect(appImage).toContainText('Squiggly-Music-9.9.9-x86_64.AppImage, 120 MB');
      await expect(appImage.getByRole('link', { name: 'Linux AppImage' })).toHaveAttribute('href', /\/download\/v9\.9\.9\/Squiggly-Music-9\.9\.9-x86_64\.AppImage$/);
    }
    await expect(appImage).toContainText('needs libmpv installed');
    // The notes under the list say which libmpv to install and link to the release's instructions.
    const notes = page.locator('.notes');
    await expect(notes).toContainText('libmpv2 on Debian and Ubuntu, mpv-libs on Fedora, mpv on Arch');
    await expect(notes.getByRole('link', { name: 'release notes' })).toHaveAttribute('href', RELEASE_PAGE);
  });
}

test('the other files keep what they need once the release fills the list', async ({ page }) => {
  await open(page, LINUX);
  await expect(row(page, 'Fedora RPM')).toContainText('squiggly-music-9.9.9.x86_64.rpm, 120 MB, pulls in mpv-libs');
  await expect(row(page, 'Debian and Ubuntu deb')).toContainText('squiggly-music_9.9.9_amd64.deb, 120 MB, pulls in libmpv2');
  await expect(row(page, 'Windows portable')).toContainText('Squiggly-Music-9.9.9-windows-x64-portable.exe, 120 MB, nothing to install');
  await expect(row(page, 'macOS, Apple silicon')).toContainText('Squiggly-Music-9.9.9-macos-arm64.zip, 120 MB, needs Homebrew\'s mpv');
  await expect(row(page, 'macOS, Intel')).toContainText('Squiggly-Music-9.9.9-macos-x64.zip, 120 MB, needs Homebrew\'s mpv');
});

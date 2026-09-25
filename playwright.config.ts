import { defineConfig } from '@playwright/test';

// Two suites share this file:
// - The player suite (default, `npm run test:ui`): the real browser build in out/web, served by
//   Vite's preview server with the real /api plugin in front of a fake Navidrome account. Each
//   worker starts its own server (tests/ui/fixtures/server.ts), so no webServer entry is needed.
// - The design mockups (`npm run test:mockups`, or SQUIGGLY_UI_MOCKUPS=1): the old mocks pages on
//   the Vite dev server.
// Chromium comes from Playwright's cache (`npx playwright install chromium-headless-shell`), or
// from PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH when set.
const mockups = process.env.SQUIGGLY_UI_MOCKUPS === '1' || process.env.npm_lifecycle_event === 'test:mockups';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
const chromium = { browserName: 'chromium' as const, launchOptions: { executablePath } };

export default mockups ? defineConfig({
  testDir: './tests/ui',
  testMatch: 'mockups.spec.ts',
  use: { ...chromium, baseURL: 'http://127.0.0.1:5194', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 960 } } },
    { name: 'narrow', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 5194',
    url: 'http://127.0.0.1:5194/mocks-2.html',
    reuseExistingServer: false,
  },
}) : defineConfig({
  testDir: './tests/ui/player',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { ...chromium, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', testIgnore: /phone\.spec\.ts/, use: { viewport: { width: 1366, height: 820 } } },
    { name: 'phone', testMatch: /(phone|a11y|qa-regressions)\.spec\.ts/, use: { viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
});

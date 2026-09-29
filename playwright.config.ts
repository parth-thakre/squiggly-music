import { defineConfig } from '@playwright/test';

// The player suite (`npm run test:ui`): the real browser build in out/web, served by Vite's
// preview server with the real /api plugin in front of a fake Navidrome account. Each worker
// starts its own server (tests/ui/fixtures/server.ts), so no webServer entry is needed.
// Chromium comes from Playwright's cache (`npx playwright install chromium-headless-shell`), or
// from PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH when set.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
const chromium = { browserName: 'chromium' as const, launchOptions: { executablePath } };

export default defineConfig({
  testDir: './tests/ui/player',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { ...chromium, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', testIgnore: /(phone|cover)\.spec\.ts/, use: { viewport: { width: 1366, height: 820 } } },
    { name: 'phone', testMatch: /(phone|a11y|qa-regressions)\.spec\.ts/, use: { viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    // The Galaxy Z Flip's cover screens, as a page sees them. Flip 5 and 6: a 748×720 panel (held
    // upright) drawn at density 3.0 into a buffer 1.5 times its size. Flip 7: 948×1048 at 2.625,
    // or at 1.75 with a smaller display size.
    { name: 'cover-flip6', testMatch: /cover\.spec\.ts/, use: { viewport: { width: 374, height: 360 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
    { name: 'cover-flip7', testMatch: /cover\.spec\.ts/, use: { viewport: { width: 361, height: 399 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 } },
    { name: 'cover-flip7-small-text', testMatch: /cover\.spec\.ts/, use: { viewport: { width: 542, height: 599 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1.75 } },
  ],
});

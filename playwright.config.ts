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
    { name: 'desktop', testIgnore: /phone\.spec\.ts/, use: { viewport: { width: 1366, height: 820 } } },
    { name: 'phone', testMatch: /(phone|a11y|qa-regressions)\.spec\.ts/, use: { viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
});

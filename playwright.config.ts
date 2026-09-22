import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  use: {
    baseURL: 'http://127.0.0.1:5194',
    browserName: 'chromium',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 960 } } },
    { name: 'narrow', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 5194',
    url: 'http://127.0.0.1:5194/mocks-2.html',
    reuseExistingServer: false,
  },
});

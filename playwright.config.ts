import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3111',
    // The product is used on a phone; test it as one.
    launchOptions: { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' },
    trace: 'off',
  },
  webServer: {
    command: 'PORT=3111 pnpm start',
    url: 'http://127.0.0.1:3111',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

import { defineConfig } from '@playwright/test';
import { resolveChromiumPath } from './e2e/chromium-path';

// Undefined in normal CI, where Playwright manages its own browser download.
const executablePath = resolveChromiumPath();

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3111',
    launchOptions: executablePath ? { executablePath } : {},
    trace: 'off',
  },
  webServer: {
    command: 'PORT=3111 pnpm start',
    url: 'http://127.0.0.1:3111',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

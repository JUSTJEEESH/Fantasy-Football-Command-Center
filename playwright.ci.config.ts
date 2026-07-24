import { defineConfig } from '@playwright/test';
import { resolveChromiumPath } from './e2e/chromium-path';

// Undefined in normal CI, where Playwright manages its own browser download.
const executablePath = resolveChromiumPath();

/**
 * CI browser-test config.
 *
 * Runs both deployments the project actually ships:
 *  - the server build on :3111 (what you get locally or on Vercel)
 *  - the static export on :3222, mounted under its sub-path exactly as GitHub
 *    Pages serves it
 *
 * Testing only the server build would let a Pages-specific breakage — an
 * unprefixed asset URL, a stripped `_next/` directory — reach production
 * looking green.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  forbidOnly: true,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://127.0.0.1:3111',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },

  // Both servers only START here. The builds run as separate, sequential steps
  // beforehand (see the workflow, or `pnpm build && pnpm build:static`), because
  // Playwright launches webServer entries concurrently and two `next build`
  // runs share one `.next` directory — racing them produced a server bundle
  // that started fine and then behaved incorrectly.
  webServer: [
    {
      command: 'PORT=3111 pnpm start',
      url: 'http://127.0.0.1:3111',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm preview:static',
      url: 'http://127.0.0.1:3222/Fantasy-Football-Command-Center/',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

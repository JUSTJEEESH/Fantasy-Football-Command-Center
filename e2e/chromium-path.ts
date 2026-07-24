import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Locate a Chromium binary.
 *
 * In CI, `playwright install chromium` puts the browser where Playwright
 * expects it and this returns undefined, letting Playwright use its default.
 * Some sandboxes and dev images pre-install Chromium at a pinned path instead
 * (PLAYWRIGHT_BROWSERS_PATH), where Playwright's default lookup misses it
 * because the build number does not match the one it wants.
 *
 * Returning undefined rather than a guess matters: a wrong explicit path fails
 * outright, whereas letting Playwright resolve its own is always correct when
 * the browser was installed normally.
 */
export function resolveChromiumPath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;

  // Prefer a full chromium build over the headless shell: the shell cannot
  // service some APIs the app uses.
  const candidates = readdirSync(root)
    .filter((entry) => entry.startsWith('chromium-'))
    .sort()
    .reverse()
    .map((entry) => join(root, entry, 'chrome-linux', 'chrome'));

  return candidates.find((candidate) => existsSync(candidate));
}

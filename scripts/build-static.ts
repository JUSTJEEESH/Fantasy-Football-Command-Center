/**
 * Build the fully static export for GitHub Pages.
 *
 *   pnpm build:static
 *
 * Why this script exists rather than a plain `next build`:
 *
 * GitHub Pages serves files, not a server. The draft path does not care — it
 * was built to run entirely client-side against a local snapshot — but the news
 * API genuinely needs a database, and Next.js refuses to export a route handler
 * marked `force-dynamic`.
 *
 * Rather than weaken that route into something that pretends to work, the API
 * directory is moved aside for the duration of the static build and restored
 * afterwards. The News page detects the static build and says outright that the
 * feed needs a server deployment, instead of rendering an empty list that would
 * read as "no news today".
 */
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const API_DIR = join(process.cwd(), 'src', 'app', 'api');
const PARKED_DIR = join(process.cwd(), '.api-parked');

function restore(): void {
  if (existsSync(PARKED_DIR)) {
    if (existsSync(API_DIR)) rmSync(API_DIR, { recursive: true, force: true });
    renameSync(PARKED_DIR, API_DIR);
  }
}

// Restore on any exit path, including Ctrl-C, so a cancelled build never leaves
// the working tree missing its API routes.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    restore();
    process.exit(1);
  });
}

function main(): void {
  if (existsSync(PARKED_DIR)) {
    console.error(
      `${PARKED_DIR} already exists — a previous build was interrupted. ` +
        'Restore it manually before continuing.',
    );
    process.exit(1);
  }

  const hasApi = existsSync(API_DIR);
  if (hasApi) {
    console.log('Parking server-only API routes (not exportable to a static host)…');
    renameSync(API_DIR, PARKED_DIR);
  }

  try {
    const result = spawnSync('pnpm', ['exec', 'next', 'build'], {
      stdio: 'inherit',
      env: { ...process.env, STATIC_EXPORT: '1' },
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  } finally {
    restore();
    if (hasApi) console.log('Restored API routes.');
  }

  // GitHub Pages runs Jekyll by default, which silently ignores any directory
  // beginning with an underscore. That would strip _next/ and leave the site
  // serving nothing but 404s, with no error to explain why.
  writeFileSync(join(process.cwd(), 'out', '.nojekyll'), '');
  console.log('Wrote out/.nojekyll (stops Jekyll stripping _next/).');

  console.log('\nStatic export written to ./out');
}

main();

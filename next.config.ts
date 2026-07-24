import type { NextConfig } from 'next';

/**
 * Two build modes.
 *
 * Default: a normal server build (Vercel, a VPS, `pnpm start`) where the news
 * API and database work.
 *
 * `STATIC_EXPORT=1`: a fully static export for GitHub Pages. This is viable
 * only because of the architecture decision made at the start — the draft path
 * runs entirely client-side against a local snapshot, so it needs no server at
 * all. The news feed does need one, and says so rather than rendering empty.
 */
const isStaticExport = process.env.STATIC_EXPORT === '1';

// GitHub Pages serves a project site from /<repo>, so every asset and route
// needs that prefix. Overridable for a custom domain, where it should be empty.
const basePath = isStaticExport
  ? (process.env.BASE_PATH ?? '/Fantasy-Football-Command-Center')
  : '';

const nextConfig: NextConfig = {
  ...(isStaticExport
    ? {
        output: 'export',
        basePath,
        // Pages has no server-side rewriting, so directory-style URLs need the
        // trailing slash to resolve to index.html.
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),

  // Exposed to the client so components can build correct asset URLs under the
  // Pages sub-path.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_STATIC_EXPORT: isStaticExport ? '1' : '',
  },
};

export default nextConfig;

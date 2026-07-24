import type { MetadataRoute } from 'next';

/**
 * Generated rather than a static file in /public, because every URL inside it
 * has to carry the deployment's base path. On GitHub Pages the app lives at
 * /<repo>/, and a manifest pointing at "/" would install a shortcut to the
 * wrong place and load no icon.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Fantasy Coach',
    short_name: 'Coach',
    description: 'Personal AI fantasy football analyst and draft assistant.',
    start_url: `${basePath}/`,
    scope: `${basePath}/`,
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0c10',
    theme_color: '#0a0c10',
    icons: [
      {
        src: `${basePath}/icon.svg`,
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  };
}

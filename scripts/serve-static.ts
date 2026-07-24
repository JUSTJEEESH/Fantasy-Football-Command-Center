/**
 * Serve ./out exactly the way GitHub Pages will — under a /<repo>/ sub-path.
 *
 *   pnpm preview:static
 *
 * Serving the export from the domain root would hide the entire class of bugs
 * that only appear under a sub-path: unprefixed asset URLs, a manifest pointing
 * at "/", links that resolve one level too high. Those are exactly the bugs
 * that make a Pages deployment 404 with no useful error, so the preview mounts
 * the site where it will actually live.
 *
 * Deliberately dependency-free: one less package to keep current for something
 * that only ever serves local files.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const OUT_DIR = resolve(process.cwd(), 'out');
const BASE_PATH = process.env.BASE_PATH ?? '/Fantasy-Football-Command-Center';
const PORT = Number(process.env.PORT ?? 3222);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

if (!existsSync(OUT_DIR)) {
  console.error('No ./out directory. Run `pnpm build:static` first.');
  process.exit(1);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);

  if (!pathname.startsWith(BASE_PATH)) {
    // Pages serves nothing outside the project sub-path; mirror that rather
    // than silently succeeding on URLs that would 404 in production.
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not found. This site is served under ${BASE_PATH}/`);
    return;
  }
  pathname = pathname.slice(BASE_PATH.length) || '/';

  // Contain path traversal: never serve outside ./out.
  const requested = resolve(OUT_DIR, `.${normalize(pathname)}`);
  if (!requested.startsWith(OUT_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  const candidates = [
    requested,
    join(requested, 'index.html'),
    `${requested}.html`,
  ];
  const file = candidates.find((c) => existsSync(c) && statSync(c).isFile());

  if (!file) {
    const notFound = join(OUT_DIR, '404.html');
    if (existsSync(notFound)) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      createReadStream(notFound).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Static preview: http://localhost:${PORT}${BASE_PATH}/`);
});

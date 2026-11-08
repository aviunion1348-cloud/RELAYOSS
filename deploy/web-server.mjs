/**
 * Static server for the `app` service image (Vercel container runtime).
 *
 * This serves the built SPA and nothing else. It is not the API, it holds no
 * database client, and it makes no outbound calls — the API is a separate service
 * reached through the public router, and the browser talks to both through one
 * origin because Vercel's top-level rewrites put them behind the same domain.
 *
 * Two rules it exists to get right:
 *
 *   1. **Deep links resolve.** `/projects/pr_northwind` is a client route, not a
 *      file. Unknown paths return `index.html` so a refresh in the middle of the
 *      app renders the app rather than a 404.
 *
 *   2. **Missing assets still 404.** A blanket rewrite would also answer
 *      `/assets/index-abc123.js` with HTML when the file is absent, and the browser
 *      reports that as "Unexpected token '<'" — a syntax error pointing at the
 *      bundle instead of a 404 pointing at the deploy. Asset paths are excluded from
 *      the rewrite so a stale index.html referencing a purged chunk fails honestly.
 *
 * `/api` is never served here. Vercel routes `/api/(.*)` to the `api` service before
 * a request reaches this container, so a request for `/api/...` arriving here means
 * the routing config is wrong; returning the SPA document for it would disguise
 * that as a client-side error, so it is a JSON 404 instead.
 */
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.WEB_ROOT ?? path.join(here, 'public');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const isAsset = (pathname) => pathname.startsWith('/assets/') || path.extname(pathname) !== '';

/**
 * Resolve a URL path to a file inside ROOT, or null.
 *
 * `path.resolve` + the `startsWith(ROOT)` check is the traversal guard: a request
 * for `/../../etc/passwd` normalises outside ROOT and is refused. Serving static
 * files without this check is the classic static-server path-traversal bug.
 */
function resolveFile(pathname) {
  /*
   * `decodeURIComponent` throws on malformed percent-encoding — `/%E0%A4%A` is
   * enough. Called unguarded inside the request handler, that exception escapes
   * `createServer`'s callback and takes the whole process down: one malformed URL
   * from anyone on the internet ends service for every user until the platform
   * restarts the container. Decoding is therefore treated as fallible input, and a
   * failure resolves to "no such file" rather than an exception.
   */
  let decoded;
  try {
    decoded = decodeURIComponent(pathname.split('?')[0]);
  } catch {
    return null;
  }
  const candidate = path.resolve(ROOT, `.${path.posix.normalize(decoded)}`);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) return null;
  if (!existsSync(candidate)) return null;
  const stat = statSync(candidate);
  if (!stat.isFile()) return null;
  return { file: candidate, size: stat.size, immutable: decoded.startsWith('/assets/') };
}

const server = http.createServer((req, res) => {
  try {
    respond(req, res);
  } catch (err) {
    /*
     * Belt and braces. Any throw that escapes a handler callback terminates the
     * process, so the handler is wrapped: an unexpected failure answers 500 for
     * that one request and leaves the service up for everyone else. Logged, not
     * swallowed — a 500 that nobody can see is worse than a crash that somebody can.
     */
    console.error('web server: unhandled error', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { code: 'internal_error', message: 'The web server failed to serve this request.' } }));
    } else {
      res.end();
    }
  }
});

function respond(req, res) {
  const url = req.url ?? '/';

  // The API is not ours. Answering with the SPA document would turn a routing
  // misconfiguration into a client-side parse error.
  if (url.startsWith('/api/') || url === '/api') {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'The API is served by a different service.' } }));
    return;
  }

  const pathname = url.split('?')[0];
  const hit = resolveFile(pathname);

  if (hit) {
    const type = MIME[path.extname(hit.file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': hit.size,
      // Vite fingerprints asset filenames, so they can be cached forever; the
      // document must not be, or a deploy leaves browsers on the old bundle.
      'cache-control': hit.immutable ? 'public, max-age=31536000, immutable' : 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(hit.file).pipe(res);
    return;
  }

  // A missing asset is a genuine 404. A missing anything else is a client route.
  if (isAsset(pathname)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Not found');
    return;
  }

  const index = path.join(ROOT, 'index.html');
  if (existsSync(index)) {
    const { size } = statSync(index);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': size,
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(index).pipe(res);
    return;
  }

  // Fail loudly: an image without a document is a broken build, and the message
  // must say so rather than returning an empty 200.
  res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify({
      error: { code: 'deployment_misconfigured', message: 'The web build artefact is missing from this image.' },
    }),
  );
}

/*
 * Started only when run as the image's entrypoint.
 *
 * The test suite imports this module to exercise the traversal guard and the
 * asset-versus-document 404 rule against a throwaway root; a module that binds a
 * port on import cannot be tested that way, and `PORT=0` would not help because the
 * suite needs the handle, not the port number.
 */
const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  server.listen(PORT, HOST, () => console.log(`web service listening on ${HOST}:${PORT} (root ${ROOT})`));

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export default server;

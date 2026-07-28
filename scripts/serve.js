#!/usr/bin/env node
/**
 * Minimal static file server for local development and the browser test.
 *
 * A server is required rather than opening the file directly: ES modules are
 * fetched with CORS rules that the file:// origin cannot satisfy, so
 * `<script type="module">` fails outright on a local file.
 *
 * Dependencies: none, on purpose. This is 60 lines of node:http.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Resolve a request path to a file inside ROOT.
 * @returns {string|null} absolute path, or null if the request escapes ROOT
 */
export function resolvePath(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const resolved = join(root, relative === '/' || relative === sep ? 'index.html' : relative);

  // Directory traversal guard: the resolved path must stay under root.
  // `..%2f..%2fetc/passwd` is a real request a scanner will send at any
  // static server it finds, including one someone left running on a laptop.
  if (resolved !== root.replace(/[/\\]$/, '') && !resolved.startsWith(root)) return null;
  return resolved;
}

const server = createServer(async (req, res) => {
  const filePath = resolvePath(ROOT, req.url || '/');
  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');

    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

const port = Number(process.env.PORT) || 8123;
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Kármán serving on http://127.0.0.1:${port}\n`);
});

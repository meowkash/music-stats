import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serves dist/ the way Cloudflare Pages does, plus an optional fixed latency per
 * request. The latency matters: every data-pull regression we care about only
 * shows up when a download is actually in flight during a gesture.
 */
export function startServer({ port = 0, latencyMs = 0 } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let filePath = path.join(ROOT, decodeURIComponent(url.pathname));

    if (url.pathname.endsWith('/')) filePath = path.join(filePath, 'index.html');

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // Data reads must 404 rather than fall through to the SPA shell: serving
      // index.html for a missing /data/ path turns a routing bug into a
      // confusing "Unexpected token '<'" deep inside JSON.parse.
      if (url.pathname.startsWith('/data/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      filePath = path.join(ROOT, 'index.html');
    }

    const send = () => {
      fs.readFile(filePath, (err, body) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(body);
      });
    };

    if (latencyMs > 0) setTimeout(send, latencyMs);
    else send();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        origin: `http://127.0.0.1:${actual}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

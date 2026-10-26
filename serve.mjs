// Minimal static file server (no dependencies). Web Serial needs http://localhost, and ES
// modules do not load from file://, so the dashboard must be served. Loopback only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8',
};
const BLOCKED = ['firmware', 'legacy', 'test', 'node_modules'];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const relative = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^([/\\])+/, '');
    const file = resolve(join(ROOT, relative));
    const top = relative.split(/[/\\]/)[0];
    if (!file.startsWith(ROOT + sep) || BLOCKED.includes(top)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`HARVESTIQ running at http://localhost:${PORT}  (Chrome or Edge)\nPress Ctrl+C to stop.\n`);
});

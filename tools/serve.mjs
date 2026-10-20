/**
 * Dependency-free static file server.
 *
 * Arclight has no build step: the browser loads the ES modules in src/ directly,
 * with `three` resolved through the import map in index.html. All this script has
 * to do is hand files over with the right Content-Type and refuse to serve
 * anything outside the project root.
 *
 * Usage: node tools/serve.mjs [--port 8080] [--no-open]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function parseArgs(argv) {
  const opts = { port: 8080, open: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') opts.port = Number(argv[++i]) || opts.port;
    else if (argv[i] === '--no-open') opts.open = false;
  }
  return opts;
}

/** Resolve a URL path to a file inside ROOT, or null if it escapes. */
function resolveRequestPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (decoded.endsWith('/')) decoded += 'index.html';
  const target = normalize(join(ROOT, decoded));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* opening a browser is a convenience, never a failure */
  }
}

const opts = parseArgs(process.argv.slice(2));

const server = createServer(async (req, res) => {
  const filePath = resolveRequestPath(req.url || '/');
  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: req.url.replace(/\/?$/, '/') }).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      // The whole point of this server is local development; stale modules are
      // far more annoying than re-reading a few hundred kB from disk.
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${opts.port} is already in use. Try: npm start -- --port 8081`);
    process.exit(1);
  }
  throw err;
});

server.listen(opts.port, () => {
  const url = `http://localhost:${opts.port}/`;
  console.log(`\n  ARCLIGHT  ->  ${url}\n  serving ${ROOT}\n  ctrl-c to stop\n`);
  if (opts.open) openBrowser(url);
});

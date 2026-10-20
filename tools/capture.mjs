/**
 * Screenshot helper for tuning the look.
 *
 *   node tools/capture.mjs                       # sandbox, every theme
 *   node tools/capture.mjs --url /?x=1 --out a.png
 *   node tools/capture.mjs --wait "game.ready"   # custom readiness probe
 *
 * Assumes `npm start` is already serving, unless --serve is passed.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Browser, sleep } from './browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = {
    port: 8711,
    out: join(ROOT, 'docs', 'captures'),
    width: 1600,
    height: 900,
    serve: false,
    url: null,
    wait: null,
    settle: 2500,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '--wait') opts.wait = argv[++i];
    else if (a === '--settle') opts.settle = Number(argv[++i]);
    else if (a === '--width') opts.width = Number(argv[++i]);
    else if (a === '--height') opts.height = Number(argv[++i]);
    else if (a === '--serve') opts.serve = true;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

let server = null;
if (opts.serve) {
  server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs'), '--port', String(opts.port), '--no-open'], {
    stdio: 'ignore',
  });
  await sleep(600);
}

const base = `http://localhost:${opts.port}`;
const shots = opts.url
  ? [{ name: 'capture', url: base + opts.url }]
  : ['ridge', 'nocturne', 'hollow'].map((t) => ({
      name: `sandbox-${t}`,
      url: `${base}/tools/sandbox/index.html?theme=${t}&frames=80`,
    }));

const outDir = opts.out.endsWith('.png') ? dirname(opts.out) : opts.out;
await mkdir(outDir, { recursive: true });

const browser = await Browser.launch({ width: opts.width, height: opts.height });
let failures = 0;

try {
  for (const shot of shots) {
    const page = await browser.open(shot.url, { width: opts.width, height: opts.height });
    try {
      if (opts.wait) await page.waitFor(opts.wait, { timeout: 60000 });
      else await sleep(opts.settle);

      const target = opts.out.endsWith('.png') ? opts.out : join(outDir, `${shot.name}.png`);
      await page.screenshot(target);

      const errors = page.errors;
      console.log(`  ${errors.length ? 'x' : 'v'} ${shot.name} -> ${target}`);
      for (const e of errors.slice(0, 8)) console.log(`      ${e.text.split('\n')[0]}`);
      if (errors.length) failures++;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  server?.kill();
}

process.exit(failures ? 1 : 0);

/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Node 22 ships a global WebSocket, so driving a headless browser needs no
 * packages at all — which matters here, because the whole project is meant to
 * clone and run with an empty node_modules.
 *
 * Used by tools/smoke-test.mjs (does the game boot and race without throwing?)
 * and tools/capture.mjs (screenshots for tuning the look).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findBrowser() {
  for (const path of CANDIDATES) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForEndpoint(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(120);
  }
  throw new Error(`browser debug endpoint on port ${port} never came up`);
}

export class Browser {
  constructor(proc, ws, profileDir) {
    this.proc = proc;
    this.ws = ws;
    this.profileDir = profileDir;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id != null) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else entry.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) fn(msg.params, msg.sessionId);
      }
    });
  }

  static async launch({ width = 1280, height = 720, port = 9333, headless = true } = {}) {
    const binary = findBrowser();
    if (!binary) {
      throw new Error(
        'No Chrome or Edge found. Set CHROME_PATH to a Chromium binary and try again.'
      );
    }

    const profileDir = await mkdtemp(join(tmpdir(), 'arclight-cdp-'));
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      // SwiftShader: headless CI machines have no GPU, and a software WebGL2
      // context still exercises every shader we compile.
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
    ];
    if (headless) args.push('--headless=new', '--hide-scrollbars');
    args.push('about:blank');

    const proc = spawn(binary, args, { stdio: 'ignore' });
    const info = await waitForEndpoint(port);

    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
    });

    return new Browser(proc, ws, profileDir);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  on(method, fn) {
    let list = this.handlers.get(method);
    if (!list) this.handlers.set(method, (list = []));
    list.push(fn);
  }

  /** Open a page and attach, returning a Page handle. */
  async open(url, { width = 1280, height = 720 } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.init(width, height);
    await page.goto(url);
    return page;
  }

  async close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
    this.proc.kill();
    // Give Chrome a moment to release the profile directory on Windows.
    await sleep(350);
    await rm(this.profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

export class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    /** Everything the page logged, in order. */
    this.messages = [];
    /** Only the things that should fail a test. */
    this.errors = [];
  }

  async init(width, height) {
    const s = this.sessionId;
    await this.browser.send('Page.enable', {}, s);
    await this.browser.send('Runtime.enable', {}, s);
    await this.browser.send('Log.enable', {}, s);
    await this.browser.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    }, s);

    const record = (level, text, source) => {
      if (!text) return;
      const entry = { level, text, source };
      this.messages.push(entry);
      if (level === 'error') this.errors.push(entry);
    };

    this.browser.on('Runtime.consoleAPICalled', (params, sid) => {
      if (sid !== s) return;
      const text = (params.args || [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ');
      record(params.type === 'error' ? 'error' : params.type === 'warning' ? 'warning' : 'info', text, 'console');
    });

    this.browser.on('Runtime.exceptionThrown', (params, sid) => {
      if (sid !== s) return;
      const d = params.exceptionDetails;
      record('error', d.exception?.description || d.text || 'uncaught exception', 'exception');
    });

    this.browser.on('Log.entryAdded', (params, sid) => {
      if (sid !== s) return;
      const e = params.entry;
      record(e.level === 'error' ? 'error' : e.level === 'warning' ? 'warning' : 'info', e.text, e.source);
    });
  }

  goto(url) {
    return this.browser.send('Page.navigate', { url }, this.sessionId);
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.browser.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true },
      this.sessionId
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text
      );
    }
    return result.result?.value;
  }

  /** Poll an expression until it is truthy, or throw. */
  async waitFor(expression, { timeout = 45000, interval = 200, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let value;
      try {
        value = await this.evaluate(`(() => { try { return (${expression}); } catch { return undefined; } })()`);
      } catch {
        value = undefined;
      }
      if (value) return value;
      await sleep(interval);
    }
    throw new Error(`timed out waiting for: ${label}`);
  }

  async screenshot(path) {
    const { data } = await this.browser.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      this.sessionId
    );
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, Buffer.from(data, 'base64'));
    return path;
  }

  async key(code, key, { type = 'keyDown', windowsVirtualKeyCode = 0 } = {}) {
    await this.browser.send(
      'Input.dispatchKeyEvent',
      { type, code, key, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode },
      this.sessionId
    );
  }

  async tap(code, key, vk) {
    await this.key(code, key, { type: 'keyDown', windowsVirtualKeyCode: vk });
    await sleep(40);
    await this.key(code, key, { type: 'keyUp', windowsVirtualKeyCode: vk });
  }

  async click(x, y) {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.browser.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, this.sessionId);
    await sleep(30);
    await this.browser.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, this.sessionId);
  }

  async close() {
    await this.browser.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}

export { sleep };

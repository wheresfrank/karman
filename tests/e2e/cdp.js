/**
 * A ~100-line Chrome DevTools Protocol client.
 *
 * Playwright would be the obvious choice, but pulling a 150 MB browser
 * download into a project whose entire premise is "no dependencies" is a poor
 * trade. Chrome is already installed; CDP is a WebSocket and JSON, and Node
 * has both built in.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  process.env.CHROME_PATH,
].filter(Boolean);

async function findChrome() {
  const { access } = await import('node:fs/promises');
  for (const path of CHROME_PATHS) {
    try {
      await access(path);
      return path;
    } catch { /* try the next candidate */ }
  }
  throw new Error(`No Chrome found. Set CHROME_PATH. Looked in:\n  ${CHROME_PATHS.join('\n  ')}`);
}

/**
 * Wait for Chrome to publish the port it actually chose.
 *
 * Launched with `--remote-debugging-port=0`, Chrome picks a free port and
 * writes it to DevToolsActivePort in the profile directory. Hardcoding a port
 * instead means two concurrent runs — or one leaked browser from a previous
 * run — collide, and the failure surfaces as a confusing "endpoint never came
 * up" rather than "the port is taken".
 */
async function waitForEndpoint(profile, timeoutMs = 20000) {
  const { readFile } = await import('node:fs/promises');
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const [port] = (await readFile(portFile, 'utf8')).split('\n');
      const response = await fetch(`http://127.0.0.1:${port.trim()}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

export async function launchChrome({ width = 1440, height = 900 } = {}) {
  const binary = await findChrome();
  const profile = await mkdtemp(join(tmpdir(), 'karman-chrome-'));

  const chrome = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    // Headless Chrome has no real GPU, so WebGL2 runs on SwiftShader. Chrome
    // requires this flag to opt into that path explicitly.
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--force-device-scale-factor=1',
    'about:blank',
  ], { stdio: 'ignore' });

  const wsUrl = await waitForEndpoint(profile);
  return {
    wsUrl,
    /**
     * Shut the browser down and wait for it to actually be gone.
     *
     * A bare `kill('SIGTERM')` returns immediately and Chrome can outlive it,
     * which leaves the debugging port bound and makes the *next* run fail
     * with a misleading "DevTools endpoint never came up". Escalate to
     * SIGKILL if it has not exited, and do not resolve until it has.
     */
    async close() {
      if (chrome.exitCode !== null || chrome.signalCode !== null) {
        await rm(profile, { recursive: true, force: true }).catch(() => {});
        return;
      }
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      chrome.kill('SIGTERM');
      const force = setTimeout(() => chrome.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(force);
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Minimal request/response + event wrapper over the CDP socket. */
export class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.method ?? ''})`));
        else resolve(message.result);
        return;
      }
      const handlers = this.listeners.get(message.method);
      if (handlers) for (const handler of handlers) handler(message.params);
    });
  }

  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });
    return new CdpSession(socket);
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
    });
  }

  close() {
    this.socket.close();
  }
}

/** Attach to a fresh tab and return a session bound to it. */
export async function openTab(wsUrl) {
  const browser = await CdpSession.connect(wsUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

  const send = (method, params) => browser.send(method, params, sessionId);
  return { browser, sessionId, send, on: browser.on.bind(browser) };
}

/** Evaluate an expression in the page and return its value. */
export async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {
    // Async wrapper so page snippets can await; `awaitPromise` unwraps it.
    expression: `(async () => { ${expression} })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text;
    throw new Error(`Page evaluation threw: ${text}`);
  }
  return result.result.value;
}

/**
 * Wait until the page has finished booting.
 *
 * Sleeping a fixed 2.5s after navigate looks like it works and then fails
 * roughly one run in five on a loaded machine, because module fetch plus GL
 * initialisation is not a constant. Poll for the real signal instead: either
 * the debug handle exists, or the page has declared its unsupported fallback.
 */
export async function waitForBoot(send, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluate(send, `
      return {
        ready: typeof window.karman !== 'undefined',
        fallback: document.getElementById('stage')?.dataset.fallback ?? null,
      };
    `).catch(() => ({ ready: false, fallback: null }));

    if (state.ready || state.fallback) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The page never finished booting');
}

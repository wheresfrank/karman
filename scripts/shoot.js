#!/usr/bin/env node
/**
 * Capture the page as a visitor actually sees it.
 *
 * The e2e suite drives the solver directly, so its screenshot shows a field
 * shaped by test input. This script only loads the page, waits, optionally
 * drags a pointer across the canvas, and shoots — which is the view that has
 * to earn its keep.
 *
 * Usage: node scripts/shoot.js [--scroll=0.35] [--drag] [--out=name.png]
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { launchChrome, openTab, evaluate } from '../tests/e2e/cdp.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 8422;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const WIDTH = Number(args.width) || 1440;
const HEIGHT = Number(args.height) || 900;
const SETTLE_MS = Number(args.settle) || 4000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(ORIGIN, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('Static server never came up');
}

/** Sweep a pressed pointer along a curve, the way a visitor would. */
async function dragAcross(send) {
  const steps = 46;
  const points = Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1);
    return {
      x: WIDTH * (0.08 + 0.84 * t),
      y: HEIGHT * (0.62 - 0.3 * Math.sin(t * Math.PI * 1.15)),
    };
  });

  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...points[0] });
  for (const point of points) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...point });
    await sleep(16);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, ...points.at(-1) });
}

const server = spawn(process.execPath, ['scripts/serve.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

const chrome = await launchChrome({ width: WIDTH, height: HEIGHT });
const tab = await openTab(chrome.wsUrl);

try {
  await waitForServer();
  await tab.send('Page.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false,
  });
  await tab.send('Page.navigate', { url: ORIGIN });
  await sleep(SETTLE_MS);

  if (args.drag) {
    await dragAcross(tab.send);
    await sleep(Number(args.after) || 900);
  }

  if (args.scroll) {
    await evaluate(tab.send, `
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: max * ${Number(args.scroll)}, behavior: 'instant' });
    `);
    await sleep(1400); // Let the reveal transitions finish.
  }

  const { data } = await tab.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(new URL('../.artifacts/', import.meta.url), { recursive: true });
  const out = new URL(`../.artifacts/${args.out || 'page.png'}`, import.meta.url);
  await writeFile(out, Buffer.from(data, 'base64'));
  process.stdout.write(`wrote ${fileURLToPath(out)}\n`);
} finally {
  tab.browser.close();
  await chrome.close();
  server.kill('SIGTERM');
}

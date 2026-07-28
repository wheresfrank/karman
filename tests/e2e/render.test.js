/**
 * Headless browser test.
 *
 * The unit suite proves the arithmetic. This proves the thing that actually
 * matters and that no unit test can reach: that nine GLSL programs compile on
 * a real driver, that thirty passes per frame run without a GL error, and
 * that light lands on the canvas. A fluid simulator that renders a black
 * rectangle passes every unit test ever written.
 *
 * Run: npm run test:browser   (requires Google Chrome installed)
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { launchChrome, openTab, evaluate, waitForBoot } from './cdp.js';

const PORT = Number(process.env.PORT) || 8321;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

let server;
let chrome;
let tab;
const consoleErrors = [];
const pageErrors = [];

/** Wait for the static server to answer. */
async function waitForServer(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ORIGIN, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Static server never came up');
}

before(async () => {
  server = spawn(process.execPath, ['scripts/serve.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitForServer();

  chrome = await launchChrome();
  tab = await openTab(chrome.wsUrl);

  await tab.send('Runtime.enable');
  await tab.send('Log.enable');
  await tab.send('Page.enable');

  tab.on('Runtime.exceptionThrown', (params) => {
    pageErrors.push(params.exceptionDetails?.exception?.description
      ?? params.exceptionDetails?.text ?? 'unknown exception');
  });
  tab.on('Log.entryAdded', (params) => {
    if (params.entry.level === 'error') consoleErrors.push(params.entry.text);
  });

  await tab.send('Page.navigate', { url: ORIGIN });
  await waitForBoot(tab.send);
  // Then let a few dozen frames of ink accumulate from the opening gesture.
  await new Promise((resolve) => setTimeout(resolve, 1200));
});

after(async () => {
  tab?.browser.close();
  await chrome?.close();
  server?.kill('SIGTERM');
});

test('the page loads without a console error or an uncaught exception', () => {
  assert.deepEqual(pageErrors, [], 'uncaught exceptions on the page');
  assert.deepEqual(consoleErrors, [], 'console errors on the page');
});

test('the simulation initialises rather than falling back', async () => {
  const fallback = await evaluate(tab.send, `
    return document.getElementById('stage').dataset.fallback ?? null;
  `);
  assert.equal(fallback, null, 'the WebGL2 fallback path was taken');
});

test('all nine GLSL programs compiled and linked', async () => {
  const programs = await evaluate(tab.send, `
    return Object.keys(window.karman.solver.programs);
  `);
  assert.equal(programs.length, 9);
  assert.ok(programs.includes('pressure') && programs.includes('vorticity'));
});

test('the solver allocated every field at a sane size', async () => {
  const stats = await evaluate(tab.send, 'return window.karman.solver.stats;');
  assert.ok(stats.simWidth > 0 && stats.simHeight > 0);
  assert.ok(stats.dyeWidth >= stats.simWidth, 'dye grid is at least the velocity grid');
  assert.ok(stats.bytes > 0, 'field memory was reported');
  assert.match(stats.precision, /float/);
});

test('the GPU pipeline runs a frame without raising a GL error', async () => {
  const error = await evaluate(tab.send, `
    const { solver } = window.karman;
    const gl = solver.gl;
    while (gl.getError() !== gl.NO_ERROR) { /* drain prior state */ }
    solver.step(1 / 60);
    solver.render();
    return gl.getError();
  `);
  assert.equal(error, 0, `glGetError returned ${error}`);
});

test('the canvas is actually painting ink, not a black rectangle', async () => {
  const sample = await evaluate(tab.send, `
    const { solver, paint } = window.karman;
    // Deterministic stroke, then let the solver carry it across the field.
    paint(0.5, 0.5, 3000, 1200, 0.9, 1.4);
    for (let i = 0; i < 30; i++) solver.step(1 / 60);
    return window.karman.sample();
  `);

  assert.ok(sample.width > 0 && sample.height > 0, 'the drawing buffer has size');
  assert.ok(sample.max > 40, `brightest pixel was only ${sample.max}`);
  assert.ok(sample.litRatio > 0.01, `only ${(sample.litRatio * 100).toFixed(2)}% of pixels lit`);
});

test('the fluid advects — ink moves between frames', async () => {
  const moved = await evaluate(tab.send, `
    const { solver } = window.karman;
    const gl = solver.gl;
    const read = () => {
      solver.render();
      const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const before = read();
    for (let i = 0; i < 20; i++) solver.step(1 / 60);
    const after = read();

    let changed = 0;
    for (let i = 0; i < before.length; i += 4) {
      if (Math.abs(before[i] - after[i]) > 3) changed++;
    }
    return changed / (before.length / 4);
  `);
  assert.ok(moved > 0.005, `only ${(moved * 100).toFixed(2)}% of pixels changed; the field looks frozen`);
});

test('the pressure solve keeps the velocity field finite', async () => {
  // The failure this guards: vorticity confinement normalises a zero-length
  // vector in still fluid, one NaN enters the velocity texture, and within a
  // few frames the whole field is NaN and the screen is black forever.
  const finite = await evaluate(tab.send, `
    const { solver } = window.karman;
    const gl = solver.gl;
    for (let i = 0; i < 120; i++) solver.step(1 / 60);
    const v = solver.velocity.read;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, v.texture, 0);
    const px = new Float32Array(v.width * v.height * 4);
    gl.readPixels(0, 0, v.width, v.height, gl.RGBA, gl.FLOAT, px);
    gl.deleteFramebuffer(fbo);
    return px.every(Number.isFinite);
  `);
  assert.equal(finite, true, 'the velocity field contains NaN or Infinity');
});

test('the controls are wired to the live config', async () => {
  const result = await evaluate(tab.send, `
    const input = document.getElementById('control-curl');
    input.value = '42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { config: window.karman.config.curl, shown: document.querySelector('output[for="control-curl"]').textContent };
  `);
  assert.equal(result.config, 42);
  assert.equal(result.shown, '42.00');
});

test('the telemetry shows measured values, not placeholders', async () => {
  const values = await evaluate(tab.send, `
    return [...document.querySelectorAll('.stat__value')].map((el) => el.textContent);
  `);
  assert.ok(values.length >= 9, `expected the full readout, got ${values.length} fields`);
  assert.equal(values.filter((v) => v === '—').length, 0, 'some telemetry never populated');
  assert.ok(values.some((v) => /\d+ fps/.test(v)), 'no frame rate reported');
});

test('prefers-reduced-motion renders a still image and stops animating', async () => {
  // The claim is that the page respects the setting rather than merely
  // shortening its transitions: the solver settles into a composition and
  // then stops stepping entirely. Vestibular triggers are not a detail.
  const reduced = await openTab(chrome.wsUrl);
  try {
    await reduced.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await reduced.send('Page.enable');
    await reduced.send('Page.navigate', { url: ORIGIN });
    await waitForBoot(reduced.send);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const state = await evaluate(reduced.send, `
      const first = window.karman.clock.frames;
      await new Promise((r) => setTimeout(r, 900));
      return {
        still: document.getElementById('stage').dataset.still ?? null,
        framesAdvanced: window.karman.clock.frames - first,
        painted: window.karman.sample().max,
        revealed: document.querySelectorAll('[data-reveal][data-revealed="true"]').length,
      };
    `);

    assert.equal(state.still, 'true', 'the still-composition path did not run');
    assert.equal(state.framesAdvanced, 0, 'the animation loop is still running');
    assert.ok(state.painted > 40, 'the still composition is blank');
    assert.ok(state.revealed > 0, 'scroll reveals must be pre-revealed, not stuck hidden');
  } finally {
    reduced.browser.close();
  }
});

test('a full-page screenshot is captured for visual review', async () => {
  const { data } = await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const bytes = Buffer.from(data, 'base64');
  await writeFile(new URL('../../.artifacts/screenshot.png', import.meta.url), bytes);
  assert.ok(bytes.length > 20000, 'screenshot looks suspiciously empty');
});

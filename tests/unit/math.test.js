import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp, lerp, smoothstep, fitGrid, scaleByPixelRatio, correctRadius,
  samplePalette, createFrameClock, tickFrameClock, formatBytes,
} from '../../src/lib/math.js';

test('clamp holds values inside the range', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test('clamp resolves NaN to the low bound rather than propagating it', () => {
  // A NaN reaching a uniform poisons the whole velocity field within a few
  // frames, and the only symptom is a permanently black canvas.
  assert.equal(clamp(NaN, 2, 8), 2);
});

test('lerp interpolates and extrapolates', () => {
  assert.equal(lerp(0, 10, 0.25), 2.5);
  assert.equal(lerp(0, 10, 0), 0);
  assert.equal(lerp(0, 10, 1), 10);
  assert.equal(lerp(0, 10, 2), 20);
});

test('smoothstep eases between edges and clamps outside them', () => {
  assert.equal(smoothstep(0, 1, -0.5), 0);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
  assert.equal(smoothstep(0, 1, 1.5), 1);
  assert.ok(smoothstep(0, 1, 0.25) < 0.25, 'eases in below the midpoint');
});

test('smoothstep survives a degenerate zero-width range', () => {
  assert.equal(smoothstep(1, 1, 0), 0);
  assert.equal(smoothstep(1, 1, 2), 1);
});

test('fitGrid keeps cells square on a landscape viewport', () => {
  const grid = fitGrid(128, 1600, 800);
  assert.equal(grid.height, 128);
  assert.equal(grid.width, 256);
});

test('fitGrid keeps cells square on a portrait viewport', () => {
  const grid = fitGrid(128, 800, 1600);
  assert.equal(grid.width, 128);
  assert.equal(grid.height, 256);
});

test('fitGrid returns a square grid for a square viewport', () => {
  assert.deepEqual(fitGrid(64, 900, 900), { width: 64, height: 64 });
});

test('fitGrid degrades safely when the canvas has no size yet', () => {
  // Fires for real: a display:none canvas measures 0x0 on first layout.
  assert.deepEqual(fitGrid(96, 0, 0), { width: 96, height: 96 });
  assert.deepEqual(fitGrid(96, 100, 0), { width: 96, height: 96 });
});

test('fitGrid never returns a zero dimension', () => {
  const grid = fitGrid(1, 10000, 1);
  assert.ok(grid.width >= 1 && grid.height >= 1);
});

test('scaleByPixelRatio caps the ratio so retina does not triple the work', () => {
  assert.equal(scaleByPixelRatio(500, 1), 500);
  assert.equal(scaleByPixelRatio(500, 2), 1000);
  assert.equal(scaleByPixelRatio(500, 3), 1000, 'capped at 2x by default');
  assert.equal(scaleByPixelRatio(500, 0), 500, 'a bogus ratio falls back to 1');
});

test('scaleByPixelRatio returns whole pixels', () => {
  assert.equal(scaleByPixelRatio(333, 1.5), 499);
  assert.ok(Number.isInteger(scaleByPixelRatio(333, 1.5)));
});

test('correctRadius stretches only on wide viewports', () => {
  assert.equal(correctRadius(0.1, 2), 0.2);
  assert.equal(correctRadius(0.1, 1), 0.1);
  assert.equal(correctRadius(0.1, 0.5), 0.1);
});

test('samplePalette returns the endpoints outside the ramp', () => {
  const stops = [
    { stop: 0, color: [0, 0, 0] },
    { stop: 1, color: [1, 1, 1] },
  ];
  assert.deepEqual(samplePalette(stops, -1), [0, 0, 0]);
  assert.deepEqual(samplePalette(stops, 2), [1, 1, 1]);
});

test('samplePalette interpolates between adjacent stops', () => {
  const stops = [
    { stop: 0, color: [0, 0, 0] },
    { stop: 0.5, color: [1, 0, 0] },
    { stop: 1, color: [1, 1, 1] },
  ];
  assert.deepEqual(samplePalette(stops, 0.25), [0.5, 0, 0]);
  assert.deepEqual(samplePalette(stops, 0.5), [1, 0, 0]);
});

test('samplePalette copies, so a caller cannot mutate the ramp', () => {
  const stops = [{ stop: 0, color: [0.5, 0.5, 0.5] }, { stop: 1, color: [1, 1, 1] }];
  const sampled = samplePalette(stops, 0);
  sampled[0] = 99;
  assert.equal(stops[0].color[0], 0.5);
});

test('samplePalette rejects an empty ramp', () => {
  assert.throws(() => samplePalette([], 0.5), TypeError);
});

test('tickFrameClock clamps the delta after a long stall', () => {
  const clock = createFrameClock(0);
  // A backgrounded tab returns a multi-second delta; fed into advection it
  // traces the whole dye field off the grid in a single frame.
  const dt = tickFrameClock(clock, 5000);
  assert.equal(dt, 1 / 30);
});

test('tickFrameClock reports a normal frame unchanged', () => {
  const clock = createFrameClock(0);
  const dt = tickFrameClock(clock, 16);
  assert.ok(Math.abs(dt - 0.016) < 1e-9);
});

test('tickFrameClock never returns a negative delta', () => {
  const clock = createFrameClock(1000);
  assert.equal(tickFrameClock(clock, 500), 0);
});

test('frame rate seeds on the first sample instead of crawling up from zero', () => {
  const clock = createFrameClock(0);
  tickFrameClock(clock, 20); // 50 fps
  assert.ok(Math.abs(clock.fps - 50) < 1e-6);
});

test('frame rate converges towards a steady cadence', () => {
  const clock = createFrameClock(0);
  let now = 0;
  for (let i = 0; i < 200; i++) {
    now += 16.667;
    tickFrameClock(clock, now);
  }
  assert.ok(Math.abs(clock.fps - 60) < 1, `expected ~60, got ${clock.fps}`);
});

test('formatBytes scales units and stays readable', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(12 * 1024 * 1024), '12 MB');
});

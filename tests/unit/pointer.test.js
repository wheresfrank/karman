import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPointer, movePointer, resetPointer, splatFromPointer, splatRadiusFor, INK,
} from '../../src/sim/pointer.js';
import { DEFAULT_CONFIG } from '../../src/sim/config.js';

test('movePointer converts to texture space with Y flipped', () => {
  const pointer = createPointer();
  movePointer(pointer, 400, 150, 800, 600);
  assert.equal(pointer.texcoordX, 0.5);
  // Pointer events measure from the top; texture space runs bottom-up.
  assert.equal(pointer.texcoordY, 0.75);
});

test('movePointer records the previous position', () => {
  const pointer = createPointer();
  movePointer(pointer, 0, 600, 800, 600);
  movePointer(pointer, 800, 0, 800, 600);
  assert.equal(pointer.prevTexcoordX, 0);
  assert.equal(pointer.texcoordX, 1);
});

test('movePointer scales the delta so strokes feel the same in both axes', () => {
  const wide = createPointer();
  movePointer(wide, 0, 300, 1600, 400); // aspect 4:1
  movePointer(wide, 160, 300, 1600, 400); // 10% of the width

  const tall = createPointer();
  movePointer(tall, 200, 400, 400, 1600);
  movePointer(tall, 200, 240, 400, 1600); // 10% of the height

  // Equal fractions of the long axis must produce equal simulation force.
  assert.ok(Math.abs(Math.abs(wide.deltaX) - Math.abs(tall.deltaY)) < 1e-9);
});

test('movePointer reports whether anything actually moved', () => {
  const pointer = createPointer();
  movePointer(pointer, 100, 100, 800, 600);
  movePointer(pointer, 100, 100, 800, 600);
  assert.equal(pointer.moved, false);

  movePointer(pointer, 101, 100, 800, 600);
  assert.equal(pointer.moved, true);
});

test('movePointer ignores a zero-sized canvas instead of dividing by it', () => {
  const pointer = createPointer();
  movePointer(pointer, 10, 10, 0, 0);
  assert.equal(pointer.texcoordX, 0);
  assert.ok(Number.isFinite(pointer.deltaX));
});

test('resetPointer places the pointer without generating a stroke', () => {
  const pointer = createPointer();
  movePointer(pointer, 0, 0, 800, 600);
  resetPointer(pointer, 700, 500, 800, 600);

  // Without this, a pointerdown far from the last hover fires one enormous
  // splat across the whole canvas.
  assert.equal(pointer.deltaX, 0);
  assert.equal(pointer.deltaY, 0);
  assert.equal(pointer.moved, false);
  assert.equal(pointer.prevTexcoordX, pointer.texcoordX);
});

test('splat intensity saturates rather than blowing out', () => {
  const slow = createPointer();
  movePointer(slow, 400, 300, 800, 600);
  movePointer(slow, 404, 300, 800, 600);

  const fast = createPointer();
  movePointer(fast, 100, 300, 800, 600);
  movePointer(fast, 700, 300, 800, 600);

  const slowSplat = splatFromPointer(slow, DEFAULT_CONFIG);
  const fastSplat = splatFromPointer(fast, DEFAULT_CONFIG);

  const brightness = (s) => Math.max(...s.color);
  assert.ok(brightness(fastSplat) > brightness(slowSplat), 'faster reads brighter');
  assert.ok(brightness(fastSplat) <= 1, 'never exceeds the palette range');
});

test('a stationary pointer produces the coolest ink, not black', () => {
  const pointer = createPointer();
  const splat = splatFromPointer(pointer, DEFAULT_CONFIG);
  assert.ok(Math.max(...splat.color) > 0, 'a still tap still leaves a mark');
});

test('splat force scales with the configured brush force', () => {
  const pointer = createPointer();
  movePointer(pointer, 100, 300, 800, 600);
  movePointer(pointer, 200, 300, 800, 600);

  const weak = splatFromPointer(pointer, { ...DEFAULT_CONFIG, splatForce: 1000 });
  const strong = splatFromPointer(pointer, { ...DEFAULT_CONFIG, splatForce: 8000 });
  assert.ok(Math.abs(strong.dx) > Math.abs(weak.dx));
  assert.ok(Math.abs(strong.dx - weak.dx * 8) < 1e-6);
});

test('splat coordinates stay inside the texture', () => {
  const pointer = createPointer();
  movePointer(pointer, 800, 0, 800, 600);
  const splat = splatFromPointer(pointer, DEFAULT_CONFIG);
  assert.ok(splat.x >= 0 && splat.x <= 1);
  assert.ok(splat.y >= 0 && splat.y <= 1);
});

test('splat radius is corrected so the mark stays circular', () => {
  const wide = splatRadiusFor(DEFAULT_CONFIG, 2);
  const square = splatRadiusFor(DEFAULT_CONFIG, 1);
  assert.ok(wide > square);
  assert.equal(splatRadiusFor(DEFAULT_CONFIG, 0.5), square, 'tall viewports are untouched');
});

test('the ink ramp is ordered, in range, and gets brighter', () => {
  let previousStop = -1;
  let previousLuma = -1;
  for (const { stop, color } of INK) {
    assert.ok(stop > previousStop, 'stops ascend');
    previousStop = stop;
    assert.equal(color.length, 3);
    for (const channel of color) {
      assert.ok(channel >= 0 && channel <= 1, `channel ${channel} out of range`);
    }
    const luma = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
    assert.ok(luma > previousLuma, 'the ramp runs cold to hot');
    previousLuma = luma;
  }
  assert.equal(INK[0].stop, 0);
  assert.equal(INK[INK.length - 1].stop, 1);
});

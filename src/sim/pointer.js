/**
 * Input layer: turns pointer events into force-and-dye injections ("splats").
 *
 * The event plumbing is thin on purpose. The mapping from screen motion to
 * simulation force is pure so it can be tested without a browser, because it
 * is the part that decides how the whole thing *feels*.
 */

import { correctRadius, samplePalette } from '../lib/math.js';

/**
 * Ink palette, sampled by how hard you are pushing.
 *
 * Deliberately not a random hue per splat: random hues read as a rainbow
 * smear and cheapen the image. A narrow ramp that runs cold-to-hot makes the
 * fluid look lit from within, and encodes real information — bright amber is
 * literally where you moved fastest.
 */
export const INK = [
  { stop: 0.0, color: [0.06, 0.11, 0.34] }, // deep indigo, slow drift
  { stop: 0.35, color: [0.05, 0.42, 0.62] }, // teal
  { stop: 0.62, color: [0.28, 0.66, 0.7] }, // pale cyan
  // Brightened from the first pass: at [0.85, 0.52, 0.20] the amber was
  // fractionally *darker* than the pale cyan before it, which put a visible
  // dark ring between a fast stroke's core and its edge.
  { stop: 0.85, color: [0.95, 0.6, 0.24] }, // amber
  { stop: 1.0, color: [1.0, 0.92, 0.78] }, // near-white core
];

export function createPointer(id = -1) {
  return {
    id,
    down: false,
    moved: false,
    texcoordX: 0,
    texcoordY: 0,
    prevTexcoordX: 0,
    prevTexcoordY: 0,
    deltaX: 0,
    deltaY: 0,
    color: [0, 0, 0],
  };
}

/**
 * Record a move in texture coordinates.
 *
 * Y is flipped because pointer events are measured from the top of the
 * viewport while texture space runs bottom-up.
 *
 * The X delta is scaled by aspect ratio: without it, the same physical hand
 * movement produces a larger normalised delta vertically than horizontally on
 * a wide screen, and the fluid feels like it resists sideways strokes.
 */
export function movePointer(pointer, x, y, width, height) {
  if (!(width > 0) || !(height > 0)) return pointer;
  const aspect = width / height;

  pointer.prevTexcoordX = pointer.texcoordX;
  pointer.prevTexcoordY = pointer.texcoordY;
  pointer.texcoordX = x / width;
  pointer.texcoordY = 1 - y / height;

  const dx = (pointer.texcoordX - pointer.prevTexcoordX) * (aspect < 1 ? aspect : 1);
  const dy = (pointer.texcoordY - pointer.prevTexcoordY) * (aspect > 1 ? 1 / aspect : 1);

  pointer.deltaX = dx;
  pointer.deltaY = dy;
  pointer.moved = Math.abs(dx) > 0 || Math.abs(dy) > 0;
  return pointer;
}

/** Place a pointer without generating motion, e.g. on pointerdown. */
export function resetPointer(pointer, x, y, width, height) {
  if (!(width > 0) || !(height > 0)) return pointer;
  pointer.texcoordX = x / width;
  pointer.texcoordY = 1 - y / height;
  pointer.prevTexcoordX = pointer.texcoordX;
  pointer.prevTexcoordY = pointer.texcoordY;
  pointer.deltaX = 0;
  pointer.deltaY = 0;
  pointer.moved = false;
  return pointer;
}

/**
 * Convert a pointer's motion into the arguments for one splat.
 *
 * Speed is mapped through a soft knee rather than used raw: a linear map
 * means a fast flick blows out to white instantly and a careful stroke is
 * invisible. `SPEED_REFERENCE` is the normalised-units-per-event speed that
 * lands mid-palette, tuned by hand against a trackpad and a mouse.
 */
const SPEED_REFERENCE = 0.035;

export function splatFromPointer(pointer, config) {
  const speed = Math.hypot(pointer.deltaX, pointer.deltaY);
  const intensity = speed / (speed + SPEED_REFERENCE); // 0..1, saturating
  const color = samplePalette(INK, intensity);
  const gain = 0.35 + 0.65 * intensity;

  return {
    x: pointer.texcoordX,
    y: pointer.texcoordY,
    dx: pointer.deltaX * config.splatForce,
    dy: pointer.deltaY * config.splatForce,
    color: [color[0] * gain, color[1] * gain, color[2] * gain],
    radius: config.splatRadius / 100,
  };
}

/** Splat radius in texture space, corrected so the mark stays circular. */
export function splatRadiusFor(config, aspect) {
  return correctRadius(config.splatRadius / 100, aspect);
}

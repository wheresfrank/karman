/**
 * Pure numeric helpers shared by the solver, the input layer and the HUD.
 *
 * Nothing in this module touches the DOM or a WebGL context, which is what
 * makes the interesting parts of the simulation testable without a GPU.
 */

/** Constrain `value` to the inclusive range [min, max]. */
export function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** Linear interpolation between `a` and `b`. `t` is not clamped. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Hermite ease between two edges, matching the GLSL smoothstep. */
export function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Fit a square simulation grid to a viewport aspect ratio.
 *
 * The solver works on a fixed number of cells along the *short* axis and
 * stretches the long axis to match, so cells stay square and advection does
 * not skew. A non-square cell is the classic source of directional smearing.
 */
export function fitGrid(resolution, viewportWidth, viewportHeight) {
  const short = Math.max(1, Math.round(resolution));
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) {
    return { width: short, height: short };
  }
  const aspect = viewportWidth / viewportHeight;
  const long = Math.max(1, Math.round(short * (aspect >= 1 ? aspect : 1 / aspect)));
  return aspect >= 1 ? { width: long, height: short } : { width: short, height: long };
}

/**
 * Scale a CSS pixel measurement by device pixel ratio, capped so that a 3x
 * retina display does not quietly ask the GPU for 9x the fragment work.
 */
export function scaleByPixelRatio(cssPixels, pixelRatio, maxRatio = 2) {
  const ratio = clamp(pixelRatio || 1, 1, maxRatio);
  return Math.floor(cssPixels * ratio);
}

/**
 * A splat is drawn as a circle in texture space. Texture space is normalised
 * to 0..1 on both axes, so on a wide viewport an untouched radius paints an
 * ellipse. Stretching the radius along the long axis restores a round splat.
 */
export function correctRadius(radius, aspect) {
  return aspect > 1 ? radius * aspect : radius;
}

/**
 * Sample a colour ramp made of `{ stop, color }` entries, where `stop` is in
 * 0..1 and `color` is an `[r, g, b]` triple in 0..1. Stops must be ascending.
 * Values outside the ramp clamp to the end colours.
 */
export function samplePalette(stops, t) {
  if (!Array.isArray(stops) || stops.length === 0) {
    throw new TypeError('samplePalette requires a non-empty stops array');
  }
  const x = clamp(t, 0, 1);
  if (x <= stops[0].stop) return stops[0].color.slice();
  const last = stops[stops.length - 1];
  if (x >= last.stop) return last.color.slice();

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (x >= a.stop && x <= b.stop) {
      const span = b.stop - a.stop;
      const k = span === 0 ? 0 : (x - a.stop) / span;
      return [
        lerp(a.color[0], b.color[0], k),
        lerp(a.color[1], b.color[1], k),
        lerp(a.color[2], b.color[2], k),
      ];
    }
  }
  return last.color.slice();
}

/**
 * Frame clock with an exponential moving average on the frame rate.
 *
 * `dt` is clamped: a backgrounded tab hands back a multi-second delta on
 * return, and feeding that into semi-Lagrangian advection throws the dye
 * clean off the grid.
 */
export function createFrameClock(nowMs = 0, maxDt = 1 / 30) {
  return { last: nowMs, maxDt, fps: 0, frames: 0 };
}

/** Advance the clock. Returns the clamped delta in seconds. */
export function tickFrameClock(clock, nowMs) {
  const raw = (nowMs - clock.last) / 1000;
  clock.last = nowMs;
  clock.frames++;

  // Guard against clock jumps, first frames and non-monotonic timestamps.
  const dt = clamp(raw, 0, clock.maxDt);
  if (raw > 0) {
    const instant = 1 / raw;
    // Seed on the first real sample so the average does not crawl up from 0.
    clock.fps = clock.fps === 0 ? instant : lerp(clock.fps, instant, 0.1);
  }
  return dt;
}

/** Format a byte count for display, e.g. 12.6 MB. */
export function formatBytes(bytes) {
  if (!(bytes > 0)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  const text = value >= 100 || exponent === 0
    ? String(Math.round(value))
    : value.toFixed(1).replace(/\.0$/, ''); // "12 MB" reads better than "12.0 MB"
  return `${text} ${units[exponent]}`;
}

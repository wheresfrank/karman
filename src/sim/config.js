/**
 * Solver configuration: defaults, bounds and quality tiers.
 *
 * Every tunable lives here with an explicit range so the UI sliders and the
 * solver cannot drift apart, and so a hostile value from a saved URL or a
 * fuzzed input cannot push the solver into a NaN state.
 */

import { clamp } from '../lib/math.js';

/**
 * Bounds are inclusive. `step` is advisory and only used to build sliders.
 *
 * A note on the physics-facing names:
 *  - `velocityDissipation` and `dyeDissipation` are per-second decay rates.
 *    Real incompressible flow does not lose momentum this way; the decay
 *    stands in for viscosity and for dye leaving the visible slab, and it
 *    keeps the simulation from saturating after a few seconds of input.
 *  - `curl` is the strength of vorticity confinement, which re-injects the
 *    small-scale rotation that first-order advection numerically damps out.
 *  - `pressureIterations` is the Jacobi count for the pressure Poisson solve.
 *    More iterations means a more strictly divergence-free field.
 */
export const PARAMETERS = {
  velocityDissipation: { min: 0, max: 4, step: 0.01, default: 0.22 },
  // Dropped from 0.85: at that rate a single stroke was gone in about two
  // seconds, so anyone who drew once and sat back watched the canvas empty
  // itself. At 0.40 strokes linger and layer into each other.
  dyeDissipation: { min: 0, max: 4, step: 0.01, default: 0.4 },
  pressure: { min: 0, max: 1, step: 0.01, default: 0.8 },
  pressureIterations: { min: 1, max: 60, step: 1, default: 22 },
  curl: { min: 0, max: 60, step: 1, default: 26 },
  splatRadius: { min: 0.05, max: 1.2, step: 0.01, default: 0.28 },
  splatForce: { min: 500, max: 12000, step: 100, default: 5200 },
};

export const DEFAULT_CONFIG = Object.freeze({
  simResolution: 128,
  dyeResolution: 1024,
  velocityDissipation: PARAMETERS.velocityDissipation.default,
  dyeDissipation: PARAMETERS.dyeDissipation.default,
  pressure: PARAMETERS.pressure.default,
  pressureIterations: PARAMETERS.pressureIterations.default,
  curl: PARAMETERS.curl.default,
  splatRadius: PARAMETERS.splatRadius.default,
  splatForce: PARAMETERS.splatForce.default,
  shading: true,
  paused: false,
});

/**
 * Numeric coercion that only accepts things that are genuinely numbers.
 *
 * `Number()` alone is too permissive here: `Number(null)`, `Number('')` and
 * `Number(false)` are all 0, which is finite, in range, and completely wrong.
 * A null arriving from a deserialised setting would silently pin a parameter
 * to its minimum instead of falling back to the default.
 */
function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

/**
 * Coerce an arbitrary object into a valid config.
 *
 * Unknown keys are dropped, out-of-range values are clamped and non-numeric
 * values fall back to the default rather than poisoning the solver: a single
 * NaN in the velocity field propagates to the whole grid within a few frames
 * and the only visible symptom is a screen that goes permanently black.
 */
export function sanitizeConfig(input = {}, base = DEFAULT_CONFIG) {
  const out = { ...base };
  for (const [key, bounds] of Object.entries(PARAMETERS)) {
    if (!(key in input)) continue;
    const value = toNumber(input[key]);
    out[key] = Number.isFinite(value) ? clamp(value, bounds.min, bounds.max) : bounds.default;
  }
  if (PARAMETERS.pressureIterations) out.pressureIterations = Math.round(out.pressureIterations);
  if ('shading' in input) out.shading = Boolean(input.shading);
  if ('paused' in input) out.paused = Boolean(input.paused);
  return out;
}

/**
 * Pick grid sizes for the device.
 *
 * The dye grid is what you see, so it is kept high. The velocity grid is only
 * ever sampled as a smooth vector field, so it can be a quarter of the size
 * without a visible difference — and it is the one the pressure solve runs
 * over N times per frame, which makes it the actual cost centre.
 */
export function resolveQuality({ pixelRatio = 1, deviceMemory = 8, coarse = false } = {}) {
  const weak = coarse || deviceMemory <= 4;
  if (weak) return { simResolution: 96, dyeResolution: 512, pressureIterations: 16 };
  if (pixelRatio > 2) return { simResolution: 128, dyeResolution: 768, pressureIterations: 20 };
  return {
    simResolution: DEFAULT_CONFIG.simResolution,
    dyeResolution: DEFAULT_CONFIG.dyeResolution,
    pressureIterations: DEFAULT_CONFIG.pressureIterations,
  };
}

/**
 * Number of full-screen GPU passes for one simulation step, used by the HUD.
 * Fixed passes: curl, vorticity, divergence, pressure clear, gradient
 * subtract, velocity advect, dye advect, display. Plus one per Jacobi sweep.
 */
export function passesPerFrame(config) {
  return 8 + Math.max(0, Math.round(config.pressureIterations));
}

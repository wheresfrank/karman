import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PARAMETERS, DEFAULT_CONFIG, sanitizeConfig, resolveQuality, passesPerFrame,
} from '../../src/sim/config.js';

test('the shipped defaults are inside their own declared bounds', () => {
  // Guards the failure where a hand-tuned default drifts outside the slider
  // range and the first user interaction silently snaps the value.
  for (const [key, bounds] of Object.entries(PARAMETERS)) {
    const value = DEFAULT_CONFIG[key];
    assert.ok(
      value >= bounds.min && value <= bounds.max,
      `${key} default ${value} outside [${bounds.min}, ${bounds.max}]`,
    );
  }
});

test('sanitizeConfig clamps values above and below the range', () => {
  const config = sanitizeConfig({ curl: 5000, pressure: -3 });
  assert.equal(config.curl, PARAMETERS.curl.max);
  assert.equal(config.pressure, PARAMETERS.pressure.min);
});

test('sanitizeConfig replaces non-finite input with the default', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'not a number', null, undefined, {}]) {
    const config = sanitizeConfig({ curl: bad });
    assert.equal(config.curl, PARAMETERS.curl.default, `failed for ${String(bad)}`);
  }
});

test('sanitizeConfig accepts numeric strings from range inputs', () => {
  // <input type="range"> hands back strings; this is the real path.
  const config = sanitizeConfig({ curl: '33' });
  assert.equal(config.curl, 33);
});

test('sanitizeConfig keeps the Jacobi count a whole number', () => {
  const config = sanitizeConfig({ pressureIterations: 12.7 });
  assert.equal(config.pressureIterations, 13);
  assert.ok(Number.isInteger(config.pressureIterations));
});

test('sanitizeConfig drops unknown keys', () => {
  const config = sanitizeConfig({ __proto__: { polluted: true }, nonsense: 1 });
  assert.equal(config.nonsense, undefined);
  assert.equal(config.polluted, undefined);
});

test('sanitizeConfig does not mutate the frozen defaults', () => {
  sanitizeConfig({ curl: 3 });
  assert.equal(DEFAULT_CONFIG.curl, PARAMETERS.curl.default);
});

test('sanitizeConfig preserves untouched keys from the base', () => {
  const config = sanitizeConfig({ curl: 10 }, { ...DEFAULT_CONFIG, simResolution: 64 });
  assert.equal(config.simResolution, 64);
  assert.equal(config.curl, 10);
});

test('sanitizeConfig coerces the boolean flags', () => {
  assert.equal(sanitizeConfig({ shading: 0 }).shading, false);
  assert.equal(sanitizeConfig({ shading: 'yes' }).shading, true);
  assert.equal(sanitizeConfig({}).shading, DEFAULT_CONFIG.shading);
});

test('resolveQuality steps down on a coarse pointer or low memory', () => {
  const weak = resolveQuality({ coarse: true });
  assert.ok(weak.simResolution < DEFAULT_CONFIG.simResolution);
  assert.ok(weak.dyeResolution < DEFAULT_CONFIG.dyeResolution);

  const lowMemory = resolveQuality({ deviceMemory: 2 });
  assert.deepEqual(lowMemory, weak);
});

test('resolveQuality trims the dye grid on a very high density display', () => {
  const dense = resolveQuality({ pixelRatio: 3, deviceMemory: 16 });
  assert.ok(dense.dyeResolution < DEFAULT_CONFIG.dyeResolution);
});

test('resolveQuality returns full quality on a normal desktop', () => {
  const desktop = resolveQuality({ pixelRatio: 2, deviceMemory: 8 });
  assert.equal(desktop.simResolution, DEFAULT_CONFIG.simResolution);
  assert.equal(desktop.dyeResolution, DEFAULT_CONFIG.dyeResolution);
});

test('resolveQuality works with no arguments at all', () => {
  assert.ok(resolveQuality().simResolution > 0);
});

test('passesPerFrame tracks the Jacobi count', () => {
  assert.equal(passesPerFrame({ pressureIterations: 22 }), 30);
  assert.equal(passesPerFrame({ pressureIterations: 1 }), 9);
  assert.equal(passesPerFrame({ pressureIterations: -5 }), 8, 'never below the fixed passes');
});

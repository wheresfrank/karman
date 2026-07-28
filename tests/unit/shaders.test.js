import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as SRC from '../../src/gl/shaders.js';

const FRAGMENT_SHADERS = Object.entries(SRC).filter(([name]) => name !== 'VERTEX_SHADER');

/**
 * These are static checks, not a GPU run — a real compile happens in the
 * headless-browser test. What they catch is the class of mistake that only
 * shows up as a blank black screen: a missing #version directive, a shader
 * that forgets to write its output, or a uniform the JS sets but the GLSL
 * never declared.
 */

test('every shader declares GLSL ES 3.00 on the first line', () => {
  for (const [name, source] of Object.entries(SRC)) {
    assert.ok(
      source.startsWith('#version 300 es\n'),
      `${name} must open with the #version directive, with nothing before it`,
    );
  }
});

test('every fragment shader declares and writes its output', () => {
  for (const [name, source] of FRAGMENT_SHADERS) {
    assert.match(source, /out vec4 fragColor;/, `${name} declares fragColor`);
    assert.match(source, /fragColor\s*=/, `${name} writes fragColor`);
  }
});

test('every fragment shader sets a float precision', () => {
  for (const [name, source] of FRAGMENT_SHADERS) {
    assert.match(source, /precision highp float;/, `${name} sets precision`);
  }
});

test('the vertex shader exports the neighbour taps the solver relies on', () => {
  for (const varying of ['vUv', 'vL', 'vR', 'vB', 'vT']) {
    assert.match(SRC.VERTEX_SHADER, new RegExp(`out vec2 ${varying};`));
  }
});

test('shaders using neighbour taps also declare them as inputs', () => {
  for (const [name, source] of FRAGMENT_SHADERS) {
    const body = source.slice(source.indexOf('void main'));
    for (const varying of ['vL', 'vR', 'vB', 'vT', 'vUv']) {
      if (!new RegExp(`\\b${varying}\\b`).test(body)) continue;
      assert.match(source, new RegExp(`in vec2 ${varying};`), `${name} declares ${varying}`);
    }
  }
});

test('no shader declares a varying it never reads', () => {
  // Unused varyings are silently optimised out, and then the matching
  // getUniformLocation-style lookups quietly return null. Keep them honest.
  for (const [name, source] of FRAGMENT_SHADERS) {
    const declared = [...source.matchAll(/^in vec2 (\w+);$/gm)].map((m) => m[1]);
    const body = source.slice(source.indexOf('void main'));
    for (const varying of declared) {
      assert.match(body, new RegExp(`\\b${varying}\\b`), `${name} declares unused ${varying}`);
    }
  }
});

test('every uniform the solver sets exists in the shader that consumes it', async () => {
  const solverSource = await readFile(new URL('../../src/sim/fluid.js', import.meta.url), 'utf8');

  // Map the JS program names to their GLSL sources.
  const pairs = {
    splat: SRC.SPLAT_SHADER,
    advection: SRC.ADVECTION_SHADER,
    divergence: SRC.DIVERGENCE_SHADER,
    curl: SRC.CURL_SHADER,
    vorticity: SRC.VORTICITY_SHADER,
    pressure: SRC.PRESSURE_SHADER,
    gradientSubtract: SRC.GRADIENT_SUBTRACT_SHADER,
    clear: SRC.CLEAR_SHADER,
    display: SRC.DISPLAY_SHADER,
  };

  // Collect `program.uniforms.NAME` reads and confirm the name is declared as
  // a uniform in at least one shader. A typo here is a silent no-op: setting
  // an undefined location is legal WebGL and does nothing at all.
  const used = new Set(
    [...solverSource.matchAll(/uniforms\.(\w+)/g)].map((match) => match[1]),
  );
  const declared = new Set(
    Object.values(pairs)
      .concat(SRC.VERTEX_SHADER)
      .flatMap((source) => [...source.matchAll(/uniform \w+ (\w+);/g)].map((m) => m[1])),
  );

  assert.ok(used.size > 0, 'found uniform usages to check');
  for (const name of used) {
    assert.ok(declared.has(name), `solver sets uniform "${name}" that no shader declares`);
  }
});

test('the advection shader decays framerate-independently', () => {
  // `result / (1 + dissipation * dt)` keeps the fade identical at 30 and 120
  // fps. A bare multiply would make the ink vanish faster on a fast display.
  assert.match(SRC.ADVECTION_SHADER, /1\.0 \+ dissipation \* dt/);
});

test('the divergence shader mirrors velocity at the boundary', () => {
  // Free-slip walls. Without these the fluid piles into the edges.
  for (const edge of [/vL\.x < 0\.0/, /vR\.x > 1\.0/, /vB\.y < 0\.0/, /vT\.y > 1\.0/]) {
    assert.match(SRC.DIVERGENCE_SHADER, edge);
  }
});

test('the vorticity shader guards its normalisation against a zero vector', () => {
  // length(force) is exactly 0 in still fluid; dividing by it fills the
  // velocity field with NaN and the screen goes black permanently.
  assert.match(SRC.VORTICITY_SHADER, /length\(force\) \+ 0\.0001/);
});

test('the vorticity shader clamps velocity to a finite range', () => {
  assert.match(SRC.VORTICITY_SHADER, /clamp\(velocity, -1000\.0, 1000\.0\)/);
});

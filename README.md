# Kármán

A real-time incompressible Navier–Stokes solver running on the GPU, wrapped in
a one-page site. Drag anywhere on the ink and the fluid responds because it is
actually being solved, thirty passes per frame, not because a video is playing.

No framework, no bundler, no CDN, no dependencies — `package.json` has an empty
dependency tree on purpose. It runs from any static directory, and offline.

```bash
npm start          # http://127.0.0.1:8123
npm test           # 60 unit tests, no browser required
npm run test:browser   # 12 headless-Chrome tests against a real GPU
```

## What it does

Each frame runs Jos Stam's *Stable Fluids* (SIGGRAPH 1999) with vorticity
confinement (Fedkiw et al. 2001):

| # | Pass | Purpose |
|---|------|---------|
| 1 | curl | measure rotation across the velocity grid |
| 2 | vorticity | re-inject the small eddies first-order advection smears away |
| 3 | divergence | find where the fluid is compressing |
| 4 | pressure clear | decay last frame's pressure as a warm start |
| 5 | pressure ×22 | Jacobi sweeps of the pressure Poisson solve |
| 6 | gradient subtract | project velocity onto its divergence-free part |
| 7 | advect velocity | move the field through itself |
| 8 | advect dye | move the visible ink through the field |

Steps 3–6 are the projection that makes the flow incompressible. Remove them
and you get smoke that inflates; keep them and you get something that behaves
like water.

Measured cost on an Apple M1 via ANGLE/Metal: **11.0 ms per frame** averaged
over 120 consecutive steps at a 1814×1024 dye grid and a 227×128 velocity grid
with 22 Jacobi sweeps — roughly 90 fps of headroom against a 60 fps budget.

## Layout

```
index.html            markup
src/styles.css        all styling
src/main.js           bootstrap: input, choreography, runtime
src/lib/math.js       pure helpers — the unit-tested core
src/sim/config.js     parameter bounds, sanitising, quality tiers
src/sim/pointer.js    pointer motion → force and ink
src/sim/fluid.js      the solver
src/gl/context.js     WebGL2 acquisition and capability probing
src/gl/program.js     shader compile / link / uniform cache
src/gl/framebuffer.js ping-pong render targets
src/gl/shaders.js     nine GLSL programs
src/ui/hud.js         live telemetry
src/ui/controls.js    solver parameter sliders
scripts/serve.js      dependency-free static server
scripts/shoot.js      screenshot the page as a visitor sees it
```

## Testing

The unit suite covers the pure logic — grid fitting, config sanitising, the
pointer-to-force mapping, the colour ramp, the frame clock — and the GLSL
sources are checked statically for the mistakes that only ever show up as a
black screen.

The browser suite is the one that matters. It launches real Chrome over the
DevTools Protocol, compiles the shaders on an actual driver, and **reads pixels
back off the GPU** to prove the thing paints, advects, and never lets a NaN
into the velocity field. A fluid simulator that renders a black rectangle
passes every unit test ever written.

Three real bugs were caught this way during the build:

1. `sanitizeConfig` accepted `null` as `0`, silently pinning parameters to
   their minimum instead of falling back to defaults.
2. The splat radius was squared before reaching a shader that already divides
   by it, shrinking the brush about twentyfold in linear extent.
3. The ink ramp's amber stop was fractionally darker than the cyan before it,
   putting a visible dark ring inside every fast stroke.

## Accessibility and degradation

- `prefers-reduced-motion: reduce` settles the solver into a still composition
  and stops the animation loop entirely. Covered by a test.
- No WebGL2, or no renderable float texture format: the page states why and
  falls back to a CSS gradient. All content remains readable.
- Sliders are real labelled `<input type="range">` elements with hints wired
  through `aria-describedby`; the telemetry is marked `aria-live="off"` because
  a readout updating four times a second would make a screen reader unusable.

## License

MIT.

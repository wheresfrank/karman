/**
 * Bootstrap: wire the canvas, the solver, the input and the readouts.
 */

import { createContext, UnsupportedError } from './gl/context.js';
import { FluidSolver } from './sim/fluid.js';
import { DEFAULT_CONFIG, sanitizeConfig, resolveQuality } from './sim/config.js';
import { createPointer, movePointer, resetPointer, splatFromPointer, INK } from './sim/pointer.js';
import { createFrameClock, tickFrameClock, samplePalette, scaleByPixelRatio, lerp } from './lib/math.js';
import { mountControls } from './ui/controls.js';
import { mountHud } from './ui/hud.js';

const HUD_INTERVAL_MS = 250;
const IDLE_DELAY_MS = 2600;
const AMBIENT_INTERVAL_MS = 190;

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function boot() {
  const canvas = document.getElementById('scene');
  const stage = document.getElementById('stage');

  let context;
  try {
    context = createContext(canvas);
  } catch (error) {
    if (error instanceof UnsupportedError) {
      stage.dataset.fallback = 'true';
      document.getElementById('fallback-reason').textContent = error.message;
      return;
    }
    throw error;
  }

  const { gl, ext } = context;
  const quality = resolveQuality({
    pixelRatio: window.devicePixelRatio || 1,
    deviceMemory: navigator.deviceMemory,
    coarse: window.matchMedia('(pointer: coarse)').matches,
  });
  const config = sanitizeConfig({}, { ...DEFAULT_CONFIG, ...quality });

  resizeCanvas(canvas);
  const solver = new FluidSolver(gl, ext, config);
  const clock = createFrameClock(performance.now());
  const pointer = createPointer();

  const hud = mountHud(document.getElementById('telemetry'), document.getElementById('rate'));
  const controls = mountControls(document.getElementById('controls'), config, (key) => {
    // Grid sizes are the only settings that need reallocation; the rest are
    // plain uniforms and take effect on the next frame for free.
    if (key === 'simResolution' || key === 'dyeResolution') solver.resize();
  });

  let lastInputAt = performance.now();
  let lastAmbientAt = 0;
  let lastHudAt = 0;
  let running = true;

  /* ---------------------------------------------------------------- input */

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, rect };
  }

  canvas.addEventListener('pointerdown', (event) => {
    const { x, y, rect } = pointerPosition(event);
    pointer.down = true;
    lastInputAt = performance.now();
    resetPointer(pointer, x, y, rect.width, rect.height);
    // A tap with no drag still deserves a mark, so emit a still splat.
    solver.splat({
      ...splatFromPointer(pointer, config),
      dx: (Math.random() - 0.5) * config.splatForce * 0.4,
      dy: (Math.random() - 0.5) * config.splatForce * 0.4,
      color: samplePalette(INK, 0.75).map((c) => c * 0.6),
    });
  });

  canvas.addEventListener('pointermove', (event) => {
    const { x, y, rect } = pointerPosition(event);
    // Hover paints too — requiring a click to see anything hides the whole
    // point of the page from anyone who does not think to try.
    movePointer(pointer, x, y, rect.width, rect.height);
    if (!pointer.moved) return;
    lastInputAt = performance.now();
    const strength = pointer.down ? 1 : 0.45;
    const splat = splatFromPointer(pointer, config);
    solver.splat({
      ...splat,
      dx: splat.dx * strength,
      dy: splat.dy * strength,
      color: splat.color.map((c) => c * strength),
    });
  });

  const release = () => { pointer.down = false; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', release);

  document.getElementById('reset').addEventListener('click', () => {
    Object.assign(config, sanitizeConfig({}, { ...DEFAULT_CONFIG, ...quality }));
    controls.sync();
    solver.resize();
    introduce();
  });

  document.getElementById('shading').addEventListener('change', (event) => {
    config.shading = event.target.checked;
  });

  /* ------------------------------------------------------- choreography */

  /** Splat in normalised coordinates with a palette colour. */
  function paint(x, y, dx, dy, tone, gain = 1) {
    const color = samplePalette(INK, tone);
    solver.splat({
      x, y, dx, dy,
      color: [color[0] * gain, color[1] * gain, color[2] * gain],
      radius: config.splatRadius / 100,
    });
  }

  /**
   * Opening gesture, so the canvas is never a blank rectangle on arrival.
   *
   * Placed to fill the frame rather than clustering: the first draft put four
   * strokes near the centre and left two thirds of the screen black behind
   * the headline. These sweep across the whole field, with the hottest one
   * offset right so it does not fight the text on the left.
   */
  function introduce() {
    const strokes = [
      [0.14, 0.28, 2200, 1400, 0.55, 0.9],
      [0.72, 0.34, -1400, 2100, 0.92, 1.25],
      [0.88, 0.7, -2400, -900, 0.7, 1.05],
      [0.3, 0.82, 1500, -1900, 0.45, 0.85],
      [0.52, 0.5, 900, 1600, 0.98, 1.3],
      [0.08, 0.62, 2000, -600, 0.35, 0.75],
    ];
    for (const [x, y, dx, dy, tone, gain] of strokes) paint(x, y, dx, dy, tone, gain);
  }

  /**
   * When nobody is touching it, drive the fluid along a slow Lissajous path.
   * Two incommensurate frequencies never repeat exactly, so the motion does
   * not read as a loop the way a keyframed animation does.
   */
  function ambient(now) {
    const t = now / 1000;
    const x = 0.5 + 0.32 * Math.sin(t * 0.31) * Math.cos(t * 0.13);
    const y = 0.5 + 0.28 * Math.sin(t * 0.23 + 1.7);
    const dx = Math.cos(t * 0.31) * 900;
    const dy = Math.sin(t * 0.19) * 900;
    const tone = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t * 0.11));
    paint(x, y, dx, dy, tone, 0.5);
  }

  /* ------------------------------------------------------------- runtime */

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    // Dragging a window edge fires continuously; reallocating six textures on
    // every one of those events will stall the compositor.
    resizeTimer = setTimeout(() => {
      if (resizeCanvas(canvas)) solver.resize();
    }, 150);
  });

  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) {
      clock.last = performance.now();
      requestAnimationFrame(frame);
    }
  });

  function frame(now) {
    if (!running) return;
    const dt = tickFrameClock(clock, now);

    if (now - lastInputAt > IDLE_DELAY_MS && now - lastAmbientAt > AMBIENT_INTERVAL_MS) {
      lastAmbientAt = now;
      ambient(now);
    }

    solver.step(dt);
    solver.render();

    if (now - lastHudAt > HUD_INTERVAL_MS) {
      lastHudAt = now;
      hud.update(clock, solver.stats);
    }
    requestAnimationFrame(frame);
  }

  introduce();

  if (prefersReducedMotion) {
    // Settle into a still composition and stop. The controls still work; the
    // page just will not move on its own.
    for (let i = 0; i < 40; i++) solver.step(1 / 60);
    solver.render();
    hud.update(clock, solver.stats);
    document.getElementById('stage').dataset.still = 'true';
  } else {
    requestAnimationFrame(frame);
  }

  // Fade the canvas in only once there is something on it, so the first
  // painted frame is ink rather than an empty black box.
  requestAnimationFrame(() => stage.dataset.ready = 'true');

  /**
   * Debug handle. Also the surface the headless browser test drives: the only
   * way to know the GPU pipeline really painted is to read the pixels back
   * off the canvas, and that has to happen from inside the page.
   */
  window.karman = {
    config,
    solver,
    clock,
    paint,
    /** Render one frame and measure what actually landed on the canvas. */
    sample() {
      solver.render();
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      // Must read in the same task as the draw: without
      // preserveDrawingBuffer the buffer is cleared once control returns to
      // the compositor.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      let sum = 0;
      let max = 0;
      let lit = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const luma = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        sum += luma;
        if (luma > max) max = luma;
        if (luma > 8) lit++;
      }
      const count = pixels.length / 4;
      return { width, height, mean: sum / count, max, litRatio: lit / count };
    },
  };
}

/**
 * Match the drawing buffer to the CSS box.
 * @returns {boolean} true when the size actually changed
 */
function resizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = scaleByPixelRatio(canvas.clientWidth, ratio);
  const height = scaleByPixelRatio(canvas.clientHeight, ratio);
  if (width === 0 || height === 0) return false;
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

/* ------------------------------------------------------------- page chrome */

/** Reveal sections as they enter the viewport. */
function mountReveals() {
  const targets = document.querySelectorAll('[data-reveal]');
  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    targets.forEach((el) => el.setAttribute('data-revealed', 'true'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.setAttribute('data-revealed', 'true');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.2, rootMargin: '0px 0px -10% 0px' });
  targets.forEach((el) => observer.observe(el));
}

/** Progress rail in the header, driven by scroll position. */
function mountScrollProgress() {
  const rail = document.getElementById('progress');
  if (!rail) return;
  let ticking = false;
  const update = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = max > 0 ? window.scrollY / max : 0;
    rail.style.transform = `scaleX(${lerp(0, 1, Math.min(1, Math.max(0, ratio)))})`;
    ticking = false;
  };
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  }, { passive: true });
  update();
}

mountReveals();
mountScrollProgress();
boot();

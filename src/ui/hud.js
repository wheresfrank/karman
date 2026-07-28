/**
 * Telemetry readout.
 *
 * Every number here is measured from the running system — frame time from the
 * clock, grid sizes and VRAM from the allocated textures, pass count from the
 * live config, GPU string from the driver. Nothing is hardcoded, because a
 * page that brags about "60 FPS" in static text is telling you nothing.
 */

import { formatBytes } from '../lib/math.js';

const FIELDS = [
  ['fps', 'Frame rate'],
  ['frametime', 'Frame time'],
  ['sim', 'Velocity grid'],
  ['dye', 'Dye grid'],
  ['passes', 'GPU passes / frame'],
  ['cells', 'Cells solved / s'],
  ['memory', 'Field memory'],
  ['precision', 'Precision'],
  ['renderer', 'Renderer', 'wide'],
];

/**
 * @param {HTMLElement} root container for the readout
 * @param {HTMLElement} [rateEl] optional masthead element for the live rate.
 *   The masthead used to read "60 fps" as static text, which is the exact
 *   kind of unearned claim this page is arguing against.
 */
export function mountHud(root, rateEl) {
  root.textContent = '';
  const values = new Map();

  for (const [key, label, modifier] of FIELDS) {
    const item = document.createElement('div');
    item.className = modifier ? `stat stat--${modifier}` : 'stat';

    const dt = document.createElement('dt');
    dt.className = 'stat__label';
    dt.textContent = label;

    const dd = document.createElement('dd');
    dd.className = 'stat__value';
    dd.textContent = '—';
    // Telemetry updates ~4x/second; announcing it would make a screen reader
    // unusable. The numbers are decorative detail, not content.
    dd.setAttribute('aria-live', 'off');

    item.append(dt, dd);
    root.append(item);
    values.set(key, dd);
  }

  function set(key, text) {
    const el = values.get(key);
    if (el && el.textContent !== text) el.textContent = text;
  }

  /**
   * @param {{fps:number}} clock
   * @param {object} stats from `FluidSolver.stats`
   */
  function update(clock, stats) {
    const fps = Math.round(clock.fps);
    set('fps', `${fps} fps`);
    if (rateEl && rateEl.textContent !== `${fps} fps`) rateEl.textContent = `${fps} fps`;
    set('frametime', `${clock.fps > 0 ? (1000 / clock.fps).toFixed(1) : '—'} ms`);
    set('sim', `${stats.simWidth} × ${stats.simHeight}`);
    set('dye', `${stats.dyeWidth} × ${stats.dyeHeight}`);
    set('passes', String(stats.passes));
    // Cells resolved per second by the pressure solve alone: the honest
    // measure of what the GPU is actually doing while you drag your cursor.
    const solves = stats.cells * (stats.passes - 8) * fps;
    set('cells', solves > 0 ? `${(solves / 1e6).toFixed(1)}M` : '—');
    set('memory', formatBytes(stats.bytes));
    set('precision', stats.precision);
    set('renderer', stats.renderer);
  }

  return { update };
}

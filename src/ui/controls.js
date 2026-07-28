/**
 * Solver controls.
 *
 * Sliders are generated from `PARAMETERS` rather than written out in HTML, so
 * the range a user can drag is the same range the sanitiser enforces. There
 * is no second place for a bound to be wrong.
 */

import { PARAMETERS } from '../sim/config.js';

const LABELS = {
  curl: ['Vorticity', 'Re-injects the small eddies advection smears away.'],
  pressureIterations: ['Jacobi sweeps', 'How far pressure travels per frame. Lower = compressible.'],
  velocityDissipation: ['Momentum decay', 'Standing in for viscosity.'],
  dyeDissipation: ['Ink decay', 'How fast the visible dye fades.'],
  splatRadius: ['Brush size', 'Radius of the injected blob.'],
  splatForce: ['Brush force', 'Momentum added per unit of pointer motion.'],
};

const EXPOSED = ['curl', 'pressureIterations', 'velocityDissipation', 'dyeDissipation', 'splatRadius', 'splatForce'];

function formatValue(key, value) {
  return key === 'pressureIterations' || key === 'splatForce'
    ? String(Math.round(value))
    : value.toFixed(2);
}

/**
 * @param {HTMLElement} root container to populate
 * @param {object} config live config object, mutated in place
 * @param {(key: string, value: number) => void} [onChange]
 */
export function mountControls(root, config, onChange = () => {}) {
  root.textContent = '';
  const inputs = new Map();

  for (const key of EXPOSED) {
    const bounds = PARAMETERS[key];
    const [label, hint] = LABELS[key];
    const id = `control-${key}`;

    const row = document.createElement('div');
    row.className = 'control';

    const head = document.createElement('div');
    head.className = 'control__head';

    const labelEl = document.createElement('label');
    labelEl.className = 'control__label';
    labelEl.setAttribute('for', id);
    labelEl.textContent = label;

    const output = document.createElement('output');
    output.className = 'control__value';
    output.setAttribute('for', id);
    output.textContent = formatValue(key, config[key]);

    const input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    input.className = 'control__range';
    input.min = String(bounds.min);
    input.max = String(bounds.max);
    input.step = String(bounds.step);
    input.value = String(config[key]);
    input.setAttribute('aria-describedby', `${id}-hint`);

    const hintEl = document.createElement('p');
    hintEl.className = 'control__hint';
    hintEl.id = `${id}-hint`;
    hintEl.textContent = hint;

    input.addEventListener('input', () => {
      const value = Number(input.value);
      config[key] = value;
      output.textContent = formatValue(key, value);
      onChange(key, value);
    });

    head.append(labelEl, output);
    row.append(head, input, hintEl);
    root.append(row);
    inputs.set(key, { input, output });
  }

  /** Push config values back into the DOM, e.g. after a reset. */
  function sync() {
    for (const [key, { input, output }] of inputs) {
      input.value = String(config[key]);
      output.textContent = formatValue(key, config[key]);
    }
  }

  return { sync };
}

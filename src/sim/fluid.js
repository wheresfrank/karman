/**
 * The solver.
 *
 * One `step()` is:
 *   1. curl            — measure rotation
 *   2. vorticity       — re-inject the rotation advection lost
 *   3. divergence      — measure compression
 *   4. pressure clear  — decay last frame's pressure (a warm start)
 *   5. pressure x N    — Jacobi sweeps of the Poisson solve
 *   6. gradient sub    — project velocity to divergence-free
 *   7. advect velocity — move the field through itself
 *   8. advect dye      — move the visible ink through the field
 *
 * Steps 3-6 are the projection that makes the fluid incompressible. Drop them
 * and you get smoke that inflates; keep them and you get something that
 * behaves like water.
 */

import { Program } from '../gl/program.js';
import { Framebuffer, DoubleFramebuffer } from '../gl/framebuffer.js';
import { fitGrid, correctRadius } from '../lib/math.js';
import { passesPerFrame } from './config.js';
import * as SRC from '../gl/shaders.js';

export class FluidSolver {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {object} ext capability record from `createContext`
   * @param {object} config sanitised configuration
   */
  constructor(gl, ext, config) {
    this.gl = gl;
    this.ext = ext;
    this.config = config;

    this.programs = {
      splat: new Program(gl, SRC.VERTEX_SHADER, SRC.SPLAT_SHADER),
      advection: new Program(gl, SRC.VERTEX_SHADER, SRC.ADVECTION_SHADER),
      divergence: new Program(gl, SRC.VERTEX_SHADER, SRC.DIVERGENCE_SHADER),
      curl: new Program(gl, SRC.VERTEX_SHADER, SRC.CURL_SHADER),
      vorticity: new Program(gl, SRC.VERTEX_SHADER, SRC.VORTICITY_SHADER),
      pressure: new Program(gl, SRC.VERTEX_SHADER, SRC.PRESSURE_SHADER),
      gradientSubtract: new Program(gl, SRC.VERTEX_SHADER, SRC.GRADIENT_SUBTRACT_SHADER),
      clear: new Program(gl, SRC.VERTEX_SHADER, SRC.CLEAR_SHADER),
      display: new Program(gl, SRC.VERTEX_SHADER, SRC.DISPLAY_SHADER),
    };

    this.#initGeometry();
    this.resize();
  }

  /**
   * A single triangle-strip quad covering clip space, drawn for every pass.
   * The vertex shader maps it straight to 0..1 texture space.
   */
  #initGeometry() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  /** Draw one full-screen pass into `target` (or the canvas when null). */
  #blit(target) {
    const gl = this.gl;
    if (target === null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * (Re)allocate every field to match the current canvas.
   *
   * Fields are dropped and re-created rather than resampled: a resize is rare
   * and user-initiated, and preserving the flow across one is not worth the
   * extra copy pass and the code to keep it correct.
   */
  resize() {
    const gl = this.gl;
    const { ext, config } = this;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;

    const sim = fitGrid(config.simResolution, width, height);
    const dye = fitGrid(config.dyeResolution, width, height);

    this.destroyFields();
    const filter = ext.filtering;
    this.dye = new DoubleFramebuffer(gl, dye.width, dye.height, ext.rgba, ext.type, filter);
    this.velocity = new DoubleFramebuffer(gl, sim.width, sim.height, ext.rg, ext.type, filter);
    // Divergence, curl and pressure are only ever sampled at texel centres,
    // so NEAREST is correct and avoids relying on float linear filtering.
    this.divergence = new Framebuffer(gl, sim.width, sim.height, ext.r, ext.type, gl.NEAREST);
    this.curl = new Framebuffer(gl, sim.width, sim.height, ext.r, ext.type, gl.NEAREST);
    this.pressure = new DoubleFramebuffer(gl, sim.width, sim.height, ext.r, ext.type, gl.NEAREST);
  }

  destroyFields() {
    for (const field of [this.dye, this.velocity, this.divergence, this.curl, this.pressure]) {
      if (field) field.destroy();
    }
    this.dye = this.velocity = this.divergence = this.curl = this.pressure = null;
  }

  /** Total VRAM held by the simulation fields, for the HUD. */
  get textureBytes() {
    return [this.dye, this.velocity, this.divergence, this.curl, this.pressure]
      .reduce((sum, field) => sum + (field ? field.bytes : 0), 0);
  }

  get stats() {
    return {
      simWidth: this.velocity.width,
      simHeight: this.velocity.height,
      dyeWidth: this.dye.width,
      dyeHeight: this.dye.height,
      cells: this.velocity.width * this.velocity.height,
      passes: passesPerFrame(this.config),
      bytes: this.textureBytes,
      precision: this.ext.precision,
      renderer: this.ext.renderer,
    };
  }

  /**
   * Inject force and dye at a point.
   * @param {{x,y,dx,dy,color,radius}} splat texture-space coordinates
   */
  splat(splat) {
    const gl = this.gl;
    const aspect = this.velocity.width / this.velocity.height;
    const program = this.programs.splat.bind();

    gl.uniform1i(program.uniforms.uTarget, this.velocity.read.attach(0));
    gl.uniform1f(program.uniforms.aspectRatio, aspect);
    gl.uniform2f(program.uniforms.point, splat.x, splat.y);
    gl.uniform3f(program.uniforms.color, splat.dx, splat.dy, 0);
    gl.uniform1f(program.uniforms.radius, correctRadius(splat.radius, aspect));
    this.#blit(this.velocity.write);
    this.velocity.swap();

    gl.uniform1i(program.uniforms.uTarget, this.dye.read.attach(0));
    gl.uniform3f(program.uniforms.color, splat.color[0], splat.color[1], splat.color[2]);
    this.#blit(this.dye.write);
    this.dye.swap();
  }

  /** Advance the simulation by `dt` seconds. */
  step(dt) {
    const gl = this.gl;
    const { config, programs, velocity, pressure } = this;
    gl.disable(gl.BLEND);

    // 1. Curl.
    let program = programs.curl.bind();
    gl.uniform2f(program.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(program.uniforms.uVelocity, velocity.read.attach(0));
    this.#blit(this.curl);

    // 2. Vorticity confinement.
    program = programs.vorticity.bind();
    gl.uniform2f(program.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(program.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(program.uniforms.uCurl, this.curl.attach(1));
    gl.uniform1f(program.uniforms.curl, config.curl);
    gl.uniform1f(program.uniforms.dt, dt);
    this.#blit(velocity.write);
    velocity.swap();

    // 3. Divergence.
    program = programs.divergence.bind();
    gl.uniform2f(program.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(program.uniforms.uVelocity, velocity.read.attach(0));
    this.#blit(this.divergence);

    // 4. Decay the previous pressure field. Starting each solve from a scaled
    //    copy of the last one converges far faster than starting from zero.
    program = programs.clear.bind();
    gl.uniform1i(program.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(program.uniforms.value, config.pressure);
    this.#blit(pressure.write);
    pressure.swap();

    // 5. Jacobi sweeps.
    program = programs.pressure.bind();
    gl.uniform2f(program.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(program.uniforms.uDivergence, this.divergence.attach(0));
    for (let i = 0; i < config.pressureIterations; i++) {
      gl.uniform1i(program.uniforms.uPressure, pressure.read.attach(1));
      this.#blit(pressure.write);
      pressure.swap();
    }

    // 6. Projection.
    program = programs.gradientSubtract.bind();
    gl.uniform2f(program.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(program.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(program.uniforms.uVelocity, velocity.read.attach(1));
    this.#blit(velocity.write);
    velocity.swap();

    // 7. Advect velocity through itself.
    program = programs.advection.bind();
    gl.uniform2f(program.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    const velocityUnit = velocity.read.attach(0);
    gl.uniform1i(program.uniforms.uVelocity, velocityUnit);
    gl.uniform1i(program.uniforms.uSource, velocityUnit);
    gl.uniform1f(program.uniforms.dt, dt);
    gl.uniform1f(program.uniforms.dissipation, config.velocityDissipation);
    this.#blit(velocity.write);
    velocity.swap();

    // 8. Advect dye. Note the texel size is the *velocity* grid's: the
    //    backwards trace happens in velocity-field units even though the
    //    source being sampled is the higher-resolution dye texture.
    gl.uniform2f(program.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(program.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(program.uniforms.uSource, this.dye.read.attach(1));
    gl.uniform1f(program.uniforms.dissipation, config.dyeDissipation);
    this.#blit(this.dye.write);
    this.dye.swap();
  }

  /** Composite the dye field to the canvas. */
  render() {
    const gl = this.gl;
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);

    const program = this.programs.display.bind();
    gl.uniform2f(program.uniforms.texelSize, this.dye.texelSizeX, this.dye.texelSizeY);
    gl.uniform1i(program.uniforms.uTexture, this.dye.read.attach(0));
    gl.uniform1f(program.uniforms.uShading, this.config.shading ? 1 : 0);
    this.#blit(null);
  }

  destroy() {
    this.destroyFields();
    for (const program of Object.values(this.programs)) program.destroy();
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteVertexArray(this.vao);
  }
}

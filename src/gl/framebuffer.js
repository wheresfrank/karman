/**
 * Render targets.
 *
 * Every field in the solver (velocity, dye, pressure) is read and written in
 * the same pass, which a GPU will not allow on one texture. The standard
 * answer is ping-ponging: read `read`, write `write`, swap. `DoubleFramebuffer`
 * exists so no call site has to remember to do that by hand.
 */

export class Framebuffer {
  constructor(gl, width, height, spec, type, filter) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    this.texelSizeX = 1 / width;
    this.texelSizeY = 1 / height;
    this.spec = spec;
    this.type = type;
    this.filter = filter;

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    // CLAMP_TO_EDGE, not REPEAT: with REPEAT, dye advected off the right edge
    // reappears on the left, which reads as a glitch rather than a boundary.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, spec.internalFormat, width, height, 0, spec.format, type, null,
    );

    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Bind to a texture unit and return the unit index, for `uniform1i`. */
  attach(unit) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    return unit;
  }

  /** Approximate VRAM footprint, for the HUD. */
  get bytes() {
    return this.width * this.height * this.spec.bytes;
  }

  destroy() {
    this.gl.deleteFramebuffer(this.fbo);
    this.gl.deleteTexture(this.texture);
  }
}

export class DoubleFramebuffer {
  constructor(gl, width, height, spec, type, filter) {
    this.gl = gl;
    this.read = new Framebuffer(gl, width, height, spec, type, filter);
    this.write = new Framebuffer(gl, width, height, spec, type, filter);
  }

  get width() { return this.read.width; }
  get height() { return this.read.height; }
  get texelSizeX() { return this.read.texelSizeX; }
  get texelSizeY() { return this.read.texelSizeY; }
  get bytes() { return this.read.bytes + this.write.bytes; }

  swap() {
    const temp = this.read;
    this.read = this.write;
    this.write = temp;
  }

  destroy() {
    this.read.destroy();
    this.write.destroy();
  }
}

/**
 * WebGL2 context acquisition and capability probing.
 *
 * The solver needs to *render into* floating-point textures, which is a
 * strictly stronger requirement than merely sampling them. Rather than trust
 * the extension string, every candidate format is probed by building a real
 * framebuffer and asking the driver whether it is complete — drivers do lie,
 * and a silent incomplete framebuffer renders black with no error anywhere.
 */

export class UnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedError';
  }
}

const CONTEXT_OPTIONS = {
  alpha: true,
  depth: false,
  stencil: false,
  antialias: false, // Every pass is full-screen; MSAA would cost for nothing.
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
  desynchronized: true,
};

/** True if `internalFormat` can be used as a colour attachment. */
export function supportsRenderTo(gl, internalFormat, format, type) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(texture);
  return status === gl.FRAMEBUFFER_COMPLETE;
}

/**
 * Report the GPU where the browser allows it. Chrome and Safari mask this
 * behind a privacy setting, so an "unavailable" result is normal, not a bug.
 */
function describeRenderer(gl) {
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  if (debugInfo) {
    const raw = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
    if (raw) return String(raw);
  }
  return gl.getParameter(gl.RENDERER) || 'unavailable';
}

/**
 * @returns {{gl: WebGL2RenderingContext, ext: object}}
 * @throws {UnsupportedError} when the device cannot run the solver at all.
 */
export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', CONTEXT_OPTIONS);
  if (!gl) {
    throw new UnsupportedError('WebGL2 is not available in this browser.');
  }

  // Required to render into any float format. Without it we have no signed
  // storage for velocity, and an unsigned-byte solver is not worth shipping.
  const colorBufferFloat = gl.getExtension('EXT_color_buffer_float');
  if (!colorBufferFloat) {
    throw new UnsupportedError('This GPU cannot render to floating-point textures.');
  }

  // Half float is preferred: same visual result as full float here, half the
  // bandwidth, and bandwidth is the binding constraint on a solver that
  // touches every texel twenty-plus times a frame.
  const half = gl.HALF_FLOAT;
  let formats;
  if (supportsRenderTo(gl, gl.RGBA16F, gl.RGBA, half)) {
    formats = {
      precision: 'half float (16F)',
      type: half,
      rgba: { internalFormat: gl.RGBA16F, format: gl.RGBA, bytes: 8 },
      rg: { internalFormat: gl.RG16F, format: gl.RG, bytes: 4 },
      r: { internalFormat: gl.R16F, format: gl.RED, bytes: 2 },
    };
  } else if (supportsRenderTo(gl, gl.RGBA32F, gl.RGBA, gl.FLOAT)) {
    formats = {
      precision: 'full float (32F)',
      type: gl.FLOAT,
      rgba: { internalFormat: gl.RGBA32F, format: gl.RGBA, bytes: 16 },
      rg: { internalFormat: gl.RG32F, format: gl.RG, bytes: 8 },
      r: { internalFormat: gl.R32F, format: gl.RED, bytes: 4 },
    };
  } else {
    throw new UnsupportedError('No renderable floating-point texture format.');
  }

  // Linear filtering of float textures is what makes semi-Lagrangian
  // advection smooth. Without it we fall back to NEAREST and accept blocky
  // dye rather than failing outright.
  const linearFilter = Boolean(gl.getExtension('OES_texture_float_linear'));

  return {
    gl,
    ext: {
      ...formats,
      linearFilter,
      filtering: linearFilter ? gl.LINEAR : gl.NEAREST,
      renderer: describeRenderer(gl),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    },
  };
}

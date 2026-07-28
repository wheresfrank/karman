/**
 * Shader compilation and uniform binding.
 *
 * Uniform locations are resolved once at link time and cached by name.
 * `gl.getUniformLocation` is a synchronous driver call; doing it per frame in
 * a pipeline with thirty draw calls is a measurable waste.
 */

export function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new Error(`Failed to compile ${kind} shader: ${log}`);
  }
  return shader;
}

export class Program {
  constructor(gl, vertexSource, fragmentSource) {
    this.gl = gl;
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

    this.program = gl.createProgram();
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.bindAttribLocation(this.program, 0, 'aPosition');
    gl.linkProgram(this.program);

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(this.program);
      gl.deleteProgram(this.program);
      throw new Error(`Failed to link program: ${log}`);
    }

    // Shaders are reference-counted by the program once attached; deleting
    // the objects here frees the sources without invalidating the program.
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    this.uniforms = {};
    const count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(this.program, i).name;
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
  }

  bind() {
    this.gl.useProgram(this.program);
    return this;
  }

  destroy() {
    this.gl.deleteProgram(this.program);
    this.program = null;
  }
}

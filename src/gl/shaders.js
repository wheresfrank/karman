/**
 * GLSL sources for the solver.
 *
 * The pipeline is Stam's "Stable Fluids" (SIGGRAPH 1999) on the GPU: advect,
 * add forces, then project the velocity field back onto its divergence-free
 * part by solving a Poisson equation for pressure. Every function below is
 * one full-screen pass over a floating-point texture.
 *
 * Shared convention: `vUv` is the fragment's cell centre in 0..1 texture
 * space and `vL/vR/vB/vT` are its four neighbours, computed in the vertex
 * shader. Doing the neighbour offsets per-vertex rather than per-fragment
 * lets the texture units prefetch, and on tile-based mobile GPUs it is the
 * difference between a dependent texture read and a free one.
 */

export const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 aPosition;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vB;
out vec2 vT;
uniform vec2 texelSize;

void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vB = vUv - vec2(0.0, texelSize.y);
    vT = vUv + vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

/** Inject a soft Gaussian blob of colour or velocity around a point. */
export const SPLAT_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;

void main () {
    vec2 p = vUv - point.xy;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    vec3 base = texture(uTarget, vUv).xyz;
    fragColor = vec4(base + splat, 1.0);
}`;

/**
 * Semi-Lagrangian advection: for each cell, walk backwards along the velocity
 * field and read what was there a timestep ago. Unconditionally stable at any
 * timestep, which is the whole point of the method — but it is a first-order
 * scheme, so it loses energy every frame. That loss is what the vorticity
 * pass below exists to claw back.
 */
export const ADVECTION_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float dt;
uniform float dissipation;

void main () {
    vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
    vec4 result = texture(uSource, coord);
    // Exponential decay, framerate independent.
    float decay = 1.0 + dissipation * dt;
    fragColor = result / decay;
}`;

/** Discrete divergence of the velocity field: how much each cell gains or loses. */
export const DIVERGENCE_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vB;
in vec2 vT;
out vec4 fragColor;
uniform sampler2D uVelocity;

void main () {
    float L = texture(uVelocity, vL).x;
    float R = texture(uVelocity, vR).x;
    float B = texture(uVelocity, vB).y;
    float T = texture(uVelocity, vT).y;

    // Free-slip walls: mirror the normal component at the boundary so the
    // fluid slides along the edge instead of piling into it.
    vec2 C = texture(uVelocity, vUv).xy;
    if (vL.x < 0.0) { L = -C.x; }
    if (vR.x > 1.0) { R = -C.x; }
    if (vB.y < 0.0) { B = -C.y; }
    if (vT.y > 1.0) { T = -C.y; }

    fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

/** Scalar curl (z of the 2D vorticity vector). */
export const CURL_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vL;
in vec2 vR;
in vec2 vB;
in vec2 vT;
out vec4 fragColor;
uniform sampler2D uVelocity;

void main () {
    float L = texture(uVelocity, vL).y;
    float R = texture(uVelocity, vR).y;
    float B = texture(uVelocity, vB).x;
    float T = texture(uVelocity, vT).x;
    fragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;

/**
 * Vorticity confinement (Fedkiw et al. 2001): find the direction that points
 * up the curl-magnitude gradient and push along it, restoring the small
 * eddies that advection smeared away. Turning `curl` up too far is visibly
 * unphysical — the fluid starts to boil — which is exactly why it is exposed
 * as a slider rather than hidden.
 */
export const VORTICITY_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vB;
in vec2 vT;
out vec4 fragColor;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;

void main () {
    float L = texture(uCurl, vL).x;
    float R = texture(uCurl, vR).x;
    float B = texture(uCurl, vB).x;
    float T = texture(uCurl, vT).x;
    float C = texture(uCurl, vUv).x;

    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;

    vec2 velocity = texture(uVelocity, vUv).xy;
    velocity += force * dt;
    velocity = clamp(velocity, -1000.0, 1000.0);
    fragColor = vec4(velocity, 0.0, 1.0);
}`;

/**
 * One Jacobi sweep of the pressure Poisson solve. Run it N times; each sweep
 * propagates information exactly one cell, so the iteration count sets how
 * far pressure can travel per frame. Below ~15 you can see the fluid fail to
 * "know" about a wall on the far side of the screen.
 */
export const PRESSURE_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vB;
in vec2 vT;
out vec4 fragColor;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;

void main () {
    float L = texture(uPressure, vL).x;
    float R = texture(uPressure, vR).x;
    float B = texture(uPressure, vB).x;
    float T = texture(uPressure, vT).x;
    float divergence = texture(uDivergence, vUv).x;
    fragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
}`;

/** Subtract the pressure gradient, leaving a (near) divergence-free field. */
export const GRADIENT_SUBTRACT_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vB;
in vec2 vT;
out vec4 fragColor;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;

void main () {
    float L = texture(uPressure, vL).x;
    float R = texture(uPressure, vR).x;
    float B = texture(uPressure, vB).x;
    float T = texture(uPressure, vT).x;
    vec2 velocity = texture(uVelocity, vUv).xy;
    velocity -= vec2(R - L, T - B);
    fragColor = vec4(velocity, 0.0, 1.0);
}`;

/** Multiply a texture by a scalar (used to damp pressure between frames). */
export const CLEAR_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTexture;
uniform float value;

void main () {
    fragColor = value * texture(uTexture, vUv);
}`;

/**
 * Final composite.
 *
 * The dye field on its own looks flat, like coloured fog. Treating dye
 * density as a height field and lighting it with a fixed key light is
 * physically bogus but reads instantly as *volume* — the eye accepts it as
 * ink in water rather than a gradient. The vignette and the ordered dither
 * are there to stop 8-bit banding in the dark falloff.
 */
export const DISPLAY_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vB;
in vec2 vT;
out vec4 fragColor;
uniform sampler2D uTexture;
uniform vec2 texelSize;
uniform float uShading;

void main () {
    vec3 color = texture(uTexture, vUv).rgb;

    if (uShading > 0.5) {
        vec3 lc = texture(uTexture, vL).rgb;
        vec3 rc = texture(uTexture, vR).rgb;
        vec3 tc = texture(uTexture, vT).rgb;
        vec3 bc = texture(uTexture, vB).rgb;

        float dx = length(rc) - length(lc);
        float dy = length(tc) - length(bc);

        vec3 n = normalize(vec3(dx, dy, length(texelSize)));
        vec3 l = vec3(0.0, 0.0, 1.0);
        float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
        color *= diffuse;
    }

    // Vignette: pull the corners down so the composition has a centre.
    vec2 d = vUv - 0.5;
    float vignette = smoothstep(0.85, 0.15, dot(d, d) * 2.2);
    color *= mix(0.72, 1.0, vignette);

    // Ordered dither, ±1/255, breaks up banding without visible noise.
    float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    color += (dither - 0.5) / 255.0;

    float a = max(color.r, max(color.g, color.b));
    fragColor = vec4(color, a);
}`;

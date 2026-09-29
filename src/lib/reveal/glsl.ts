// GLSL for the reveal animation, spliced into both composite shaders (engine.ts compositeFrag and
// deck/composite-shader.ts). Pure math, no textures or uniforms of its own: each shader passes its
// own uniforms (packing in config.ts RevealUniforms). Only runs while a reveal is active
// (a.w > 0), so the classic composite stays pixel-identical otherwise.
//
// revealAt → vec3(alpha, glow, ridgeAlpha):
//   tD  = distance, log range normalised to the view's own near/far percentiles
//   tE  = terrain height, reconstructed from range and the pixel's ray (+ earth curvature), normalised
//         to the view's low/high percentiles
//   f   = the preset's arrival field (config.ts fieldAt mirrors it for labels) + organic grain
//   the front p sweeps f; alpha = behind the front, glow = a light band on it, ridgeAlpha = the
//   silhouettes, which sketch in a little ahead of the fill.
export const REVEAL_GLSL = /* glsl */ `
float rvHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rvNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rvHash(i), rvHash(i + vec2(1.0, 0.0)), f.x),
             mix(rvHash(i + vec2(0.0, 1.0)), rvHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float rvFbm(vec2 p) {
  return 0.5 * rvNoise(p) + 0.3 * rvNoise(p * 2.03 + 7.1) + 0.2 * rvNoise(p * 4.07 + 3.7);
}

float rvSeg(float x, float a, float b) { return clamp((x - a) / max(b - a, 1e-4), 0.0, 1.0); }
// 65 % area-equalised (piecewise-linear through the 20..80 % quantiles), 35 % linear: the front
// crosses equal screen area in equal time, but distance still reads (config.ts equalise mirrors it)
float rvEq(float x, float lo, vec4 q, float hi) {
  float t;
  if (x < q.x) t = 0.2 * rvSeg(x, lo, q.x);
  else if (x < q.y) t = 0.2 + 0.2 * rvSeg(x, q.x, q.y);
  else if (x < q.z) t = 0.4 + 0.2 * rvSeg(x, q.y, q.z);
  else if (x < q.w) t = 0.6 + 0.2 * rvSeg(x, q.z, q.w);
  else t = 0.8 + 0.2 * rvSeg(x, q.w, hi);
  return 0.35 * rvSeg(x, lo, hi) + 0.65 * t;
}

vec3 revealAt(vec2 uv, float range, vec4 a, vec4 win, vec4 qD, vec4 qE, vec4 shape, vec4 focus, vec3 F, vec3 R, vec3 U, float aspect) {
  float t = a.x;
  int mode = int(a.y + 0.5);
  float soft = max(shape.x, 1e-3);
  float gw = max(shape.y, 1e-3);
  float grain = shape.z;
  float tD = 1.0;
  float tE = 1.0;
  if (range > 0.0) {
    tD = rvEq(log(range), win.x, qD, win.y);
    vec3 d = normalize(F + R * (uv.x * 2.0 - 1.0) + U * (uv.y * 2.0 - 1.0));
    float horiz = range * length(d.xy);
    // ENU z drops below the tangent plane with distance: add it back (k = 0.13 refraction)
    float h = a.z + range * d.z + horiz * horiz * (0.87 / 12742000.0);
    tE = rvEq(h, win.z, qE, win.w);
  }
  vec2 sp = vec2(uv.x * aspect, uv.y);
  float f;
  if (mode == 1) f = (1.0 - tE) * 0.8 + tD * 0.2;       // alpenglow: summits first
  else if (mode == 2) f = tE * 0.85 + tD * 0.15;        // rising tide: valleys first
  else if (mode == 3) {                                  // shockwave from the focus peak
    float ds = length(sp - vec2(focus.x * aspect, focus.y)) / max(aspect, 1.0);
    float dd = tD - focus.z;
    float de = tE - focus.w;
    f = min(1.0, sqrt(ds * ds + 0.5 * dd * dd + 0.3 * de * de) / 0.9);
  }
  else if (mode == 4) f = (floor(tE * 8.0) + tD * 0.7) / 8.7; // terraces
  else if (mode == 5) f = uv.x * 0.8 + (1.0 - tE) * 0.2;      // sunsweep
  else if (mode == 6) f = mix(tD, rvHash(floor(sp * 240.0)), 0.45); // stardust
  else f = tD;                                                // bloom: near → far
  if (a.w > 1.5) f = 1.0 - f;
  if (range <= 0.0) f = 1.0;
  f += (rvFbm(sp * 11.0) - 0.5) * grain;

  float p = -(soft + grain * 0.5) + t * (1.0 + 2.0 * soft + grain);
  float alpha = 1.0 - smoothstep(p - soft, p, f);
  float lead = gw * 1.5;
  float ridgeA = 1.0 - smoothstep(p + lead - soft, p + lead, f);
  float g = (f - (p - soft * 0.4)) / gw;
  // a longer tail behind the front than ahead of it
  g *= g < 0.0 ? 0.55 : 1.0;
  float glow = exp(-g * g) * smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.82, 1.0, t));
  return vec3(alpha, glow, ridgeA);
}

// Unrevealed terrain dims a touch; the light band washes the terrain, flares on the overlay's own
// lines and blazes along ridges. keep = 1 − people mask; lineA = the layer's coverage there.
// The dim ignores the people mask on purpose: that mask is dilated, and exempting it leaves a halo;
// people lift with the terrain behind them instead.
vec3 revealLight(vec3 col, vec3 rv, float range, float lineA, float ridge, vec4 glowC, float dim, float keep) {
  float terrain = range > 0.0 ? 1.0 : 0.0;
  col *= mix(1.0 - dim * terrain, 1.0, rv.x);
  float light = rv.y * keep * (terrain * (0.08 + 0.9 * lineA) + ridge * 1.6);
  return col + glowC.rgb * glowC.a * light;
}
`;

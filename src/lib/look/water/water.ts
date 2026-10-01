// Lake water shading (LOOK_WATER, style terrain.albedo { mode: 'alpine', water: true }): the alpine
// look's flat lake tint replaced by a depth-tinted body with a Schlick-Fresnel sky-gradient reflection
// and an optional faint ripple normal (the useful parts of luma PR #3311's water shading, without its
// refraction / wave simulation: the DEM has no bathymetry). The lake test is the alpine albedo's
// (look/glsl/ramps.ts, zero elevation gradient below 2600 m). One source for both engines: the GLSL
// chunk (deck terrain-layer.ts, after ALPINE_FNS, which supplies rampNoise / rampFbm / rampSrgb) and
// the WGSL one (deck-webgpu/layers/terrain-styles.ts, after ALPINE_WGSL). Colours are LINEAR.

/** Ripple height scale: the normal tilt (rad-ish) at the nearest range, fading with distance. */
const RIPPLE = "0.035";

export const WATER_FNS = /* glsl */ `
// lake coverage: same test as alpineAlbedo's
float lakeMask(float elev, vec2 xy) {
  float grad = fwidth(elev) / max(length(fwidth(xy)), 1e-3);
  return (1.0 - smoothstep(0.0004, 0.0015, grad)) * (1.0 - smoothstep(2500.0, 2600.0, elev));
}

// col: the alpine albedo (already carries the flat lake tint); view: unit vector fragment -> eye
vec3 waterShade(vec3 col, float elev, vec2 xy, vec3 n, vec3 view, float range) {
  float m = lakeMask(elev, xy);
  if (m <= 0.0) return col;
  // ripple: two drifting octaves of value-noise gradient, calmer with distance (no shimmer at range)
  float amp = ${RIPPLE} / (1.0 + range / 2500.0);
  vec2 q = xy / 9.0;
  float e = 0.5;
  vec2 g = vec2(rampNoise(q + vec2(e, 0.0)) - rampNoise(q - vec2(e, 0.0)),
                rampNoise(q + vec2(0.0, e)) - rampNoise(q - vec2(0.0, e)));
  vec2 q2 = xy / 31.0 + 11.7;
  g += 0.6 * vec2(rampNoise(q2 + vec2(e, 0.0)) - rampNoise(q2 - vec2(e, 0.0)),
                  rampNoise(q2 + vec2(0.0, e)) - rampNoise(q2 - vec2(0.0, e)));
  vec3 nw = normalize(vec3(n.xy - g * amp, max(n.z, 1e-3)));
  // depth tint: shallow turquoise to deep blue-green, patchy (no bathymetry in the DEM)
  float depth = clamp(0.35 + 0.9 * (rampFbm(xy / 380.0) - 0.4), 0.0, 1.0);
  vec3 body = mix(rampSrgb(vec3(0.30, 0.55, 0.58)), rampSrgb(vec3(0.07, 0.24, 0.36)), depth);
  // Schlick Fresnel (water F0 = 0.02) reflecting a sky gradient: pale horizon to deep zenith
  float cosT = clamp(dot(nw, view), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  vec3 r = reflect(-view, nw);
  vec3 sky = mix(rampSrgb(vec3(0.80, 0.88, 0.95)), rampSrgb(vec3(0.28, 0.50, 0.84)), pow(clamp(r.z, 0.0, 1.0), 0.5));
  return mix(col, mix(body, sky, fres), m * 0.95);
}
`;

/** The WGSL twin; `grad` = fwidth(elev) / |fwidth(xy)| from the caller, as for ts_alpine_albedo. */
export const WATER_WGSL = /* wgsl */ `
fn ts_water_shade(col: vec3<f32>, elev: f32, xy: vec2<f32>, grad: f32, n: vec3<f32>, view: vec3<f32>, range: f32) -> vec3<f32> {
  let m = (1.0 - smoothstep(0.0004, 0.0015, grad)) * (1.0 - smoothstep(2500.0, 2600.0, elev));
  if (m <= 0.0) { return col; }
  let amp = ${RIPPLE} / (1.0 + range / 2500.0);
  let q = xy / 9.0;
  let e = 0.5;
  var g = vec2<f32>(ts_noise(q + vec2<f32>(e, 0.0)) - ts_noise(q - vec2<f32>(e, 0.0)),
                    ts_noise(q + vec2<f32>(0.0, e)) - ts_noise(q - vec2<f32>(0.0, e)));
  let q2 = xy / 31.0 + 11.7;
  g += 0.6 * vec2<f32>(ts_noise(q2 + vec2<f32>(e, 0.0)) - ts_noise(q2 - vec2<f32>(e, 0.0)),
                       ts_noise(q2 + vec2<f32>(0.0, e)) - ts_noise(q2 - vec2<f32>(0.0, e)));
  let nw = normalize(vec3<f32>(n.xy - g * amp, max(n.z, 1e-3)));
  let depth = clamp(0.35 + 0.9 * (ts_fbm(xy / 380.0) - 0.4), 0.0, 1.0);
  let body = mix(ts_srgb(vec3<f32>(0.30, 0.55, 0.58)), ts_srgb(vec3<f32>(0.07, 0.24, 0.36)), depth);
  let cosT = clamp(dot(nw, view), 0.0, 1.0);
  let fres = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  let r = reflect(-view, nw);
  let sky = mix(ts_srgb(vec3<f32>(0.80, 0.88, 0.95)), ts_srgb(vec3<f32>(0.28, 0.50, 0.84)), pow(clamp(r.z, 0.0, 1.0), 0.5));
  return mix(col, mix(body, sky, fres), m * 0.95);
}
`;

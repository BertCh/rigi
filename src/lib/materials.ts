// One uber-shader for terrain tiles. `uStyle` picks what a pass renders:
//   0 hillshade  – hypsometric tint × sun + aerial perspective
//   1 imagery    – draped map/satellite texture (falls back to hillshade)
//   2 contours   – isolines + ridge tint on a transparent background (photo overlay)
//   3 geometry   – float target: rgb = ENU xyz, a = range from camera (for readback)
//   4 elevation  – banded hypsometric "topology" colouring, semi-transparent
// Independently, uProjectPhoto > 0 projects the photo onto terrain from its camera,
// using the photo camera's range buffer as a shadow map (only surfaces the photo saw).
import * as THREE from "three";
import {
	ATM_BLOCK,
	ATMOSPHERE_FNS,
	SKY_BLOCK,
	SKY_FS_MAIN,
	SKY_VS,
} from "./look/glsl/atmosphere";
import { HARM_BLOCK, HARMONIZE_FNS } from "./look/glsl/composite";
import {
	ALPINE_FNS,
	SLOPE_BLOCK,
	SLOPE_FNS,
	TANAKA_FNS,
} from "./look/glsl/ramps";
import { REL_BLOCK, RELIEF_FNS } from "./look/glsl/relief";

/** slopeClass (6): the slope layer, only in a LOOK_SLOPE program; normal (7): the ink creases' normal pass, only under LOOK_INK. */
export const STYLE = {
	hillshade: 0,
	imagery: 1,
	contours: 2,
	geometry: 3,
	elevation: 4,
	slopeClass: 6,
	normal: 7,
} as const;

/** Ramp uniforms hold at most this many stops (src/lib/style/ramps.ts MAX_RAMP_STOPS). */
export const RAMP_MAX = 8;

/**
 * A colour ramp as uniform arrays: C = sRGB stop colours, T = stop positions, D = per-segment divisor
 * (t_i - t_{i-1}, computed in double precision so it rounds to the same float as the old literal, e.g.
 * 0.72 - 0.5 → 0.22), E = 1 where the segment ending at stop i eases with smoothstep, N = stop count.
 * The shader mixes in sRGB and then applies toLinear (pow 2.2), the order the old hypso()/coolRamp() used.
 */
export type RampStopsU = {
	t: number;
	c: [number, number, number];
	smooth?: boolean;
}[];

export function writeRamp(
	u: Record<string, THREE.IUniform>,
	prefix: string,
	stops: RampStopsU,
) {
	const n = Math.max(1, Math.min(RAMP_MAX, stops.length));
	const C = u[`${prefix}C`].value as THREE.Vector3[];
	const T = u[`${prefix}T`].value as number[];
	const D = u[`${prefix}D`].value as number[];
	const E = u[`${prefix}E`].value as number[];
	for (let i = 0; i < RAMP_MAX; i++) {
		const s = stops[Math.min(i, n - 1)];
		C[i].set(s.c[0], s.c[1], s.c[2]);
		T[i] = s.t;
		D[i] = i > 0 && i < n ? stops[i].t - stops[i - 1].t || 1 : 1;
		E[i] = i < n && s.smooth ? 1 : 0;
	}
	u[`${prefix}N`].value = n;
}

function rampUniforms(
	prefix: string,
	stops: RampStopsU,
): Record<string, THREE.IUniform> {
	const u: Record<string, THREE.IUniform> = {
		[`${prefix}C`]: {
			value: Array.from({ length: RAMP_MAX }, () => new THREE.Vector3()),
		},
		[`${prefix}T`]: { value: new Array<number>(RAMP_MAX).fill(0) },
		[`${prefix}D`]: { value: new Array<number>(RAMP_MAX).fill(1) },
		[`${prefix}E`]: { value: new Array<number>(RAMP_MAX).fill(0) },
		[`${prefix}N`]: { value: 1 },
	};
	writeRamp(u, prefix, stops);
	return u;
}

// The classic look. These duplicate src/lib/style (CLASSIC, RAMPS) on purpose, so this file stays
// standalone; scripts/style-check.ts cross-checks the two.
/** hypso(): linear to .72, then smoothstep(0.72, 0.85, t), constant above */
export const HYPSO_CLASSIC: RampStopsU = [
	{ t: 0, c: [0.36, 0.52, 0.3] },
	{ t: 0.25, c: [0.62, 0.66, 0.4] },
	{ t: 0.5, c: [0.6, 0.5, 0.38] },
	{ t: 0.72, c: [0.62, 0.6, 0.6] },
	{ t: 0.85, c: [0.97, 0.98, 1.0], smooth: true },
];
/** coolRamp(): teal → blue → violet → magenta → cream, evenly spaced */
export const COOL_CLASSIC: RampStopsU = [
	{ t: 0, c: [0.1, 0.85, 0.8] },
	{ t: 0.25, c: [0.3, 0.55, 1.0] },
	{ t: 0.5, c: [0.75, 0.35, 1.0] },
	{ t: 0.75, c: [1.0, 0.35, 0.7] },
	{ t: 1, c: [1.0, 0.95, 0.85] },
];

export function makeSharedUniforms(): Record<string, THREE.IUniform> {
	return {
		uStyle: { value: 0 },
		uSunDir: { value: new THREE.Vector3(-0.5, -0.4, 0.75).normalize() },
		uContourInterval: { value: 100 },
		uContourMajorEvery: { value: 5 },
		uContourWidth: { value: 1.2 },
		uContourFadeNear: { value: 4000 },
		uContourFadeFar: { value: 25000 },
		uContourOpacity: { value: 1 },
		uNearFade: { value: 0 },
		uElevRange: { value: new THREE.Vector2(400, 4200) },
		uHaze: { value: 1 },
		uHazeColor: { value: new THREE.Color(0xb9cde0) },
		// photo projection
		uProjectPhoto: { value: 0 },
		uPhoto: { value: null },
		uPhotoViewProj: { value: new THREE.Matrix4() },
		uPhotoPos: { value: new THREE.Vector3() },
		uPhotoRange: { value: null },
		uPhotoMinRange: { value: 60 },
		uPhotoTint: { value: 0 },
		uPhotoFg: { value: null },
		uPhotoFgOn: { value: 0 },
		// Step Inside "Truth" toggle (world / step view only): tint by provenance, observed drape vs DEM.
		// 0 = off: the classic shader path, unchanged
		uTruth: { value: 0 },
		uTruthObs: { value: new THREE.Vector3(0, 158 / 255, 115 / 255) },
		uTruthDem: { value: new THREE.Vector3(230 / 255, 159 / 255, 0) },
		// ---- view style (src/lib/style, applied by style/three-apply.ts). Defaults = the classic look. ----
		...rampUniforms("uReliefRamp", HYPSO_CLASSIC),
		...rampUniforms("uLineRamp", COOL_CLASSIC),
		...rampUniforms("uBandRamp", COOL_CLASSIC),
		uShadeAmbient: { value: 0.25 },
		uShadeDirect: { value: 0.85 },
		uHazeDensity: { value: 0.000018 },
		uHazeMax: { value: 0.85 },
		uContourMajorMul: { value: 1.8 },
		uMinorAlpha: { value: 0.45 },
		uMajorAlpha: { value: 0.95 },
		/** minor lo, minor hi, major lo, major hi (smoothstep on fwidth) */
		uDensityFade: { value: new THREE.Vector4(0.08, 0.2, 0.1, 0.25) },
		uFadeFloor: { value: 0.3 },
		/** 1 = solid minor/major colours (sRGB) instead of uLineRamp */
		uContourSolid: { value: 0 },
		uContourMinorCol: { value: new THREE.Vector3(1, 1, 1) },
		uContourMajorCol: { value: new THREE.Vector3(1, 1, 1) },
		/** on, extra px, minor multiplier, alpha */
		uCasing: { value: new THREE.Vector4(1, 2, 0.45, 0.55) },
		/** used as-is (a linear value), like the old literal */
		uCasingCol: { value: new THREE.Vector3(0.02, 0.03, 0.06) },
		/** (shadeMin, 1 - shadeMin) */
		uBandShade: { value: new THREE.Vector2(0.55, 1 - 0.55) },
		uBandLineWhiten: { value: 0.8 },
		uBandLineCol: { value: new THREE.Vector3(1, 1, 1) },
		uBandAlpha: { value: 0.55 },
		uBandLineAlpha: { value: 0.4 },
		uBandGroundFade: { value: new THREE.Vector2(60, 450) },
		/** imagery adjust; skipped entirely while uImgOn = 0 (identity) */
		uImgOn: { value: 0 },
		uImgSat: { value: 1 },
		uImgBright: { value: 1 },
		uImgContrast: { value: 1 },
		/** linear rgb + amount */
		uImgTint: { value: new THREE.Vector4(1, 1, 1, 0) },
		uPhotoTintCol: { value: new THREE.Vector3(1, 0.85, 0.6) },
		// ---- look features (look/glsl), read only under their LOOK_* define ----
		...ATM_BLOCK.threeUniforms(),
		...REL_BLOCK.threeUniforms(),
		...SLOPE_BLOCK.threeUniforms(),
		...HARM_BLOCK.threeUniforms(),
		// the relief field (look/relief/field.ts); A = 0 (no coverage) until one is built
		reliefField: { value: emptyTexture() },
		reliefGen: { value: emptyTexture() },
	};
}

function emptyTexture() {
	const t = new THREE.DataTexture(new Uint8Array(4), 1, 1);
	t.needsUpdate = true;
	return t;
}

/** GLSL: the RAMP_MAX define and rampEval() over the uniform arrays writeRamp fills (also used by engine.ts's composite). */
export const RAMP_GLSL = /* glsl */ `
#define RAMP_MAX 8
// piecewise ramp in sRGB: segment i runs from stop i-1 to stop i; t below the first / above the
// last stop clamps. D holds the segment divisors (see writeRamp), E the smoothstep flags.
vec3 rampEval(vec3 C[RAMP_MAX], float T[RAMP_MAX], float D[RAMP_MAX], float E[RAMP_MAX], int n, float t) {
  vec3 c = C[0];
  for (int i = 1; i < RAMP_MAX; i++) {
    if (i >= n) break;
    if (t < T[i] || i == n - 1) {
      float f = E[i] > 0.5 ? smoothstep(T[i - 1], T[i], t) : clamp((t - T[i - 1]) / D[i], 0.0, 1.0);
      c = mix(C[i - 1], C[i], f);
      break;
    }
  }
  return c;
}
`;

const vertex = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float elev;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying float vElev;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  vElev = elev;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}
`;

const fragment = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform int uStyle;
uniform sampler2D map;
uniform float hasMap;
uniform vec3 uSunDir;
uniform float uContourInterval;
uniform float uContourMajorEvery;
uniform float uContourWidth;
uniform float uContourFadeNear;
uniform float uContourFadeFar;
uniform float uContourOpacity;
uniform float uNearFade;
uniform vec2 uElevRange;
uniform float uHaze;
uniform vec3 uHazeColor;
uniform float uProjectPhoto;
uniform sampler2D uPhoto;
uniform mat4 uPhotoViewProj;
uniform vec3 uPhotoPos;
uniform sampler2D uPhotoRange;
uniform float uPhotoMinRange;
uniform float uPhotoTint;
uniform sampler2D uPhotoFg;
uniform float uPhotoFgOn;
uniform float uTruth;
uniform vec3 uTruthObs;
uniform vec3 uTruthDem;
${RAMP_GLSL}
uniform vec3 uReliefRampC[RAMP_MAX];
uniform float uReliefRampT[RAMP_MAX];
uniform float uReliefRampD[RAMP_MAX];
uniform float uReliefRampE[RAMP_MAX];
uniform int uReliefRampN;
uniform vec3 uLineRampC[RAMP_MAX];
uniform float uLineRampT[RAMP_MAX];
uniform float uLineRampD[RAMP_MAX];
uniform float uLineRampE[RAMP_MAX];
uniform int uLineRampN;
uniform vec3 uBandRampC[RAMP_MAX];
uniform float uBandRampT[RAMP_MAX];
uniform float uBandRampD[RAMP_MAX];
uniform float uBandRampE[RAMP_MAX];
uniform int uBandRampN;
uniform float uShadeAmbient;
uniform float uShadeDirect;
uniform float uHazeDensity;
uniform float uHazeMax;
uniform float uContourMajorMul;
uniform float uMinorAlpha;
uniform float uMajorAlpha;
uniform vec4 uDensityFade;
uniform float uFadeFloor;
uniform float uContourSolid;
uniform vec3 uContourMinorCol;
uniform vec3 uContourMajorCol;
uniform vec4 uCasing;
uniform vec3 uCasingCol;
uniform vec2 uBandShade;
uniform float uBandLineWhiten;
uniform vec3 uBandLineCol;
uniform float uBandAlpha;
uniform float uBandLineAlpha;
uniform vec2 uBandGroundFade;
uniform float uImgOn;
uniform float uImgSat;
uniform float uImgBright;
uniform float uImgContrast;
uniform vec4 uImgTint;
uniform vec3 uPhotoTintCol;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying float vElev;

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
#ifdef LOOK_ATMOSPHERE
${ATM_BLOCK.threeDecl}${ATMOSPHERE_FNS}
#endif
#ifdef LOOK_RELIEF
${REL_BLOCK.threeDecl}${RELIEF_FNS}
#endif
#ifdef LOOK_ALPINE
${ALPINE_FNS}
#endif
#ifdef LOOK_TANAKA
${TANAKA_FNS}
#endif
#ifdef LOOK_SLOPE
${SLOPE_BLOCK.threeDecl}${SLOPE_FNS}
#endif
#ifdef LOOK_HARMONIZE
${HARM_BLOCK.threeDecl}${HARMONIZE_FNS}
#endif

float elevT(float h) {
  return clamp((h - uElevRange.x) / (uElevRange.y - uElevRange.x), 0.0, 1.0);
}

vec3 hypso(float h) {
  return toLinear(rampEval(uReliefRampC, uReliefRampT, uReliefRampD, uReliefRampE, uReliefRampN, elevT(h)));
}

// the hillshade albedo: the relief ramp, or the Alpine tint (LOOK_ALPINE)
#ifdef LOOK_ALPINE
#define ALBEDO(n) alpineAlbedo(vElev, n, vWorld.xy)
#else
#define ALBEDO(n) hypso(vElev)
#endif

// "topology" ramp for contour lines (classic: cool teal → cyan → violet → magenta → cream)
vec3 lineRamp(float t) {
  return toLinear(rampEval(uLineRampC, uLineRampT, uLineRampD, uLineRampE, uLineRampN, clamp(t, 0.0, 1.0)));
}

vec3 bandRamp(float t) {
  return toLinear(rampEval(uBandRampC, uBandRampT, uBandRampD, uBandRampE, uBandRampN, clamp(t, 0.0, 1.0)));
}

float shade(vec3 n) {
  float l = max(dot(n, uSunDir), 0.0);
  float sky = 0.5 + 0.5 * n.z;
  return uShadeAmbient * sky + uShadeDirect * l;
}

// uHazeColor is a THREE.Color (already linear) and gets toLinear again: the classic look relies on
// that double linearisation (styling.md §2.3), so it stays.
vec3 haze(vec3 col, float range) {
  float f = 1.0 - exp(-range * uHazeDensity * uHaze);
  return mix(col, toLinear(uHazeColor), clamp(f, 0.0, uHazeMax));
}

float contourLine(float e, float widthPx) {
  float fw = fwidth(e);
  float d = abs(fract(e - 0.5) - 0.5) / max(fw, 1e-6);
  return 1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, d);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormal);
  float range = length(vWorld - cameraPosition);

  if (uStyle == 3) {
    gl_FragColor = vec4(vWorld, range);
    return;
  }
#ifdef LOOK_INK
  // the normal pass for the composite's ink creases
  if (uStyle == 7) {
    gl_FragColor = vec4(n, 1.0);
    return;
  }
#endif

#ifdef LOOK_SLOPE
  if (uStyle == 6) {
    vec4 sc = slopeClass(n);
    float near = uNearFade > 0.0 ? smoothstep(uNearFade * 0.5, uNearFade, range) : 1.0;
    gl_FragColor = vec4(sc.rgb, sc.a * near * uContourOpacity);
    return;
  }
#endif

  vec4 col;
  if (uStyle == 2 || uStyle == 4) {
    float e = vElev / uContourInterval;
    float fade = 1.0 - smoothstep(uContourFadeNear, uContourFadeFar, range);
    // lines that get denser than ~3px apart turn into mush: fade them out
    float density = fwidth(e);
    float minorFade = 1.0 - smoothstep(uDensityFade.x, uDensityFade.y, density);
    float minorA = contourLine(e, uContourWidth) * minorFade;
    float em = e / uContourMajorEvery;
    float majorFade = 1.0 - smoothstep(uDensityFade.z, uDensityFade.w, fwidth(em));
    float majorA = contourLine(em, uContourWidth * uContourMajorMul) * majorFade;
    float t = elevT(vElev);
    vec3 lc = uContourSolid > 0.5
      ? toLinear(majorA * uMajorAlpha >= minorA * uMinorAlpha ? uContourMajorCol : uContourMinorCol)
      : lineRamp(t);
    // terrain closer than the GPS error is in the wrong place anyway: fade it
    float near = uNearFade > 0.0 ? smoothstep(uNearFade * 0.5, uNearFade, range) : 1.0;
    float a = max(minorA * uMinorAlpha, majorA * uMajorAlpha) * mix(uFadeFloor, 1.0, fade) * near;
#ifdef LOOK_TANAKA
    if (uStyle == 2) {
      vec4 tk = tanakaLines(vElev, uContourInterval, uContourMajorEvery, n, uSunDir, vWorld, cameraPosition, range);
      gl_FragColor = vec4(tk.rgb, tk.a * mix(uFadeFloor, 1.0, fade) * near * uContourOpacity);
      return;
    }
#endif
    if (uStyle == 4) {
      float band = floor(vElev / (uContourInterval * uContourMajorEvery));
      float bt = clamp((band * uContourInterval * uContourMajorEvery - uElevRange.x) / (uElevRange.y - uElevRange.x), 0.0, 1.0);
#ifdef LOOK_RELIEF
      vec3 bc = bandRamp(bt) * (uBandShade.x + uBandShade.y * reliefLight(n, vWorld, range));
#else
      vec3 bc = bandRamp(bt) * (uBandShade.x + uBandShade.y * shade(n));
#endif
      // the ground at your feet reads better as photo than as a flat tint
      col = vec4(mix(bc, uBandLineCol, a * uBandLineWhiten), (uBandAlpha + uBandLineAlpha * a) * smoothstep(uBandGroundFade.x, uBandGroundFade.y, range));
    } else if (uCasing.x > 0.5) {
      // dark casing just outside the line keeps it legible over snow and bright sky
      float casing = max(contourLine(e, uContourWidth + uCasing.y) * minorFade * uCasing.z, contourLine(em, uContourWidth * uContourMajorMul + uCasing.y) * majorFade) * mix(uFadeFloor, 1.0, fade) * near;
      vec3 c = mix(uCasingCol, lc, a / max(casing, 1e-3));
      col = vec4(c, max(a, casing * uCasing.w) * uContourOpacity);
    } else {
      col = vec4(lc, a * uContourOpacity);
    }
    gl_FragColor = col;
    return;
  }

  vec3 base;
  if (uStyle == 1 && hasMap > 0.5) {
    base = texture2D(map, vUv).rgb;
    if (uImgOn > 0.5) {
      float l = dot(base, vec3(0.2126, 0.7152, 0.0722));
      base = mix(vec3(l), base, uImgSat);
      base = max((base - 0.18) * uImgContrast + 0.18, 0.0) * uImgBright;
      // tint: shift the hue toward the tint colour at constant luminance
      float tl = max(dot(uImgTint.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
      base = mix(base, uImgTint.rgb * (dot(base, vec3(0.2126, 0.7152, 0.0722)) / tl), uImgTint.a);
    }
  } else {
#ifdef LOOK_RELIEF
    base = reliefShade(ALBEDO(n), n, vWorld, range);
#else
    base = ALBEDO(n) * shade(n);
#endif
  }

  if (uProjectPhoto > 0.0) {
    vec4 clip = uPhotoViewProj * vec4(vWorld, 1.0);
    if (clip.w > 0.0) {
      vec3 ndc = clip.xyz / clip.w;
      vec2 puv = ndc.xy * 0.5 + 0.5;
      if (all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
        float r = length(vWorld - uPhotoPos);
#ifdef LOOK_HARMONIZE
        // inside the photo's footprint, tone the render toward the photo so the holes the photo
        // can't fill read as intentional; feathered over a quarter of the frame
        vec2 edge = min(puv, 1.0 - puv);
        if (hrm_amount > 0.0) base = mix(base, harmonize(base, r), smoothstep(0.0, 0.25, min(edge.x, edge.y)));
#endif
        float seen = texture2D(uPhotoRange, puv).a;
        // visible from the photo camera if not occluded (range test with relative bias)
        bool visible = seen > 0.0 && r < seen * 1.015 + 15.0 && r > uPhotoMinRange;
        // people in the photo would smear across the ground behind them
        if (uPhotoFgOn > 0.5 && texture2D(uPhotoFg, puv).r > 0.5) visible = false;
        if (visible) {
          vec3 pc = texture2D(uPhoto, puv).rgb;
          // grazing angles smear: weight by incidence to the photo ray
          vec3 ray = normalize(vWorld - uPhotoPos);
          float inc = clamp(-dot(ray, n) * 3.0, 0.0, 1.0);
          // uProjectPhoto > 1.5: Step Inside (seen from the photo camera the drape is the photo itself)
          float w = uProjectPhoto > 1.5 ? 1.0 : uProjectPhoto * mix(0.35, 1.0, inc);
          base = mix(base, pc, w);
          base = mix(base, base * uPhotoTintCol, uPhotoTint);
        }
      }
    }
  }

  // Step Inside "Truth" (uTruth > 0.5, world / step view only): surfaces tinted by provenance, the drape's
  // photo pixels (the same visibility test as above) = observed, every other terrain fragment = dem.
  // uTruth = uTruthMix (splats: three-splats.ts truth 0.65)
  if (uTruth > 0.0) {
    bool seenT = false;
    vec4 clipT = uPhotoViewProj * vec4(vWorld, 1.0);
    if (uProjectPhoto > 0.0 && clipT.w > 0.0) {
      vec2 puvT = (clipT.xy / clipT.w) * 0.5 + 0.5;
      if (all(greaterThan(puvT, vec2(0.0))) && all(lessThan(puvT, vec2(1.0)))) {
        float rT = length(vWorld - uPhotoPos);
        float seen = texture2D(uPhotoRange, puvT).a;
        seenT = seen > 0.0 && rT < seen * 1.015 + 15.0 && rT > uPhotoMinRange;
        if (uPhotoFgOn > 0.5 && texture2D(uPhotoFg, puvT).r > 0.5) seenT = false;
      }
    }
    base = mix(base, toLinear(seenT ? uTruthObs : uTruthDem), uTruth);
  }

#ifdef LOOK_ATMOSPHERE
  gl_FragColor = vec4(applyAtmosphere(base, vWorld), 1.0);
#else
  gl_FragColor = vec4(haze(base, range), 1.0);
#endif
  #include <colorspace_fragment>
}
`;

/** `defines`: the look's LOOK_* set (look-key.ts); none for classic. */
export function makeTerrainMaterial(
	uniforms: Record<string, THREE.IUniform>,
	defines: Record<string, string> = {},
) {
	return new THREE.ShaderMaterial({
		uniforms,
		defines,
		vertexShader: vertex,
		fragmentShader: fragment,
		transparent: false,
		side: THREE.FrontSide,
	});
}

/** World view background for world.sky.mode 'atmosphere': look/glsl atmSky on a fullscreen triangle. */
export function makeSkyMesh(uniforms: Record<string, THREE.IUniform>) {
	const geo = new THREE.BufferGeometry().setAttribute(
		"position",
		new THREE.BufferAttribute(new Float32Array(9), 3),
	);
	const mesh = new THREE.Mesh(
		geo,
		new THREE.ShaderMaterial({
			uniforms: { ...uniforms, ...SKY_BLOCK.threeUniforms() },
			vertexShader: SKY_VS,
			fragmentShader: `${ATM_BLOCK.threeDecl}${ATMOSPHERE_FNS}${SKY_BLOCK.threeDecl}${SKY_FS_MAIN}
void main() {
  gl_FragColor = vec4(skyColor(), 1.0);
  #include <colorspace_fragment>
}`,
			depthTest: false,
			depthWrite: false,
		}),
	);
	mesh.frustumCulled = false;
	mesh.renderOrder = -1;
	return mesh;
}

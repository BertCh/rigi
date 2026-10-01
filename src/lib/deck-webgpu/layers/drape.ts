// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The projective photo drape on WebGPU: a TerrainShaderPart plugin (README.md "Terrain shading
// parts") that ports deck/terrain-layer.ts's projectPhoto branch (+ its LOOK_HARMONIZE tone-in and
// the Step Inside "Truth" provenance tint) onto TerrainCore / the batched terrain, with the occlusion
// test of roll/map/multi-drape-layer.ts.
//
// How it maps onto the foundation:
//   - photo camera: photoCameraModule (`photoCam`), uniforms sized to the GEOMETRY target
//     (setPhotoCamera(cameraUniforms(photoCamera({pose, eye, width: g.width, height: g.height})))),
//     so photo_uv() lands on geometry texels. In the world view the colour pass's `camera` is the
//     orbit camera and `photoCam` the photo's: that difference is the drape.
//   - range map: ctx.geometry.geometry (.w = range from the photo eye, 0 = sky), read with
//     textureLoad in the same frame (the geometry pass has already ended) — no CPU rangeMapFrom().
//   - photo: imageTexture (rgba8unorm-srgb + mips: samples come back LINEAR, so the WebGL
//     srgbDecode() is done by the hardware). Mip level: dpdx / dpdy of the photo uv taken at the
//     TOP of drape_apply (uniform control flow), textureSampleGrad inside the branches.
//   - mask: maskTexture (r8unorm, row 0 = top): the people mask, or engine.ts drapeMask()'s
//     people ∪ Object pixels / stepMasks().step while Step Inside is on.
//
// Occlusion. WebGL (terrain-layer.ts) point-sampled one range texel and tested
// `r < seen·1.015 + 15`; at every silhouette the nearest texel flips between the ridge and the
// ground behind it, which stripes grazing slopes ("drape acne"). Here, as in multi-drape-layer.ts,
// the TEST is filtered like PCF: the 2×2 nearest texels each vote (same range test + a
// slope-scaled bias `1.5·r·Δθ / max(sin incidence, 0.012)`, Δθ = one geometry texel's angle) and
// the votes are bilinearly weighted; `smoothstep(0, 0.75, vis)` scales the drape. The silhouette
// lands at ± half a texel and fades over one texel. `vote: false` restores the classic
// single-texel binary test (A/B, and what the check compares against).
//
// Colour: blends happen in linear on the opaque terrain colour before fog_apply (the terrain's
// fragmentMain applies fog after the plugins, as WebGL's haze(base, range) did). Transparent
// styles (a < 1: contours, bands over the photo) are returned unchanged, as WebGL's contour style
// returned before the drape. Output stays premultiplied with alpha 1 on terrain.
//
//   projectPhoto  0 = off; 0..1 blend × mix(0.35, 1, incidence); > 1.5 = Step Inside (the full
//                 photo at every incidence: seen from the photo camera the drape IS the photo)
//   minRange      photoMinRange: no drape closer than this (m; engine minProjectRange, Step 1)
//   tint          the style's projection tint (world.projectionTint), on draped fragments only
//   truth         Step Inside Truth: mix toward observed (seen) / dem (not seen) provenance colours
//   harmonize     LOOK_HARMONIZE band stats (look/composite.ts harmonizeValues) or null; toggling
//                 it rebuilds the terrain colour pipeline (a define), values are uniforms
//   clearAir      look/clear-air.ts clearAirValues() or null (= CLEAR_AIR_OFF, amount 0 = identity):
//                 the photo's own haze inverted along the PHOTO camera's ray (photoCam.eye → the
//                 fragment) on the linear photo sample, before it blends (not in Step Inside), so
//                 the terrain's fog_apply doesn't haze distant ground twice. Own module (clearAir),
//                 values are uniforms, always bound
//
// Wiring (assembler / engine port):
//   const drape = new DrapePart(device);
//   terrain.setShaderParts(stylePart, [drape.part(), ...]);   // part() is stable; call again after
//                                                            // setSettings({harmonize}) toggles it
//   drape.setPhoto(photoImg);                 // HTMLImageElement / ImageBitmap (or setPhotoTexture(tex))
//   drape.setMask(engineDrapeMask.photoFg);   // {width, height, data} row 0 = top, or null
//   drape.setPhotoCamera(cameraUniforms(photoCamera({pose, eye, width: host.geometry.width,
//                                                     height: host.geometry.height})));
//   drape.setSettings({
//     projectPhoto: stepView ? 2 : s.projectOpacity,
//     minRange: stepView ? 1 : s.minProjectRange,
//     protectPeople: drapeMask.protectPeople,
//     tint: look.photoTint, tintColor: look.photoTintCol,
//     truth: nf?.opts.truth ? PROVENANCE_TINT_MIX : 0,
//     harmonize: engine.harmonize(style.world.drapeHarmonize),
//     clearAir: clearAirOn(style) ? clearAirValues(style, haze.fit, sunDir, {eyeAlt, dir}) : null,
//   });
// The drape is drawn in the views listed in settings.views (default: world only — the photo
// view's colour pass stays classic, as the WebGL offscreen passes forced projectPhoto 0).
import type { Device, Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";
import { type ClearAirValues, CLEAR_AIR_OFF } from "#/lib/look/clear-air";
import { BAND_CENTERS_LOG10 } from "#/lib/look/color-stats";
import type { harmonizeValues } from "#/lib/look/composite";
import {
	CLEAR_AIR_UNIFORM_TYPES,
	CLEAR_AIR_WGSL,
	clearAirUniforms,
} from "#/lib/look/glsl/clear-air";
import { PROVENANCE_COLORS } from "#/lib/nearfield/provenance";
import { type CameraUniforms, photoCameraModule } from "../camera";
import type { PassContext } from "../pass";
import { USAGE } from "../targets";
import type { TerrainShaderPart } from "../terrain";
import { imageTexture, maskTexture, placeholderTextures } from "../textures";

type V3 = [number, number, number];

/** multi-drape-layer.ts MIN_SIN_INC: the slope bias grows as 1/sin(incidence) down to ≈ 0.7°. */
export const MIN_SIN_INC = 0.012;

export type DrapeSettings = {
	/** 0 = off; 0..1 blend of the projected photo; > 1.5 = Step Inside (the full photo). */
	projectPhoto: number;
	/** No drape closer than this to the photo eye (m). */
	minRange: number;
	/** Keep masked pixels (people / objects) out of the drape. */
	protectPeople: boolean;
	/** The style's projection tint amount (deckTerrainStyle(...).photoTint) and colour. */
	tint: number;
	tintColor: V3;
	/** Step Inside Truth: 0 = off, else the provenance tint's mix (PROVENANCE_TINT_MIX). */
	truth: number;
	/** LOOK_HARMONIZE band stats (look/composite.ts harmonizeValues), null = off. */
	harmonize: ReturnType<typeof harmonizeValues> | null;
	/** Clear air (look/clear-air.ts clearAirValues): the photo's haze inverted on the drape sample. null = off. */
	clearAir: ClearAirValues | null;
	/** Soft 2×2 vote + slope bias (true) or the classic single-texel binary test (false). */
	vote: boolean;
	/** Views the drape is drawn in (FrameState.view). */
	views: readonly ("photo" | "world")[];
};

export const DEFAULT_DRAPE: DrapeSettings = {
	projectPhoto: 0,
	minRange: 80, // engine.ts defaultSettings.minProjectRange
	protectPeople: true,
	tint: 0,
	tintColor: [1, 1, 1],
	truth: 0,
	harmonize: null,
	clearAir: null,
	vote: true,
	views: ["world"],
};

const TRUTH_OBS = [...PROVENANCE_COLORS.observed.map((c) => c / 255), 1];
const TRUTH_DEM = [...PROVENANCE_COLORS.dem.map((c) => c / 255), 1];

export const drapeModule = {
	name: "drape",
	source: /* wgsl */ `\
struct DrapeUniforms {
  tintCol: vec4<f32>,
  truthObs: vec4<f32>,
  truthDem: vec4<f32>,
  amount: f32,
  minRange: f32,
  fgOn: f32,
  tint: f32,
  truth: f32,
  vote: f32,
  pad0: f32,
  pad1: f32,
};
@group(0) @binding(auto) var<uniform> drape: DrapeUniforms;
`,
	uniformTypes: {
		tintCol: "vec4<f32>",
		truthObs: "vec4<f32>",
		truthDem: "vec4<f32>",
		amount: "f32",
		minRange: "f32",
		fgOn: "f32",
		tint: "f32",
		truth: "f32",
		vote: "f32",
		pad0: "f32",
		pad1: "f32",
	},
	bindingLayout: [{ name: "drape", group: 0 }],
} as const satisfies ShaderModule;

/** Clear air (look/glsl/clear-air.ts): struct + clear_air_photo(); the uniform is `clearAir`. */
export const clearAirModule = {
	name: "clearAir",
	source: /* wgsl */ `\
${CLEAR_AIR_WGSL}
@group(0) @binding(auto) var<uniform> clearAir: ClearAirUniforms;
`,
	uniformTypes: CLEAR_AIR_UNIFORM_TYPES,
	bindingLayout: [{ name: "clearAir", group: 0 }],
} as const satisfies ShaderModule;

/** LOOK_HARMONIZE band stats (look/glsl/composite.ts HARM_BLOCK; column k = band k, Oklab xyz). */
export const drapeHarmonizeModule = {
	name: "drapeHrm",
	source: /* wgsl */ `\
struct DrapeHrmUniforms {
  pm: mat4x4<f32>,
  ps: mat4x4<f32>,
  lm: mat4x4<f32>,
  ls: mat4x4<f32>,
  amount: f32,
  chroma: f32,
  pad0: f32,
  pad1: f32,
};
@group(0) @binding(auto) var<uniform> drapeHrm: DrapeHrmUniforms;
`,
	uniformTypes: {
		pm: "mat4x4<f32>",
		ps: "mat4x4<f32>",
		lm: "mat4x4<f32>",
		ls: "mat4x4<f32>",
		amount: "f32",
		chroma: "f32",
		pad0: "f32",
		pad1: "f32",
	},
	bindingLayout: [{ name: "drapeHrm", group: 0 }],
} as const satisfies ShaderModule;

const HRM_C = BAND_CENTERS_LOG10.map((x) => x.toFixed(6)).join(", ");

/** look/glsl/{oklab,composite}.ts harmonize() in WGSL (drape_ prefixed: parts share one program). */
const HARMONIZE_WGSL = /* wgsl */ `\
fn drape_linear_to_oklab(c0: vec3<f32>) -> vec3<f32> {
  let c = max(c0, vec3<f32>(0.0));
  let l = pow(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b, 1.0 / 3.0);
  let m = pow(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b, 1.0 / 3.0);
  let s = pow(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b, 1.0 / 3.0);
  return vec3<f32>(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
fn drape_oklab_to_linear(c: vec3<f32>) -> vec3<f32> {
  var l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  var m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  var s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3<f32>(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
const DRAPE_HRM_C: vec4<f32> = vec4<f32>(${HRM_C});
fn drape_hrm_band(m: mat4x4<f32>, lg: f32) -> vec3<f32> {
  if (lg <= DRAPE_HRM_C.x) { return m[0].xyz; }
  if (lg >= DRAPE_HRM_C.w) { return m[3].xyz; }
  if (lg < DRAPE_HRM_C.y) { return mix(m[0].xyz, m[1].xyz, (lg - DRAPE_HRM_C.x) / (DRAPE_HRM_C.y - DRAPE_HRM_C.x)); }
  if (lg < DRAPE_HRM_C.z) { return mix(m[1].xyz, m[2].xyz, (lg - DRAPE_HRM_C.y) / (DRAPE_HRM_C.z - DRAPE_HRM_C.y)); }
  return mix(m[2].xyz, m[3].xyz, (lg - DRAPE_HRM_C.z) / (DRAPE_HRM_C.w - DRAPE_HRM_C.z));
}
// Reinhard transfer in Oklab toward the photo's band statistics at this range
fn drape_harmonize(lin: vec3<f32>, range: f32) -> vec3<f32> {
  let lg = select(DRAPE_HRM_C.w, log(range) / log(10.0), range > 0.0);
  let lab = drape_linear_to_oklab(lin);
  let ratio = clamp(drape_hrm_band(drapeHrm.ps, lg) / drape_hrm_band(drapeHrm.ls, lg), vec3<f32>(0.5), vec3<f32>(2.0));
  let t = (lab - drape_hrm_band(drapeHrm.lm, lg)) * ratio + drape_hrm_band(drapeHrm.pm, lg);
  let a = drapeHrm.amount;
  return max(drape_oklab_to_linear(mix(lab, t, vec3<f32>(a, a * drapeHrm.chroma, a * drapeHrm.chroma))), vec3<f32>(0.0));
}
`;

/** The plugin's WGSL (after TERRAIN_COMMON: TerrainSample, colorWGSL, camera + photoCam in scope). */
export const DRAPE_WGSL = /* wgsl */ `\
@group(0) @binding(auto) var drapeGeo: texture_2d<f32>;
@group(0) @binding(auto) var drapePhoto: texture_2d<f32>;
@group(0) @binding(auto) var drapePhotoSampler: sampler;
@group(0) @binding(auto) var drapeMask: texture_2d<f32>;
@group(0) @binding(auto) var drapeMaskSampler: sampler;

const DRAPE_MIN_SIN_INC: f32 = ${MIN_SIN_INC};

#ifdef DRAPE_HARMONIZE
${HARMONIZE_WGSL}
#endif

// one range texel's vote: visible from the photo camera (terrain-layer.ts range test + slack)
fn drape_seen_texel(t: vec2<i32>, r: f32, slack: f32) -> f32 {
  let seen = textureLoad(drapeGeo, t, 0).w;
  return select(0.0, 1.0, seen > 0.0 && r < seen * 1.015 + 15.0 + slack);
}

// visibility of a point at range r projecting to uv (0..1, v down) on the geometry target:
// soft = PCF over the 2×2 nearest texels (multi-drape-layer.ts), classic = the nearest texel
fn drape_visibility(uv: vec2<f32>, r: f32, slack: f32) -> f32 {
  let dims = vec2<i32>(textureDimensions(drapeGeo));
  let hi = dims - vec2<i32>(1);
  if (drape.vote < 0.5) {
    return drape_seen_texel(clamp(vec2<i32>(uv * vec2<f32>(dims)), vec2<i32>(0), hi), r, 0.0);
  }
  let tc = uv * vec2<f32>(dims) - 0.5;
  let f = fract(tc);
  let b = vec2<i32>(floor(tc));
  let v00 = drape_seen_texel(clamp(b, vec2<i32>(0), hi), r, slack);
  let v10 = drape_seen_texel(clamp(b + vec2<i32>(1, 0), vec2<i32>(0), hi), r, slack);
  let v01 = drape_seen_texel(clamp(b + vec2<i32>(0, 1), vec2<i32>(0), hi), r, slack);
  let v11 = drape_seen_texel(clamp(b + vec2<i32>(1, 1), vec2<i32>(0), hi), r, slack);
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}

fn drape_apply(c: vec4<f32>, s: TerrainSample) -> vec4<f32> {
  // uniform control flow: the photo uv's gradients (mip level) and the mask sample, before any
  // per-fragment branch (implicit derivatives inside the visibility branches are undefined)
  let p = photo_uv(s.enu);
  let pdx = dpdx(p.xy);
  let pdy = dpdy(p.xy);
  let m = textureSampleLevel(drapeMask, drapeMaskSampler, clamp(p.xy, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).r;

  // transparent styles (contours / bands over the photo) are never draped (WebGL returned early)
  if (c.a < 0.999 || (drape.amount <= 0.0 && drape.truth <= 0.0)) { return c; }
  var base = c.rgb;
  var seen = 0.0;
  let inFrame = p.z > 0.0 && all(p.xy > vec2<f32>(0.0)) && all(p.xy < vec2<f32>(1.0));
  if (drape.amount > 0.0 && inFrame) {
    let d = s.enu - photoCam.eye;
    let r = length(d);
    let sinInc = -dot(d / max(r, 1e-6), s.normal);
#ifdef DRAPE_HARMONIZE
    // inside the photo's footprint, tone the render toward the photo so the holes the photo
    // can't fill read as intentional; feathered over a quarter of the frame
    let edge = min(p.xy, vec2<f32>(1.0) - p.xy);
    if (drapeHrm.amount > 0.0) {
      base = mix(base, drape_harmonize(base, r), smoothstep(0.0, 0.25, min(edge.x, edge.y)));
    }
#endif
    if (r > drape.minRange) {
      // slope-scaled bias: at grazing incidence one range texel spans r·Δθ/sin(incidence) metres
      let radPx = 2.0 * atan(photoCam.tanHalfY) / f32(textureDimensions(drapeGeo).y);
      let slack = 1.5 * r * radPx / max(sinInc, DRAPE_MIN_SIN_INC);
      let vis = drape_visibility(p.xy, r, slack);
      if (drape.vote > 0.5) {
        // people / objects in the photo would smear across the ground behind them: soft cut-out
        let keep = select(1.0, 1.0 - smoothstep(0.4, 0.6, m), drape.fgOn > 0.5);
        seen = smoothstep(0.0, 0.75, vis) * keep;
      } else {
        seen = select(vis, 0.0, drape.fgOn > 0.5 && m > 0.5);
      }
    }
    if (seen > 0.0) {
      var pc = textureSampleGrad(drapePhoto, drapePhotoSampler, p.xy, pdx, pdy).rgb;
      // clear air: undo the photo's own haze along its ray (the terrain fog goes on after)
      if (drape.amount < 1.5) { pc = clear_air_photo(pc, s.enu, photoCam.eye, clearAir); }
      let inc = clamp(sinInc * 3.0, 0.0, 1.0);
      let amt = select(drape.amount * mix(0.35, 1.0, inc), 1.0, drape.amount > 1.5);
      base = mix(base, pc, amt * seen);
      base = mix(base, base * drape.tintCol.rgb, drape.tint * seen);
    }
  }
  // Step Inside Truth: the drape's photo pixels = observed, every other terrain fragment = dem
  if (drape.truth > 0.0) {
    let t = mix(srgb_decode(drape.truthDem.rgb), srgb_decode(drape.truthObs.rgb), seen);
    base = mix(base, t, drape.truth);
  }
  return vec4<f32>(base, c.a);
}
`;

type MaskLike = {
	width: number;
	height: number;
	data: Uint8Array | Uint8ClampedArray;
};
type ImageLike =
	| ImageBitmap
	| HTMLImageElement
	| HTMLCanvasElement
	| OffscreenCanvas;

/**
 * The drape plugin's state (photo, mask, photo camera, settings) and its TerrainShaderPart.
 * One instance per terrain core; part() returns the same object until the harmonize define flips.
 */
export class DrapePart {
	settings: DrapeSettings = DEFAULT_DRAPE;
	private photoCam: CameraUniforms | null = null;
	private photo: Texture | null = null;
	private photoOwned = false;
	private photoSrc: unknown = null;
	private mask: Texture | null = null;
	private maskSrc: MaskLike | null = null;
	private readonly placeholders: ReturnType<typeof placeholderTextures>;
	private readonly noGeometry: Texture;
	private cached: TerrainShaderPart | null = null;

	constructor(readonly device: Device) {
		this.placeholders = placeholderTextures(device);
		// 1×1 range 0 (= sky): nothing is seen when the host has no geometry target
		this.noGeometry = device.createTexture({
			id: "drape-no-geometry",
			format: "rgba32float",
			width: 1,
			height: 1,
			usage: USAGE.SAMPLE | USAGE.COPY_DST,
		});
		this.noGeometry.writeData(new Float32Array(4) as never, {
			width: 1,
			height: 1,
			bytesPerRow: 16,
		});
	}

	setSettings(s: Partial<DrapeSettings>) {
		this.settings = { ...this.settings, ...s };
	}

	/** Photo camera uniforms sized to the geometry target (cameraUniforms(photoCamera(...))). */
	setPhotoCamera(u: CameraUniforms | null) {
		this.photoCam = u;
	}

	/** The photo (uploaded once per object, mipmapped); null = no drape. */
	setPhoto(image: ImageLike | null) {
		if (image === this.photoSrc) return;
		this.dropPhoto();
		this.photoSrc = image;
		if (image)
			this.photo = imageTexture(this.device, image, { id: "drape-photo" });
		this.photoOwned = !!image;
	}

	/** A photo texture owned by someone else (rgba8unorm-srgb, mipmapped: textures.ts imageTexture). */
	setPhotoTexture(tex: Texture | null) {
		if (tex === this.photo) return;
		this.dropPhoto();
		this.photo = tex;
		this.photoSrc = tex;
	}

	/** The drape mask (people, or people ∪ objects; 0/255, row 0 = top); null = none. */
	setMask(mask: MaskLike | null) {
		if (mask === this.maskSrc) return;
		this.mask?.destroy();
		this.mask = null;
		this.maskSrc = mask;
		if (mask?.width && mask.height)
			this.mask = maskTexture(
				this.device,
				mask.data,
				mask.width,
				mask.height,
				"drape-mask",
			);
	}

	/** The plugin (stable identity; the key includes the harmonize define). */
	part(): TerrainShaderPart {
		const harmonize = !!this.settings.harmonize;
		const key = harmonize ? "drape+hrm" : "drape";
		if (this.cached?.key === key) return this.cached;
		this.cached = {
			key,
			wgsl: DRAPE_WGSL,
			modules: [
				photoCameraModule as unknown as ShaderModule,
				drapeModule as unknown as ShaderModule,
				clearAirModule as unknown as ShaderModule,
				...(harmonize ? [drapeHarmonizeModule as unknown as ShaderModule] : []),
			],
			defines: harmonize ? { DRAPE_HARMONIZE: true } : {},
			apply: "drape_apply",
			props: (ctx) => this.props(ctx, harmonize),
		};
		return this.cached;
	}

	/** Whether the drape (or the truth tint) does anything in this pass. */
	active(ctx: Pick<PassContext, "frame" | "geometry">) {
		const s = this.settings;
		return (
			s.views.includes(ctx.frame.view) &&
			!!this.photoCam &&
			!!ctx.geometry &&
			((s.projectPhoto > 0 && !!this.photo) || s.truth > 0)
		);
	}

	private props(ctx: PassContext, harmonize: boolean) {
		const s = this.settings;
		const on = this.active(ctx);
		const amount = on && this.photo ? s.projectPhoto : 0;
		const uniforms: Record<string, unknown> = {
			// never null in the pipeline: an unused camera when off
			photoCam: this.photoCam ?? ctx.camera,
			clearAir: clearAirUniforms(
				on ? (s.clearAir ?? CLEAR_AIR_OFF) : CLEAR_AIR_OFF,
			),
			drape: {
				tintCol: [...s.tintColor, 1],
				truthObs: TRUTH_OBS,
				truthDem: TRUTH_DEM,
				amount,
				minRange: s.minRange,
				fgOn: s.protectPeople && this.mask ? 1 : 0,
				tint: s.tint,
				truth: on ? s.truth : 0,
				vote: s.vote ? 1 : 0,
				pad0: 0,
				pad1: 0,
			},
		};
		if (harmonize) {
			const h = s.harmonize;
			uniforms.drapeHrm = h
				? { ...h, amount: on ? h.amount : 0, pad0: 0, pad1: 0 }
				: {
						pm: IDENTITY16,
						ps: IDENTITY16,
						lm: IDENTITY16,
						ls: IDENTITY16,
						amount: 0,
						chroma: 0,
						pad0: 0,
						pad1: 0,
					};
		}
		return {
			uniforms,
			bindings: {
				drapeGeo: ctx.geometry?.geometry ?? this.noGeometry,
				drapePhoto: this.photo ?? this.placeholders.white,
				drapeMask: this.mask ?? this.placeholders.zeroMask,
			},
		};
	}

	private dropPhoto() {
		if (this.photoOwned) this.photo?.destroy();
		this.photo = null;
		this.photoOwned = false;
		this.photoSrc = null;
	}

	destroy() {
		this.dropPhoto();
		this.mask?.destroy();
		this.mask = null;
		this.placeholders.white.destroy();
		this.placeholders.zeroMask.destroy();
		this.noGeometry.destroy();
	}
}

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Factory (same shape as the other layer ports). */
export function createDrape(device: Device, settings?: Partial<DrapeSettings>) {
	const d = new DrapePart(device);
	if (settings) d.setSettings(settings);
	return d;
}

/**
 * CPU twin of drape_visibility (the check and harnesses use it). `range` is the geometry target's
 * w channel, row 0 = top; uv v down.
 */
export function drapeVisibilityCpu(
	range: Float32Array,
	width: number,
	height: number,
	uv: [number, number],
	r: number,
	slack: number,
	vote: boolean,
): number {
	const at = (x: number, y: number) => {
		const cx = Math.min(width - 1, Math.max(0, x));
		const cy = Math.min(height - 1, Math.max(0, y));
		const seen = range[cy * width + cx];
		return seen > 0 && r < seen * 1.015 + 15 + slack ? 1 : 0;
	};
	if (!vote)
		return at(Math.floor(uv[0] * width), Math.floor(uv[1] * height)) * 1;
	const tx = uv[0] * width - 0.5;
	const ty = uv[1] * height - 0.5;
	const bx = Math.floor(tx);
	const by = Math.floor(ty);
	const fx = tx - bx;
	const fy = ty - by;
	const top = at(bx, by) * (1 - fx) + at(bx + 1, by) * fx;
	const bot = at(bx, by + 1) * (1 - fx) + at(bx + 1, by + 1) * fx;
	return top * (1 - fy) + bot * fy;
}

/** The slope-scaled bias the shader adds (m): 1.5·r·Δθ / max(sin incidence, MIN_SIN_INC). */
export function drapeSlack(
	r: number,
	sinInc: number,
	tanHalfY: number,
	geometryHeight: number,
) {
	const radPx = (2 * Math.atan(tanHalfY)) / geometryHeight;
	return (1.5 * r * radPx) / Math.max(sinInc, MIN_SIN_INC);
}

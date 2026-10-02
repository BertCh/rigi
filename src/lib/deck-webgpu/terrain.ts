// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared WGSL and types of the WebGPU terrain (the batched core, layers/batched-terrain.ts, supplies the
// vertex stage). Two passes:
//   geometry  → ENU xyz + range, normal + class 0 (GeometryTargets MRT)
//   color     → hillshade (the style's relief ramp × fog_shade) or draped imagery (texture array),
//               with the style's haze (fog_apply); linear output into the MSAA colour target
// Reversed-Z depth, camera-relative projection (camera.ts).
//
// Extension seam: setShaderParts() (TerrainShaderPart) swaps the colour shading and chains
// plugins (drape, truth…) without editing this file: terrain styles (layers/terrain-styles.ts),
// the projective photo drape (layers/drape.ts).
import type { ShaderModule } from "@luma.gl/shadertools";
import type { DeckRampU } from "#/lib/style/deck-apply";
import { IMAGERY_SMALL_TIER_BASE } from "./atlas-layout";
import { cameraModule } from "./camera";
import type { PassContext } from "./pass";
import {
	colorWGSL,
	DEFAULT_FOG,
	type FogUniforms,
	fogModule,
	rampWGSL,
} from "./wgsl";

export type TerrainLook = {
	/** 'imagery' drapes the texture array where a tile has a layer, else hillshade. */
	style: "hillshade" | "imagery";
	/** The style's relief ramp (deckTerrainStyle(...).relief). */
	relief: DeckRampU;
	elevRange: [number, number];
	fog: FogUniforms;
	/** Discard terrain closer than this in the geometry pass (m; nearFadeFor(hAccuracy) / 2). */
	nearDiscard: number;
};

/** A plain relief ramp (green → brown → white) for when no style is supplied. */
const PLAIN_RELIEF: DeckRampU = {
	c0: [
		0.33, 0.47, 0.3, 0, 0.55, 0.5, 0.38, 0.45, 0.75, 0.72, 0.68, 0.75, 0.97,
		0.97, 0.98, 1,
	],
	c1: new Array(16).fill(0),
	de: [1, 0.45, 0.3, 0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
	n: 4,
};

export const DEFAULT_TERRAIN_LOOK: TerrainLook = {
	style: "imagery",
	relief: PLAIN_RELIEF,
	elevRange: [0, 4000],
	fog: DEFAULT_FOG,
	nearDiscard: 0,
};

export const terrainModule = {
	name: "terrain",
	source: /* wgsl */ `\
struct TerrainUniforms {
  reliefC0: mat4x4<f32>,
  reliefC1: mat4x4<f32>,
  reliefDE: mat4x4<f32>,
  elevRange: vec2<f32>,
  rampN: f32,
  style: f32,
  nearDiscard: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};
@group(0) @binding(auto) var<uniform> terrain: TerrainUniforms;
`,
	uniformTypes: {
		reliefC0: "mat4x4<f32>",
		reliefC1: "mat4x4<f32>",
		reliefDE: "mat4x4<f32>",
		elevRange: "vec2<f32>",
		rampN: "f32",
		style: "f32",
		nearDiscard: "f32",
		pad0: "f32",
		pad1: "f32",
		pad2: "f32",
	},
	bindingLayout: [{ name: "terrain", group: 0 }],
} as const satisfies ShaderModule;

/** The varyings contract, hypso, both fragment stages, the parts seam. */
const TERRAIN_COMMON_WGSL = /* wgsl */ `\
${colorWGSL}
${rampWGSL}

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) enu: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) elev: f32,
  @location(4) @interpolate(flat) layer: f32,
};

//__TERRAIN_VERTEX__

fn hypso(h: f32) -> vec3<f32> {
  let t = clamp((h - terrain.elevRange.x) / max(terrain.elevRange.y - terrain.elevRange.x, 1.0), 0.0, 1.0);
  return to_linear(ramp_eval(terrain.reliefC0, terrain.reliefC1, terrain.reliefDE, terrain.rampN, t));
}

#ifdef GEOMETRY_PASS
struct GeometryOut {
  @location(0) xyzr: vec4<f32>,
  @location(1) normal: vec4<f32>,
};
@fragment fn fragmentMain(v: Varyings) -> GeometryOut {
  let range = camera_range(v.enu);
  if (range < terrain.nearDiscard) { discard; }
  var o: GeometryOut;
  o.xyzr = vec4<f32>(v.enu, range);
  o.normal = vec4<f32>(normalize(v.normal), 0.0);
  return o;
}
#else
@group(0) @binding(auto) var imagery: texture_2d_array<f32>;
@group(0) @binding(auto) var imagerySampler: sampler;
// the 256² tier of the imagery (imagery.ts): a row's layer >= IMAGERY_SMALL_BASE is layer − base there
@group(0) @binding(auto) var imagerySmall: texture_2d_array<f32>;
@group(0) @binding(auto) var imagerySmallSampler: sampler;
const IMAGERY_SMALL_BASE: f32 = ${IMAGERY_SMALL_TIER_BASE}.0;

// Everything a shading function / plugin may need, gathered in UNIFORM control flow (WGSL only
// allows textureSample / derivatives there): shading and plugins must not call textureSample or
// dpdx/fwidth themselves after branching — use these fields or textureSampleLevel/Grad.
struct TerrainSample {
  enu: vec3<f32>,
  normal: vec3<f32>,
  uv: vec2<f32>,
  elev: f32,
  layer: f32,
  range: f32,
  img: vec3<f32>,
  imgAvg: vec3<f32>,
  hasImg: bool,
  // fwidth(elev), dpdx / dpdy of the ENU position (face normal, contour widths)
  dElev: f32,
  dEnuDx: vec3<f32>,
  dEnuDy: vec3<f32>,
  fragCoord: vec4<f32>,
};

fn terrain_sample(v: Varyings) -> TerrainSample {
  var s: TerrainSample;
  s.enu = v.enu;
  s.normal = normalize(v.normal);
  s.uv = v.uv;
  s.elev = v.elev;
  s.layer = v.layer;
  s.range = camera_range(v.enu);
  // both tiers sampled in uniform control flow, then selected (an out-of-range index clamps);
  // the 256² tier's mip 2 is the 512² tier's mip 3 (64 px), so imgAvg means the same in both
  let small = v.layer >= IMAGERY_SMALL_BASE;
  let layer = i32(max(v.layer, 0.0));
  let layerSmall = i32(max(v.layer - IMAGERY_SMALL_BASE, 0.0));
  let imgBig = textureSample(imagery, imagerySampler, v.uv, layer).rgb;
  let imgSmall = textureSample(imagerySmall, imagerySmallSampler, v.uv, layerSmall).rgb;
  let avgBig = textureSampleLevel(imagery, imagerySampler, v.uv, layer, 3.0).rgb;
  let avgSmall = textureSampleLevel(imagerySmall, imagerySmallSampler, v.uv, layerSmall, 2.0).rgb;
  s.img = select(imgBig, imgSmall, small);
  s.imgAvg = select(avgBig, avgSmall, small);
  s.hasImg = v.layer >= 0.0;
  s.dElev = fwidth(v.elev);
  s.dEnuDx = dpdx(v.enu);
  s.dEnuDy = dpdy(v.enu);
  s.fragCoord = v.position;
  return s;
}

#ifndef TERRAIN_SHADING
// default shading: hillshade relief, or the imagery drape (terrain.style 1) with the steep-face
// softening of deck/terrain-layer.ts; alpha 1 (opaque)
fn terrain_base(s: TerrainSample) -> vec4<f32> {
  var base = hypso(s.elev) * fog_shade(s.normal);
  if (terrain.style > 0.5 && s.hasImg) {
    let steep = 1.0 - smoothstep(0.17, 0.34, s.normal.z);
    base = mix(s.img, s.imgAvg * (0.7 + 0.45 * fog_shade(s.normal)), 0.5 * steep);
  }
  return vec4<f32>(base, 1.0);
}
#endif

//__TERRAIN_PARTS__

@fragment fn fragmentMain(v: Varyings) -> @location(0) vec4<f32> {
  let s = terrain_sample(v);
  var c = terrain_base(s);
  //__TERRAIN_PLUGIN_CALLS__
#ifdef TERRAIN_NO_FOG
  return c;
#else
  return vec4<f32>(fog_apply(c.rgb, s.range), c.a);
#endif
}
#endif
`;

/**
 * Extension seam for the terrain colour pass (README.md "Terrain shading parts"). A part adds WGSL
 * (functions over TerrainSample), its uniform modules / defines, and per-draw uniforms / bindings.
 *   shading  replaces the default `terrain_base(s) -> vec4<f32>`; must `#define`-guard nothing and
 *            set defines.TERRAIN_SHADING = true (the terrain-styles port)
 *   plugins  each defines `fn <apply>(c: vec4<f32>, s: TerrainSample) -> vec4<f32>`, called in
 *            order after terrain_base (drape, truth tint, harmonize…)
 * Changing the set rebuilds the colour pipeline (key = the parts' keys).
 */
export type TerrainShaderPart = {
	/** Stable identity of the WGSL + defines (part of the pipeline cache key). */
	key: string;
	wgsl: string;
	modules?: ShaderModule[];
	defines?: Record<string, boolean | number>;
	/** Plugins only: the WGSL function applied to the colour. */
	apply?: string;
	/** Per colour-pass draw: uniform props (by module name) and bindings (by WGSL var name). */
	props?(ctx: PassContext): {
		uniforms?: Record<string, unknown>;
		bindings?: Record<string, unknown>;
	};
};

/**
 * The full terrain program: common WGSL + `vertex` (a `vertexMain` returning Varyings) + the colour
 * shading parts. Modules: terrainModules(parts); defines: terrainDefines(kind, parts).
 */
export function terrainSource(
	vertex: string,
	shading: TerrainShaderPart | null,
	plugins: readonly TerrainShaderPart[],
) {
	const parts = [...(shading ? [shading] : []), ...plugins];
	return TERRAIN_COMMON_WGSL.replace("//__TERRAIN_VERTEX__", vertex)
		.replace("//__TERRAIN_PARTS__", parts.map((p) => p.wgsl).join("\n"))
		.replace(
			"//__TERRAIN_PLUGIN_CALLS__",
			plugins
				.filter((p) => p.apply)
				.map((p) => `c = ${p.apply}(c, s);`)
				.join("\n  "),
		);
}

export function terrainModules(
	parts: readonly TerrainShaderPart[],
): ShaderModule[] {
	const modules: ShaderModule[] = [
		cameraModule as unknown as ShaderModule,
		fogModule as unknown as ShaderModule,
		terrainModule as unknown as ShaderModule,
	];
	for (const p of parts)
		for (const m of p.modules ?? [])
			if (!modules.some((x) => x.name === m.name)) modules.push(m);
	return modules;
}

export function terrainDefines(
	kind: "geometry" | "color",
	parts: readonly TerrainShaderPart[],
): Record<string, boolean | number> {
	return kind === "geometry"
		? { GEOMETRY_PASS: true }
		: Object.assign({}, ...parts.map((p) => p.defines ?? {}));
}

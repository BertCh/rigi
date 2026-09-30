// The roll map's many-photo drape on WebGPU: the port of roll/map/multi-drape-layer.ts
// (MultiDrapeLayer + DrapeTileLayer) to a host-agnostic GpuLayerCore (README.md "Layer contract").
// /roll is its own deck stack and ignores the renderer flag; this core exists for when /roll moves
// to WebGPU. It is drawn OVER the terrain core in the colour pass, exactly like the WebGL layer was
// drawn over TerrainLayer.
//
// Same as the WebGL layer (the reference look):
//   - inputs: the tile meshes (deck/terrain-data.ts TileMesh with CPU vertices; roll-terrain.ts
//     always builds them), a DrapeAtlas (roll/map/drape-atlas.ts: photo atlases, r32float range
//     atlas, r8 people-mask atlas), DrapePhoto[] (viewProj / eye / minRange / gain / aspect / vfov)
//     and the settings opacity / sharpness / falloffM / outline / reachM / people;
//   - the per-fragment photo competition: frustum + min range, reach fade, distance falloff,
//     incidence, frame-edge feather, graze fade (unless looking along the photo's rays), the soft
//     2×2 PCF range vote with the slope-scaled bias (MIN_SIN_INC), the people cut-out, weights to
//     the power `sharpness`, the TOP_K best by exact pruning, then only the winners' pixels
//     sampled with analytic gradients; highlighted photos (gain > 1.5) get the footprint outline;
//   - the CPU candidate lists per tile (frustum outcodes, reach, the coarse max-pooled range cull)
//     nearest camera first, ≤ MAX_PER_TILE;
//   - the grid only (no skirts), never in the geometry pass (it would pollute range maps / queries);
//   - the blend: photos are filtered and weighted in sRGB (rgba8unorm atlases, as WebGL did).
//
// What changed with the foundation:
//   - colour: the weighted sRGB result is decoded to LINEAR and written premultiplied
//     (rgb·a, a) with passModelProps("color", {depth: "test", blend: true}). So the drape now
//     composites over the terrain in linear light (the WebGL canvas blended sRGB bytes). At full
//     opacity and full coverage the output is identical; partial alpha (frame feather, reach fade,
//     opacity < 1) mixes a little brighter in the midtones. No fog, as in WebGL (the photo shows
//     its own haze).
//   - depth: the terrain writes reversed-Z hardware depth (near / w), which interpolates exactly on
//     a planar triangle; there is no per-fragment log depth. The drape runs the same camera_clip on
//     the same vertices, so on the per-tile terrain path it passes `greater-equal` on its own
//     surface. The WebGL per-vertex forward pull (the Jensen gap of log depth for this mesh cell
//     size, (ln ρ)²/8) is kept as a relative pull of clip.z by exp(g²/8 + DEPTH_SLACK): it now
//     covers a terrain drawn with a DIFFERENT triangulation (the batched path, another LOD) and
//     compiler non-invariance, and it is still a few centimetres far away. Early-Z stays on (no
//     frag_depth write), so hidden ground and the tile skirts are rejected before the photo loop.
//   - per-tile data: WebGL bound a 48 × 8-vec4 range of one shared UNIFORM buffer per tile draw
//     (the photos' parameters copied inline). WebGPU writes uniforms once per submit (README rule
//     2), so here the photos' parameters live ONCE in a read-only storage table (8 vec4 per photo),
//     each tile's candidates are a run of photo indices in a second storage buffer, and the tile's
//     (first, count, cellM) is a per-instance vertex attribute. One Model, one bind group, one draw
//     per tile, nothing per draw but the vertex buffers.
//   - precision: each photo's view-projection is stored camera-RELATIVE (M · T(eye), composed in
//     f64 on the CPU), so the shader projects (p − eye) instead of kilometre-scale ENU in f32.
//   - WGSL: implicit-derivative sampling is not allowed after the per-candidate branches, so as in
//     GLSL the world footprint (dpdx / dpdy of the position) is taken first and every photo read
//     is textureSampleGrad; the mask read is textureSampleLevel(0) (the mask atlas has no mips);
//     the range atlas (r32float, unfilterable) is read with textureLoad.
//   - device: luma 9.4 derives sampleType "float" for every texture_2d<f32>, so the r32float range
//     atlas binds only on a device with 'float32-filterable' (device.ts requests it; Apple / Metal
//     has it). Same constraint as the geometry target and the batched heights.
//   - mips: DrapeAtlas only generates photo mips on WebGL. Build the atlas with WebGpuDrapeAtlas
//     (below: same class, plus generateMipmapsWebGPU after each photo lands) when the device is
//     WebGPU.
//
// Wiring (assembler / a WebGPU roll map; nothing here is wired into the lab route):
//   const atlas = new WebGpuDrapeAtlas(device, items);    // instead of new DrapeAtlas(...)
//   const drape = createMultiDrape(device);               // add to host.cores (after the terrain)
//   drape.setTiles(set.tiles);                            // same meshes the terrain core draws
//   drape.setAtlas(atlas);                                // rebuilds candidate lists itself when
//                                                         // atlas.readyVersion moves
//   drape.setPhotos(drapePhotos);                         // DrapePhoto[] (keep the identity while
//                                                         // nothing changed, as roll-map does)
//   drape.setSettings({ opacity, sharpness, reachM, people: protectPeople ? 1 : 0 });
//   atlas.setPhoto / setRange / setMask as today; host.requestRender() on atlas.version changes.
// The view camera (orbit / fly-in) is the colour pass's `camera`; the photos' cameras come from
// DrapePhoto.viewProj (deck/photo-view.ts photoViewProjection, roll ENU frame = the host frame).
// visible() is false at opacity 0 (the WebGL roll map dropped the layer then).
import type { Buffer, Device, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import type { TileMesh } from "#/lib/deck/terrain-data";
import { COARSE, DrapeAtlas, type DrapeItem } from "#/lib/roll/map/drape-atlas";
import { cameraModule, sphereInView } from "../camera";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	passModelProps,
	targetKey,
} from "../pass";
import { colorWGSL } from "../wgsl";

/** Same as multi-drape-layer.ts: the slope bias grows as 1/sin(incidence) down to ≈ 0.7°. */
export const MIN_SIN_INC = 0.012;
/** Photos blended per fragment (the best by weight). */
export const TOP_K = 4;
/** vec4s per photo in the storage table (multi-drape-layer.ts SLOT_W). */
export const SLOT_W = 8;
/** Most candidates per tile (nearest kept). */
export const MAX_PER_TILE = 48;
/** Constant relative forward pull of the drape's depth (the WebGL 2e-6 of the normalised log
 * depth at LOG_DEPTH_FAR = 400 km: 2e-6 · log2(400 001) · ln 2 ≈ 2.6e-5 in ln w). */
export const DEPTH_SLACK = 2.6e-5;
/** Draw order in the colour pass: after the terrain (0), before trails / tiles3d (10), gizmos (20). */
export const MULTI_DRAPE_ORDER = 5;

/** One photo's projection state (roll/map/multi-drape-layer.ts DrapePhoto, same fields). */
export type DrapePhoto = {
	id: string;
	/** Column-major view-projection (deck/photo-view.ts photoViewProjection) in the roll frame. */
	viewProj: ArrayLike<number>;
	eye: [number, number, number];
	/** Terrain nearer than this (m) is not draped (GPS error). */
	minRange: number;
	/** Weight multiplier: 1 normal, >1 highlighted, <1 dimmed, 0 hidden. */
	gain: number;
	/** Width / height of the photo. */
	aspect: number;
	/** Vertical FOV (deg), for the range map's angular texel size. */
	vfov: number;
};

/** What the core reads from a DrapeAtlas (roll/map/drape-atlas.ts). */
export type MultiDrapeAtlas = Pick<
	DrapeAtlas,
	| "ids"
	| "cells"
	| "photo"
	| "range"
	| "mask"
	| "ready"
	| "coarse"
	| "readyVersion"
	| "version"
>;

export type MultiDrapeSettings = {
	/** 0..1 overall drape opacity (0 = not drawn). */
	opacity: number;
	/** Exponent on the per-photo weights: 1 = soft blend, higher = best photo wins. */
	sharpness: number;
	/** Distance (m) at which a photo's weight halves (prefers the nearer camera). */
	falloffM: number;
	/** Outline the footprint of highlighted (gain > 1.5) photos. */
	outline: number;
	/** Terrain further than this from a photo's camera (m) fades out of its drape. */
	reachM: number;
	/** 0..1: how strongly people masks cut photos out of the drape. */
	people: number;
};

/** The WebGL layer's prop defaults. */
export const DEFAULT_MULTI_DRAPE: MultiDrapeSettings = {
	opacity: 1,
	sharpness: 3,
	falloffM: 2500,
	outline: 1,
	reachM: 8000,
	people: 1,
};

/**
 * DrapeAtlas for a WebGPU device: identical layout and API; after each photo lands its atlas's
 * mip chain is regenerated (DrapeAtlas does that only on WebGL). Runs off-frame (setPhoto resolves
 * between frames) because luma's generateMipmapsWebGPU submits its own passes.
 */
export class WebGpuDrapeAtlas extends DrapeAtlas {
	private gone = false;

	constructor(
		private readonly gpu: Device,
		items: DrapeItem[],
	) {
		super(gpu, items);
	}

	override async setPhoto(k: number, img: HTMLImageElement | ImageBitmap) {
		const before = this.version;
		await super.setPhoto(k, img);
		const c = this.cells[k];
		if (this.gone || !c || this.version === before) return;
		if (this.gpu.type === "webgpu")
			(
				this.gpu as unknown as { generateMipmapsWebGPU(t: Texture): void }
			).generateMipmapsWebGPU(this.photo[c.atlas]);
	}

	override destroy() {
		this.gone = true;
		super.destroy();
	}
}

export const multiDrapeModule = {
	name: "mdrape",
	source: /* wgsl */ `\
struct MDrapeUniforms {
  opacity: f32,
  sharpness: f32,
  falloffM: f32,
  outline: f32,
  reachM: f32,
  people: f32,
  pad0: f32,
  pad1: f32,
};
@group(0) @binding(auto) var<uniform> mdrape: MDrapeUniforms;
`,
	uniformTypes: {
		opacity: "f32",
		sharpness: "f32",
		falloffM: "f32",
		outline: "f32",
		reachM: "f32",
		people: "f32",
		pad0: "f32",
		pad1: "f32",
	},
	bindingLayout: [{ name: "mdrape", group: 0 }],
} as const satisfies ShaderModule;

/** The program (camera + mdrape modules in scope). */
export const MULTI_DRAPE_WGSL = /* wgsl */ `\
${colorWGSL}

const TOP_K: i32 = ${TOP_K};
const MIN_SIN_INC: f32 = ${MIN_SIN_INC};
const DEPTH_SLACK: f32 = ${DEPTH_SLACK};

// one photo (multi-drape-layer.ts slotData, 8 vec4)
struct MDrapeSlot {
  // camera-relative view-projection: clip = m · (p − eye, 1)
  m: mat4x4<f32>,
  // xyz, gain
  eye: vec4<f32>,
  // photo rect in its atlas (uv, top-left origin)
  photoRect: vec4<f32>,
  // range / mask cell (texels)
  rangeRect: vec4<f32>,
  // minRange, aspect, range-map rad/px, atlas index
  ex: vec4<f32>,
};

@group(0) @binding(auto) var<storage, read> mdrapeSlots: array<MDrapeSlot>;
@group(0) @binding(auto) var<storage, read> mdrapeLists: array<u32>;
@group(0) @binding(auto) var mdPhoto0: texture_2d<f32>;
@group(0) @binding(auto) var mdPhoto0Sampler: sampler;
@group(0) @binding(auto) var mdPhoto1: texture_2d<f32>;
@group(0) @binding(auto) var mdPhoto1Sampler: sampler;
@group(0) @binding(auto) var mdPhoto2: texture_2d<f32>;
@group(0) @binding(auto) var mdPhoto2Sampler: sampler;
@group(0) @binding(auto) var mdPhoto3: texture_2d<f32>;
@group(0) @binding(auto) var mdPhoto3Sampler: sampler;
@group(0) @binding(auto) var mdRange: texture_2d<f32>;
@group(0) @binding(auto) var mdMask: texture_2d<f32>;
@group(0) @binding(auto) var mdMaskSampler: sampler;

struct MDAttributes {
  @location(0) positions: vec3<f32>,
  @location(1) normals: vec3<f32>,
  // first candidate, candidate count, mesh cell size (m), unused
  @location(2) tileInfo: vec4<f32>,
};

struct MDVaryings {
  @builtin(position) position: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) @interpolate(flat) list: vec2<u32>,
};

@vertex fn vertexMain(a: MDAttributes) -> MDVaryings {
  var o: MDVaryings;
  var clip = camera_clip(a.positions);
  // forward pull for this mesh cell size (see the header on depth); reversed-Z: nearer = larger
  // z / w. Vertices inside the near plane keep the terrain's own clipping (z = near).
  let g = log(1.0 + 2.0 * a.tileInfo.z / max(clip.w, 1.0));
  let pulled = min(camera.near * exp(g * g / 8.0 + DEPTH_SLACK), clip.w);
  clip.z = select(camera.near, pulled, clip.w >= camera.near);
  o.position = clip;
  o.world = a.positions;
  o.normal = a.normals;
  o.list = vec2<u32>(u32(a.tileInfo.x + 0.5), u32(a.tileInfo.y + 0.5));
  return o;
}

// (u, v) with v DOWN (photo + range rows run top → bottom), z = clip w
fn md_photo_uv(m: mat4x4<f32>, d: vec3<f32>) -> vec3<f32> {
  let c = m * vec4<f32>(d, 1.0);
  let w = select(1e-6, c.w, abs(c.w) > 1e-6);
  let uv = c.xy / w * 0.5 + 0.5;
  return vec3<f32>(uv.x, 1.0 - uv.y, c.w);
}

// pow for weights: 0 stays 0 (WGSL pow(0, y) is undefined)
fn md_pow(x: f32, s: f32) -> f32 {
  return select(0.0, pow(x, s), x > 0.0);
}

fn md_photo_texel(a: i32, uv: vec2<f32>, gx: vec2<f32>, gy: vec2<f32>) -> vec3<f32> {
  if (a == 0) { return textureSampleGrad(mdPhoto0, mdPhoto0Sampler, uv, gx, gy).rgb; }
  if (a == 1) { return textureSampleGrad(mdPhoto1, mdPhoto1Sampler, uv, gx, gy).rgb; }
  if (a == 2) { return textureSampleGrad(mdPhoto2, mdPhoto2Sampler, uv, gx, gy).rgb; }
  return textureSampleGrad(mdPhoto3, mdPhoto3Sampler, uv, gx, gy).rgb;
}

// one range texel's vote: visible from the photo camera (range test + bias)
fn md_seen_by(t: vec2<i32>, r: f32, slack: f32) -> f32 {
  let seen = textureLoad(mdRange, t, 0).r;
  return select(0.0, 1.0, seen > 0.0 && r < seen * 1.015 + 15.0 + slack);
}

// percentage-closer filtering of the range test over the 2×2 nearest texels of the cell rr
fn md_visibility(rr: vec4<f32>, uv: vec2<f32>, r: f32, slack: f32) -> f32 {
  let tc = uv * rr.zw - 0.5;
  let f = fract(tc);
  let b = vec2<i32>(floor(tc));
  let lo = vec2<i32>(rr.xy);
  let hi = lo + vec2<i32>(rr.zw) - vec2<i32>(1);
  let v00 = md_seen_by(clamp(lo + b, lo, hi), r, slack);
  let v10 = md_seen_by(clamp(lo + b + vec2<i32>(1, 0), lo, hi), r, slack);
  let v01 = md_seen_by(clamp(lo + b + vec2<i32>(0, 1), lo, hi), r, slack);
  let v11 = md_seen_by(clamp(lo + b + vec2<i32>(1, 1), lo, hi), r, slack);
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}

@fragment fn fragmentMain(v: MDVaryings) -> @location(0) vec4<f32> {
  let n = normalize(v.normal);
  // world-space footprint of this pixel, in uniform control flow; each photo's uv gradients are
  // derived from it below (implicit derivatives are not allowed inside the loop)
  let dwx = dpdx(v.world);
  let dwy = dpdy(v.world);
  let viewDir = normalize(v.world - camera.eye);
  let rangeSize = vec2<f32>(textureDimensions(mdRange));
  let first = v.list.x;
  let count = v.list.y;
  // pass 1: score every candidate; keep the TOP_K best (descending)
  var topW: array<f32, ${TOP_K}>;
  var topI: array<u32, ${TOP_K}>;
  for (var j = 0; j < TOP_K; j++) {
    topW[j] = 0.0;
    topI[j] = 0u;
  }
  var wmax = 0.0;
  var edge = 0.0;
  for (var c = 0u; c < count; c++) {
    let i = mdrapeLists[first + c];
    let eye = mdrapeSlots[i].eye;
    let ex = mdrapeSlots[i].ex;
    let d = v.world - eye.xyz;
    let r = length(d);
    if (r < ex.x) { continue; }
    // beyond the reach a photo shows hazy, low-resolution far country: fade it out
    let reach = 1.0 - smoothstep(0.55 * mdrape.reachM, mdrape.reachM, r);
    // exact pruning, first on distance alone: every other factor of the weight is ≤ 1
    if (md_pow(eye.w * reach / (1.0 + r / mdrape.falloffM), mdrape.sharpness) <= topW[TOP_K - 1]) { continue; }
    let p = md_photo_uv(mdrapeSlots[i].m, d);
    let uv = p.xy;
    if (p.z <= 0.0 || any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { continue; }
    let sinInc = -dot(d / r, n);
    let inc = clamp(sinInc * 3.0, 0.0, 1.0);
    // feather the frame edges (in photo height units, so it is even on all four sides)
    let e2 = min(uv, vec2<f32>(1.0) - uv) * vec2<f32>(ex.y, 1.0);
    let feather = smoothstep(0.0, 0.05, min(e2.x, e2.y));
    // grazing projections smear, unless the viewer looks along the photo's own rays (fly-in)
    let along = smoothstep(0.985, 0.9995, dot(viewDir, d / r));
    let graze = mix(smoothstep(0.08, 0.3, sinInc), 1.0, along);
    // how much this photo could cover the fragment on its own (before occlusion + people)
    let cover = eye.w * feather * reach * graze;
    if (cover <= 0.0) { continue; }
    let wBase = cover * mix(0.25, 1.0, inc) / (1.0 + r / mdrape.falloffM);
    // then on the unoccluded weight: visibility and the people mask only lower it
    if (md_pow(wBase, mdrape.sharpness) <= topW[TOP_K - 1]) { continue; }
    let rr = mdrapeSlots[i].rangeRect;
    // slope-scaled bias: at grazing incidence one range texel spans r·Δθ/sin(incidence) metres
    let slack = 1.5 * r * ex.z / max(sinInc, MIN_SIN_INC);
    let vis = md_visibility(rr, uv, r, slack);
    if (vis <= 0.0) { continue; }
    // people in the photo would smear across the ground behind them: soft cut-out
    let muv = (rr.xy + clamp(uv * rr.zw, vec2<f32>(0.5), rr.zw - vec2<f32>(0.5))) / rangeSize;
    let keep = 1.0 - mdrape.people * smoothstep(0.25, 0.6, textureSampleLevel(mdMask, mdMaskSampler, muv, 0.0).r);
    let seen = smoothstep(0.0, 0.75, vis) * keep;
    if (seen <= 0.0) { continue; }
    let w = md_pow(wBase * seen, mdrape.sharpness);
    wmax = max(wmax, cover * seen);
    // a thin frame line where this photo's footprint ends (selection outline)
    if (eye.w > 1.5) { edge = max(edge, 1.0 - smoothstep(0.0, 0.006, min(e2.x, e2.y))); }
    if (w <= topW[TOP_K - 1]) { continue; }
    var at = TOP_K - 1;
    for (var q = TOP_K - 1; q > 0; q--) {
      if (topW[q - 1] >= w) { break; }
      topW[q] = topW[q - 1];
      topI[q] = topI[q - 1];
      at = q - 1;
    }
    topW[at] = w;
    topI[at] = i;
  }
  // pass 2: sample the winners' pixels
  var acc = vec3<f32>(0.0);
  var wsum = 0.0;
  for (var j = 0; j < TOP_K; j++) {
    if (topW[j] <= 0.0) { break; }
    let i = topI[j];
    let m = mdrapeSlots[i].m;
    let pr = mdrapeSlots[i].photoRect;
    let atlas = i32(mdrapeSlots[i].ex.w + 0.5);
    let d = v.world - mdrapeSlots[i].eye.xyz;
    let uv = md_photo_uv(m, d).xy;
    let gx = (md_photo_uv(m, d + dwx).xy - uv) * pr.zw;
    let gy = (md_photo_uv(m, d + dwy).xy - uv) * pr.zw;
    let auv = pr.xy + clamp(uv, vec2<f32>(0.001), vec2<f32>(0.999)) * pr.zw;
    acc += md_photo_texel(atlas, auv, gx, gy) * topW[j];
    wsum += topW[j];
  }
  if (wsum <= 0.0) { discard; }
  var col = acc / wsum;
  if (mdrape.outline > 0.0) { col = mix(col, vec3<f32>(1.0, 0.72, 0.45), edge * mdrape.outline); }
  // the weighted blend is in sRGB (as WebGL); the colour target is linear, premultiplied
  let a = mdrape.opacity * clamp(wmax, 0.0, 1.0);
  return vec4<f32>(srgb_decode(col) * a, a);
}
`;

// ---------------------------------------------------------------------------------------------
// CPU side: candidate lists (multi-drape-layer.ts buildTileSlots / reaches, same logic)

/** A tile mesh's grid spacing (m): its size over its segments. */
export function cellSize(m: TileMesh) {
	const b = meshBox(m);
	return Math.max(b[3] - b[0], b[4] - b[1]) / Math.max(1, m.seg);
}

/** World-space bounding box of a tile mesh (cached: meshes are immutable). */
const boxes = new WeakMap<TileMesh, Float64Array>();
export function meshBox(m: TileMesh) {
	let b = boxes.get(m);
	if (!b) {
		b = new Float64Array([
			Infinity,
			Infinity,
			Infinity,
			-Infinity,
			-Infinity,
			-Infinity,
		]);
		const p = m.positions;
		for (let i = 0; i < p.length; i += 3)
			for (let j = 0; j < 3; j++) {
				if (p[i + j] < b[j]) b[j] = p[i + j];
				if (p[i + j] > b[j + 3]) b[j + 3] = p[i + j];
			}
		boxes.set(m, b);
	}
	return b;
}

/** One photo's slot (SLOT_W vec4) in the shader's layout, view-projection camera-relative. */
export function slotData(atlas: MultiDrapeAtlas, k: number, p: DrapePhoto) {
	const c = atlas.cells[k];
	const out = new Float32Array(SLOT_W * 4);
	const M = p.viewProj;
	const [ex, ey, ez] = p.eye;
	// M · T(eye): columns 0..2 unchanged, column 3 = M · (eye, 1) (f64)
	for (let i = 0; i < 12; i++) out[i] = M[i];
	for (let r = 0; r < 4; r++)
		out[12 + r] = M[r] * ex + M[4 + r] * ey + M[8 + r] * ez + M[12 + r];
	out.set([...p.eye, p.gain], 16);
	out.set(c.photo, 20);
	out.set(c.range, 24);
	out.set(
		[p.minRange, p.aspect, (p.vfov * Math.PI) / 180 / c.range[3], c.atlas],
		28,
	);
	return out;
}

/**
 * Could photo k see any of box b? False only when certain: the box is entirely outside one side
 * plane of the frustum (homogeneous clip space: valid for corners behind the camera too), beyond
 * the reach, or behind the terrain the photo sees (its coarse range map over the box's projected
 * rect, one block of margin for the 2×2 filter, against the shader's largest bias).
 */
export function reaches(
	b: Float64Array,
	p: DrapePhoto,
	atlas: MultiDrapeAtlas,
	k: number,
	reachM: number,
	radPerPx: number,
) {
	let d2 = 0;
	for (let j = 0; j < 3; j++) {
		const v = Math.max(b[j] - p.eye[j], 0, p.eye[j] - b[j + 3]);
		d2 += v * v;
	}
	if (d2 > reachM * reachM) return false;
	const M = p.viewProj;
	// outcodes: a bit stays set while every corner so far is outside that plane
	let all = 0b11111;
	let u0 = Infinity;
	let u1 = -Infinity;
	let v0 = Infinity;
	let v1 = -Infinity;
	let behind = false;
	for (let q = 0; q < 8; q++) {
		const x0 = q & 1 ? b[3] : b[0];
		const y0 = q & 2 ? b[4] : b[1];
		const z0 = q & 4 ? b[5] : b[2];
		const x = M[0] * x0 + M[4] * y0 + M[8] * z0 + M[12];
		const y = M[1] * x0 + M[5] * y0 + M[9] * z0 + M[13];
		const w = M[3] * x0 + M[7] * y0 + M[11] * z0 + M[15];
		let code = 0;
		if (x > w) code |= 1;
		if (x < -w) code |= 2;
		if (y > w) code |= 4;
		if (y < -w) code |= 8;
		if (w <= 0) code |= 16;
		all &= code;
		if (w <= 0) behind = true;
		else {
			const u = (x / w) * 0.5 + 0.5;
			const v = 0.5 - (y / w) * 0.5;
			u0 = Math.min(u0, u);
			u1 = Math.max(u1, u);
			v0 = Math.min(v0, v);
			v1 = Math.max(v1, v);
		}
	}
	if (all) return false;
	const cr = atlas.coarse[k];
	if (behind || !cr) return true;
	const [, , rw, rh] = atlas.cells[k].range;
	const bx0 = Math.max(0, Math.floor((Math.max(0, u0) * rw) / COARSE) - 1);
	const bx1 = Math.min(
		cr.width - 1,
		Math.floor((Math.min(1, u1) * rw) / COARSE) + 1,
	);
	const by0 = Math.max(0, Math.floor((Math.max(0, v0) * rh) / COARSE) - 1);
	const by1 = Math.min(
		cr.height - 1,
		Math.floor((Math.min(1, v1) * rh) / COARSE) + 1,
	);
	let far = 0;
	for (let y = by0; y <= by1; y++)
		for (let x = bx0; x <= bx1; x++)
			far = Math.max(far, cr.data[y * cr.width + x]);
	// the shader accepts r < seen·1.015 + 15 + 1.5·r·Δθ/MIN_SIN_INC at most
	return (
		Math.sqrt(d2) * Math.max(0, 1 - (1.5 / MIN_SIN_INC) * radPerPx) <=
		far * 1.015 + 15
	);
}

export type MultiDrapeTables = {
	/** SLOT_W vec4 per listed photo (camera-relative view-projection, eye+gain, rects, extras). */
	slots: Float32Array;
	/** Per tile, its candidates' indices into `slots`, nearest camera first (runs back to back). */
	lists: Uint32Array;
	/** Per tile id: [first index in `lists`, candidate count]. Tiles no photo reaches are absent. */
	rows: Map<string, [number, number]>;
	/** Atlas slot k of each table photo (diagnostics / checks). */
	atlasIndex: number[];
};

/**
 * The candidate tables (multi-drape-layer.ts buildTileSlots): only ready photos with a gain are
 * listed; per tile, the photos that can reach it, nearest camera first, at most MAX_PER_TILE.
 */
export function buildMultiDrapeTables(
	tiles: readonly TileMesh[],
	atlas: MultiDrapeAtlas,
	photos: readonly DrapePhoto[],
	reachM: number,
): MultiDrapeTables {
	const byId = new Map(photos.map((p) => [p.id, p]));
	const cams: { k: number; p: DrapePhoto; radPerPx: number }[] = [];
	for (const [k, id] of atlas.ids.entries()) {
		const p = byId.get(id);
		if (!p || !atlas.ready[k] || p.gain <= 0) continue;
		cams.push({
			k,
			p,
			radPerPx: (p.vfov * Math.PI) / 180 / atlas.cells[k].range[3],
		});
	}
	const slots = new Float32Array(Math.max(1, cams.length) * SLOT_W * 4);
	for (const [i, c] of cams.entries())
		slots.set(slotData(atlas, c.k, c.p), i * SLOT_W * 4);
	const rows = new Map<string, [number, number]>();
	const all: number[] = [];
	for (const t of tiles) {
		if (!t.indices.length) continue;
		const b = meshBox(t);
		const list: [number, number][] = [];
		for (const [i, c] of cams.entries()) {
			if (!reaches(b, c.p, atlas, c.k, reachM, c.radPerPx)) continue;
			const e = c.p.eye;
			const cx = (b[0] + b[3]) / 2 - e[0];
			const cy = (b[1] + b[4]) / 2 - e[1];
			list.push([i, cx * cx + cy * cy]);
		}
		if (!list.length) continue;
		// nearest cameras first: they usually weigh most, so the shader's pruning bites early
		list.sort((x, y) => x[1] - y[1]);
		const kept = list.slice(0, MAX_PER_TILE);
		rows.set(t.id, [all.length, kept.length]);
		for (const [i] of kept) all.push(i);
	}
	return {
		slots,
		lists: new Uint32Array(all.length ? all : [0]),
		rows,
		atlasIndex: cams.map((c) => c.k),
	};
}

// ---------------------------------------------------------------------------------------------
// GPU core

const BUF = {
	INDEX: 0x0010,
	VERTEX: 0x0020,
	COPY_DST: 0x0008,
	STORAGE: 0x0080,
};
const STRIDE = 6; // floats per vertex: position 3, normal 3

type GpuTile = {
	mesh: TileMesh;
	vertices: Buffer;
	indices: Buffer;
	indexCount: number;
	/** per-instance (first, count, cellM, 0) */
	info: Buffer;
	cellM: number;
	sphere: [number, number, number, number];
	/** candidate run this frame (null: no photo reaches the tile, not drawn) */
	row: [number, number] | null;
};

export class MultiDrapeCore implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["color"];
	readonly order = MULTI_DRAPE_ORDER;
	settings: MultiDrapeSettings = { ...DEFAULT_MULTI_DRAPE };
	private tiles = new Map<string, GpuTile>();
	private meshes: readonly TileMesh[] = [];
	private atlas: MultiDrapeAtlas | null = null;
	private photos: readonly DrapePhoto[] = [];
	private models = new ModelCache();
	private slotBuf: Buffer | null = null;
	private listBuf: Buffer | null = null;
	/** What the tables were built for (rebuilt lazily in draw when any of it moves). */
	private builtFor: {
		meshes: readonly TileMesh[];
		atlas: MultiDrapeAtlas | null;
		readyVersion: number;
		photos: readonly DrapePhoto[];
		reachM: number;
	} | null = null;
	stats = {
		tiles: 0,
		listed: 0,
		photos: 0,
		candidates: 0,
		drawn: 0,
		builds: 0,
		buildMs: 0,
	};
	/** Last tables (diagnostics, checks). */
	tables: MultiDrapeTables | null = null;

	constructor(
		readonly device: Device,
		readonly id = "multi-drape",
	) {}

	setSettings(s: Partial<MultiDrapeSettings>) {
		this.settings = { ...this.settings, ...s };
	}

	/** The terrain tile meshes (full CPU vertices). Keeps GPU buffers of unchanged mesh objects. */
	setTiles(meshes: readonly TileMesh[]) {
		this.meshes = meshes;
		const want = new Map(meshes.map((m) => [m.id, m]));
		for (const [id, t] of this.tiles)
			if (want.get(id) !== t.mesh) {
				this.release(t);
				this.tiles.delete(id);
			}
		for (const m of meshes)
			if (!this.tiles.has(m.id) && m.indices.length && m.seg > 0)
				this.tiles.set(m.id, this.upload(m));
		this.stats.tiles = this.tiles.size;
	}

	setAtlas(atlas: MultiDrapeAtlas | null) {
		this.atlas = atlas;
	}

	/** Per-photo projection state, matched to the atlas by id (keep the identity when unchanged). */
	setPhotos(photos: readonly DrapePhoto[]) {
		this.photos = photos;
	}

	visible() {
		return this.settings.opacity > 0 && !!this.atlas && this.tiles.size > 0;
	}

	private upload(m: TileMesh): GpuTile {
		const n = m.positions.length / 3;
		const v = new Float32Array(n * STRIDE);
		for (let i = 0; i < n; i++) {
			v.set(m.positions.subarray(i * 3, i * 3 + 3), i * STRIDE);
			v.set(m.normals.subarray(i * 3, i * 3 + 3), i * STRIDE + 3);
		}
		// the grid only: the skirts after it (terrain-data.ts buildMesh) hang just under the
		// neighbouring surface, within the depth slack, and would drape as lines on tile seams
		const idx = m.indices.subarray(
			0,
			Math.min(m.indices.length, m.seg * m.seg * 6),
		);
		const b = meshBox(m);
		const d = this.device;
		const cellM = cellSize(m);
		return {
			mesh: m,
			vertices: d.createBuffer({
				id: `${this.id}-${m.id}-v`,
				data: v,
				usage: BUF.VERTEX | BUF.COPY_DST,
			}),
			indices: d.createBuffer({
				id: `${this.id}-${m.id}-i`,
				data: idx,
				usage: BUF.INDEX | BUF.COPY_DST,
			}),
			indexCount: idx.length,
			info: d.createBuffer({
				id: `${this.id}-${m.id}-info`,
				data: new Float32Array([0, 0, cellM, 0]),
				usage: BUF.VERTEX | BUF.COPY_DST,
			}),
			cellM,
			sphere: [
				(b[0] + b[3]) / 2,
				(b[1] + b[4]) / 2,
				(b[2] + b[5]) / 2,
				Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2,
			],
			row: null,
		};
	}

	private release(t: GpuTile) {
		t.vertices.destroy();
		t.indices.destroy();
		t.info.destroy();
	}

	/** Rebuild the candidate tables when the tiles, atlas readiness, photos or reach changed. */
	private prepare() {
		const a = this.atlas;
		const f = this.builtFor;
		const reachM = this.settings.reachM;
		if (
			f &&
			f.meshes === this.meshes &&
			f.atlas === a &&
			f.readyVersion === (a?.readyVersion ?? -1) &&
			f.photos === this.photos &&
			f.reachM === reachM
		)
			return;
		const t0 = performance.now();
		this.builtFor = {
			meshes: this.meshes,
			atlas: a,
			readyVersion: a?.readyVersion ?? -1,
			photos: this.photos,
			reachM,
		};
		this.slotBuf?.destroy();
		this.listBuf?.destroy();
		this.slotBuf = this.listBuf = null;
		for (const t of this.tiles.values()) t.row = null;
		this.tables = null;
		if (!a) return;
		const tables = buildMultiDrapeTables(this.meshes, a, this.photos, reachM);
		this.tables = tables;
		const d = this.device;
		this.slotBuf = d.createBuffer({
			id: `${this.id}-slots`,
			data: tables.slots,
			usage: BUF.STORAGE | BUF.COPY_DST,
		});
		this.listBuf = d.createBuffer({
			id: `${this.id}-lists`,
			data: tables.lists,
			usage: BUF.STORAGE | BUF.COPY_DST,
		});
		let candidates = 0;
		for (const [id, row] of tables.rows) {
			const t = this.tiles.get(id);
			if (!t) continue;
			t.row = row;
			t.info.write(new Float32Array([row[0], row[1], t.cellM, 0]));
			candidates += row[1];
		}
		this.stats.listed = tables.rows.size;
		this.stats.photos = tables.atlasIndex.length;
		this.stats.candidates = candidates;
		this.stats.builds++;
		this.stats.buildMs = performance.now() - t0;
	}

	private model(ctx: PassContext) {
		return this.models.get(
			targetKey(ctx),
			() =>
				new Model(this.device, {
					id: `${this.id}-color`,
					source: MULTI_DRAPE_WGSL,
					modules: [cameraModule, multiDrapeModule] as never,
					...passModelProps("color", { depth: "test", blend: true }),
					topology: "triangle-list",
					bufferLayout: [
						{
							name: "tile",
							byteStride: STRIDE * 4,
							attributes: [
								{ attribute: "positions", format: "float32x3", byteOffset: 0 },
								{ attribute: "normals", format: "float32x3", byteOffset: 12 },
							],
						},
						{ name: "tileInfo", format: "float32x4", stepMode: "instance" },
					],
					isInstanced: true,
					instanceCount: 1,
				} as never),
		);
	}

	draw(ctx: PassContext) {
		this.stats.drawn = 0;
		if (ctx.kind !== "color" || !this.visible()) return;
		this.prepare();
		const a = this.atlas;
		if (!a || !this.slotBuf || !this.listBuf || !a.photo.length) return;
		const model = this.model(ctx);
		const s = this.settings;
		model.shaderInputs.setProps({
			camera: ctx.camera,
			mdrape: {
				opacity: s.opacity,
				sharpness: s.sharpness,
				falloffM: s.falloffM,
				outline: s.outline,
				reachM: s.reachM,
				people: s.people,
				pad0: 0,
				pad1: 0,
			},
		} as never);
		const ph = (i: number) => a.photo[Math.min(i, a.photo.length - 1)];
		model.setBindings({
			mdrapeSlots: this.slotBuf,
			mdrapeLists: this.listBuf,
			mdPhoto0: ph(0),
			mdPhoto1: ph(1),
			mdPhoto2: ph(2),
			mdPhoto3: ph(3),
			mdRange: a.range,
			mdMask: a.mask,
		} as never);
		let drawn = 0;
		for (const t of this.tiles.values()) {
			if (!t.row || !sphereInView(ctx.camera, t.sphere)) continue;
			model.setAttributes({ tile: t.vertices, tileInfo: t.info });
			model.setIndexBuffer(t.indices);
			model.setIndexCount(t.indexCount);
			model.draw(ctx.renderPass);
			drawn++;
		}
		this.stats.drawn = drawn;
	}

	destroy() {
		for (const t of this.tiles.values()) this.release(t);
		this.tiles.clear();
		this.slotBuf?.destroy();
		this.listBuf?.destroy();
		this.slotBuf = this.listBuf = null;
		this.models.destroy();
	}
}

/** Factory (same shape as the other layer ports). */
export function createMultiDrape(
	device: Device,
	settings?: Partial<MultiDrapeSettings>,
) {
	const c = new MultiDrapeCore(device);
	if (settings) c.setSettings(settings);
	return c;
}

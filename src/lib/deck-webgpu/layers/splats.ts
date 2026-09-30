// Step Inside's Gaussian splats on WebGPU: the port of nearfield/deck-splat-layer.ts DeckSplatLayer
// + deck-splat-shaders.ts (GLSL) to a host-agnostic GpuLayerCore (README.md "Layer contract").
//
// What is the same as the WebGL layer (the reference look):
//   - instanced screen-space quads, 6 vertices per splat, EWA covariance projection with the same
//     0.3 px² low-pass, `sigmas` extent, `maxRadiusPx` crop (clamped radius keeps its sigma scale),
//     1/255 alpha cut, nearW cull, off-screen cull with the quad's own radius
//   - the quad sits at the splat CENTRE's depth (constant over the quad): the terrain occludes the
//     splats, the splats never occlude anything (depth test only, no depth write)
//   - premultiplied alpha, back-to-front order from nearfield/splat-sort.ts SplatSorter (worker,
//     sync fallback), re-sorted when the camera turns / moves by more than `sortEvery` (deg / m)
//   - the Truth toggle (provenance tints mixed into the sRGB colour, PROVENANCE_TINT_MIX) and the
//     opacity multiplier
//   - colour: sRGB bytes → linear in the fragment shader, i.e. the WebGL photo view's
//     `linearOut = 1` path. The colour target is linear everywhere on WebGPU, so the world view now
//     blends in linear too (the WebGL canvas path blended sRGB bytes); the compositor encodes.
//
// What changed with the foundation:
//   - depth: the GLSL wrote gl_FragDepth = log2(1 + w)·FC (the terrain's log depth). Reversed-Z
//     (depth.ts) gives the same constant-per-quad centre depth with no frag_depth write: the quad
//     vertices carry clip.z = camera.near, clip.w = the centre's view depth. Early-Z stays on.
//   - the Jacobian: the GLSL differenced deck's project_position_to_clipspace; here the view-proj
//     is ours and camera-relative, so d clip / d world_k is just column k of camera.viewProj.
//   - data: one read-only STORAGE buffer (3 × vec4<u32> per splat, bitcast; colour packed as
//     unpack4x8unorm bytes) instead of the rgba32float texture, and the back-to-front order in a
//     second storage buffer indexed by instance_index (no float index attribute). No vertex
//     buffers at all: quad corners come from vertex_index.
//   - no SplatColorPass snapshot / merge: the colour target is premultiplied, so the splats blend
//     straight in with passModelProps("color", {depth: "test", blend: true}).
//   - optional geometry-pass contribution (`geometry: true`, off by default): each non-generated
//     splat's core (own alpha ≥ `geometryAlpha`) writes its CENTRE (ENU xyz, photo range) and
//     class 2 in normal.w, depth-tested and written like any opaque surface. That is the GPU twin
//     of nearfield/measure.ts buildMeasureGrid (nearest non-generated splat per cell) — the input
//     of the nf masks (deck-step.ts stepMasks / engine.ts rebuildNearFieldMasks) without the CPU
//     projection. Off by default because it changes what queries / drape see (splats then occlude
//     terrain in the geometry target, which the WebGL geometry pass never did).
//
// Order in the colour pass: 95, after the sky cores (atm-sky 90, photo-sky 91). The sky cores draw
// only where depth is still the cleared 0, and splats write no depth, so a splat against the sky
// must be blended AFTER the sky or the sky overwrites it (the WebGL layer was likewise drawn last).
//
// Wiring (assembler / engine.ts):
//   const splats = createSplatsCore(host.device);      // add to host.cores
//   splats.onChange = () => host.requestRender();       // a new sort order landed
//   splats.setCloud(scene.splats);                      // ENU GaussianCloud (null clears)
//   splats.setOptions({ truth, opacity, sortEvery, maxRadiusPx, sigmas, geometry });
//   splats.setEnabled(stepping);                        // visible() gate
// Diagnostics: splats.stats (sorts, lastSortMs, drawn, worker, sortVersion). The WebGL layer's
// globalThis.__rigiSplatStats is not touched here (engine may alias splats.stats onto it).
import type { Buffer, Device } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import {
	PROVENANCE_COLORS_BY_CODE,
	PROVENANCE_TINT_MIX,
} from "#/lib/nearfield/provenance";
import {
	type DepthRow,
	type SortResult,
	SplatSorter,
} from "#/lib/nearfield/splat-sort";
import { type GaussianCloud, PROVENANCE_CODE } from "#/lib/nearfield/types";
import { type CameraUniforms, cameraModule } from "../camera";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	passModelProps,
} from "../pass";
import { colorWGSL } from "../wgsl";

/** GPUBufferUsage bits. */
const STORAGE = 0x0080;
const COPY_DST = 0x0008;

/** u32 words per splat in the storage buffer (3 × vec4). */
export const SPLAT_WORDS = 12;

export type SplatsOptions = {
	/** Splat opacity multiplier 0..1 (fades). Default 1. */
	opacity: number;
	/** Tint by provenance (the "Truth" toggle). Default false. */
	truth: boolean;
	/** Re-sort when the view turns by more than this many degrees or moves this many metres. 0 = every frame. Default 1. */
	sortEvery: number;
	/** Screen-space radius cap per splat, px. Default 1024. */
	maxRadiusPx: number;
	/** Ellipse extent in standard deviations. Default 3. */
	sigmas: number;
	/** Sort in a worker (default true; false = synchronous, for tests). Applies at the next setCloud. */
	sortWorker: boolean;
	/** Test hook: depth test off (splats over everything), to prove occlusion works. */
	noDepthTest: boolean;
	/** Draw splat cores into the geometry pass (class 2). Default false (see header). */
	geometry: boolean;
	/** Minimum own alpha (before the opacity fade) for a geometry-pass fragment. Default 0.5. */
	geometryAlpha: number;
};

export const DEFAULT_SPLATS_OPTIONS: SplatsOptions = {
	opacity: 1,
	truth: false,
	sortEvery: 1,
	maxRadiusPx: 1024,
	sigmas: 3,
	sortWorker: true,
	noDepthTest: false,
	geometry: false,
	geometryAlpha: 0.5,
};

/** WebGL constants kept identical (deck-splat-layer.ts draw()). */
const NEAR_W = 0.05;
const LOW_PASS = 0.3;

/** Truth tints per PROVENANCE_CODE (sRGB 0..1, a = mix), as deck-splat-layer.ts PROVENANCE_TINTS. */
export const SPLAT_TINTS: [number, number, number, number][] = [0, 1, 2, 3].map(
	(code) => {
		const c = PROVENANCE_COLORS_BY_CODE[code] ?? [255, 255, 255];
		return [c[0] / 255, c[1] / 255, c[2] / 255, PROVENANCE_TINT_MIX];
	},
);

export const splatModule = {
	name: "splat",
	source: /* wgsl */ `\
struct SplatUniforms {
  tint0: vec4<f32>,
  tint1: vec4<f32>,
  tint2: vec4<f32>,
  tint3: vec4<f32>,
  opacity: f32,
  truth: f32,
  maxRadiusPx: f32,
  nearW: f32,
  sigmas: f32,
  lowPass: f32,
  geometryAlpha: f32,
  pad0: f32,
};
@group(0) @binding(auto) var<uniform> splat: SplatUniforms;
`,
	uniformTypes: {
		tint0: "vec4<f32>",
		tint1: "vec4<f32>",
		tint2: "vec4<f32>",
		tint3: "vec4<f32>",
		opacity: "f32",
		truth: "f32",
		maxRadiusPx: "f32",
		nearW: "f32",
		sigmas: "f32",
		lowPass: "f32",
		geometryAlpha: "f32",
		pad0: "f32",
	},
	bindingLayout: [{ name: "splat", group: 0 }],
} as const satisfies ShaderModule;

export type SplatUniformValues = {
	tint0: number[];
	tint1: number[];
	tint2: number[];
	tint3: number[];
	opacity: number;
	truth: number;
	maxRadiusPx: number;
	nearW: number;
	sigmas: number;
	lowPass: number;
	geometryAlpha: number;
	pad0: number;
};

/** Uniform values for the `splat` module from the options. */
export function splatUniforms(o: SplatsOptions): SplatUniformValues {
	const t = SPLAT_TINTS;
	return {
		tint0: t[0],
		tint1: t[1],
		tint2: t[2],
		tint3: t[3],
		opacity: o.opacity,
		truth: o.truth ? 1 : 0,
		maxRadiusPx: o.maxRadiusPx,
		nearW: NEAR_W,
		sigmas: o.sigmas,
		lowPass: LOW_PASS,
		geometryAlpha: o.geometryAlpha,
		pad0: 0,
	};
}

/**
 * The splat program. Colour pass by default; GEOMETRY_PASS for the class-2 geometry contribution.
 * Storage (per splat i, words 12i..12i+11, f32 bit patterns unless noted):
 *   [0] pos x, y, z (ENU m), provenance code
 *   [1] Σ xx, xy, xz, yy (m²)
 *   [2] Σ yz, zz, rgba (u32: r | g<<8 | b<<16 | a<<24, sRGB bytes), 0
 */
export const splatsWGSL = /* wgsl */ `\
${colorWGSL}
@group(0) @binding(auto) var<storage, read> splatData: array<vec4<u32>>;
@group(0) @binding(auto) var<storage, read> splatOrder: array<u32>;

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat) color: vec4<f32>,
  @location(1) uv: vec2<f32>,
  // xyz = splat centre (ENU), w = its range from the eye (geometry pass)
  @location(2) @interpolate(flat) center: vec4<f32>,
};

fn splat_culled() -> Varyings {
  var v: Varyings;
  v.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  v.color = vec4<f32>(0.0);
  v.uv = vec2<f32>(0.0);
  v.center = vec4<f32>(0.0);
  return v;
}

fn splat_corner(i: u32) -> vec2<f32> {
  // two triangles: (-1,-1) (1,-1) (1,1) / (-1,-1) (1,1) (-1,1)
  var c = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0)
  );
  return c[i];
}

@vertex fn vertexMain(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> Varyings {
  let i = splatOrder[iid];
  let t0 = bitcast<vec4<f32>>(splatData[3u * i]);
  let t1 = bitcast<vec4<f32>>(splatData[3u * i + 1u]);
  let w2 = splatData[3u * i + 2u];
  let t2 = bitcast<vec2<f32>>(w2.xy);
  let p = t0.xyz;
  let code = t0.w;
#ifdef GEOMETRY_PASS
  // measurement rule (nearfield/measure.ts): generated splats never enter the geometry target
  if (code > 2.5) { return splat_culled(); }
#endif

  let clip = camera_clip(p);
  if (clip.w < splat.nearW) { return splat_culled(); }

  // linear part of world -> clip (x, y, w): the columns of the camera-relative view-proj
  let M = camera.viewProj;
  let dX = vec3<f32>(M[0].x, M[0].y, M[0].w);
  let dY = vec3<f32>(M[1].x, M[1].y, M[1].w);
  let dZ = vec3<f32>(M[2].x, M[2].y, M[2].w);
  let ndc = clip.xy / clip.w;
  let halfRes = 0.5 * camera.viewport;
  // d(pixel)/d(world_k) = halfRes * (d clip.xy - ndc * d clip.w) / clip.w
  let jX = halfRes * (dX.xy - ndc * dX.z) / clip.w;
  let jY = halfRes * (dY.xy - ndc * dY.z) / clip.w;
  let jZ = halfRes * (dZ.xy - ndc * dZ.z) / clip.w;
  let Jx = vec3<f32>(jX.x, jY.x, jZ.x);
  let Jy = vec3<f32>(jX.y, jY.y, jZ.y);
  let S = mat3x3<f32>(
    vec3<f32>(t1.x, t1.y, t1.z),
    vec3<f32>(t1.y, t1.w, t2.x),
    vec3<f32>(t1.z, t2.x, t2.y)
  );
  let SJx = S * Jx;
  let SJy = S * Jy;
  let a = dot(Jx, SJx) + splat.lowPass;
  let b = dot(Jx, SJy);
  let d = dot(Jy, SJy) + splat.lowPass;

  let mid = 0.5 * (a + d);
  let rad = sqrt(max(0.25 * (a - d) * (a - d) + b * b, 0.0));
  let l1 = mid + rad;
  let l2 = max(mid - rad, 0.05);
  var v1: vec2<f32>;
  if (abs(b) > 1e-9) { v1 = normalize(vec2<f32>(b, l1 - a)); }
  else if (a >= d) { v1 = vec2<f32>(1.0, 0.0); }
  else { v1 = vec2<f32>(0.0, 1.0); }
  let v2 = vec2<f32>(-v1.y, v1.x);
  let r1 = min(splat.sigmas * sqrt(l1), splat.maxRadiusPx);
  let r2 = min(splat.sigmas * sqrt(l2), splat.maxRadiusPx);

  // off-screen (with the quad's own radius) -> cull
  let px = ndc * halfRes;
  if (any(abs(px) - vec2<f32>(r1) > halfRes * 1.05)) { return splat_culled(); }

  var col = unpack4x8unorm(w2.z);
  if (splat.truth > 0.5) {
    var tint = splat.tint3;
    if (code < 0.5) { tint = splat.tint0; }
    else if (code < 1.5) { tint = splat.tint1; }
    else if (code < 2.5) { tint = splat.tint2; }
    col = vec4<f32>(mix(col.rgb, tint.rgb, tint.a), col.a);
  }
#ifndef GEOMETRY_PASS
  col.a *= splat.opacity;
#endif
  if (col.a < 1.0 / 255.0) { return splat_culled(); }

  let q = splat_corner(vid);
  let off = q.x * r1 * v1 + q.y * r2 * v2;
  var v: Varyings;
  v.color = col;
  // quad corner in units of sigma along the ellipse's axes; a radius clamped by maxRadiusPx keeps
  // its sigma scale, so the clamp crops rather than stretches
  v.uv = vec2<f32>(q.x * r1 / max(sqrt(l1), 1e-6), q.y * r2 / max(sqrt(l2), 1e-6));
  // clip.z = near and clip.w = the centre's view depth at every corner: the whole quad gets the
  // centre's reversed-Z depth (near / w), the WebGL layer's constant log depth
  v.position = vec4<f32>(clip.xy + off / halfRes * clip.w, clip.z, clip.w);
  v.center = vec4<f32>(p, camera_range(p));
  return v;
}

#ifdef GEOMETRY_PASS
struct GeometryOut {
  @location(0) xyzr: vec4<f32>,
  @location(1) normal: vec4<f32>,
};
@fragment fn fragmentMain(v: Varyings) -> GeometryOut {
  let r2 = dot(v.uv, v.uv);
  if (r2 > splat.sigmas * splat.sigmas) { discard; }
  if (v.color.a * exp(-0.5 * r2) < splat.geometryAlpha) { discard; }
  var o: GeometryOut;
  o.xyzr = v.center;
  // splats carry no surface normal: face the photo eye; w = class 2 (object / splat)
  let n = camera.eye - v.center.xyz;
  o.normal = vec4<f32>(n / max(length(n), 1e-6), 2.0);
  return o;
}
#else
@fragment fn fragmentMain(v: Varyings) -> @location(0) vec4<f32> {
  let r2 = dot(v.uv, v.uv);
  if (r2 > splat.sigmas * splat.sigmas) { discard; }
  let alpha = v.color.a * exp(-0.5 * r2);
  if (alpha < 1.0 / 255.0) { discard; }
  // premultiplied, linear (the colour target); blend one / one-minus-src-alpha
  return vec4<f32>(srgb_decode(v.color.rgb) * alpha, alpha);
}
#endif
`;

/**
 * Pack positions / covariance / colour / provenance into the storage layout (splatsWGSL).
 * Σ = R diag(s²) Rᵀ from the unit quaternion (w, x, y, z): deck-splat-layer.ts packSplatTexture.
 */
export function packSplats(cloud: GaussianCloud): Uint32Array {
	const n = cloud.count;
	const buf = new ArrayBuffer(Math.max(1, n) * SPLAT_WORDS * 4);
	const f = new Float32Array(buf);
	const u = new Uint32Array(buf);
	const { positions: P, scales: S, rotations: Q, colors: C } = cloud;
	const prov = cloud.provenance;
	for (let i = 0; i < n; i++) {
		const o = i * SPLAT_WORDS;
		f[o] = P[3 * i];
		f[o + 1] = P[3 * i + 1];
		f[o + 2] = P[3 * i + 2];
		f[o + 3] = prov[i] ?? 0;
		let w = Q[4 * i];
		let x = Q[4 * i + 1];
		let y = Q[4 * i + 2];
		let z = Q[4 * i + 3];
		const qn = Math.hypot(w, x, y, z) || 1;
		w /= qn;
		x /= qn;
		y /= qn;
		z /= qn;
		const r00 = 1 - 2 * (y * y + z * z);
		const r01 = 2 * (x * y - w * z);
		const r02 = 2 * (x * z + w * y);
		const r10 = 2 * (x * y + w * z);
		const r11 = 1 - 2 * (x * x + z * z);
		const r12 = 2 * (y * z - w * x);
		const r20 = 2 * (x * z - w * y);
		const r21 = 2 * (y * z + w * x);
		const r22 = 1 - 2 * (x * x + y * y);
		const sx = S[3 * i];
		const sy = S[3 * i + 1];
		const sz = S[3 * i + 2];
		const m00 = r00 * sx;
		const m01 = r01 * sy;
		const m02 = r02 * sz;
		const m10 = r10 * sx;
		const m11 = r11 * sy;
		const m12 = r12 * sz;
		const m20 = r20 * sx;
		const m21 = r21 * sy;
		const m22 = r22 * sz;
		f[o + 4] = m00 * m00 + m01 * m01 + m02 * m02;
		f[o + 5] = m00 * m10 + m01 * m11 + m02 * m12;
		f[o + 6] = m00 * m20 + m01 * m21 + m02 * m22;
		f[o + 7] = m10 * m10 + m11 * m11 + m12 * m12;
		f[o + 8] = m10 * m20 + m11 * m21 + m12 * m22;
		f[o + 9] = m20 * m20 + m21 * m21 + m22 * m22;
		u[o + 10] =
			(C[4 * i] |
				(C[4 * i + 1] << 8) |
				(C[4 * i + 2] << 16) |
				(C[4 * i + 3] << 24)) >>>
			0;
		u[o + 11] = 0;
	}
	return u;
}

/**
 * The sorter's depth row for a camera (splat-sort.worker.ts DepthRow: view z = a x + b y + c z + d,
 * looking down −z). Our view depth is forward·(p − eye), so view z = −forward·p + forward·eye.
 */
export function splatDepthRow(c: CameraUniforms): DepthRow {
	const f = c.forward;
	return [
		-f[0],
		-f[1],
		-f[2],
		f[0] * c.eye[0] + f[1] * c.eye[1] + f[2] * c.eye[2],
	];
}

export type SplatsStats = {
	count: number;
	sorts: number;
	lastSortMs: number;
	/** Instances drawn in the last colour pass. */
	drawn: number;
	worker: boolean;
	/** Bumped when a new draw order lands. */
	sortVersion: number;
};

type Gpu = {
	cloud: GaussianCloud;
	data: Buffer;
	order: Buffer;
	/** identity order for the geometry pass (created on first use) */
	identity?: Buffer;
	sorter: SplatSorter;
	/** spare index array for the next sort (transferred to the worker and back) */
	spare?: Uint32Array;
	drawCount: number;
	lastRow?: DepthRow;
	lastEye?: number[];
	dirty: boolean;
};

export class SplatsCore implements GpuLayerCore {
	readonly order = 95;
	options: SplatsOptions = { ...DEFAULT_SPLATS_OPTIONS };
	stats: SplatsStats = {
		count: 0,
		sorts: 0,
		lastSortMs: 0,
		drawn: 0,
		worker: false,
		sortVersion: 0,
	};
	/** Called when a new back-to-front order has landed (hook host.requestRender() here). */
	onChange?: () => void;
	private enabled = true;
	private gpu: Gpu | null = null;
	private models = new ModelCache();

	constructor(
		readonly device: Device,
		readonly id = "splats",
	) {}

	get passes(): readonly PassKind[] {
		return this.options.geometry ? ["geometry", "color"] : ["color"];
	}

	visible() {
		return this.enabled && !!this.gpu && this.options.opacity > 0;
	}

	setEnabled(on: boolean) {
		this.enabled = on;
	}

	setOptions(o: Partial<SplatsOptions>) {
		const noDepth = this.options.noDepthTest;
		this.options = { ...this.options, ...o };
		if (this.options.noDepthTest !== noDepth) this.models.invalidate("color");
	}

	/** Replace the cloud (ENU GaussianCloud; null clears). Same object → no-op. */
	setCloud(cloud: GaussianCloud | null) {
		if (cloud === this.gpu?.cloud) return;
		this.releaseGpu();
		if (!cloud || !cloud.count) {
			this.stats.count = 0;
			return;
		}
		if (cloud.frame !== "enu")
			console.warn(
				"[deck-webgpu splats] cloud is in the camera frame; SplatsCore expects ENU (anchor it first)",
			);
		const n = cloud.count;
		const d = this.device;
		const data = d.createBuffer({
			id: `${this.id}-data`,
			data: packSplats(cloud),
			usage: STORAGE | COPY_DST,
		});
		// identity order until the first sort lands
		const initial = new Uint32Array(n);
		for (let i = 0; i < n; i++) initial[i] = i;
		const order = d.createBuffer({
			id: `${this.id}-order`,
			data: initial,
			usage: STORAGE | COPY_DST,
		});
		const sorter = new SplatSorter(cloud.positions, n, {
			worker: this.options.sortWorker,
		});
		this.stats.count = n;
		this.stats.worker = sorter.usingWorker;
		this.gpu = {
			cloud,
			data,
			order,
			sorter,
			spare: new Uint32Array(n),
			drawCount: n,
			dirty: true,
		};
	}

	private model(kind: "geometry" | "color") {
		const noDepth = this.options.noDepthTest;
		const key = kind === "geometry" ? "geometry" : `color|${noDepth}`;
		return this.models.get(
			key,
			() =>
				new Model(this.device, {
					id: `${this.id}-${kind}`,
					source: splatsWGSL,
					vertexEntryPoint: "vertexMain",
					fragmentEntryPoint: "fragmentMain",
					modules: [cameraModule, splatModule] as never,
					defines: kind === "geometry" ? { GEOMETRY_PASS: true } : {},
					...(kind === "geometry"
						? passModelProps("geometry")
						: passModelProps("color", {
								depth: noDepth ? "none" : "test",
								blend: true,
							})),
					topology: "triangle-list",
					bufferLayout: [],
					vertexCount: 6,
					isInstanced: true,
					instanceCount: 1,
				} as never),
		);
	}

	/** Request a back-to-front sort when the view camera has moved / turned enough since the last one. */
	private maybeSort(g: Gpu, cam: CameraUniforms) {
		const { sorter, spare } = g;
		// a sort is in flight: its landing calls onChange → a redraw, which re-checks the camera
		if (!spare) return;
		const row = splatDepthRow(cam);
		const eye = cam.eye;
		const every = this.options.sortEvery;
		if (g.lastRow && g.lastEye && !g.dirty) {
			const cos =
				row[0] * g.lastRow[0] + row[1] * g.lastRow[1] + row[2] * g.lastRow[2];
			const turned = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
			const moved = Math.hypot(
				eye[0] - g.lastEye[0],
				eye[1] - g.lastEye[1],
				eye[2] - g.lastEye[2],
			);
			if (every > 0 && turned <= every && moved <= every) return;
		}
		if (sorter.busy) {
			g.dirty = true;
			return;
		}
		g.lastRow = row;
		g.lastEye = [eye[0], eye[1], eye[2]];
		g.dirty = false;
		g.spare = undefined;
		sorter.sort(row, spare, (r) => this.onSorted(g, r));
	}

	private onSorted(g: Gpu, r: SortResult) {
		// the result belongs to a cloud that has since been replaced
		if (this.gpu !== g) return;
		this.stats.sorts++;
		this.stats.lastSortMs = r.ms;
		if (r.count) g.order.write(r.indices.subarray(0, r.count));
		g.drawCount = r.count;
		g.spare = r.indices;
		this.stats.sortVersion++;
		this.onChange?.();
	}

	/** Draw version for caches keyed on what this core shows (bumps with each new sort order). */
	get drawVersion() {
		return this.stats.sortVersion;
	}

	draw(ctx: PassContext) {
		const g = this.gpu;
		if (!g || ctx.kind === "screen") return;
		if (ctx.kind === "geometry" && !this.options.geometry) return;
		const model = this.model(ctx.kind);
		let order = g.order;
		let count = g.drawCount;
		if (ctx.kind === "geometry") {
			// opaque + depth-written: no order needed, and the view sort may have dropped splats that
			// are behind the VIEW camera but in front of the photo camera
			g.identity ??= this.identityBuffer(g.cloud.count);
			order = g.identity;
			count = g.cloud.count;
		} else {
			this.maybeSort(g, ctx.camera);
			count = g.drawCount;
			this.stats.drawn = count;
		}
		if (!count) return;
		model.shaderInputs.setProps({
			camera: ctx.camera,
			splat: splatUniforms(this.options),
		} as never);
		model.setBindings({ splatData: g.data, splatOrder: order } as never);
		model.setInstanceCount(count);
		model.draw(ctx.renderPass);
	}

	private identityBuffer(n: number) {
		const a = new Uint32Array(n);
		for (let i = 0; i < n; i++) a[i] = i;
		return this.device.createBuffer({
			id: `${this.id}-identity`,
			data: a,
			usage: STORAGE | COPY_DST,
		});
	}

	private releaseGpu() {
		const g = this.gpu;
		if (!g) return;
		g.sorter.dispose();
		g.data.destroy();
		g.order.destroy();
		g.identity?.destroy();
		this.gpu = null;
	}

	destroy() {
		this.releaseGpu();
		this.models.destroy();
	}
}

/** Factory for the assembler (see the header for wiring). */
export function createSplatsCore(
	device: Device,
	opts: Partial<SplatsOptions> = {},
	id = "splats",
): SplatsCore {
	const core = new SplatsCore(device, id);
	core.setOptions(opts);
	return core;
}

/** PROVENANCE_CODE of generated splats (never written to the geometry target). */
export const SPLAT_GENERATED_CODE = PROVENANCE_CODE.generated;

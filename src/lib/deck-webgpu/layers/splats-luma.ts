// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside's splats on luma.gl's splat stack (@luma.gl/splats, vendored rigi.6 with luma PR
// #3340): the colour-pass renderer SplatsCore (splats.ts) uses by default on WebGPU.
//
//   cloud ──buildSplatLod (nearfield/splat-lod.ts)──▶ LoD rows, BFS, ≤ 8 children per row
//         ──GPUSplatData per 65 536-row page──▶ SplatRADHierarchyManager (progressive selection:
//           a fresh best-first cut (selectView) when the camera has turned / moved enough, walked
//           SELECT_ROWS_PER_FRAME rows per frame (continueTraversal) and published only when
//           complete, so the previous cut keeps drawing meanwhile; coarse merged rows for small /
//           far parts, the original splats where the projected error exceeds MAX_SCREEN_ERROR px.
//           Not refineView: it never coarsens visible branches, and far away luma's anti-aliasing
//           compensation fades sub-pixel leaves to nothing where a merged row stays visible)
//         ──frontier (pages + active rows)──▶ GPUPagedSplatRenderer.prepare(encoder) in the colour
//           pass prepass: projection, culling, one global GPU radix depth sort across pages and
//           the gather into ordered projected records, all on luma's GPUCommandGraph
//         ──our draw──▶ one indirect draw per ordered segment in the host's colour pass.
//
// Why our own draw and not GPUPagedSplatRenderer.draw(renderPass): its render Model is built for
// the canvas format with 'less-equal' depth and straight alpha; our colour pass is 4× MSAA
// rgba16float, reversed-Z ('greater-equal', layers/../depth.ts) and premultiplied. The renderer
// exposes its ordered projected records, uniforms and indirect records for exactly this
// ("integrations that draw ordered segments externally"), so the draw here reads the 48-byte
// ProjectedSplat records and writes the depth convention of every other colour-pass core.
//
// The depth convention, twice: luma's projection derives its 16-bit sort key from an OpenGL clip
// z (z/w ∈ [−1, 1], farther = larger) and culls outside it. So luma gets a GL-convention matrix
// whose x / y / w rows are ours (camera.viewProj, camera-relative) and whose z row maps the
// cloud's current depth span [near, far] (from its bounding sphere, refreshed per frame) onto
// [−1, 1] — the 16-bit keys then spread over the cloud instead of over 0.05 m … ∞. Our vertex
// shader ignores that z and writes clip.z = camera.near, clip.w = the centre's view depth, the
// constant-per-quad reversed-Z depth of splats.ts.
//
// Differences from the Rigi path (splats.ts), by design and not bit-exact: luma's EWA
// projection adds the low-pass as a kernel (√0.3 px σ) and dims tiny splats by
// √(det Σ / det(Σ + low-pass)) (anti-aliasing compensation); the 16-bit sort key is in 1/depth
// over the cloud span, not linear depth; coarse LoD rows replace leaves where they project small;
// the Truth tint is baked into the uploaded colours (re-uploaded on toggle) instead of mixed per
// fragment. Colour: sRGB bytes, decoded to linear here like splats.ts; alpha = opacity · fade.
import type { Device, RenderPass } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import {
	type GPUPagedSplatPage,
	GPUPagedSplatRenderer,
	GPUSplatData,
	type SplatRADHierarchyFrontierEntry,
	SplatRADHierarchyManager,
} from "@luma.gl/splats";
import {
	buildSplatLod,
	type SplatLod,
	tintedLodColors,
} from "#/lib/nearfield/splat-lod";
import type { GaussianCloud } from "#/lib/nearfield/types";
import type { CameraUniforms } from "../camera";
import { ModelCache, passModelProps } from "../pass";
import { colorWGSL } from "../wgsl";

/** Projected geometric error (px) above which a LoD row is refined into its children. */
export const MAX_SCREEN_ERROR = 1.5;
/** LoD rows walked per frame (about 0.6 µs each on this Mac in node, 2026-10-02: ~5 ms). */
export const SELECT_ROWS_PER_FRAME = 8192;
/**
 * Larger clouds stay on the Rigi path: the LoD build is synchronous (~2 µs per splat in node,
 * 70 000 splats in 136 ms) and would block the main thread for seconds.
 */
export const LUMA_MAX_SPLATS = 2_000_000;
/** Re-select when the view turned by more than this (degrees)… */
export const SELECT_TURN_DEG = 2;
/** …or the eye moved by more than this fraction of its distance to the cloud. */
export const SELECT_MOVE_FRACTION = 0.05;
/** Selected rows cap (luma's active-row budget); larger clouds draw coarser. */
export const MAX_ACTIVE_ROWS = 2_000_000;
/** Same cull as splats.ts NEAR_W: nothing nearer than this many metres. */
const NEAR_W = 0.05;

export type LumaSplatsOptions = {
	opacity: number;
	truth: boolean;
	maxRadiusPx: number;
	sigmas: number;
	/** Test hook (splats.ts noDepthTest): depth test off. */
	noDepthTest: boolean;
	/** Truth tints (sRGB 0..1, a = mix) per PROVENANCE_CODE (splats.ts SPLAT_TINTS). */
	tints: readonly (readonly number[])[];
};

export type LumaSplatsStats = {
	/** LoD rows (interior + leaves) and leaves. */
	rows: number;
	leaves: number;
	pages: number;
	/** Rows in the current frontier, and of those coarse rows standing in for missing detail. */
	activeRows: number;
	fallbackRows: number;
	/** Bumped when the frontier or the projection changed (a re-encode was recorded). */
	version: number;
	/** CPU ms of the last selection step. */
	selectMs: number;
	/** CPU ms of building the LoD tree. */
	buildMs: number;
};

export const lumaSplatModule = {
	name: "lumaSplat",
	source: /* wgsl */ `\
struct LumaSplatUniforms {
  viewport: vec2<f32>,
  near: f32,
  support: f32,
  alphaCutoff: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};
@group(0) @binding(auto) var<uniform> lumaSplat: LumaSplatUniforms;
`,
	uniformTypes: {
		viewport: "vec2<f32>",
		near: "f32",
		support: "f32",
		alphaCutoff: "f32",
		pad0: "f32",
		pad1: "f32",
		pad2: "f32",
	},
	bindingLayout: [{ name: "lumaSplat", group: 0 }],
} as const satisfies ShaderModule;

/**
 * Draws luma's ordered ProjectedSplat records (gpu-splat-graph-shaders.ts: clipCenter vec4, the
 * two screen half-axes in px (already × the support radius), colour (sRGB rgb, final alpha)),
 * one instance per record in painter order, into the reversed-Z premultiplied colour pass.
 */
export const lumaSplatsWGSL = /* wgsl */ `\
${colorWGSL}
struct ProjectedSplat {
  clipCenter: vec4<f32>,
  axis0: vec2<f32>,
  axis1: vec2<f32>,
  color: vec4<f32>,
};
@group(0) @binding(auto) var<storage, read> projectedRecords: array<ProjectedSplat>;

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) coord: vec2<f32>,
  @location(1) @interpolate(flat) color: vec4<f32>,
};

@vertex fn vertexMain(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> Varyings {
  var corners = array<vec2<f32>, 4>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0)
  );
  let corner = corners[vid];
  let p = projectedRecords[iid];
  let px = corner.x * p.axis0 + corner.y * p.axis1;
  // luma's screen axes are y-down pixels
  let clipOffset = vec2<f32>(px.x * 2.0 / max(lumaSplat.viewport.x, 1.0),
                             -px.y * 2.0 / max(lumaSplat.viewport.y, 1.0)) * p.clipCenter.w;
  var v: Varyings;
  // reversed-Z: clip.z = near, clip.w = the centre's view depth (constant over the quad)
  v.position = vec4<f32>(p.clipCenter.xy + clipOffset, lumaSplat.near, p.clipCenter.w);
  v.coord = corner * lumaSplat.support;
  v.color = p.color;
  return v;
}

@fragment fn fragmentMain(v: Varyings) -> @location(0) vec4<f32> {
  let alpha = v.color.a * exp(-0.5 * dot(v.coord, v.coord));
  if (alpha < lumaSplat.alphaCutoff) { discard; }
  // premultiplied, linear (the colour target); blend one / one-minus-src-alpha
  return vec4<f32>(srgb_decode(v.color.rgb) * alpha, alpha);
}
`;

/**
 * The GL-convention clip matrix luma's projection gets: rows x, y, w of camera.viewProj (which
 * acts on world − eye), z row mapping view depth [near, far] to [−1, 1], composed with the
 * translation by −eye so it acts on world (ENU) positions. Column-major.
 */
export function lumaClipMatrix(
	camera: CameraUniforms,
	near: number,
	far: number,
): number[] {
	const M = camera.viewProj;
	const a = (far + near) / (far - near);
	const b = (-2 * far * near) / (far - near);
	const out = new Array<number>(16).fill(0);
	for (let c = 0; c < 3; c++) {
		out[4 * c] = M[4 * c];
		out[4 * c + 1] = M[4 * c + 1];
		out[4 * c + 2] = a * M[4 * c + 3];
		out[4 * c + 3] = M[4 * c + 3];
	}
	// translation column: Mrel · (−eye, 1); Mrel's own column 3 is (0, 0, b, 0) here
	const e = camera.eye;
	for (let r = 0; r < 4; r++)
		out[12 + r] =
			(r === 2 ? b : 0) -
			(out[r] * e[0] + out[4 + r] * e[1] + out[8 + r] * e[2]);
	return out;
}

/** View-depth span [near, far] of a bounding sphere seen from the camera (clamped to NEAR_W). */
export function depthSpan(
	camera: CameraUniforms,
	center: readonly number[],
	radius: number,
): [number, number] {
	const f = camera.forward;
	const e = camera.eye;
	const d =
		f[0] * (center[0] - e[0]) +
		f[1] * (center[1] - e[1]) +
		f[2] * (center[2] - e[2]);
	const near = Math.max(NEAR_W, d - radius);
	const far = Math.max(near * 2, d + radius);
	return [near, far];
}

/** One cloud on luma's splat stack (owned by SplatsCore). Throws if the stack cannot be built. */
export class LumaSplats {
	readonly lod: SplatLod;
	readonly stats: LumaSplatsStats;
	/** True while the progressive selection has more rows to walk (ask the host for a frame). */
	pending = false;

	private readonly datas: GPUSplatData[];
	private readonly hierarchy: SplatRADHierarchyManager;
	private readonly renderer: GPUPagedSplatRenderer;
	private readonly models = new ModelCache();
	private readonly baseColors: Uint8Array;
	private readonly center: [number, number, number];
	private readonly radius: number;
	private frontier: readonly SplatRADHierarchyFrontierEntry[] | null = null;
	private frontierRows: Uint32Array[] = [];
	/** The camera of the last selectView (eye, forward, viewport, tan half fov). */
	private selectedFor: {
		eye: number[];
		forward: number[];
		viewport: number[];
		tanHalfY: number;
	} | null = null;
	private truth = false;
	private options: LumaSplatsOptions;
	private destroyed = false;

	constructor(
		readonly device: Device,
		readonly cloud: GaussianCloud,
		options: LumaSplatsOptions,
		readonly id = "splats-luma",
	) {
		const t0 = performance.now();
		this.lod = buildSplatLod(cloud);
		const buildMs = performance.now() - t0;
		const lod = this.lod;
		// alpha lives in `opacities` (luma multiplies colour alpha × opacity): colour alpha = 255
		this.baseColors = opaqueAlpha(lod.colors);
		[this.center, this.radius] = boundingSphere(lod);
		this.options = options;
		this.datas = [];
		try {
			for (const [index, page] of lod.pages.entries()) {
				const a = page.rowStart;
				const b = a + page.rowCount;
				this.datas.push(
					new GPUSplatData(device, {
						positions: lod.positions.subarray(3 * a, 3 * b),
						scales: lod.scales.subarray(3 * a, 3 * b),
						rotations: lod.rotations.subarray(4 * a, 4 * b),
						// a copy: GPUSplatData.update writes new colours into its retained source
						colors: this.baseColors.slice(4 * a, 4 * b),
						opacities: lod.opacities.subarray(a, b),
						sourceBatchIndex: index,
						rowIndexBase: a,
					}),
				);
			}
			this.hierarchy = new SplatRADHierarchyManager({
				pages: lod.pages.map((page, index) => ({
					id: `${id}-page-${index}`,
					data: this.datas[index],
					childCounts: lod.childCounts.subarray(
						page.rowStart,
						page.rowStart + page.rowCount,
					),
					childStarts: lod.childStarts.subarray(
						page.rowStart,
						page.rowStart + page.rowCount,
					),
				})),
				pageSize: lod.pages[0]?.rowCount ?? 1,
				maximumScreenSpaceError: MAX_SCREEN_ERROR,
				maximumActiveRows: MAX_ACTIVE_ROWS,
			});
			this.renderer = new GPUPagedSplatRenderer(device, {
				sphericalHarmonicsDegree: 0,
				alphaCutoff: 1 / 255,
				...rendererProps(options),
			});
		} catch (e) {
			for (const d of this.datas) d.destroy();
			throw e;
		}
		this.stats = {
			rows: lod.rowCount,
			leaves: lod.leafCount,
			pages: lod.pages.length,
			activeRows: 0,
			fallbackRows: 0,
			version: 0,
			selectMs: 0,
			buildMs,
		};
		if (options.truth) this.setTruth(true);
	}

	setOptions(options: LumaSplatsOptions) {
		this.options = options;
		this.renderer.setProps(rendererProps(options));
		if (options.truth !== this.truth) this.setTruth(options.truth);
	}

	/** Bake (or remove) the provenance tints in the uploaded colours. */
	private setTruth(on: boolean) {
		this.truth = on;
		const { lod } = this;
		const colors = on
			? opaqueAlpha(tintedLodColors(lod, this.options.tints))
			: this.baseColors;
		for (const [index, page] of lod.pages.entries())
			this.datas[index].update({
				colors: colors.subarray(
					4 * page.rowStart,
					4 * (page.rowStart + page.rowCount),
				),
			});
	}

	/**
	 * Colour-pass prepass: progressive selection for this camera, then luma's projection / sort /
	 * gather recorded on the frame encoder (no pass open).
	 */
	prepare(
		camera: CameraUniforms,
		commandEncoder: Parameters<GPUPagedSplatRenderer["prepare"]>[0],
	) {
		if (this.destroyed) return;
		const [near, far] = depthSpan(camera, this.center, this.radius);
		const clip = lumaClipMatrix(camera, near, far);
		const t0 = performance.now();
		if (this.viewMoved(camera)) {
			this.selectedFor = {
				eye: [...camera.eye],
				forward: [...camera.forward],
				viewport: [...camera.viewport],
				tanHalfY: camera.tanHalfY,
			};
			this.hierarchy.selectView(
				{
					cameraPosition: camera.eye,
					viewportSize: camera.viewport,
					modelViewProjectionMatrix: clip,
					verticalFieldOfView: 2 * Math.atan(camera.tanHalfY),
				},
				SELECT_ROWS_PER_FRAME,
			);
		} else if (this.hierarchy.hasPendingTraversal)
			this.hierarchy.continueTraversal(SELECT_ROWS_PER_FRAME);
		const frontier = this.hierarchy.frontier;
		this.stats.selectMs = performance.now() - t0;
		this.pending = this.hierarchy.hasPendingTraversal;
		// the manager may publish a new array or update entries in place: compare the row arrays
		const rows = frontier.map((e) => e.activeRows);
		if (
			frontier !== this.frontier ||
			rows.length !== this.frontierRows.length ||
			rows.some((r, i) => r !== this.frontierRows[i])
		) {
			this.frontier = frontier;
			this.frontierRows = rows;
			this.renderer.setFrontier(frontier.map(toPage));
			const s = this.hierarchy.stats;
			this.stats.activeRows = s.activeRowCount;
			this.stats.fallbackRows = s.fallbackRowCount;
		}
		this.renderer.setProps({
			modelViewProjectionMatrix: clip,
			viewportSize: camera.viewport,
			cameraPosition: camera.eye,
		});
		if (this.renderer.prepare(commandEncoder)) this.stats.version++;
	}

	/** Has the camera turned / moved enough since the last selection to select again? */
	private viewMoved(camera: CameraUniforms) {
		const last = this.selectedFor;
		if (!last) return true;
		if (
			last.viewport[0] !== camera.viewport[0] ||
			last.viewport[1] !== camera.viewport[1] ||
			last.tanHalfY !== camera.tanHalfY
		)
			return true;
		const f = camera.forward;
		const cos =
			f[0] * last.forward[0] + f[1] * last.forward[1] + f[2] * last.forward[2];
		if ((Math.acos(Math.min(1, cos)) * 180) / Math.PI > SELECT_TURN_DEG)
			return true;
		const e = camera.eye;
		const moved = Math.hypot(
			e[0] - last.eye[0],
			e[1] - last.eye[1],
			e[2] - last.eye[2],
		);
		const distance = Math.max(
			NEAR_W,
			Math.hypot(
				this.center[0] - e[0],
				this.center[1] - e[1],
				this.center[2] - e[2],
			) - this.radius,
		);
		return moved > SELECT_MOVE_FRACTION * distance;
	}

	/** Draw the prepared ordered segments into the colour pass. */
	draw(renderPass: RenderPass, camera: CameraUniforms) {
		if (this.destroyed || !this.stats.activeRows) return;
		const records = this.renderer.projectedRecordBuffers;
		if (!records.length) return;
		const commands = this.renderer.drawCommands;
		const model = this.model();
		model.shaderInputs.setProps({
			lumaSplat: {
				viewport: camera.viewport,
				near: camera.near,
				support: this.options.sigmas,
				alphaCutoff: 1 / 255,
				pad0: 0,
				pad1: 0,
				pad2: 0,
			},
		} as never);
		for (const [index, buffer] of records.entries()) {
			model.setBindings({ projectedRecords: buffer } as never);
			// record 0 is the global count; segment i draws from record i + 1
			model.setIndirectBuffer(
				commands.buffer,
				(index + 1) * commands.recordByteLength,
			);
			model.draw(renderPass);
		}
	}

	private model() {
		const noDepth = this.options.noDepthTest;
		return this.models.get(
			`color|${noDepth}`,
			() =>
				new Model(this.device, {
					id: `${this.id}-color`,
					source: lumaSplatsWGSL,
					vertexEntryPoint: "vertexMain",
					fragmentEntryPoint: "fragmentMain",
					modules: [lumaSplatModule] as never,
					...passModelProps("color", {
						depth: noDepth ? "none" : "test",
						blend: true,
					}),
					topology: "triangle-strip",
					bufferLayout: [],
					vertexCount: 4,
					isInstanced: true,
					instanceCount: 1,
				} as never),
		);
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.models.destroy();
		this.renderer.destroy();
		this.hierarchy.destroy();
		for (const d of this.datas) d.destroy();
	}
}

function rendererProps(o: LumaSplatsOptions) {
	return {
		alphaScale: o.opacity,
		gaussianSupportRadius: o.sigmas,
		// splats.ts caps the quad radius (sigmas · σ) at maxRadiusPx; luma caps the 1σ axis
		maxScreenSpaceSplatSize: o.maxRadiusPx / Math.max(o.sigmas, 1e-3),
		// splats.ts adds 0.3 px² to the projected covariance; luma adds kernel2DSize²
		kernel2DSize: Math.sqrt(0.3),
	};
}

const toPage = (e: SplatRADHierarchyFrontierEntry): GPUPagedSplatPage => ({
	id: e.id,
	data: e.data,
	activeRows: e.activeRows,
	bounds: e.bounds,
});

function opaqueAlpha(colors: Uint8Array): Uint8Array {
	const out = new Uint8Array(colors);
	for (let i = 3; i < out.length; i += 4) out[i] = 255;
	return out;
}

/** Bounding sphere of the LoD rows (centres ± 3σ of the largest axis). */
function boundingSphere(lod: SplatLod): [[number, number, number], number] {
	const P = lod.positions;
	let minX = Infinity;
	let minY = Infinity;
	let minZ = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let maxZ = -Infinity;
	for (let r = 0; r < lod.rowCount; r++) {
		const x = P[3 * r];
		const y = P[3 * r + 1];
		const z = P[3 * r + 2];
		if (!Number.isFinite(x + y + z)) continue;
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
		if (z < minZ) minZ = z;
		if (z > maxZ) maxZ = z;
	}
	if (!Number.isFinite(minX)) return [[0, 0, 0], 1];
	const c: [number, number, number] = [
		(minX + maxX) / 2,
		(minY + maxY) / 2,
		(minZ + maxZ) / 2,
	];
	let r2 = 0;
	let sigma = 0;
	for (let r = 0; r < lod.rowCount; r++) {
		const dx = P[3 * r] - c[0];
		const dy = P[3 * r + 1] - c[1];
		const dz = P[3 * r + 2] - c[2];
		const d2 = dx * dx + dy * dy + dz * dz;
		if (d2 > r2) r2 = d2;
		const s = Math.max(
			lod.scales[3 * r],
			lod.scales[3 * r + 1],
			lod.scales[3 * r + 2],
		);
		if (s > sigma && lod.leafIndex[r] >= 0) sigma = s;
	}
	return [c, Math.sqrt(r2) + 3 * sigma + 1e-3];
}

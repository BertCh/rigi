// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside (P1b deck parity, reports/step-inside-design.md): a deck.gl 9.4 layer that draws a
// GaussianCloud in DeckEngine's CARTESIAN, camera-anchored ENU metres (deck/photo-view.ts,
// deck/world-view.ts).
//   · instanced quads, EWA covariance projection, premultiplied alpha (deck-splat-shaders.ts)
//   · the terrain's LOGARITHMIC depth convention (deck/terrain-layer.ts LOG_DEPTH_FAR; the terrain
//     writes it per vertex, TERRAIN_DEPTH, the splats exactly per fragment), depthCompare
//     'less-equal', depthWrite off: the log-depth terrain occludes the splats, splats never occlude
//     anything (they are drawn last, back to front)
//   · back-to-front order from ./splat-sort.ts (SplatSorter: a module worker, sync fallback),
//     re-requested when the camera turns / moves by more than `sortEvery`
// Where it draws: the canvas pass by default (the world view / a standalone Deck). With
// pass: "color" it draws only inside the photo view's offscreen colour pass (linear output), like
// TrailLayer; composite.ts then has to include it in its terrain-pass layer filter
// (isDeckSplatLayer) — not wired here (composite.ts belongs to the deck engine).
import {
	COORDINATE_SYSTEM,
	Layer,
	type LayerProps,
	project32,
	type UpdateParameters,
	type Viewport,
} from "@deck.gl/core";
import type { Buffer, Device, Framebuffer, Texture } from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import type { Pose } from "../camera";
import { glOf } from "../deck/gl";
import { drawLayersOffscreen } from "../deck/offscreen-layers";
import { PhotoViewport } from "../deck/photo-view";
import {
	currentTerrainPass,
	LOG_DEPTH_FAR,
	withTerrainPass,
} from "../deck/terrain-layer";
import {
	SPLAT_TEX_PER_ROW,
	type SplatModuleProps,
	splatFs,
	splatModule,
	splatVs,
} from "./deck-splat-shaders";
import { PROVENANCE_COLORS_BY_CODE, PROVENANCE_TINT_MIX } from "./provenance";
import { type DepthRow, type SortResult, SplatSorter } from "./splat-sort";
import type { GaussianCloud } from "./types";

/** How much of the provenance tint replaces the colour with truth on (three-splats.ts: truth=true → 0.65). */
export { PROVENANCE_TINT_MIX };
/**
 * Truth-toggle tints per PROVENANCE_CODE (sRGB 0..1, a = how much of the tint replaces the colour), from
 * the single palette in ./provenance (PROVENANCE_COLORS).
 */
export const PROVENANCE_TINTS: [number, number, number, number][] = [
	0, 1, 2, 3,
].map((code) => {
	const c = PROVENANCE_COLORS_BY_CODE[code] ?? [255, 255, 255];
	return [c[0] / 255, c[1] / 255, c[2] / 255, PROVENANCE_TINT_MIX];
});

export type DeckSplatLayerProps = LayerProps & {
	cloud: GaussianCloud | null;
	/** Splat opacity multiplier 0..1 (fades). Default 1. */
	opacity?: number;
	/** Tint by provenance (the "Truth" toggle). Default false. */
	truth?: boolean;
	/**
	 * Camera delta that triggers a re-sort: the view direction turning by more than this many
	 * degrees, or the eye moving more than this many metres. Default 1. 0 = every frame.
	 */
	sortEvery?: number;
	/** "canvas" (default): the normal draw, sRGB out. "color": photo view offscreen colour pass only. */
	pass?: "canvas" | "color";
	/** Screen-space radius cap per splat, px (keeps a splat at the eye from filling the screen). */
	maxRadiusPx?: number;
	/** Ellipse extent in standard deviations. Default 3. */
	sigmas?: number;
	/** Sort in a worker (default true; false = synchronous, for tests). */
	sortWorker?: boolean;
	/** Test hook: depth test off (splats drawn over everything), to prove occlusion is working. */
	noDepthTest?: boolean;
};

/** Diagnostics for harnesses (globalThis.__rigiSplatStats). */
export const splatStats = {
	sorts: 0,
	lastSortMs: 0,
	drawn: 0,
	worker: false,
};
(globalThis as { __rigiSplatStats?: typeof splatStats }).__rigiSplatStats =
	splatStats;

type State = {
	model?: Model;
	tex?: Texture;
	index?: Buffer;
	sorter?: SplatSorter;
	/** Spare index array for the next sort (transferred to the worker and back). */
	spare?: Uint32Array;
	drawCount: number;
	lastRow?: DepthRow;
	lastEye?: number[];
	/** A sort was skipped while one was in flight: re-request on the next draw. */
	dirty: boolean;
	/** Bumped when a new draw order lands (the photo view's cached colour pass keys on it). */
	sortVersion?: number;
};

/** Pack positions / covariance / colour / provenance into the rgba32float layout the shader reads. */
export function packSplatTexture(cloud: GaussianCloud) {
	const n = cloud.count;
	const rows = Math.max(1, Math.ceil(n / SPLAT_TEX_PER_ROW));
	const width = SPLAT_TEX_PER_ROW * 3;
	const data = new Float32Array(width * rows * 4);
	const { positions: P, scales: S, rotations: Q, colors: C } = cloud;
	const prov = cloud.provenance;
	for (let i = 0; i < n; i++) {
		const o = i * 12;
		data[o] = P[3 * i];
		data[o + 1] = P[3 * i + 1];
		data[o + 2] = P[3 * i + 2];
		data[o + 3] = prov[i] ?? 0;
		// Σ = R diag(s²) Rᵀ, R from the unit quaternion (w, x, y, z)
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
		// M = R · diag(s); Σ = M Mᵀ
		const m00 = r00 * sx;
		const m01 = r01 * sy;
		const m02 = r02 * sz;
		const m10 = r10 * sx;
		const m11 = r11 * sy;
		const m12 = r12 * sz;
		const m20 = r20 * sx;
		const m21 = r21 * sy;
		const m22 = r22 * sz;
		data[o + 4] = m00 * m00 + m01 * m01 + m02 * m02;
		data[o + 5] = m00 * m10 + m01 * m11 + m02 * m12;
		data[o + 6] = m00 * m20 + m01 * m21 + m02 * m22;
		data[o + 7] = m10 * m10 + m11 * m11 + m12 * m12;
		data[o + 8] = m10 * m20 + m11 * m21 + m12 * m22;
		data[o + 9] = m20 * m20 + m21 * m21 + m22 * m22;
		data[o + 10] = C[4 * i] * 256 + C[4 * i + 1];
		data[o + 11] = C[4 * i + 2] * 256 + C[4 * i + 3];
	}
	// splat i sits at texel ((i % PER_ROW) * 3, i / PER_ROW): 12 floats per splat, row-major, so the
	// packed order above is already that layout
	return { data, width, height: rows };
}

/** Row 2 of the (model·)view matrix, in metres: view z = a x + b y + c z + d, camera looks down -z. */
function depthRow(
	view: ArrayLike<number>,
	model: ArrayLike<number> | null | undefined,
): DepthRow {
	// column-major: row 2 = elements 2, 6, 10, 14
	let a = view[2];
	let b = view[6];
	let c = view[10];
	let d = view[14];
	if (model) {
		// (row · M)_j = Σ_k row_k M[k][j]; M column-major: M[k][j] = model[j*4 + k]
		const r = [a, b, c, d];
		const out = [0, 1, 2, 3].map(
			(j) =>
				r[0] * model[j * 4] +
				r[1] * model[j * 4 + 1] +
				r[2] * model[j * 4 + 2] +
				r[3] * model[j * 4 + 3],
		);
		[a, b, c, d] = out;
	}
	// an OrbitView-style view matrix carries a zoom scale: normalise to metres
	const s = Math.hypot(a, b, c) || 1;
	return [a / s, b / s, c / s, d / s];
}

export class DeckSplatLayer extends Layer<DeckSplatLayerProps> {
	static layerName = "DeckSplatLayer";
	declare state: State;

	getShaders() {
		return super.getShaders({
			vs: splatVs,
			fs: splatFs,
			modules: [project32, splatModule],
		});
	}

	initializeState() {
		this.setState({ drawCount: 0, dirty: false });
		this.rebuild();
	}

	updateState({ props, oldProps }: UpdateParameters<this>) {
		if (props.cloud !== oldProps.cloud) this.rebuild();
	}

	private pipelineParameters() {
		return {
			...SPLAT_PARAMETERS,
			depthCompare: this.props.noDepthTest ? "always" : "less-equal",
		} as const;
	}

	private destroyGpu() {
		const s = this.state;
		s.sorter?.dispose();
		s.model?.destroy();
		s.tex?.destroy();
		s.index?.destroy();
	}

	private rebuild() {
		this.destroyGpu();
		const cloud = this.props.cloud;
		if (!cloud || !cloud.count) {
			this.setState({
				model: undefined,
				tex: undefined,
				index: undefined,
				sorter: undefined,
				drawCount: 0,
				lastRow: undefined,
				lastEye: undefined,
			});
			return;
		}
		if (cloud.frame !== "enu")
			console.warn(
				"[deck-splats] cloud is in the camera frame; DeckSplatLayer expects ENU (anchor it first)",
			);
		const device = this.context.device;
		const n = cloud.count;
		const packed = packSplatTexture(cloud);
		const tex = device.createTexture({
			id: `${this.props.id}-data`,
			format: "rgba32float",
			width: packed.width,
			height: packed.height,
			data: packed.data,
			sampler: {
				minFilter: "nearest",
				magFilter: "nearest",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			},
		});
		// identity order until the first sort lands
		const initial = new Float32Array(n);
		for (let i = 0; i < n; i++) initial[i] = i;
		const index = device.createBuffer({ data: initial });
		const model = new Model(device, {
			...this.getShaders(),
			id: this.props.id,
			geometry: new Geometry({
				topology: "triangle-list",
				attributes: {
					positions: {
						size: 2,
						value: new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]),
					},
				},
			}),
			bufferLayout: [
				{ name: "splatIndex", format: "float32", stepMode: "instance" },
			],
			isInstanced: true,
			instanceCount: n,
			parameters: this.pipelineParameters(),
		});
		model.setAttributes({ splatIndex: index });
		const sorter = new SplatSorter(cloud.positions, n, {
			worker: this.props.sortWorker !== false,
		});
		splatStats.worker = sorter.usingWorker;
		this.setState({
			model,
			tex,
			index,
			sorter,
			spare: new Uint32Array(n),
			drawCount: n,
			lastRow: undefined,
			lastEye: undefined,
			dirty: true,
		});
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		super.finalizeState(context);
		this.destroyGpu();
	}

	/** Request a back-to-front sort when the camera has moved / turned enough since the last one. */
	private maybeSort(vp: Viewport) {
		const s = this.state;
		const { sorter, spare } = s;
		if (!sorter || !spare) return;
		const row = depthRow(
			vp.viewMatrix,
			this.props.modelMatrix as ArrayLike<number> | null,
		);
		const eye = vp.cameraPosition;
		const every = this.props.sortEvery ?? 1;
		if (s.lastRow && s.lastEye && !s.dirty) {
			const cos =
				row[0] * s.lastRow[0] + row[1] * s.lastRow[1] + row[2] * s.lastRow[2];
			const turned = (Math.acos(Math.min(1, cos)) * 180) / Math.PI;
			const moved = Math.hypot(
				eye[0] - s.lastEye[0],
				eye[1] - s.lastEye[1],
				eye[2] - s.lastEye[2],
			);
			if (every > 0 && turned <= every && moved <= every) return;
		}
		if (sorter.busy) {
			s.dirty = true;
			return;
		}
		s.lastRow = row;
		s.lastEye = [eye[0], eye[1], eye[2]];
		s.dirty = false;
		s.spare = undefined;
		sorter.sort(row, spare, (r) => this.onSorted(sorter, r));
	}

	private onSorted(sorter: SplatSorter, r: SortResult) {
		const s = this.state;
		// a result for a sorter (cloud) that has since been replaced
		if (!s || s.sorter !== sorter || !s.index) return;
		splatStats.sorts++;
		splatStats.lastSortMs = r.ms;
		const f = new Float32Array(r.count);
		for (let i = 0; i < r.count; i++) f[i] = r.indices[i];
		s.index.write(f);
		s.drawCount = r.count;
		s.spare = r.indices;
		s.sortVersion = (s.sortVersion ?? 0) + 1;
		this.setNeedsRedraw();
	}

	/** Changes whenever what this layer draws may change without a prop change (a new sort order). */
	get drawVersion() {
		return this.state?.sortVersion ?? 0;
	}

	draw(opts?: { shaderModuleProps?: { project?: { viewport?: Viewport } } }) {
		const { model, tex } = this.state;
		const pass = currentTerrainPass();
		const want = this.props.pass === "color" ? "color" : null;
		if (!model || !tex || pass !== want) return;
		// an offscreen pass (composite.ts) draws through its own viewport; context.viewport is the canvas'
		this.maybeSort(
			opts?.shaderModuleProps?.project?.viewport ?? this.context.viewport,
		);
		const count = this.state.drawCount;
		if (!count) return;
		// deck resets instanceCount from getNumInstances() (no `data` here): set it per draw
		model.setInstanceCount(count);
		const t = PROVENANCE_TINTS;
		const props: SplatModuleProps = {
			tint0: t[0],
			tint1: t[1],
			tint2: t[2],
			tint3: t[3],
			opacity: this.props.opacity ?? 1,
			truth: this.props.truth ? 1 : 0,
			logDepthFC: 1 / Math.log2(LOG_DEPTH_FAR + 1),
			linearOut: want === "color" ? 1 : 0,
			maxRadiusPx: this.props.maxRadiusPx ?? 1024,
			nearW: 0.05,
			sigmas: this.props.sigmas ?? 3,
			lowPass: 0.3,
		};
		model.shaderInputs.setProps({ splat: { ...props, splatData: tex } });
		// deck applies the layer's `parameters` prop to its models before draw(): set ours after it
		model.setParameters(this.pipelineParameters());
		splatStats.drawn = count;
		model.draw(this.context.renderPass);
	}
}

const SPLAT_PARAMETERS = {
	cullMode: "none",
	depthWriteEnabled: false,
	depthCompare: "less-equal",
	blend: true,
	// premultiplied alpha, back to front
	blendColorOperation: "add",
	blendColorSrcFactor: "one",
	blendColorDstFactor: "one-minus-src-alpha",
	blendAlphaOperation: "add",
	blendAlphaSrcFactor: "one",
	blendAlphaDstFactor: "one-minus-src-alpha",
} as const;

DeckSplatLayer.defaultProps = {
	coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
	pickable: false,
	parameters: SPLAT_PARAMETERS,
} as never;

export function isDeckSplatLayer(layer: unknown): layer is DeckSplatLayer {
	return layer instanceof DeckSplatLayer;
}

// ---------------- photo view colour pass (composite.ts) ----------------

/** The splat layers keep their own blend / depth parameters (no terrain overrides). */
function splatPassParameters(layer: Layer) {
	return { ...layer.props.parameters };
}

const mergeVs = /* glsl */ `#version 300 es
in vec2 positions;
void main() { gl_Position = vec4(positions, 0.0, 1.0); }
`;

// base: the terrain colour pass as the composite reads it (linear rgb, straight alpha);
// splat: the splats alone, premultiplied "over" from transparent black.
// Out: straight alpha such that the composite's mix(photo, rgb, a) equals the splats over
// (the terrain over the photo): a = Sa + Ta (1 - Sa), rgb = (S.rgb + (1 - Sa) T.rgb Ta) / a.
// Pixels without splat coverage keep the base texel bit for bit.
const mergeFs = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D baseTex;
uniform sampler2D splatTex;
out vec4 fragColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 t = texelFetch(baseTex, p, 0);
  vec4 s = texelFetch(splatTex, p, 0);
  if (s.a <= 0.0) { fragColor = t; return; }
  float a = s.a + t.a * (1.0 - s.a);
  fragColor = vec4((s.rgb + (1.0 - s.a) * t.rgb * t.a) / max(a, 1e-6), a);
}
`;

/**
 * The photo view's splats (DeckSplatLayer, pass "color") over the composite's colour target.
 * That target holds straight alpha (sky = 0) and the composite blends it with
 * mix(photo, rgb, a); premultiplied splats blended straight into it would leave dark fringes
 * wherever a splat covers sky (rgb·a read back as straight rgb). So the splats are drawn alone into
 * a premultiplied buffer, depth-tested against the target's (terrain, log) depth, and merged over a
 * snapshot of the terrain colour into straight alpha (mergeFs).
 * Usage: draw the terrain into `target` (colour + depth), snapshot(target), then draw(...) as often
 * as the splats change; the snapshot keeps the terrain so a splat-only change redraws only splats.
 */
export class SplatColorPass {
	private base?: Framebuffer;
	private splat?: Texture;
	private splatFbo?: WebGLFramebuffer;
	private splatFboKey: [unknown, unknown] = [null, null];
	private merge?: Model;
	constructor(readonly device: Device) {}

	private get gl() {
		return glOf(this.device);
	}

	private tex(id: string, width: number, height: number) {
		return this.device.createTexture({
			id,
			format: "rgba16float",
			width,
			height,
			sampler: {
				minFilter: "nearest",
				magFilter: "nearest",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			},
		});
	}

	/** Copy target's colour (the terrain, straight alpha) into the snapshot the merge reads. */
	snapshot(target: Framebuffer) {
		const { width, height } = target;
		if (this.base?.width !== width || this.base.height !== height) {
			this.destroyBase();
			this.base = this.device.createFramebuffer({
				id: "splat-base",
				width,
				height,
				colorAttachments: [this.tex("splat-base-tex", width, height)],
			});
		}
		const gl = this.gl;
		const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
		const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, handleOf(target));
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, handleOf(this.base));
		gl.blitFramebuffer(
			0,
			0,
			width,
			height,
			0,
			0,
			width,
			height,
			gl.COLOR_BUFFER_BIT,
			gl.NEAREST,
		);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
	}

	/**
	 * The splat layers through `pose` over the snapshot, into target's colour. target's depth must
	 * hold the terrain's log depth (it is only read). No-op without a snapshot of target's size.
	 */
	draw(
		layers: Layer[],
		target: Framebuffer,
		pose: Pose,
		eye: [number, number, number],
	) {
		const base = this.base;
		const depth = target.depthStencilAttachment?.texture;
		if (!base || base.width !== target.width || base.height !== target.height)
			return;
		const { width, height } = target;
		const gl = this.gl;
		if (this.splat?.width !== width || this.splat.height !== height) {
			this.splat?.destroy();
			this.splat = this.tex("splat-premul-tex", width, height);
			this.splatFboKey = [null, null];
		}
		if (this.splatFboKey[0] !== this.splat || this.splatFboKey[1] !== depth) {
			if (this.splatFbo) gl.deleteFramebuffer(this.splatFbo);
			const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
			const fbo = gl.createFramebuffer() as WebGLFramebuffer;
			gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
			gl.framebufferTexture2D(
				gl.FRAMEBUFFER,
				gl.COLOR_ATTACHMENT0,
				gl.TEXTURE_2D,
				handleOf(this.splat),
				0,
			);
			if (depth)
				gl.framebufferTexture2D(
					gl.FRAMEBUFFER,
					gl.DEPTH_ATTACHMENT,
					gl.TEXTURE_2D,
					handleOf(depth),
					0,
				);
			gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
			this.splatFbo = fbo;
			this.splatFboKey = [this.splat, depth];
		}
		// clear the splat colour only: the depth is the terrain's
		const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.splatFbo as WebGLFramebuffer);
		gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
		gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
		const proxy = {
			id: "splat-premul",
			handle: this.splatFbo,
			width,
			height,
			colorAttachments: [{ texture: this.splat }],
			depthStencilAttachment: null,
		} as unknown as Framebuffer;
		const viewport = new PhotoViewport({
			id: "splat-color",
			...pose,
			eye,
			x: 0,
			y: 0,
			width,
			height,
			near: 1,
			far: 400_000,
		});
		withTerrainPass("color", () =>
			drawLayersOffscreen(this.device, {
				layers: layers.filter(isDeckSplatLayer),
				viewport,
				target: proxy,
				pass: "splat-color",
				clearCanvas: false,
				shouldDrawLayer: isDeckSplatLayer,
				getLayerParameters: splatPassParameters,
				shaderModuleProps: { project: { devicePixelRatio: 1 } },
			}),
		);
		this.merge ??= new Model(this.device, {
			id: "splat-merge",
			vs: mergeVs,
			fs: mergeFs,
			geometry: new Geometry({
				topology: "triangle-list",
				attributes: {
					positions: {
						size: 2,
						value: new Float32Array([-1, -1, 3, -1, -1, 3]),
					},
				},
			}),
			bufferLayout: [],
			parameters: {
				depthCompare: "always",
				depthWriteEnabled: false,
				blend: false,
			},
		});
		this.merge.setBindings({
			baseTex: base.colorAttachments[0].texture,
			splatTex: this.splat,
		});
		const rp = this.device.beginRenderPass({
			framebuffer: target,
			clearColor: false,
			clearDepth: false,
			clearStencil: false,
		} as never);
		this.merge.draw(rp);
		rp.end();
	}

	private destroyBase() {
		if (!this.base) return;
		this.base.colorAttachments[0].texture.destroy();
		this.base.destroy();
		this.base = undefined;
	}

	destroy() {
		this.destroyBase();
		if (this.splatFbo) this.gl.deleteFramebuffer(this.splatFbo);
		this.splatFbo = undefined;
		this.splatFboKey = [null, null];
		this.splat?.destroy();
		this.splat = undefined;
		this.merge?.destroy();
		this.merge = undefined;
	}
}

function handleOf(x: unknown) {
	return (x as { handle: unknown }).handle as never;
}

/** What the photo view's splat colour pass depends on besides the camera: instances + sort orders. */
export function splatDrawKey(layers: Layer[]): unknown[] {
	const out: unknown[] = [];
	for (const l of layers) if (isDeckSplatLayer(l)) out.push(l, l.drawVersion);
	return out;
}

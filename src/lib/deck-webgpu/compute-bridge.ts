// Render targets → look compute, on the GPU (no render → CPU → upload round trip).
//
// The look passes of the WebGPU engine used to read their inputs back from the GPU first:
// - LOOK_REFINE masks: the query geometry readback (range grid) + the photo → CPU gather (luma,
//   coverage, people, cut) → upload → guided filters (gpu/look) → read back → CPU RGBA8 packing →
//   the composite uploads that as its mask texture;
// - LOOK_HARMONIZE band stats: an offscreen colour render at ≤ 256 px → readTexture (rgba16float
//   → f32 on the CPU, flipped, un-premultiplied) → CompositeLook.setStats (flipped back, range /
//   people arrays) → upload → band-stats kernel → 6.6 KB back.
// - the fitted haze (HazeController): the range readback ×2-decimated → fitHazeGpu's CPU input build
//   (range, P(sky), people bits, the photo at 2W × 2H) → upload → prep → lists → fit.
// This bridge runs src/lib/gpu/look/textures.ts' texture-in ComputeGraphs (masksTex, bandStatsTex,
// hazePrepTex; mt-image-03) on the render targets themselves:
// - geometry: WebGpuGeometrySource.targets.geometry (rgba32float, xyz + range, 0 = sky, row 0 = top)
//   — the very texture the query readback copies, so the inputs are the same bits;
// - colour: the stats render's ColorTargets.color (rgba16float, linear, premultiplied);
// - photo: rgba8unorm at each pass's grid, made once per (photo, grid) from the SAME canvas
//   resample the CPU path uses (look/composite.ts photoPixels): a static input, not a per-pose
//   upload, and what makes the result bit-identical (the GPU box filter ≠ drawImage);
// - P(sky) / people: r8unorm, uploaded once per mask change.
// The masks land in a bridge-owned rgba8unorm texture (ping-pong, LINEAR_CLAMP sampler) that the
// composite samples directly (CompositeCore.setMaskTexture); stats come back as the 4-band
// ColorStats only (a few uniforms).
//
// Ordering: every graph is its own submit issued right AFTER the submit that rendered its input
// (the geometry source's render(), renderOffscreen's frame), on the same queue, so it sees the
// finished target; results are read only after that submit (graph.run). The host's per-frame
// targets are never read (a later frame could rewrite them before a queued graph runs).
//
// Gate (createLookBridge): lookGpuOn() (the existing ?lookgpu switch), the device has
// float32-filterable, and getComputeDevice() === the render device (adoptRenderDevice). Anything
// else (sidecar device, ?gpu=off, CPU geometry source) keeps the readback path. Select it per
// engine with WebGpuEngineOptions.lookBridge (default true) or engine.setLookBridge(on).
//
// Haze (fitHaze): gpu/look/haze-graph.ts prepAndFitHazeTex = hazePrepTex on the geometry target +
// fitHazeFromPrep, under ONE haze lease (no other prep can overwrite the prep's buffers in between).
// The CPU keeps only what the fit's f64 tail needs: the ×2 range grid HazeController already builds
// from the query readback (which stays, for labels / queries) for the representative pixels' ENU
// points; nothing is read back from a render target and nothing is uploaded per pose. The engine
// guards the pairing (geometry target ↔ that range readback) with WebGpuGeometrySource.renderSeq:
// re-rendered while the call was queued → null → HazeController's readback path. Bit-identical to
// fitHazeGpu (bridge-check.mjs: whole fit + final image). Engine option hazeBridge (default true).
//
// Relief (reliefField): the readback path was ReliefController → gpu/look/hooks.ts →
// buildReliefFieldGpu (relief graph on the compute device) → read node (2 × 4 MB) → CPU
// ReliefField → TerrainStyles.setReliefField → writeData into two new rgba8unorm textures. On the
// render device the same graph (gpu/look/relief-graph.ts reliefGraphToTextures, out = "texture")
// ends in a copyBufferToTexture of its packed field / gen transients into two fresh rgba8unorm
// textures made here with setReliefField's descriptor (+ COPY_SRC for the lazy CPU copy). Same
// heights (reliefHeights), same uniform block (reliefWords), same kernels; PACK's u32 per texel is
// the RGBA8 texel byte for byte and both paths use tightly packed rows (res·4 = 4096 B, 256-aligned)
// with row 0 = south, so the textures hold exactly the bytes the readback path uploads (no format
// conversion exists on either path). Ordering: one submit on the render queue; every later frame
// samples the finished textures. The result is a ResidentReliefField whose textures pass to
// TerrainStyles (it owns and destroys them on replace); its read() is the lazy CPU copy (only the
// lookSmoke / hookParity diagnostics read the WebGPU engine's field bytes). The engine passes it as
// ReliefController.update's `bridged` while the bridge is attached (same gate); a rejection or
// null (bridge destroyed in flight) falls back to the readback path, and the CPU twin stays the
// lookgpu-off path.
import type { Device, Texture } from "@luma.gl/core";
import { getComputeDevice } from "#/lib/gpu/device";
import { prepAndFitHazeTex } from "#/lib/gpu/look/haze-graph";
import { lookGpuOn, trackLook } from "#/lib/gpu/look/opt-in";
import { reliefHeights, reliefWords } from "#/lib/gpu/look/relief";
import { reliefGraphToTextures } from "#/lib/gpu/look/relief-graph";
import {
	bandStatsTex,
	type HazePrepResult,
	hazePrepTex,
	masksTex,
	releaseTextureGraphs,
} from "#/lib/gpu/look/textures";
import type { Vec3 } from "#/lib/look/atmosphere";
import type { ColorStats } from "#/lib/look/color-stats";
import {
	type Cut,
	gridSize,
	MASK_LONG_SIDE,
	type Mask8,
	photoPixels,
	type RangeGrid,
} from "#/lib/look/composite";
import type { HazeFit, HazeGeo } from "#/lib/look/haze-fit";
import type {
	BridgedRelief,
	ReliefField,
	ResidentReliefField,
} from "#/lib/look/relief/field";
import type { ViewStyle } from "#/lib/style/types";
import { USAGE } from "./targets";

const LINEAR_CLAMP = {
	minFilter: "linear",
	magFilter: "linear",
	addressModeU: "clamp-to-edge",
	addressModeV: "clamp-to-edge",
} as const;

/** The refined masks on the GPU: CompositeLook.masks without the bytes. */
export type BridgedMasks = {
	w: number;
	h: number;
	gen: number;
	cut: string;
	/** rgba8unorm (r coverage, g cut, b people, a 255), row 0 = top; bridge-owned, sample only */
	texture: Texture;
};

/** Per-pass timings (ms) of the last runs, for the bench / BRIDGE.md. */
export type BridgeTiming = {
	/** main-thread time of the call (input build + encode + submit) */
	cpuMs: number;
	/** call → result usable (GPU done, promise resolved) */
	totalMs: number;
};

/** Why the bridge is off, or null when it may run on `device`. */
export async function lookBridgeGate(device: Device): Promise<string | null> {
	if (!lookGpuOn()) return "lookgpu off (or ?gpu=off / no WebGPU)";
	if (device.type !== "webgpu") return "not a WebGPU device";
	if (!device.features.has("float32-filterable" as never))
		return "no float32-filterable";
	const d = await getComputeDevice().catch(() => null);
	if (d !== device) return "compute device is not the render device";
	return null;
}

/** A LookBridge for the render device, or null (with the reason in `onOff`) when gated off. */
export async function createLookBridge(
	device: Device,
	onOff?: (reason: string) => void,
): Promise<LookBridge | null> {
	const why = await lookBridgeGate(device);
	if (why) {
		onOff?.(why);
		return null;
	}
	return new LookBridge(device);
}

export class LookBridge {
	readonly device: Device;
	/** The latest refined masks (null until the first masks pass lands). */
	masks: BridgedMasks | null = null;
	/** The latest band stats (null until the first stats pass lands). */
	stats: ColorStats | null = null;
	/** Bumps whenever masks / stats change. */
	version = 0;
	/** A pass landed (the engine re-applies the look). */
	onAsync?: () => void;
	readonly timing: {
		masks: BridgeTiming[];
		stats: BridgeTiming[];
		haze: BridgeTiming[];
		relief: BridgeTiming[];
	} = {
		masks: [],
		stats: [],
		haze: [],
		relief: [],
	};
	private maskIn: unknown[] = [];
	private statsKey = "";
	private maskSeq = 0;
	private statsSeq = 0;
	private flip = 0;
	private outs: (Texture | null)[] = [null, null];
	private photos = new Map<string, { img: HTMLImageElement; tex: Texture }>();
	private byteMasks = new Map<string, { src: Mask8; tex: Texture }>();
	private destroyed = false;

	constructor(device: Device) {
		this.device = device;
	}

	/** Forget the inputs (the next update / stats call runs again). */
	reset() {
		this.maskIn = [];
		this.statsKey = "";
		this.maskSeq++;
		this.statsSeq++;
	}

	/**
	 * CompositeLook.updateMasks on the geometry TEXTURE (same gating, grid, radii, ε, packing).
	 * Returns true when a masks pass was started; `masks` / onAsync follow when it lands.
	 * `range` is only read for the blend cut (the CPU closure CompositeLook samples too).
	 */
	updateMasks(o: {
		style: ViewStyle;
		gen: number;
		img?: HTMLImageElement;
		fg: Mask8 | null;
		sky: Mask8 | null;
		cut: Cut | null;
		geometry: Texture;
		range: () => RangeGrid;
	}): boolean {
		const c = o.style.composite;
		if (this.destroyed || !c.refine || !o.img) return false;
		const sky = c.sky === "photo" ? o.sky : null;
		const input = [o.gen, o.img, o.fg, sky, o.cut?.key];
		if (input.every((v, i) => v === this.maskIn[i])) return false;
		this.maskIn = input;
		const t0 = performance.now();
		const geo = o.geometry;
		const [w, h] = gridSize(geo.width / geo.height, MASK_LONG_SIDE);
		let cut: Float32Array | null = null;
		if (o.cut) {
			// CompositeLook's cut plane, sample for sample (range: the query buffer the CPU also reads)
			const g = o.range();
			cut = new Float32Array(w * h);
			for (let y = 0; y < h; y++)
				for (let x = 0; x < w; x++) {
					const u = (x + 0.5) / w;
					const v = (y + 0.5) / h;
					cut[y * w + x] = o.cut.at(
						u,
						v,
						g.at(
							Math.min(g.w - 1, Math.floor(u * g.w)),
							Math.min(g.h - 1, Math.floor(v * g.h)),
						),
					);
				}
		}
		const seq = ++this.maskSeq;
		const slot = this.flip ^ 1;
		const target = this.outTexture(slot, w, h);
		const gen = o.gen;
		const cutKey = o.cut?.key ?? "";
		const run = masksTex(
			this.device,
			{
				geometry: geo,
				photo: this.photoTexture(o.img, w, h),
				sky: sky ? this.byteMask("sky", sky) : null,
				fg: o.fg ? this.byteMask("fg", o.fg) : null,
				cut,
				size: [w, h],
			},
			{ texture: target },
		);
		const cpuMs = performance.now() - t0;
		trackLook(
			run
				.then(() => {
					if (seq !== this.maskSeq || this.destroyed) return;
					this.flip = slot;
					this.masks = { w, h, gen, cut: cutKey, texture: target };
					this.version++;
					push(this.timing.masks, {
						cpuMs,
						totalMs: performance.now() - t0,
					});
					this.onAsync?.();
				})
				.catch((e) => console.warn("[look-bridge] masks failed", e)),
		);
		return true;
	}

	/** CompositeLook.wantsStats with the bridge's own key. */
	wantsStats(amount: number, key: string) {
		return amount > 0 && key !== this.statsKey;
	}

	/**
	 * CompositeLook.setStats on the stats layer TEXTURE (linear premultiplied, row 0 = top) and the
	 * geometry texture. Call right after the submit that rendered `layer`; `layer` must stay alive
	 * until the promise resolves. Resolves the stats (also stored, onAsync fired) or null.
	 */
	async setStats(o: {
		key: string;
		img: HTMLImageElement;
		layer: Texture;
		geometry: Texture;
		fg: Mask8 | null;
		minRange: number;
		/** the stats call started (engine: the offscreen render began) */
		t0?: number;
	}): Promise<ColorStats | null> {
		if (this.destroyed) return null;
		const t0 = o.t0 ?? performance.now();
		const seq = ++this.statsSeq;
		this.statsKey = o.key;
		const { width: w, height: h } = o.layer;
		const run = bandStatsTex(this.device, {
			geometry: o.geometry,
			layer: o.layer,
			photo: this.photoTexture(o.img, w, h),
			fg: o.fg ? this.byteMask("fg", o.fg) : null,
			minRange: o.minRange,
		});
		const cpuMs = performance.now() - t0;
		const r = await trackLook(run);
		if (seq !== this.statsSeq || this.destroyed || !r.stats) return null;
		this.stats = r.stats;
		this.version++;
		push(this.timing.stats, { cpuMs, totalMs: performance.now() - t0 });
		this.onAsync?.();
		return r.stats;
	}

	/** fitHazeGpu's GPU prep on the geometry texture (HazeController's ×2 decimation). */
	hazePrep(o: {
		img: HTMLImageElement;
		geometry: Texture;
		sky: Mask8 | null;
		fg: Mask8 | null;
		read?: boolean;
	}): Promise<HazePrepResult> {
		const W = Math.floor(o.geometry.width / 2);
		const H = Math.floor(o.geometry.height / 2);
		return hazePrepTex(
			this.device,
			{
				geometry: o.geometry,
				photo: this.photoTexture(o.img, W * 2, H * 2),
				sky: o.sky ? this.byteMask("sky", o.sky) : null,
				fg: o.fg ? this.byteMask("fg", o.fg) : null,
				step: 2,
			},
			{ read: o.read },
		);
	}

	/**
	 * HazeController's fit (fitHazeGpu, bit for bit) on the geometry TEXTURE: prep + fit under one
	 * haze lease (haze-graph.ts prepAndFitHazeTex). `geo` is HazeController's ×2 grid (row 0 =
	 * bottom; its points only). `valid` is re-checked just before the prep's submit: false (the
	 * geometry target no longer holds the render `geo` was read from) resolves null, as does a
	 * destroyed bridge, so the caller can take the readback path.
	 */
	async fitHaze(o: {
		img: HTMLImageElement;
		geometry: Texture;
		sky: Mask8 | null;
		fg: Mask8 | null;
		geo: HazeGeo;
		eyeAlt: number;
		sunDir: Vec3;
		valid?: () => boolean;
	}): Promise<HazeFit | null> {
		if (this.destroyed) return null;
		const t0 = performance.now();
		const W = Math.floor(o.geometry.width / 2);
		const H = Math.floor(o.geometry.height / 2);
		const run = prepAndFitHazeTex(
			this.device,
			{
				geometry: o.geometry,
				photo: this.photoTexture(o.img, W * 2, H * 2),
				sky: o.sky ? this.byteMask("sky", o.sky) : null,
				fg: o.fg ? this.byteMask("fg", o.fg) : null,
				step: 2,
			},
			{ geo: o.geo, eyeAlt: o.eyeAlt, sunDir: o.sunDir },
			{ valid: () => !this.destroyed && (o.valid?.() ?? true) },
		);
		const cpuMs = performance.now() - t0;
		const fit = await trackLook(run);
		// graph.run's lease hop sits between the pre-submit valid() and the submit, so a render can
		// slip in there: re-check after the fit (a false negative only costs one readback fallback).
		if (o.valid && !o.valid()) return null;
		if (fit) push(this.timing.haze, { cpuMs, totalMs: performance.now() - t0 });
		return this.destroyed ? null : fit;
	}

	/** reliefField as ReliefController.update's `bridged`. */
	readonly relief: BridgedRelief = (o) => this.reliefField(o);

	/**
	 * buildReliefFieldGpu on this (render) device, straight into two new rgba8unorm textures (see the
	 * header). Resolves once the graph is submitted, or null when the bridge was destroyed meanwhile
	 * (the caller takes the readback path). The caller owns the result (setReliefField / dispose).
	 */
	async reliefField(
		o: Parameters<BridgedRelief>[0],
	): Promise<ResidentReliefField | null> {
		if (this.destroyed) return null;
		const t0 = performance.now();
		const { res, extent, px, H } = reliefHeights(o.tiles, o.frame, o.yawDeg);
		const { words, degenerate } = reliefWords(res, px, o.sunDir);
		const tex = (id: string) =>
			this.device.createTexture({
				id,
				format: "rgba8unorm",
				width: res,
				height: res,
				usage: USAGE.SAMPLE | USAGE.COPY_DST | USAGE.COPY_SRC,
				sampler: LINEAR_CLAMP,
			});
		const textures = { field: tex("relief-field"), gen: tex("relief-gen") };
		const dispose = () => {
			textures.field.destroy();
			textures.gen.destroy();
		};
		const cpuMs = performance.now() - t0;
		try {
			await reliefGraphToTextures(
				this.device,
				H,
				res,
				words,
				degenerate,
				textures,
			);
		} catch (e) {
			dispose();
			throw e;
		}
		if (this.destroyed) {
			dispose();
			return null;
		}
		const ms = performance.now() - t0;
		push(this.timing.relief, { cpuMs, totalMs: ms });
		const device = this.device;
		let bytes: Promise<ReliefField> | null = null;
		return {
			res,
			extent,
			textures,
			ms,
			read: () =>
				(bytes ??= (async () => {
					if (textures.field.destroyed || textures.gen.destroyed)
						throw new Error("relief textures destroyed");
					const [field, gen] = await Promise.all([
						readRgba8(device, textures.field),
						readRgba8(device, textures.gen),
					]);
					return { res, extent, field, gen, ms };
				})()),
			dispose,
		};
	}

	/** The photo at w × h as rgba8unorm: photoPixels' bytes (the CPU path's resample), cached. */
	photoTexture(img: HTMLImageElement, w: number, h: number): Texture {
		const key = `${w}x${h}`;
		const c = this.photos.get(key);
		if (c?.img === img && !c.tex.destroyed) return c.tex;
		c?.tex.destroy();
		const tex = this.device.createTexture({
			id: `look-bridge-photo-${key}`,
			format: "rgba8unorm",
			width: w,
			height: h,
			usage: USAGE.SAMPLE | USAGE.COPY_DST,
		});
		tex.writeData(photoPixels(img, w, h).data as never, {
			width: w,
			height: h,
			bytesPerRow: w * 4,
		});
		this.photos.set(key, { img, tex });
		return tex;
	}

	/** A byte mask as r8unorm (re-uploaded only when the mask object changes). */
	private byteMask(name: string, m: Mask8): Texture {
		const c = this.byteMasks.get(name);
		if (c?.src === m && !c.tex.destroyed) return c.tex;
		c?.tex.destroy();
		const tex = this.device.createTexture({
			id: `look-bridge-${name}`,
			format: "r8unorm",
			width: m.width,
			height: m.height,
			usage: USAGE.SAMPLE | USAGE.COPY_DST,
		});
		// r8 rows need no padding for writeData (the queue path takes any bytesPerRow)
		tex.writeData(m.data as never, {
			width: m.width,
			height: m.height,
			bytesPerRow: m.width,
		});
		this.byteMasks.set(name, { src: m, tex });
		return tex;
	}

	/** One of the two mask outputs at w × h (the other may be on screen). */
	private outTexture(i: number, w: number, h: number): Texture {
		const t = this.outs[i];
		if (t && t.width === w && t.height === h && !t.destroyed) return t;
		// WebGPU defers the destroy until the submitted work using it completes
		t?.destroy();
		const n = this.device.createTexture({
			id: `look-bridge-masks-${i}:${w}x${h}`,
			format: "rgba8unorm",
			width: w,
			height: h,
			usage: USAGE.SAMPLE | USAGE.COPY_DST | USAGE.COPY_SRC,
			sampler: LINEAR_CLAMP,
		});
		this.outs[i] = n;
		return n;
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.maskSeq++;
		this.statsSeq++;
		this.masks = null;
		this.stats = null;
		const textures = [
			...this.outs,
			...[...this.photos.values()].map((p) => p.tex),
			...[...this.byteMasks.values()].map((m) => m.tex),
		];
		this.outs = [null, null];
		this.photos.clear();
		this.byteMasks.clear();
		for (const t of textures) t?.destroy();
		if (!this.device.isLost)
			void releaseTextureGraphs(this.device).catch(() => {});
	}
}

/** A whole rgba8unorm texture (COPY_SRC), rows top-first (row 0 = texel row 0), tightly packed. */
export async function readRgba8(
	device: Device,
	tex: Texture,
): Promise<Uint8Array> {
	const layout = tex.computeMemoryLayout();
	const buf = device.createBuffer({
		id: "look-bridge-read",
		byteLength: layout.byteLength,
		usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
	});
	try {
		tex.readBuffer({}, buf);
		const data = await buf.readAsync(0, layout.byteLength);
		const row = tex.width * 4;
		const out = new Uint8Array(row * tex.height);
		for (let y = 0; y < tex.height; y++)
			out.set(
				data.subarray(y * layout.bytesPerRow, y * layout.bytesPerRow + row),
				y * row,
			);
		return out;
	} finally {
		buf.destroy();
	}
}

function push(a: BridgeTiming[], t: BridgeTiming) {
	a.push(t);
	if (a.length > 32) a.shift();
}

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

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
// - photo: rgba8unorm at each pass's grid, resampled ON THE GPU from the engine's resident photo
//   texture (setPhotoSource; gpu/look/photo-resample.ts: box filter over sRGB-encoded bytes, one
//   submit per (source, grid), re-run per call for the live video texture). Parity with the CPU
//   path is tolerance level, no longer bit-identical: photoPixels' canvas drawImage resample is not
//   reproduced (scripts/gpu/look-photo-resample-dawn.ts measures the gap against a CPU box
//   filter). With no source texture set, or while the resample kernel is still compiling, the grid
//   is uploaded from photoPixels as before (the CPU reference; also compute-bridge.check.ts);
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
// Fewer settle submits (WAG W1.2; engine option settleFusion, default on): two passes are instead
// recorded on their own command encoder right after the render that produced their input, and
// core submitWithDefault submits that render's buffer and theirs in ONE queue.submit, render first
// (the same compiled graphs, so the same bytes). A throw while recording drops only the fused
// encoder: the render submits alone and the pass runs separately, as before.
// - masks: prepareMasks() runs inside the query geometry render (WebGpuGeometrySource's
//   encodeAfterDraw hook; query sources only, i.e. wider than 512 px: the 384 px silhouette
//   sources get no fusion) and writes a spare mask texture. The query render stays its own
//   1024 px pass with its 90 ms debounce and GeometryGenerations / renderSeq pairing; nothing about
//   when it runs changes. Once submitted, updateMasks() ADOPTS that texture instead of running a
//   pass when its inputs are the prepared ones: the same geometry texture still holding the same
//   render (renderSeq), the same photo, P(sky) and people masks, and no blend cut (the cut plane is
//   sampled from the CPU range readback, which a draw-time encode does not have). Anything else
//   runs the pass as before.
// - band stats: encodeStats() records bandStatsTex (with its 256 B readback staged) for the stats
//   layer render: render + stats are one submit instead of two. The stats keep their own render,
//   timer and key (they wait for the haze fit's CPU range through layerGen); the key is taken only
//   once the submit went through, so a dropped one is retried.
// With fusion on, mask outputs are a small pool of textures: the one shown, the prepared one, and
// any a queued masks pass still writes are never handed out for another write. With it off
// (fusionOn), the masks pass uses the original two-texture ping-pong unchanged.
//
// Gate (createLookBridge): lookGpuOn() (?gpu=off and WebGPU present), the device has
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
// ?gpu=off path.
import { type CommandEncoder, type Device, Texture } from "@luma.gl/core";
import { getComputeDevice } from "#/lib/gpu/device";
import { prepAndFitHazeTex } from "#/lib/gpu/look/haze-graph";
import { lookGpuOn, trackLook } from "#/lib/gpu/look/opt-in";
import {
	resamplePhotoInto,
	warmPhotoResampleAsync,
} from "#/lib/gpu/look/photo-resample";
import { reliefHeights, reliefWords } from "#/lib/gpu/look/relief";
import { reliefGraphToTextures } from "#/lib/gpu/look/relief-graph";
import {
	type HeightResidency,
	planReliefHeights,
	reliefGraphToTexturesGpuHeights,
} from "#/lib/gpu/look/relief-heights";
import {
	bandStatsTex,
	encodeBandStatsTex,
	encodeMasksTex,
	type HazePrepResult,
	hazePrepTex,
	masksTex,
	releaseTextureGraphs,
	warmTextureKernelsAsync,
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
import type { FusedWork } from "./layers/geometry-source";
import { readTextureBytes } from "./readback";

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

/** Mask output textures at most (shown + prepared + queued writes; see pickOut). */
const MAX_MASK_OUTS = 4;

/** A masks pass recorded into a query geometry render (prepareMasks), not yet adopted. */
type PreparedMasks = {
	/** WebGpuGeometrySource.renderSeq of the render whose encoder holds it */
	seq: number;
	geometry: Texture;
	img: HTMLImageElement;
	fg: Mask8 | null;
	sky: Mask8 | null;
	w: number;
	h: number;
	slot: number;
	texture: Texture;
	cpuMs: number;
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
	if (!lookGpuOn()) return "look GPU off (?gpu=off or no WebGPU)";
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
	/** Settle fusion on (the engine's settleFusion option; read per call). Off: no prepared masks,
	 * nothing adopted, and the separate masks pass uses the old two-texture ping-pong. */
	fusionOn: () => boolean = () => true;
	/**
	 * The batched terrain's resident DEM tiles. Set: the relief field's height raster is gathered
	 * in WGSL from them (relief-heights.ts) whenever every tile in range is resident, else the CPU
	 * raster (reliefHeights) is used for that build. Null: always the CPU raster.
	 */
	heightSource: (() => HeightResidency) | null = null;
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
	/** mask output textures; `shown` is the one `masks` holds (-1 = none) */
	private outs: (Texture | null)[] = [];
	/** queued / in-flight masks passes writing each output texture */
	private writing: number[] = [];
	private shown = -1;
	private prepared: PreparedMasks | null = null;
	/** masks passes recorded into a geometry render / adopted (settle-submit counters) */
	readonly fused = { masksPrepared: 0, masksAdopted: 0, statsEncoded: 0 };
	private photos = new Map<
		string,
		{ img: HTMLImageElement; tex: Texture; gpu: Texture | null }
	>();
	/** the engine's resident photo texture (the GPU resample's source) and whether it is live video */
	private photoSource: Texture | null = null;
	private photoLive = false;
	private byteMasks = new Map<string, { src: Mask8; tex: Texture }>();
	private destroyed = false;

	constructor(device: Device) {
		this.device = device;
		// build the texture-look pipelines off the main thread, so the first fused encode compiles cheaply
		Promise.resolve(device)
			.then(warmTextureKernelsAsync)
			.catch(() => {});
		Promise.resolve(device)
			.then(warmPhotoResampleAsync)
			.catch(() => {});
	}

	/** Forget the inputs (the next update / stats call runs again). */
	reset() {
		this.maskIn = [];
		this.prepared = null;
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
		/** WebGpuGeometrySource.renderSeq: the render `geometry` holds now (adopts a prepared pass) */
		geometrySeq?: number;
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
		const p = this.prepared;
		if (!this.fusionOn()) this.prepared = null;
		else if (
			p &&
			!o.cut &&
			o.geometrySeq !== undefined &&
			p.seq === o.geometrySeq &&
			p.geometry === geo &&
			p.img === o.img &&
			p.fg === o.fg &&
			p.sky === sky &&
			p.w === w &&
			p.h === h &&
			!p.texture.destroyed
		) {
			// the pass this call would run is already on the queue (recorded into that render's
			// encoder, same graph, same input bytes): take its texture, submit nothing
			this.prepared = null;
			this.maskSeq++;
			this.shown = p.slot;
			this.masks = { w, h, gen: o.gen, cut: "", texture: p.texture };
			this.version++;
			this.fused.masksAdopted++;
			push(this.timing.masks, { cpuMs: p.cpuMs, totalMs: p.cpuMs });
			// the engine is applying the look right now; notify as a landed pass would
			queueMicrotask(() => {
				if (!this.destroyed && this.masks?.texture === p.texture)
					this.onAsync?.();
			});
			return true;
		}
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
		// settleFusion off: the two-texture ping-pong exactly as before (flip = the last landed slot)
		const slot = this.fusionOn()
			? this.pickOut(false)
			: this.shown === 1
				? 0
				: 1;
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
		// queued: a prepared write must not take this texture until the pass is done (pickOut)
		this.writing[slot] = (this.writing[slot] ?? 0) + 1;
		const cpuMs = performance.now() - t0;
		trackLook(
			run
				.then(() => {
					if (seq !== this.maskSeq || this.destroyed) return;
					this.shown = slot;
					this.masks = { w, h, gen, cut: cutKey, texture: target };
					this.version++;
					push(this.timing.masks, {
						cpuMs,
						totalMs: performance.now() - t0,
					});
					this.onAsync?.();
				})
				.catch((e) => console.warn("[look-bridge] masks failed", e))
				.finally(() => {
					this.writing[slot]--;
				}),
		);
		return true;
	}

	/**
	 * Record the masks pass for a query geometry render into that render's encoder (WAG W1.2; see the
	 * header), before its submit. updateMasks adopts it when its inputs turn out to be these. Called
	 * synchronously from WebGpuGeometrySource's encodeAfterDraw: the caller submits `encoder` right
	 * after. No cut: with a blend cut, updateMasks runs its own pass as before. False = nothing
	 * recorded (gated off, or a check failed before anything was encoded).
	 */
	prepareMasks(o: {
		seq: number;
		style: ViewStyle;
		img?: HTMLImageElement;
		fg: Mask8 | null;
		sky: Mask8 | null;
		geometry: Texture;
		encoder: CommandEncoder;
	}): FusedWork | null {
		this.prepared = null;
		const c = o.style.composite;
		if (this.destroyed || !this.fusionOn() || !c.refine || !o.img) return null;
		const t0 = performance.now();
		const sky = c.sky === "photo" ? o.sky : null;
		const geo = o.geometry;
		const [w, h] = gridSize(geo.width / geo.height, MASK_LONG_SIDE);
		const slot = this.pickOut(true);
		if (slot < 0) return null;
		try {
			const target = this.outTexture(slot, w, h);
			encodeMasksTex(
				this.device,
				o.encoder,
				{
					geometry: geo,
					photo: this.photoTexture(o.img, w, h),
					sky: sky ? this.byteMask("sky", sky) : null,
					fg: o.fg ? this.byteMask("fg", o.fg) : null,
					size: [w, h],
				},
				target,
			);
			const prepared: PreparedMasks = {
				seq: o.seq,
				geometry: geo,
				img: o.img,
				fg: o.fg,
				sky,
				w,
				h,
				slot,
				texture: target,
				cpuMs: performance.now() - t0,
			};
			return {
				// on the queue right after its render: updateMasks may adopt it from now on
				submitted: () => {
					if (this.destroyed) return;
					this.prepared = prepared;
					this.fused.masksPrepared++;
				},
				// never reached the queue: nothing to adopt, updateMasks runs its own pass
				dropped: () => {},
			};
		} catch (e) {
			console.warn("[look-bridge] prepared masks failed, separate pass", e);
			return null;
		}
	}

	/**
	 * An output texture index for a masks write: never the shown one or the prepared one. `idle`
	 * also skips any a queued pass still writes (a prepared write is submitted at once, so a queued
	 * pass submitted later would overwrite it); -1 when none is free. A separate pass may share a
	 * texture with an older queued pass (its later submit wins; maskSeq drops the older result), as
	 * the ping-pong did.
	 */
	private pickOut(idle: boolean): number {
		const reserved = (i: number) =>
			i === this.shown || i === this.prepared?.slot;
		for (let i = 0; i < this.outs.length; i++)
			if (!reserved(i) && !this.writing[i]) return i;
		if (this.outs.length < MAX_MASK_OUTS) return this.outs.length;
		if (idle) return -1;
		for (let i = 0; i < this.outs.length; i++) if (!reserved(i)) return i;
		return -1;
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

	/**
	 * setStats recorded into the encoder of the render that drew `layer` (WAG W1.2; see the header):
	 * record it on its own encoder after that render's passes, submit both together (core
	 * submitWithDefault), then call `after()` once submitted (it resolves as setStats does) or
	 * `cancel()` if it was not. Same graph, parameters and
	 * fold as setStats. Null = nothing recorded (destroyed, or a check failed).
	 */
	encodeStats(o: {
		key: string;
		img: HTMLImageElement;
		layer: Texture;
		geometry: Texture;
		fg: Mask8 | null;
		minRange: number;
		encoder: CommandEncoder;
	}): { after: () => Promise<ColorStats | null>; cancel: () => void } | null {
		if (this.destroyed) return null;
		const t0 = performance.now();
		const { width: w, height: h } = o.layer;
		let staged: ReturnType<typeof encodeBandStatsTex>;
		try {
			staged = encodeBandStatsTex(this.device, o.encoder, {
				geometry: o.geometry,
				layer: o.layer,
				photo: this.photoTexture(o.img, w, h),
				fg: o.fg ? this.byteMask("fg", o.fg) : null,
				minRange: o.minRange,
			});
		} catch (e) {
			console.warn("[look-bridge] encoded band stats failed", e);
			return null;
		}
		const cpuMs = performance.now() - t0;
		return {
			// call only once the render + stats submit went through: the key is taken here, so a
			// dropped / failed submit (cancel) leaves wantsStats true and the stats are retried
			after: async () => {
				const seq = ++this.statsSeq;
				this.statsKey = o.key;
				this.fused.statsEncoded++;
				const r = await trackLook(staged.read());
				if (seq !== this.statsSeq || this.destroyed || !r.stats) return null;
				this.stats = r.stats;
				this.version++;
				push(this.timing.stats, { cpuMs, totalMs: performance.now() - t0 });
				this.onAsync?.();
				return r.stats;
			},
			cancel: () => staged.cancel(),
		};
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
		/** false = the CPU airlight band (default on; compute-bridge.check A/B) */
		bandGpu?: boolean;
		/** false = read the whole haze grid back instead of the arg-min program's pick (default on) */
		argminGpu?: boolean;
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
			{
				valid: () => !this.destroyed && (o.valid?.() ?? true),
				bandGpu: o.bandGpu,
				argminGpu: o.argminGpu,
			},
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
		const resident = this.heightSource?.() ?? null;
		const gather = resident
			? planReliefHeights(this.device, o.tiles, o.frame, o.yawDeg, resident)
			: null;
		// the CPU raster only when the GPU gather cannot run (or fails below)
		let cpu = gather ? null : reliefHeights(o.tiles, o.frame, o.yawDeg);
		const { res, extent, px } = gather ?? (cpu as NonNullable<typeof cpu>);
		const { words, degenerate } = reliefWords(res, px, o.sunDir);
		const tex = (id: string) =>
			this.device.createTexture({
				id,
				format: "rgba8unorm",
				width: res,
				height: res,
				usage: Texture.SAMPLE | Texture.COPY_DST | Texture.COPY_SRC,
				sampler: LINEAR_CLAMP,
			});
		const textures = { field: tex("relief-field"), gen: tex("relief-gen") };
		const dispose = () => {
			textures.field.destroy();
			textures.gen.destroy();
		};
		const cpuMs = performance.now() - t0;
		try {
			if (gather && resident) {
				try {
					await reliefGraphToTexturesGpuHeights(
						this.device,
						gather,
						resident,
						words,
						degenerate,
						textures,
					);
				} catch (e) {
					console.warn("[relief] GPU height gather failed, CPU raster", e);
					cpu = reliefHeights(o.tiles, o.frame, o.yawDeg);
				}
			}
			if (cpu)
				await reliefGraphToTextures(
					this.device,
					cpu.H,
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

	/** The photo source as set (harnesses: compute-bridge.check.ts restores it after a CPU-reference run). */
	get photoSourceState(): { tex: Texture | null; live: boolean } {
		return { tex: this.photoSource, live: this.photoLive };
	}

	/** The engine's resident photo texture, the source of photoTexture's GPU resample (null = CPU upload). */
	setPhotoSource(tex: Texture | null, live: boolean) {
		this.photoSource = tex;
		this.photoLive = live;
	}

	/**
	 * The photo at w × h as rgba8unorm: resampled on the GPU from the photo source texture
	 * (cached per source and size; a live source is resampled on every call), else photoPixels'
	 * bytes (the CPU path's canvas resample, cached) when there is no source or its kernel is not
	 * ready yet. The resample is submitted before this returns, so a graph submitted after sees it.
	 */
	photoTexture(img: HTMLImageElement, w: number, h: number): Texture {
		const key = `${w}x${h}`;
		const c = this.photos.get(key);
		const alive = c && !c.tex.destroyed ? c : null;
		const source = this.photoSource;
		const gpuSource = source && !source.destroyed ? source : null;
		if (gpuSource && alive?.gpu === gpuSource && !this.photoLive)
			return alive.tex;
		if (!gpuSource && alive && !alive.gpu && alive.img === img)
			return alive.tex;
		const tex =
			alive?.tex ??
			this.device.createTexture({
				id: `look-bridge-photo-${key}`,
				format: "rgba8unorm",
				width: w,
				height: h,
				usage: Texture.SAMPLE | Texture.COPY_DST,
			});
		if (gpuSource && resamplePhotoInto(this.device, gpuSource, tex)) {
			this.photos.set(key, { img, tex, gpu: gpuSource });
			return tex;
		}
		tex.writeData(photoPixels(img, w, h).data as never, {
			width: w,
			height: h,
			bytesPerRow: w * 4,
		});
		this.photos.set(key, { img, tex, gpu: null });
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
			usage: Texture.SAMPLE | Texture.COPY_DST,
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
			usage: Texture.SAMPLE | Texture.COPY_DST | Texture.COPY_SRC,
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
		this.prepared = null;
		const textures = [
			...this.outs,
			...[...this.photos.values()].map((p) => p.tex),
			...[...this.byteMasks.values()].map((m) => m.tex),
		];
		this.outs = [];
		this.writing = [];
		this.shown = -1;
		this.photos.clear();
		this.photoSource = null;
		this.byteMasks.clear();
		for (const t of textures) t?.destroy();
		if (!this.device.isLost)
			void releaseTextureGraphs(this.device).catch(() => {});
	}
}

/** A whole rgba8unorm texture (COPY_SRC), rows top-first (row 0 = texel row 0), tightly packed. */
export function readRgba8(device: Device, tex: Texture): Promise<Uint8Array> {
	return readTextureBytes(device, tex, 4);
}

function push(a: BridgeTiming[], t: BridgeTiming) {
	a.push(t);
	if (a.length > 32) a.shift();
}

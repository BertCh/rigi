// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// LiveNearField: the live (per-frame) Step Inside back end for a FIXED camera (tripod / webcam after one
// solve; a moving camera only needs `setCamera`, the splats are ENU). Plan: reports/realtime-investigation-
// 2026-10-02.md RT-3 items 3 and 4.
//
// Once per location (CPU, async, rare):
//   calibrate()  the focal / z shift (focal-shift.ts, via composeDepth) and the anchor curve (fitAnchor)
//                against the DEM range grid, from one read-back of the net's outputs; refit() repeats it
//                every K depth runs without blocking a frame.
// Per frame (no CPU readback, no await on the GPU):
//   runDepth()   one ComputeGraph submit: depth from the net's z / mask / metric-scale buffers → lift
//                (normals in-kernel, anchor curve, DEM-range classification, ENU, covariance) with atomic
//                compaction into `source.buffer` → dead-slot fill → colours from the video texture.
//   refreshColour()  the colour kernel alone (between depth runs).
//   frame()      LiveSchedule decides: depth every N frames, colours every frame.
// `source` is what the WebGPU splat layer draws (deck-webgpu/layers/splats.ts setLiveSource).
//
// Differences from the still-photo scene (controller.ts → buildNearFieldScene): no object grounding
// (ground.ts), no sky / people masks (the net's mask is the only sky estimate), no completion; Object
// splats are selected by the anchored range against the DEM grid exactly like split.ts classifyRange.
import { Buffer, type Device, Texture } from "@luma.gl/core";
import { ComputeGraph } from "#/lib/gpu/core/graph";
import type { GraphTextureDescriptor } from "#/lib/gpu/core/luma";
import { submit } from "#/lib/gpu/core/queue";
import { readBack } from "#/lib/gpu/core/readback";
import { fitAnchor } from "../anchor";
import { gridDemRange } from "../geom";
import { quatFromMatrix } from "../lift";
import { composeDepth, type DepthNetArrays } from "../local/compose";
import { focalFromFy, intrinsicsFromFocal } from "../local/focal-shift";
import {
	LIFT_DEFAULTS,
	LIFT_RECORD_WORDS,
	type LiftParams,
} from "../local/lift";
import type { AnchorFit, GaussianCloud } from "../types";
import {
	ANCHOR_MIN_QUALITY,
	DEFAULT_SPLIT,
	PROVENANCE_CODE,
	type SplitParams,
} from "../types";
import {
	K_LIVE_COLOUR,
	K_LIVE_DEPTH,
	K_LIVE_FINALIZE,
	K_LIVE_LIFT,
	LIVE_PRM,
	packLiveCurve,
} from "./kernels";
import {
	chooseLiveGrid,
	type FramePlan,
	type LiveGrid,
	LiveSchedule,
	type LiveScheduleOptions,
} from "./schedule";
import {
	LIVE_SPLAT_WORDS,
	type LiveCameraState,
	type LiveDepthInputs,
	type LiveSplatSource,
} from "./types";

export type LiveNearFieldOptions = {
	device: Device;
	/** The depth grid the net's z / mask / normal buffers are on. */
	width: number;
	height: number;
	/** Splat budget: the live LOD picks the smallest stride whose cell grid fits (default 250 000). */
	maxSplats?: number;
	/** Smallest stride (default 2, the still-photo lift's). */
	minStride?: number;
	lift?: Partial<LiftParams>;
	/** Object split parameters (default controller.ts STEP_SPLIT: margin 0.5, near radius 150 m, min gap 3 m). */
	split?: Partial<SplitParams>;
	schedule?: Partial<LiveScheduleOptions>;
	/** "frozen" (default): the metric scale of the calibration frame; "live": read from the net's buffer each run. */
	scaleMode?: "frozen" | "live";
	/** Also write the ENU lift records for readCloud() (the WebGL2 fallback; costs 48 B per slot). */
	writeCloud?: boolean;
	/** DEM range grid on the depth grid (geom.sampleDemGrid; NaN = no terrain). Without it every in-range cell is Object. */
	demGrid?: Float32Array | null;
	/**
	 * Where the focal comes from: "net" (default, the still-photo solve of focal and shift) or "camera":
	 * the focal of the camera passed to setCamera (a live camera's known field of view; the net's own
	 * focal is ~26% off at 256 tokens), solving only the z shift.
	 */
	focalSource?: "net" | "camera";
};

export type LiveCalibration = {
	focal: number;
	shift: number;
	metricScale: number;
	/** Depth-model intrinsics (normalised) from the focal. */
	K: { fx: number; fy: number; cx: number; cy: number };
	anchor: AnchorFit | null;
	/** anchor quality ≥ ANCHOR_MIN_QUALITY (or no DEM to calibrate against: identity anchor). */
	usable: boolean;
};

const STORAGE = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;
const DEFAULT_MAX_SPLATS = 250_000;
const NORMAL_STEP = 2;
const NORMAL_EDGE = 0.08;

type GraphMode = "depth" | "empty" | "colour";
type GraphKey = {
	mode: GraphMode;
	/** The depth graph binds the net's normal buffer (3 · W · H f32), else a 4-byte dummy. */
	normal: boolean;
	video: { w: number; h: number; format: string; usage: number } | null;
};

export class LiveNearField {
	readonly device: Device;
	readonly width: number;
	readonly height: number;
	readonly grid: LiveGrid;
	readonly source: LiveSplatSource;
	readonly schedule: LiveSchedule;
	calibration: LiveCalibration | null = null;
	/** Depth runs submitted / colour refreshes submitted (diagnostics). */
	readonly stats = { depthRuns: 0, colourRuns: 0, refits: 0 };

	private readonly opts: Required<
		Pick<LiveNearFieldOptions, "scaleMode" | "writeCloud">
	> &
		LiveNearFieldOptions;
	private readonly splats: Buffer;
	private readonly counter: Buffer;
	private readonly cloud: Buffer;
	private readonly prm: Buffer;
	private readonly crv: Buffer;
	private readonly dem: Buffer;
	private readonly dummy: Buffer;
	private demW = 0;
	private demH = 0;
	private demGrid: Float32Array | null = null;
	private camera: LiveCameraState | null = null;
	private version = 0;
	private emptied = false;
	private refitting = false;
	private disposed = false;
	private readonly graphs = new Map<string, ComputeGraph<void>>();
	private readonly compiling = new Map<
		string,
		Promise<ComputeGraph<void> | null>
	>();

	constructor(opts: LiveNearFieldOptions) {
		this.opts = { scaleMode: "frozen", writeCloud: false, ...opts };
		this.device = opts.device;
		this.width = opts.width;
		this.height = opts.height;
		this.grid = chooseLiveGrid(
			opts.width,
			opts.height,
			opts.maxSplats ?? DEFAULT_MAX_SPLATS,
			opts.minStride ?? LIFT_DEFAULTS.stride,
		);
		this.schedule = new LiveSchedule(opts.schedule);
		const d = this.device;
		const cap = this.grid.capacity;
		this.splats = d.createBuffer({
			id: "live-splats",
			byteLength: cap * LIVE_SPLAT_WORDS * 4,
			usage: STORAGE,
		});
		this.counter = d.createBuffer({
			id: "live-count",
			byteLength: 16,
			usage: STORAGE,
		});
		this.cloud = d.createBuffer({
			id: "live-cloud",
			byteLength: this.opts.writeCloud ? cap * LIFT_RECORD_WORDS * 4 : 16,
			usage: STORAGE,
		});
		this.prm = d.createBuffer({
			id: "live-prm",
			byteLength: LIVE_PRM.byteLength,
			usage: Buffer.UNIFORM | Buffer.COPY_DST,
		});
		this.crv = d.createBuffer({
			id: "live-crv",
			byteLength: 128,
			usage: Buffer.UNIFORM | Buffer.COPY_DST,
		});
		this.dem = d.createBuffer({
			id: "live-dem",
			byteLength: opts.width * opts.height * 4,
			usage: STORAGE,
		});
		this.dummy = d.createBuffer({
			id: "live-dummy",
			byteLength: 16,
			usage: STORAGE,
		});
		if (opts.demGrid) this.setDemGrid(opts.demGrid);
		this.source = {
			buffer: this.splats,
			countBuffer: this.counter,
			capacity: cap,
			getVersion: () => this.version,
		};
	}

	/** The photo camera (pose → ENU rotation, eye, photo intrinsics). Takes effect at the next depth run. */
	setCamera(camera: LiveCameraState) {
		this.camera = camera;
	}

	/** Replace the DEM range grid (depth grid resolution; NaN / ≤ 0 = no terrain). */
	setDemGrid(grid: Float32Array | null) {
		this.demGrid = grid;
		if (!grid) {
			this.demW = 0;
			this.demH = 0;
			return;
		}
		if (grid.length !== this.width * this.height)
			throw new Error("live: demGrid must be on the depth grid");
		this.demW = this.width;
		this.demH = this.height;
		// NaN → 0 (the kernel reads dem > 0 as "terrain")
		const g = new Float32Array(grid.length);
		for (let i = 0; i < g.length; i++) g[i] = grid[i] > 0 ? grid[i] : 0;
		this.dem.write(g);
	}

	/** Set the calibration directly (a saved solve), e.g. from a still-photo scene's anchor. */
	setCalibration(c: LiveCalibration) {
		this.calibration = c;
	}

	/**
	 * Solve the focal / shift and fit the anchor from one frame's net outputs (already read back; the
	 * caller owns that async read). The first call is awaited by the caller before the first depth run.
	 */
	calibrate(
		arrays: DepthNetArrays,
		opts: { anchor?: Parameters<typeof fitAnchor>[3] } = {},
	): LiveCalibration {
		if (!this.camera) throw new Error("live: setCamera before calibrate");
		const knownFocal =
			this.opts.focalSource === "camera"
				? focalFromFy(this.camera.K.fy, this.width, this.height)
				: undefined;
		const depth = composeDepth(
			knownFocal ? { ...arrays, knownFocal } : arrays,
			"live",
		);
		const K =
			depth.intrinsicsNorm ??
			intrinsicsFromFocal(depth.focal, this.width, this.height);
		let anchor: AnchorFit | null = null;
		let usable = true;
		if (this.demGrid) {
			const dem = gridDemRange(this.demGrid, this.width, this.height);
			anchor = fitAnchor(depth, dem, this.camera.K, opts.anchor ?? {});
			usable = anchor.quality >= ANCHOR_MIN_QUALITY;
		}
		this.calibration = {
			focal: depth.focal,
			shift: depth.shift,
			metricScale: arrays.metricScale,
			K,
			anchor,
			usable,
		};
		return this.calibration;
	}

	/**
	 * Refit off the frame path: `read` resolves the net outputs of a frame (nn.read of the tensors; the
	 * caller chooses the frame). One refit at a time; a failure keeps the previous calibration. Returns
	 * whether the new calibration replaced the old one.
	 */
	async refit(read: () => Promise<DepthNetArrays>): Promise<boolean> {
		if (this.refitting || this.disposed) return false;
		this.refitting = true;
		try {
			const previous = this.calibration;
			const next = this.calibrate(await read());
			// a refit that lost the anchor must not blank a working scene
			if (previous?.usable && !next.usable) this.calibration = previous;
			this.stats.refits++;
			return this.calibration === next;
		} catch (e) {
			console.warn("[live nearfield] refit failed", e);
			return false;
		} finally {
			this.refitting = false;
		}
	}

	private prmWords(depthInputs: LiveDepthInputs | null): ArrayBuffer {
		const cal = this.calibration;
		// a depth run lifts with the camera of the frame the net saw (runs.ts), not the latest one
		const cam = depthInputs?.camera ?? this.camera;
		if (!cal || !cam)
			throw new Error("live: calibrate and setCamera before a depth run");
		const p = { ...LIFT_DEFAULTS, ...this.opts.lift };
		const split = {
			...DEFAULT_SPLIT,
			objectMargin: 0.5,
			nearRadius: 150,
			...this.opts.split,
		};
		const { words, n } = packLiveCurve(cal.anchor?.curve);
		this.crv.write(words);
		const m = cam.camToEnu;
		const [qw, qx, qy, qz] = quatFromMatrix(m as number[]);
		return LIVE_PRM.pack({
			width: this.width,
			height: this.height,
			gw: this.grid.gw,
			gh: this.grid.gh,
			stride: this.grid.stride,
			hasNormal: depthInputs?.normal ? 1 : 0,
			useBufScale:
				this.opts.scaleMode === "live" && depthInputs?.metricScale ? 1 : 0,
			curveN: n,
			edgeRatio: p.edgeRatio,
			sigmaFrac: p.sigmaFrac,
			flatFrac: p.flatFrac,
			maxStretch: p.maxStretch,
			kdFx: cal.K.fx,
			kdFy: cal.K.fy,
			kdCx: cal.K.cx,
			kdCy: cal.K.cy,
			kpFx: cam.K.fx,
			kpFy: cam.K.fy,
			kpCx: cam.K.cx,
			kpCy: cam.K.cy,
			shift: cal.shift,
			metricScale: cal.metricScale,
			affScale: cal.anchor?.scale ?? 1,
			affShift: cal.anchor?.shift ?? 0,
			nearRadius: split.nearRadius,
			objectMargin: split.objectMargin,
			minGapM: split.minGapM,
			normalEdge: NORMAL_EDGE,
			normalStep: NORMAL_STEP,
			writeCloud: this.opts.writeCloud ? 1 : 0,
			capacity: this.grid.capacity,
			demW: this.demW,
			demH: this.demH,
			r00: m[0],
			r01: m[1],
			r02: m[2],
			r10: m[3],
			r11: m[4],
			r12: m[5],
			r20: m[6],
			r21: m[7],
			r22: m[8],
			ex: cam.eye[0],
			ey: cam.eye[1],
			ez: cam.eye[2],
			qw,
			qx,
			qy,
			qz,
		});
	}

	private graphKey(k: GraphKey) {
		return `${k.mode}${k.normal ? "+n" : ""}|${k.video ? `${k.video.w}x${k.video.h}:${k.video.format}:${k.video.usage}` : "-"}`;
	}

	private buildGraph(k: GraphKey): ComputeGraph<void> {
		const n = this.width * this.height;
		const g = new ComputeGraph<void>(
			this.device,
			`nearfield-live/${this.graphKey(k)}`,
		);
		const STO = Buffer.STORAGE | Buffer.COPY_DST;
		const UNI = Buffer.UNIFORM | Buffer.COPY_DST;
		const prm = g.importBuffer("prm", LIVE_PRM.byteLength, this.prm, UNI);
		const counter = g.importBuffer("counter", 16, this.counter, STORAGE);
		const splats = g.importBuffer(
			"splats",
			this.splats.byteLength,
			this.splats,
			STORAGE,
		);
		if (k.mode !== "colour") g.clearNode("clear-count", counter);
		if (k.mode === "depth") {
			const crv = g.importBuffer("crv", 128, this.crv, UNI);
			const z = g.importBuffer("z", n * 4, undefined, STO);
			const mask = g.importBuffer("mask", n * 4, undefined, STO);
			const scale = g.importBuffer("scale", 4, this.dummy, STO);
			const normal = k.normal
				? g.importBuffer("normal", n * 12, undefined, STO)
				: g.importBuffer("normal", 4, this.dummy, STO);
			const dem = g.importBuffer("dem", this.dem.byteLength, this.dem, STO);
			const cloud = g.importBuffer(
				"cloud",
				this.cloud.byteLength,
				this.cloud,
				STORAGE,
			);
			const depth = g.transientBuffer("depth", n * 4);
			g.addKernel({
				id: "depth",
				spec: K_LIVE_DEPTH,
				bindings: { prm, zIn: z, maskIn: mask, scaleIn: scale, depth },
				workgroups: [Math.ceil(this.width / 8), Math.ceil(this.height / 8)],
			});
			g.addKernel({
				id: "lift",
				spec: K_LIVE_LIFT,
				bindings: {
					prm,
					crv,
					depth,
					normalIn: normal,
					dem,
					counter,
					splats,
					cloud,
				},
				workgroups: [Math.ceil(this.grid.gw / 8), Math.ceil(this.grid.gh / 8)],
				writes: { counter: "atomic", splats: "partial", cloud: "partial" },
			});
		}
		if (k.mode !== "colour")
			g.addKernel({
				id: "finalize",
				spec: K_LIVE_FINALIZE,
				bindings: { prm, counter, splats },
				workgroups: [Math.ceil(this.grid.capacity / 64)],
				writes: { splats: "partial" },
			});
		if (k.video) {
			const desc: GraphTextureDescriptor = {
				id: "video",
				format: k.video.format as GraphTextureDescriptor["format"],
				width: k.video.w,
				height: k.video.h,
				usage: k.video.usage,
				dimension: "2d",
				depth: 1,
				mipLevels: 1,
				samples: 1,
			};
			const tex = g.importTexture(desc);
			g.addKernel({
				id: "colour",
				spec: K_LIVE_COLOUR,
				bindings: { prm, counter, splats, tex },
				workgroups: [Math.ceil(this.grid.capacity / 64)],
				writes: { splats: "partial" },
			});
		}
		return g.compile();
	}

	/** A compiled graph for the mode, or null while it is still being built (the frame is skipped, never blocked). */
	private graphFor(k: GraphKey): ComputeGraph<void> | null {
		const key = this.graphKey(k);
		const hit = this.graphs.get(key);
		if (hit) return hit;
		if (!this.compiling.has(key)) {
			const p = Promise.resolve()
				.then(() => {
					const g = this.buildGraph(k);
					return g.compileAsync().then(() => g);
				})
				.then((g) => {
					if (this.disposed) {
						g.destroy();
						return null;
					}
					this.graphs.set(key, g);
					return g;
				})
				.catch((e) => {
					console.warn("[live nearfield] graph build failed", e);
					return null;
				});
			this.compiling.set(key, p);
		}
		return null;
	}

	/** Resolves when the graphs for this mode are compiled (tests, warm-up). */
	async warm(
		video: Texture | null,
		mode: GraphMode = "depth",
		normal = false,
	): Promise<void> {
		const k = this.keyFor(video, mode, normal);
		this.graphFor(k);
		await this.compiling.get(this.graphKey(k));
	}

	private keyFor(
		video: Texture | null,
		mode: GraphMode,
		normal = false,
	): GraphKey {
		return {
			mode,
			normal,
			video: video
				? {
						w: video.width,
						h: video.height,
						format: video.format,
						usage: video.props.usage ?? Texture.SAMPLE | Texture.COPY_DST,
					}
				: null,
		};
	}

	private encode(
		g: ComputeGraph<void>,
		buffers: Record<string, Buffer>,
		video: Texture | null,
	) {
		const enc = this.device.createCommandEncoder({ id: g.id });
		g.encode(enc, undefined, buffers, video ? { video } : undefined);
		submit(this.device, enc);
	}

	/** Make every slot dead (before the first depth run, or when the calibration is unusable). */
	clear(): boolean {
		const g = this.graphFor(this.keyFor(null, "empty"));
		if (!g) return false;
		this.prm.write(this.prmWords(null));
		this.encode(g, {}, null);
		this.emptied = true;
		this.version++;
		return true;
	}

	/**
	 * One depth run: the net's outputs → splats, in one submit with no readback. Returns false when it
	 * could not run yet (graph still compiling, no calibration): the previous splats stay. `video` (a
	 * texture on this device, rgba8unorm) gives the colours; without it they stay grey.
	 */
	runDepth(inputs: LiveDepthInputs, video: Texture | null = null): boolean {
		if (this.disposed || !this.calibration || !this.camera) return false;
		if (!this.calibration.usable) return this.emptied || this.clear();
		const g = this.graphFor(this.keyFor(video, "depth", !!inputs.normal));
		if (!g) return false;
		this.prm.write(this.prmWords(inputs));
		const buffers: Record<string, Buffer> = { z: inputs.z, mask: inputs.mask };
		if (inputs.normal) buffers.normal = inputs.normal;
		if (this.opts.scaleMode === "live" && inputs.metricScale)
			buffers.scale = inputs.metricScale;
		this.encode(g, buffers, video);
		this.emptied = false;
		this.stats.depthRuns++;
		this.version++;
		return true;
	}

	/**
	 * GPU time per node (ms) of one depth run through ComputeGraph.run({ timings }): diagnostics only (a
	 * timed run waits on the GPU). Empty without the device's timestamp-query feature.
	 */
	async profileDepth(
		inputs: LiveDepthInputs,
		video: Texture | null = null,
	): Promise<Record<string, number>> {
		const g = this.graphFor(this.keyFor(video, "depth", !!inputs.normal));
		if (!g || !this.calibration) return {};
		this.prm.write(this.prmWords(inputs));
		const buffers: Record<string, Buffer> = { z: inputs.z, mask: inputs.mask };
		if (inputs.normal) buffers.normal = inputs.normal;
		if (this.opts.scaleMode === "live" && inputs.metricScale)
			buffers.scale = inputs.metricScale;
		const { timings } = await g.run(undefined, {
			buffers,
			...(video ? { textures: { video } } : {}),
			timings: true,
		});
		const out: Record<string, number> = {};
		for (const n of timings?.nodes ?? [])
			out[n.id] = n.gpuTimeMilliseconds ?? Number.NaN;
		return out;
	}

	/** Colours only, from `video`, for the splats of the last depth run (no position change: no re-sort). */
	refreshColour(video: Texture): boolean {
		if (this.disposed || !this.calibration || !this.camera) return false;
		// nothing to colour before the first depth run (the counter is zero: the kernel would be a no-op)
		if (this.stats.depthRuns === 0) return false;
		const g = this.graphFor(this.keyFor(video, "colour"));
		if (!g) return false;
		this.prm.write(this.prmWords(null));
		this.encode(g, {}, video);
		this.stats.colourRuns++;
		return true;
	}

	/**
	 * Per-frame entry: the schedule's plan for this frame. `getInputs` is called only on a depth frame and
	 * returns the net's latest outputs (or null when the net has none ready, which defers the run).
	 */
	frame(
		getInputs: () => LiveDepthInputs | null,
		video: Texture | null,
	): FramePlan {
		const inputs = this.schedule.isDepthDue() ? getInputs() : null;
		const plan = this.schedule.next({ depthReady: !!inputs });
		if (plan.runDepth && inputs) this.runDepth(inputs, video);
		else if (plan.refreshColour && video) this.refreshColour(video);
		return plan;
	}

	/** The number of live splats (a 4-byte readback: diagnostics, not the frame path). */
	async readCount(): Promise<number> {
		const [b] = await readBack(this.device, () => [
			{ buffer: this.counter, size: 4 },
		]);
		return Math.min(new Uint32Array(b)[0], this.grid.capacity);
	}

	/** The slot → cell ids and positions of the live splats (tests, the WebGL2 fallback's cloud). */
	async readSplats(): Promise<{ count: number; words: Uint32Array }> {
		const count = await this.readCount();
		if (!count) return { count, words: new Uint32Array(0) };
		const [b] = await readBack(this.device, () => [
			{ buffer: this.splats, size: count * LIVE_SPLAT_WORDS * 4 },
		]);
		return { count, words: new Uint32Array(b) };
	}

	/**
	 * The live splats as an ENU GaussianCloud (needs `writeCloud`): the WebGL2 fallback's bridge and the
	 * parity tests. Colours are the current ones.
	 */
	async readCloud(): Promise<GaussianCloud & { cells: Uint32Array }> {
		if (!this.opts.writeCloud)
			throw new Error("live: readCloud needs writeCloud");
		const count = await this.readCount();
		const empty = (): GaussianCloud & { cells: Uint32Array } => ({
			count: 0,
			frame: "enu",
			positions: new Float32Array(0),
			scales: new Float32Array(0),
			rotations: new Float32Array(0),
			colors: new Uint8Array(0),
			provenance: new Uint8Array(0),
			cells: new Uint32Array(0),
		});
		if (!count) return empty();
		const [rec, spl] = await readBack(this.device, () => [
			{ buffer: this.cloud, size: count * LIFT_RECORD_WORDS * 4 },
			{ buffer: this.splats, size: count * LIVE_SPLAT_WORDS * 4 },
		]);
		const f = new Float32Array(rec);
		const sw = new Uint32Array(spl);
		const positions = new Float32Array(3 * count);
		const scales = new Float32Array(3 * count);
		const rotations = new Float32Array(4 * count);
		const colors = new Uint8Array(4 * count);
		const cells = new Uint32Array(count);
		for (let i = 0; i < count; i++) {
			const o = i * LIFT_RECORD_WORDS;
			positions.set(f.subarray(o, o + 3), 3 * i);
			scales.set(f.subarray(o + 3, o + 6), 3 * i);
			rotations.set(f.subarray(o + 6, o + 10), 4 * i);
			const rgba = sw[i * LIVE_SPLAT_WORDS + 10];
			colors[4 * i] = rgba & 255;
			colors[4 * i + 1] = (rgba >>> 8) & 255;
			colors[4 * i + 2] = (rgba >>> 16) & 255;
			colors[4 * i + 3] = rgba >>> 24;
			cells[i] = sw[i * LIVE_SPLAT_WORDS + 11];
		}
		return {
			count,
			frame: "enu",
			positions,
			scales,
			rotations,
			colors,
			provenance: new Uint8Array(count).fill(PROVENANCE_CODE.reconstructed),
			cells,
		};
	}

	dispose() {
		this.disposed = true;
		for (const g of this.graphs.values()) g.destroy();
		this.graphs.clear();
		for (const b of [
			this.splats,
			this.counter,
			this.cloud,
			this.prm,
			this.crv,
			this.dem,
			this.dummy,
		])
			b.destroy();
	}
}

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Off-frame photo-camera geometry on WebGPU: deck/geometry-source.ts `GeometrySource` for the
// queries (1024 px long side, with xyz) and autoAlign's silhouette re-rank (384 px, range only).
// WebGPU port of deck/geometry-pass.ts GpuGeometrySource.
//
// How it works:
// - Each source owns a private GeometryTargets of its size, so an off-frame render never touches
//   the host's per-frame targets.
// - render(pose) runs hosts/passes.ts runGeometryPass with the terrain cores (TerrainCore /
//   BatchedTerrainCore; no trails, splats or tiles3d) through the photo camera, then
//   device.submit().
// - The readback is TextureReader: a copy into a MAP_READ staging buffer, then mapAsync. The
//   mapAsync resolving IS the "GPU done" signal, so the WebGL path's fence / quiet-queue polling
//   (gpuDone, glFence, readbackQuiet) has no equivalent here: mapAsync never stalls the thread.
// - Frustum culling happens inside the cores (TerrainCore uses camera.sphereInView).
//
// Buffer layout: the GeometrySource contract (deck/geometry-source.ts) is already TOP-first. The
// WebGL implementation flips GL's bottom-first readPixels rows in unpack(). WebGPU rows are
// top-first, so NO flip here. skylineRows, the query sampling (sampleAt) and the align scoring
// (scoreSilhouette) read `range` through the contract and work unchanged.
//   range[i]  = xyzr.w (metres from the eye), or +Infinity where w ≤ 0 (cleared = sky)
//   xyz[3i..] = xyzr.xyz straight from the GPU (no CPU ray rebuild), or NaN for sky
// For the drape, rangeMapFrom's CPU copy is not needed any more: GPU consumers read `targets.geometry`
// (rgba32float, w = range, 0 = sky) directly.
//
// Fused submit (WAG W1.2): `encodeAfterDraw` records extra GPU work (the engine's prepared look
// masks) on its OWN command encoder after the geometry pass; core submitWithDefault then submits
// the render's buffer and that one in a single queue.submit, in that order, so the work sees this
// render's targets. A throw while recording drops only the extra encoder (the render submits alone,
// as before, and the work's owner runs its separate pass). It changes nothing about when renders
// happen: the debounce and renderSeq pairing below are the same with or without it. Only query
// sources get it: the factory passes it to sources wider than `xyzMinWidth` (512 px), so the
// 384 px silhouette re-rank sources and any other source ≤ 512 px wide get no fusion.
//
// Uniform safety: TerrainCore keeps ONE geometry Model. The luma WebGPU uniform writes go through
// queue.writeBuffer at draw time. This render encodes and submits its own command buffer before
// returning, so the frame's geometry pass (encoded later, submitted later) cannot see our photo
// camera, and we cannot see its. Never call render() from inside a host's pass callback: the
// device's default encoder would be flushed mid-frame.
//
// Wiring (the engine / lab assembler):
//   const factory = webgpuGeometryFactory({
//     device: host.device,
//     cores: () => [terrainCore],   // or terrainCoresOf(host.cores)
//     eye: () => eye,               // read once per source; re-create the sources when the eye changes
//   });
//   const queries = factory(...Object.values(geometrySize(aspect)));   // 1024 long side, with xyz
//   const sil = factory(384, Math.round(384 / aspect));               // the re-rank (see note)
// - deck/engine.ts accepts it as-is: `new DeckEngine({..., geometryFactory: factory})` (makeSource
//   uses geometryFactory before the WebGL GpuGeometrySource).
// - Only the WebGL-free engine port (deck-webgpu/engine.ts) needs GeometryGenerations below. It is
//   the engine's geoGen / 90 ms debounce / readback() logic (deck/engine.ts invalidateGeometry,
//   refreshGeometry, readback, geometryReady) lifted out, so the port keeps the same semantics.
// - Note: the GeometrySourceFactory signature has no xyz flag. webgpuGeometryFactory skips the xyz
//   unpack for widths ≤ `xyzMinWidth` (default 512), so the 384 px re-rank stays range-only as in
//   deck/engine.ts silhouetteSource (makeSource(W, H, false)).
import type { CommandEncoder, Device } from "@luma.gl/core";
import type { Pose } from "#/lib/camera";
import type {
	GeometrySource,
	GeometrySourceFactory,
} from "#/lib/deck/geometry-source";
import { submitWithDefault } from "#/lib/gpu/core/queue";
import type { Vec3 } from "#/lib/ontology/core/geometry";
import { photoCamera } from "../camera";
import { type CameraPose, runGeometryPass } from "../hosts/passes";
import type { FrameState, GpuLayerCore } from "../pass";
import { TextureReader } from "../readback";
import { GeometryTargets } from "../targets";

/** deck/engine.ts invalidateGeometry: the buffer is re-read this long after the last change. */
export const GEOMETRY_DEBOUNCE_MS = 90;
/** Sources at most this wide skip the xyz unpack (the 384 px silhouette re-rank). */
export const XYZ_MIN_WIDTH = 512;

/** Timing of the last WebGpuGeometrySource.render(), ms (deck/geometry-pass.ts GeometryTiming). */
export type WebGpuGeometryTiming = {
	/** CPU time to encode and submit the geometry pass. */
	submitMs: number;
	/** submit → copy → mapAsync resolved (GPU render + transfer, off the thread). */
	readbackMs: number;
	/** w → range (sky → Infinity), plus the xyz copy. */
	unpackMs: number;
	totalMs: number;
	/** Terrain cores that drew in the pass. */
	cores: number;
};

/**
 * The terrain cores of a host's core list: TerrainCore ("terrain") and BatchedTerrainCore
 * ("batched-terrain"). The geometry off-frame pass draws only these, as the WebGL
 * TerrainLayersPass drew only terrain tiles in its geometry pass. Matched by id so this file needs
 * no import from layers/batched-terrain.ts (README rule 1).
 */
export function terrainCoresOf(cores: readonly GpuLayerCore[]): GpuLayerCore[] {
	return cores.filter(
		(c) => c.passes.includes("geometry") && /(^|-)terrain$/.test(c.id),
	);
}

/**
 * Lazy mode of the 1024 px query source (WebGpuEngine's geometry diet): render() draws into the
 * target and awaits `after` (GPU point queries on that target) instead of reading the whole
 * rgba32float target back. `range` / `xyz` then stay empty until ensureFull() is called, and
 * `hasCpu` says whether they describe the current render. `after` resolving false (a kernel
 * failed) makes that render() fall back to the full readback.
 */
export type LazyQueries = {
	after: (seq: number, pose: Pose) => Promise<boolean>;
};

/** What an EncodeAfterDraw recorded: told whether it reached the queue with the render. */
export type FusedWork = {
	/** submitted in the render's queue.submit (after its geometry pass) */
	submitted: () => void;
	/** not submitted (finish failed, device lost): the owner falls back to its separate pass */
	dropped: () => void;
};

/**
 * Extra GPU work for a render (WAG W1.2), called synchronously inside render() / drawOnly() after
 * the geometry pass, recorded on its own `encoder` (never the device's default one). `seq` is the
 * render's renderSeq. It must not submit or await. Null (nothing worth submitting) or a throw
 * (logged) drops `encoder`; the render then submits alone.
 */
export type EncodeAfterDraw = (o: {
	seq: number;
	pose: Pose;
	encoder: CommandEncoder;
	targets: GeometryTargets;
}) => FusedWork | null;

export type WebGpuGeometryOptions = {
	device: Device;
	/** Cores to draw (terrain only). Read on every render, so tile / core swaps apply. */
	cores: () => readonly GpuLayerCore[];
	/** Photo eye (ENU m). Read once per source: a source describes the eye it was made with. */
	eye: Vec3 | (() => Vec3);
	/** Lazy queries for the sources wider than `xyzMinWidth` (the 1024 px query source). */
	lazyQueries?: () => LazyQueries | undefined;
	/** Extra work on the encoder of each render of the sources wider than `xyzMinWidth`. */
	encodeAfterDraw?: EncodeAfterDraw;
	/** Near plane (m); the frame's photo camera uses 1 (lab.ts, deck/geometry-pass.ts). */
	near?: number;
};

/**
 * GeometrySource on WebGPU. It renders the terrain cores through the photo camera at `eye` into
 * its own GeometryTargets, and reads xyzr back asynchronously. Layout as in deck/geometry-source.ts:
 * row 0 = top, Infinity = sky, xyz NaN for sky.
 */
export class WebGpuGeometrySource implements GeometrySource {
	readonly width: number;
	readonly height: number;
	readonly range: Float32Array;
	readonly xyz?: Float32Array;
	pose: Pose | null = null;
	/** Timing of the last completed render(). */
	timing: WebGpuGeometryTiming | null = null;
	/** The targets of the last render (GPU consumers: geometry.w = range, 0 = sky; top-first). */
	readonly targets: GeometryTargets;
	private readonly device: Device;
	private lazy: LazyQueries | null;
	private readonly encodeAfterDraw: EncodeAfterDraw | null;
	/** The render() whose readback `range` / `xyz` hold (0 = none yet). */
	private cpuSeq = 0;
	private fullRead: { seq: number; p: Promise<boolean> } | null = null;
	private readonly cores: () => readonly GpuLayerCore[];
	private readonly eye: Vec3;
	private readonly near: number;
	/** Idle readers. TextureReader refuses a second read while one is in flight, and an older
	 * render may still be mapping when a newer one starts, so each read takes its own reader. */
	private readers: TextureReader[] = [];
	private seq = 0;
	private unpacked = 0;
	private frame = 0;
	private disposed = false;

	/** The latest render() started (its pass is on the queue: the targets hold it, or will). */
	get renderSeq() {
		return this.seq;
	}

	/** The render() whose readback `range` / `xyz` / `pose` hold. The targets still hold that
	 * render exactly while renderSeq === rangeSeq (GPU consumers pairing them with `range`). */
	get rangeSeq() {
		return this.unpacked;
	}

	constructor(
		o: Omit<WebGpuGeometryOptions, "eye"> & { eye: Vec3 },
		width: number,
		height: number,
		opts: {
			xyz?: boolean;
			lazy?: LazyQueries;
			encodeAfterDraw?: EncodeAfterDraw;
		} = {},
	) {
		this.device = o.device;
		this.lazy = opts.lazy ?? null;
		this.encodeAfterDraw = opts.encodeAfterDraw ?? null;
		this.cores = o.cores;
		this.eye = [o.eye[0], o.eye[1], o.eye[2]];
		this.near = o.near ?? 1;
		this.width = width;
		this.height = height;
		this.range = new Float32Array(width * height).fill(
			Number.POSITIVE_INFINITY,
		);
		if (opts.xyz !== false)
			this.xyz = new Float32Array(width * height * 3).fill(Number.NaN);
		this.targets = new GeometryTargets(
			o.device,
			width,
			height,
			`geometry-source-${width}x${height}`,
		);
	}

	/** The photo camera for `pose` at this source's eye (hosts/passes.ts CameraPose). */
	private camera(pose: Pose): CameraPose {
		const c = photoCamera({
			pose,
			eye: this.eye,
			width: this.width,
			height: this.height,
			near: this.near,
		});
		return {
			eye: c.eye,
			forward: c.forward,
			up: c.up,
			vfov: c.vfov,
			near: c.near,
		};
	}

	/** True when `range` / `xyz` hold the render `pose` describes (always, outside lazy mode). */
	get hasCpu() {
		return this.cpuSeq > 0 && this.cpuSeq === this.unpacked;
	}

	/** Lazy mode on (render() does not read the target back). */
	get isLazy() {
		return this.lazy !== null;
	}

	/** Back to reading every render() in full (a diet kernel failed for good). */
	disableLazy() {
		this.lazy = null;
	}

	/**
	 * Lazy mode: read the current render's target back in full now (once per render; concurrent calls
	 * share it) so `range` / `xyz` / hasCpu describe it. The copy is queued immediately, so it holds
	 * the render the pose describes; a newer render() meanwhile discards the result.
	 */
	ensureFull(): Promise<boolean> {
		if (this.hasCpu) return Promise.resolve(true);
		const seq = this.unpacked;
		if (this.disposed || !seq || seq !== this.seq || !this.pose)
			return Promise.resolve(false);
		if (this.fullRead?.seq === seq) return this.fullRead.p;
		const p = (async () => {
			const reader = this.readers.pop() ?? new TextureReader(this.device);
			const data = await reader.read(this.targets.geometry);
			if (this.disposed || this.readers.length >= 2) reader.destroy();
			else this.readers.push(reader);
			if (!data || seq !== this.seq || this.disposed) return false;
			this.readBytes = data.byteLength;
			this.unpack(data);
			this.cpuSeq = seq;
			return true;
		})().finally(() => {
			if (this.fullRead?.seq === seq) this.fullRead = null;
		});
		this.fullRead = { seq, p };
		return p;
	}

	/** The device the targets live on (GPU consumers of `targets.geometry`). */
	get gpuDevice() {
		return this.device;
	}

	/** Bytes the last completed readback copied (render() / readDrawn()). */
	readBytes = 0;

	/**
	 * render() without the readback: the geometry pass for `pose` is encoded and submitted now, so
	 * later submits on this queue see `targets.geometry`. `range` / `pose` are unchanged until
	 * readDrawn() (or a render()) reads it back. false = disposed / lost (nothing drawn).
	 */
	drawOnly(pose: Pose): boolean {
		if (this.disposed || this.device.isLost) return false;
		++this.seq;
		this.drawPass(pose, performance.now());
		return true;
	}

	/**
	 * Reads back what drawOnly() number `seq` (drawSeq right after it) drew for `pose` (render()'s
	 * second half), so `range` / `pose` describe it. false = anything else is in the target now (a
	 * later drawOnly() / render(), e.g. a concurrent autoAlign, or another pose), disposed, lost:
	 * the caller must not score what it would read.
	 */
	async readDrawn(seq: number, pose: Pose): Promise<boolean> {
		const drawn = this.drawn;
		if (this.disposed || !drawn || this.seq !== seq) return false;
		if (
			drawn.yaw !== pose.yaw ||
			drawn.pitch !== pose.pitch ||
			drawn.roll !== pose.roll ||
			drawn.vfov !== pose.vfov
		)
			return false;
		if (this.unpacked === seq) return true;
		const t = performance.now();
		await this.finish(seq, drawn, this.drawnCores, t, t);
		return this.unpacked === seq;
	}

	private drawn: Pose | null = null;
	private drawnCores: readonly GpuLayerCore[] = [];

	private drawPass(pose: Pose, time: number) {
		const cores = this.cores();
		const frame: FrameState = {
			frame: ++this.frame,
			time,
			view: "photo",
		};
		runGeometryPass({
			device: this.device,
			cores,
			geometry: this.targets,
			photo: this.camera(pose),
			frame,
		});
		// the copy in TextureReader.read is its own queue submit: the pass must be on the queue first
		this.submitDraw(pose);
		this.drawn = { ...pose };
		this.drawnCores = cores;
		return cores;
	}

	/** Submit the geometry pass, with the encodeAfterDraw work in the same queue.submit if any. */
	private submitDraw(pose: Pose) {
		if (!this.encodeAfterDraw) return this.device.submit();
		const encoder = this.device.createCommandEncoder({
			id: "geometry-source-fused",
		});
		let work: FusedWork | null = null;
		try {
			work = this.encodeAfterDraw({
				seq: this.seq,
				pose: { ...pose },
				encoder,
				targets: this.targets,
			});
		} catch (e) {
			console.warn("[geometry-source] encodeAfterDraw failed, dropped", e);
		}
		if (!work) {
			encoder.destroy();
			return this.device.submit();
		}
		let sent = false;
		try {
			sent = submitWithDefault(this.device, [encoder]);
		} catch (e) {
			// lost device: nothing was submitted (the render is gone with it)
			console.warn("[geometry-source] fused submit failed", e);
		}
		if (sent) work.submitted();
		else work.dropped();
	}

	async render(pose: Pose): Promise<void> {
		if (this.disposed || this.device.isLost) return;
		const seq = ++this.seq;
		const t0 = performance.now();
		const cores = this.drawPass(pose, t0);
		const t1 = performance.now();
		if (this.lazy) {
			let ok = false;
			try {
				ok = await this.lazy.after(seq, { ...pose });
			} catch (e) {
				console.warn("[geometry-source] lazy queries failed, full readback", e);
			}
			if (this.disposed || seq !== this.seq) return;
			if (ok) {
				this.pose = { ...pose };
				this.unpacked = seq;
				const t2 = performance.now();
				this.timing = {
					submitMs: t1 - t0,
					readbackMs: t2 - t1,
					unpackMs: 0,
					totalMs: t2 - t0,
					cores: cores.filter(
						(c) => c.passes.includes("geometry") && (c.visible?.() ?? true),
					).length,
				};
				return;
			}
			this.lazy = null;
		}
		await this.finish(seq, pose, cores, t0, t1);
	}

	private async finish(
		seq: number,
		pose: Pose,
		cores: readonly GpuLayerCore[],
		t0: number,
		t1: number,
	) {
		const reader = this.readers.pop() ?? new TextureReader(this.device);
		const data = await reader.read(this.targets.geometry);
		// keep two readers warm (a render overlapping one in flight); drop extras
		if (this.disposed || this.readers.length >= 2) reader.destroy();
		else this.readers.push(reader);
		const t2 = performance.now();
		// a newer render() superseded this one (its buffers win), or the device went away
		if (!data || seq !== this.seq || this.disposed) return;
		this.readBytes = data.byteLength;
		this.unpack(data);
		const t3 = performance.now();
		this.pose = { ...pose };
		this.unpacked = seq;
		this.cpuSeq = seq;
		this.timing = {
			submitMs: t1 - t0,
			readbackMs: t2 - t1,
			unpackMs: t3 - t2,
			totalMs: t3 - t0,
			cores: cores.filter(
				(c) => c.passes.includes("geometry") && (c.visible?.() ?? true),
			).length,
		};
	}

	/** xyzr (top-first, tightly packed) → range (+ xyz). No row flip: see the header. */
	private unpack(xyzr: Float32Array) {
		const { range, xyz } = this;
		const n = range.length;
		if (!xyz) {
			for (let i = 0; i < n; i++) {
				const r = xyzr[i * 4 + 3];
				range[i] = r > 0 ? r : Number.POSITIVE_INFINITY;
			}
			return;
		}
		for (let i = 0; i < n; i++) {
			const o = i * 4;
			const r = xyzr[o + 3];
			if (r > 0) {
				range[i] = r;
				xyz[i * 3] = xyzr[o];
				xyz[i * 3 + 1] = xyzr[o + 1];
				xyz[i * 3 + 2] = xyzr[o + 2];
			} else {
				range[i] = Number.POSITIVE_INFINITY;
				xyz[i * 3] = xyz[i * 3 + 1] = xyz[i * 3 + 2] = Number.NaN;
			}
		}
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const r of this.readers) r.destroy();
		this.readers = [];
		// an in-flight copy was submitted before this: WebGPU defers the actual free until it is done
		this.targets.destroy();
	}
}

/**
 * The GeometrySourceFactory (deck/geometry-source.ts) for a WebGPU device: DeckEngine's
 * `geometryFactory`, or the WebGPU engine port's equivalent. Sources at most `xyzMinWidth` wide
 * are range-only (the silhouette re-rank), and wider ones carry xyz (the queries).
 */
export function webgpuGeometryFactory(
	o: WebGpuGeometryOptions & { xyzMinWidth?: number },
): GeometrySourceFactory {
	const xyzMin = o.xyzMinWidth ?? XYZ_MIN_WIDTH;
	return (width, height) =>
		new WebGpuGeometrySource(
			{
				device: o.device,
				cores: o.cores,
				near: o.near,
				eye: typeof o.eye === "function" ? o.eye() : o.eye,
			},
			width,
			height,
			{
				xyz: width > xyzMin,
				...(width > xyzMin && o.lazyQueries?.()
					? { lazy: o.lazyQueries() }
					: {}),
				...(width > xyzMin && o.encodeAfterDraw
					? { encodeAfterDraw: o.encodeAfterDraw }
					: {}),
			},
		);
}

function samePose(a: Pose, b: Pose) {
	return (
		a.yaw === b.yaw &&
		a.pitch === b.pitch &&
		a.roll === b.roll &&
		a.vfov === b.vfov
	);
}

export type GeometryGenerationsOptions = {
	/** The query source (created lazily by the engine; null = none possible yet). */
	source: () => GeometrySource | null;
	/** The current pose (copied at refresh start). */
	pose: () => Pose;
	/** Terrain present and device alive (deck/engine.ts: terrain && !disposed && !contextLost). */
	canRender: () => boolean;
	/** Mid-interaction: the debounced refresh waits for input idle (the engine calls invalidate() or
	 * readback() when the interaction ends, as deck/engine.ts inputIdle does). */
	interactive?: () => boolean;
	/** Awaited before each render (deck/engine.ts: deckReady, flushLayers). */
	beforeRender?: () => void | Promise<void>;
	/** The buffer now describes the current pose (fitHaze, updateLook, relief, emit…). */
	onFresh?: (gen: number) => void;
	debounceMs?: number;
};

/**
 * The geometry generation bookkeeping of deck/engine.ts, lifted out for the WebGPU engine port:
 * - `invalidate()` bumps the generation on every pose or mesh change. It re-reads the buffer
 *   GEOMETRY_DEBOUNCE_MS (90 ms) after the last change, unless the view is interactive or there
 *   is no terrain.
 * - `readback()` forces the refresh now. It retries up to 4 times when a newer change supersedes
 *   the refresh.
 * - `ready()` is true while the buffer describes the current generation.
 * Same semantics as invalidateGeometry, refreshGeometry, readback and geometryReady.
 */
export class GeometryGenerations {
	private gen = 0;
	private bufGen = -1;
	private timer = 0;
	private waiters: ((ok: boolean) => void)[] = [];
	private disposed = false;

	constructor(private o: GeometryGenerationsOptions) {}

	/** Generation counter (bumps on every pose or terrain change). */
	get generation() {
		return this.gen;
	}

	/** True when the buffer describes the current pose and meshes. */
	ready() {
		return !this.disposed && this.bufGen >= 0 && this.bufGen === this.gen;
	}

	/** The geometry no longer matches the buffer (pose or meshes changed): re-read it 90 ms later. */
	invalidate() {
		this.gen++;
		clearTimeout(this.timer);
		this.timer = 0;
		if (this.disposed || !this.o.canRender() || this.o.interactive?.()) return;
		this.timer = window.setTimeout(() => {
			this.timer = 0;
			void this.refresh();
		}, this.o.debounceMs ?? GEOMETRY_DEBOUNCE_MS);
	}

	/** Render and read back for the current pose. True if the buffer is fresh afterwards. */
	async refresh(): Promise<boolean> {
		if (this.disposed || !this.o.canRender()) return false;
		await this.o.beforeRender?.();
		const src = this.o.source();
		if (this.disposed || !src) return false;
		const gen = this.gen;
		const pose = { ...this.o.pose() };
		await src.render(pose);
		if (this.disposed) return false;
		const got = src.pose;
		// a newer pose / mesh change arrived meanwhile: its own refresh takes over
		if (gen !== this.gen || !got || !samePose(got, pose)) return this.ready();
		this.bufGen = gen;
		this.o.onFresh?.(gen);
		const w = this.waiters;
		this.waiters = [];
		for (const r of w) r(true);
		return true;
	}

	/**
	 * Resolves once the buffer describes the current pose (true), or false if disposed first.
	 * Without terrain it waits for the first successful refresh (deck/engine.ts readbackWaiters).
	 */
	async readback(): Promise<boolean> {
		if (this.ready()) return true;
		if (this.disposed) return false;
		if (!this.o.canRender())
			return new Promise((res) => this.waiters.push(res));
		clearTimeout(this.timer);
		this.timer = 0;
		for (let i = 0; i < 4 && !this.disposed; i++)
			if (await this.refresh()) return true;
		return this.ready();
	}

	dispose() {
		this.disposed = true;
		clearTimeout(this.timer);
		this.timer = 0;
		const w = this.waiters;
		this.waiters = [];
		for (const r of w) r(false);
	}
}

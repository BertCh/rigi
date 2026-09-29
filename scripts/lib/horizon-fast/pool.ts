/**
 * Splits azimuth sectors across workers. The main thread loads tiles and
 * snaps peaks, then per sector copies just the wedge of each ring mosaic
 * and transfers it (no copy); workers build the max-mipmaps and march.
 * Bench-only: used by scripts/horizon-fast-bench.ts (the app marches in one
 * worker via src/lib/integration/horizon-fast-app.worker.ts).
 */

import type { Ridge } from "../../../src/lib/geo/horizon";
import { type EngineOptions, type EngineTimings, prepare } from "./engine";
import type {
	Eye,
	FastHorizonProfile,
} from "../../../src/lib/horizon-fast/march";
import {
	buildMosaics,
	canShare,
	type Mosaic,
	type TileStore,
} from "../../../src/lib/horizon-fast/mosaic";
import type { PeakVisibility } from "../../../src/lib/horizon-fast/visibility";
import type { SectorJob, SectorResult } from "./worker-core";

/** Minimal worker handle (node worker_threads: see node.ts). */
export interface WorkerPort {
	post(msg: unknown, transfer: Transferable[]): void;
	onMessage(cb: (msg: unknown) => void): void;
	terminate(): void;
}

export interface PoolOptions extends EngineOptions {
	/**
	 * Build the mosaics once in SharedArrayBuffers and share them with all
	 * workers (default: when canShare(), i.e. node or a crossOriginIsolated
	 * page). Otherwise each sector gets its own wedge copy, transferred.
	 */
	shared?: boolean;
	/** Sectors per worker (default 4 shared, 1 transferred). */
	sectorsPerWorker?: number;
}

export interface PoolTimings extends EngineTimings {
	/** Main-thread sector mosaic copies, ms. */
	mosaicMs: number;
	/** Sum over sectors of worker mip build / march time, ms. */
	workerMipMs: number;
	workerMarchMs: number;
}

export class HorizonPool {
	private next = 0;
	private readonly pending = new Map<number, (r: SectorResult) => void>();
	private readonly idle: WorkerPort[];

	constructor(private readonly ports: WorkerPort[]) {
		this.idle = [...ports];
		for (const p of ports)
			p.onMessage((msg) => {
				const r = msg as SectorResult;
				const cb = this.pending.get(r.id);
				this.pending.delete(r.id);
				this.idle.push(p);
				cb?.(r);
				this.pump();
			});
	}

	get size() {
		return this.ports.length;
	}

	private queue: {
		job: () => SectorJob;
		resolve: (r: SectorResult) => void;
	}[] = [];

	private pump() {
		while (this.idle.length && this.queue.length) {
			const port = this.idle.pop() as WorkerPort;
			const q = this.queue.shift() as (typeof this.queue)[number];
			// Build the sector's mosaics only when a worker is free.
			const job = q.job();
			this.pending.set(job.id, q.resolve);
			const transfer = job.mosaics
				.flatMap((m) => [m.data, ...(m.mip?.mips ?? [])])
				.map((a) => a.buffer)
				.filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);
			port.post(job, transfer);
		}
	}

	private run(job: () => SectorJob) {
		return new Promise<SectorResult>((resolve) => {
			this.queue.push({ job, resolve });
			this.pump();
		});
	}

	async compute(
		store: TileStore,
		eye: Eye,
		opts: PoolOptions = {},
	): Promise<FastHorizonProfile & { timings: PoolTimings }> {
		const t0 = performance.now();
		const prep = await prepare(store, eye, opts);
		const t1 = performance.now();
		const step = opts.step ?? 0.05;
		const n = Math.round(360 / step);
		const shared = opts.shared ?? canShare();
		const nSec = Math.max(
			1,
			this.size * (opts.sectorsPerWorker ?? (shared ? 4 : 1)),
		);
		const peaks = prep.peaks ?? [];
		let mosaicMs = 0;
		let sharedMosaics: Mosaic[] | undefined;
		if (shared) {
			const tm = performance.now();
			sharedMosaics = buildMosaics(eye.lat, eye.lon, store, prep.spans, {
				mips: opts.mipSkip !== false,
				shared: true,
			});
			mosaicMs += performance.now() - tm;
		}
		const jobs: Promise<SectorResult>[] = [];
		const { osmPeaks: _o, snap: _s, rings: _r, ...march } = opts;
		for (let s = 0; s < nSec; s++) {
			const i0 = Math.round((s * n) / nSec);
			const i1 = Math.round(((s + 1) * n) / nSec);
			const az0 = i0 * step;
			const az1 = i1 * step;
			const secPeaks = peaks.filter(
				(p) => p.azimuth >= az0 && (p.azimuth < az1 || s === nSec - 1),
			);
			jobs.push(
				this.run(() => {
					const tm = performance.now();
					const mosaics =
						sharedMosaics ??
						buildMosaics(eye.lat, eye.lon, store, prep.spans, {
							az0,
							az1,
							mips: opts.mipSkip !== false,
						});
					mosaicMs += performance.now() - tm;
					return {
						id: this.next++,
						eye,
						opts: {
							...march,
							i0,
							i1,
							peaks: opts.osmPeaks ? secPeaks : undefined,
						},
						mosaics,
					};
				}),
			);
		}
		const results = await Promise.all(jobs);
		const elevation = new Float32Array(n);
		const distance = new Float32Array(n);
		const ridges: Ridge[][] = new Array(n);
		let outPeaks: PeakVisibility[] | undefined = opts.osmPeaks ? [] : undefined;
		let samples = 0;
		let skips = 0;
		let workerMipMs = 0;
		let workerMarchMs = 0;
		for (const r of results) {
			if (r.error) throw new Error(`horizon worker: ${r.error}`);
			const p = r.profile;
			elevation.set(p.elevation, p.i0);
			distance.set(p.distance, p.i0);
			for (let i = 0; i < p.ridges.length; i++) ridges[p.i0 + i] = p.ridges[i];
			if (outPeaks && p.peaks) outPeaks = outPeaks.concat(p.peaks);
			samples += p.stats.samples;
			skips += p.stats.skips;
			workerMipMs += r.mipMs;
			workerMarchMs += p.stats.ms;
		}
		outPeaks?.sort((a, b) => a.index - b.index);
		const t2 = performance.now();
		return {
			step,
			elevation,
			distance,
			ridges,
			i0: 0,
			peaks: outPeaks,
			stats: { azimuths: n, samples, skips, ms: t2 - t1 },
			timings: {
				loadMs: prep.loadMs,
				mosaicMs,
				marchMs: t2 - t1,
				totalMs: t2 - t0,
				workerMipMs,
				workerMarchMs,
			},
		};
	}

	terminate() {
		for (const p of this.ports) p.terminate();
	}
}

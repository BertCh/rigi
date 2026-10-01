/**
 * Browser bench + parity of the GPU horizon against horizon-fast's CPU march (the reference). Loaded by
 * scripts/gpu/horizon-bench.mjs inside headless Chromium:
 *
 *   const { benchPhoto } = await import('/src/lib/gpu/horizon/bench.ts');
 *   await benchPhoto({ id, lat, lon, h })
 *
 * Mosaics are the app's (LITE_RINGS, 120 km, full circle, max-mips), fetched straight from Mapterhorn.
 * Returns small JSON (no profiles).
 */
import { blobHeights, MAPTERHORN } from "#/lib/dem";
import { EARTH_R } from "#/lib/geodesy";
import {
	computeHorizonFast,
	type Eye,
	type FastHorizonOptions,
	type FastHorizonProfile,
} from "#/lib/horizon-fast/march";
import {
	DEFAULT_RINGS,
	LITE_RINGS,
	loadMosaics,
	type Mosaic,
	TileStore,
} from "#/lib/horizon-fast/mosaic";
import { getComputeDevice } from "../device";
import {
	computeHorizonGpu,
	lastGpuHorizonTiming,
	releaseHorizonGpu,
} from "./index";

const store = new TileStore({
	tileSize: MAPTERHORN.tileSize,
	maxZoom: MAPTERHORN.maxZoom,
	async load(k) {
		const r = await fetch(MAPTERHORN.url(k)).catch(() => undefined);
		if (!r) return undefined;
		if (r.status === 404 || r.status === 204) return null;
		if (!r.ok) return undefined;
		return blobHeights(await r.blob());
	},
});

const q = (xs: number[], p: number) => {
	if (!xs.length) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
};

/** Parity of one GPU profile against the CPU one. */
export function parity(cpu: FastHorizonProfile, gpu: FastHorizonProfile) {
	const dEl: number[] = [];
	const dRel: number[] = [];
	let emptyMismatch = 0;
	let over001 = 0;
	let signed = 0;
	const worst: {
		i: number;
		cpuEl: number;
		gpuEl: number;
		cpuD: number;
		gpuD: number;
	}[] = [];
	for (let i = 0; i < cpu.elevation.length; i++) {
		const a = cpu.elevation[i];
		const b = gpu.elevation[i];
		if (a === -90 || b === -90) {
			if (a !== b) emptyMismatch++;
			continue;
		}
		const e = Math.abs(a - b);
		dEl.push(e);
		signed += b - a;
		worst.push({
			i,
			cpuEl: a,
			gpuEl: b,
			cpuD: cpu.distance[i],
			gpuD: gpu.distance[i],
		});
		if (worst.length > 3) {
			worst.sort(
				(x, y) => Math.abs(y.gpuEl - y.cpuEl) - Math.abs(x.gpuEl - x.cpuEl),
			);
			worst.length = 3;
		}
		if (e > 0.01) over001++;
		const da = cpu.distance[i];
		const db = gpu.distance[i];
		dRel.push(Math.abs(da - db) / Math.max(da, 1));
	}
	return {
		n: cpu.elevation.length,
		emptyMismatch,
		maxDEl: Math.max(0, ...dEl),
		p99DEl: q(dEl, 0.99),
		medDEl: q(dEl, 0.5),
		over001,
		/** Mean signed GPU − CPU elevation (a bias, vs noise). */
		meanSignedDEl: signed / Math.max(1, dEl.length),
		medCpuEl: q(
			Array.from(cpu.elevation).filter((x) => x > -90),
			0.5,
		),
		medCpuD: q(
			Array.from(cpu.distance).filter((x) => x > 0),
			0.5,
		),
		worst,
		/** Fraction of azimuths whose skyline distance agrees within 1 %. */
		dist1pct: dRel.filter((x) => x <= 0.01).length / Math.max(1, dRel.length),
		distMedRel: q(dRel, 0.5),
		distP99Rel: q(dRel, 0.99),
	};
}

export interface BenchIn {
	id: string;
	lat: number;
	lon: number;
	h: number;
	/** Eyes in the batch test (default 343 = 7³ grid). */
	batch?: number;
	/** CPU eyes timed / checked from the batch (default 6). */
	cpuSample?: number;
	rings?: "lite" | "default";
	maxDistance?: number;
}

/** 7×7×7 grid of eyes around `e`: ±60 m E/N, ±30 m U (like an eye search around the GPS fix). */
function eyeGrid(e: Eye, count: number): Eye[] {
	const out: Eye[] = [];
	const n = Math.max(1, Math.round(Math.cbrt(count)));
	const mPerLat = (Math.PI * EARTH_R) / 180;
	const mPerLon = mPerLat * Math.cos((e.lat * Math.PI) / 180);
	for (let a = 0; a < n; a++)
		for (let b = 0; b < n; b++)
			for (let c = 0; c < n; c++) {
				const f = (i: number) => (n === 1 ? 0 : (2 * i) / (n - 1) - 1);
				out.push({
					lat: e.lat + (f(a) * 60) / mPerLat,
					lon: e.lon + (f(b) * 60) / mPerLon,
					h: e.h + f(c) * 30,
				});
			}
	return out;
}

/** Bit-level diff of two GPU profile batches: differing elevation / distance entries and stats. */
function bitDiff(a: FastHorizonProfile[], b: FastHorizonProfile[]) {
	let el = 0;
	let dist = 0;
	let stats = 0;
	const bits = (x: Float32Array) =>
		new Uint32Array(x.buffer, x.byteOffset, x.length);
	for (let j = 0; j < a.length; j++) {
		const ae = bits(a[j].elevation);
		const be = bits(b[j].elevation);
		const ad = bits(a[j].distance);
		const bd = bits(b[j].distance);
		if (ae.length !== be.length) el += Math.max(ae.length, be.length);
		for (let i = 0; i < ae.length; i++) if (ae[i] !== be[i]) el++;
		for (let i = 0; i < ad.length; i++) if (ad[i] !== bd[i]) dist++;
		if (
			a[j].stats.samples !== b[j].stats.samples ||
			a[j].stats.skips !== b[j].stats.skips ||
			a[j].step !== b[j].step ||
			a[j].i0 !== b[j].i0
		)
			stats++;
	}
	return { el, dist, stats, n: a.length };
}
const median = (x: number[]) =>
	[...x].sort((p, q) => p - q)[Math.floor(x.length / 2)];

export async function benchPhoto(o: BenchIn) {
	const device = await getComputeDevice();
	if (!device) throw new Error("no WebGPU compute device");
	const t0 = performance.now();
	const mosaics: Mosaic[] = await loadMosaics(o.lat, o.lon, store, {
		rings: o.rings === "default" ? DEFAULT_RINGS : LITE_RINGS,
		maxDistance: o.maxDistance ?? 120_000,
		mips: true,
	});
	const loadMs = performance.now() - t0;
	const eye: Eye = { lat: o.lat, lon: o.lon, h: o.h };
	// The app worker's options (horizon-fast-app.ts) plus the library defaults as a second config.
	const configs: Record<string, FastHorizonOptions> = {
		app: {
			step: 0.05,
			minDistance: 2,
			maxDistance: o.maxDistance ?? 120_000,
			noRidges: true,
		},
		defaults: { noRidges: true },
		noMipSkip: {
			step: 0.05,
			minDistance: 2,
			maxDistance: o.maxDistance ?? 120_000,
			noRidges: true,
			mipSkip: false,
		},
	};
	const res: Record<string, unknown> = {
		id: o.id,
		loadMs,
		mosaicMB: mosaics.reduce((a, m) => a + m.data.byteLength, 0) / 1e6,
		rings: mosaics.map((m) => `z${m.z} ${m.width}x${m.height}`),
	};
	let firstUpload = 0;
	let firstTotal = 0;
	for (const [name, opts] of Object.entries(configs)) {
		const c0 = performance.now();
		const cpu = computeHorizonFast(mosaics, eye, opts);
		const cpuMs = performance.now() - c0;
		const cold = await computeHorizonGpu(device, mosaics, [eye], opts);
		const coldT = lastGpuHorizonTiming;
		if (!firstTotal && coldT) {
			firstUpload = coldT.uploadMs;
			firstTotal = coldT.totalMs;
		}
		const warm: number[] = [];
		let g = cold[0];
		for (let r = 0; r < 3; r++) {
			g = (await computeHorizonGpu(device, mosaics, [eye], opts))[0];
			warm.push(lastGpuHorizonTiming?.totalMs ?? Number.NaN);
		}
		// the command-graph path (./graph.ts, the default) against the pooled path ({ graph: false }):
		// bit-identical, alternated timings
		const oldMs: number[] = [];
		const graphMs: number[] = [];
		let diff = bitDiff(
			[g],
			await computeHorizonGpu(device, mosaics, [eye], opts, { graph: false }),
		);
		for (let r = 0; r < 5; r++) {
			const a = await computeHorizonGpu(device, mosaics, [eye], opts, {
				graph: false,
			});
			oldMs.push(lastGpuHorizonTiming?.totalMs ?? Number.NaN);
			const b = await computeHorizonGpu(device, mosaics, [eye], opts, {
				graph: true,
			});
			graphMs.push(lastGpuHorizonTiming?.totalMs ?? Number.NaN);
			const d = bitDiff(a, b);
			diff = {
				el: diff.el + d.el,
				dist: diff.dist + d.dist,
				stats: diff.stats + d.stats,
				n: diff.n + d.n,
			};
		}
		res[name] = {
			graph: { diff, oldMedMs: median(oldMs), graphMedMs: median(graphMs) },
			cpuMs,
			gpuColdMs: coldT?.totalMs,
			gpuWarmMs: Math.min(...warm),
			cpuSamples: cpu.stats.samples,
			gpuSamples: g.stats.samples,
			cpuSkips: cpu.stats.skips,
			gpuSkips: g.stats.skips,
			parity: parity(cpu, g),
			coldEqualsWarm: cold[0].elevation.every((v, i) => v === g.elevation[i]),
		};
	}
	res.firstCallUploadMs = firstUpload;
	res.firstCallTotalMs = firstTotal;

	// Batch throughput (the eye-search shape), app options.
	const bOpts = configs.app;
	const eyes = eyeGrid(eye, o.batch ?? 343);
	const b0 = performance.now();
	const batch = await computeHorizonGpu(device, mosaics, eyes, bOpts, {
		graph: false,
	});
	const batchMs = performance.now() - b0;
	const batchChunks = lastGpuHorizonTiming?.chunks;
	// `batch` is the pooled path; the graph path on the batch (15 chunks of 24 eyes at 343 eyes: the
	// chunk overlap), alternated
	const bOld: number[] = [batchMs];
	const bGraph: number[] = [];
	let batchDiff = { el: 0, dist: 0, stats: 0, n: 0 };
	for (let r = 0; r < 3; r++) {
		const t = performance.now();
		const gb = await computeHorizonGpu(device, mosaics, eyes, bOpts, {
			graph: true,
		});
		bGraph.push(performance.now() - t);
		const d = bitDiff(batch, gb);
		batchDiff = {
			el: batchDiff.el + d.el,
			dist: batchDiff.dist + d.dist,
			stats: batchDiff.stats + d.stats,
			n: batchDiff.n + d.n,
		};
		if (r < 2) {
			const t2 = performance.now();
			const ob = await computeHorizonGpu(device, mosaics, eyes, bOpts, {
				graph: false,
			});
			bOld.push(performance.now() - t2);
			const d2 = bitDiff(batch, ob);
			batchDiff.el += d2.el;
			batchDiff.dist += d2.dist;
			batchDiff.stats += d2.stats;
		}
	}
	const sampleN = Math.min(eyes.length, o.cpuSample ?? 6);
	const stride = Math.max(1, Math.floor(eyes.length / sampleN));
	const worst = {
		maxDEl: 0,
		p99DEl: 0,
		medDEl: 0,
		dist1pct: 1,
		emptyMismatch: 0,
	};
	let cpuMs = 0;
	for (let s = 0; s < sampleN; s++) {
		const j = Math.min(eyes.length - 1, s * stride);
		const c0 = performance.now();
		const cpu = computeHorizonFast(mosaics, eyes[j], bOpts);
		cpuMs += performance.now() - c0;
		const p = parity(cpu, batch[j]);
		worst.maxDEl = Math.max(worst.maxDEl, p.maxDEl);
		worst.p99DEl = Math.max(worst.p99DEl, p.p99DEl);
		worst.medDEl = Math.max(worst.medDEl, p.medDEl);
		worst.dist1pct = Math.min(worst.dist1pct, p.dist1pct);
		worst.emptyMismatch += p.emptyMismatch;
	}
	res.batch = {
		eyes: eyes.length,
		gpuMs: batchMs,
		gpuMsPerEye: batchMs / eyes.length,
		chunks: batchChunks,
		graph: {
			diff: batchDiff,
			oldMedMs: median(bOld),
			graphMedMs: median(bGraph),
		},
		cpuMsPerEye: cpuMs / sampleN,
		cpuMsExtrapolated: (cpuMs / sampleN) * eyes.length,
		speedup: ((cpuMs / sampleN) * eyes.length) / batchMs,
		sampledParityWorst: worst,
	};
	releaseHorizonGpu(mosaics);
	store.clear();
	return res;
}

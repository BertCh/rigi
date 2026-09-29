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
		res[name] = {
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
	const batch = await computeHorizonGpu(device, mosaics, eyes, bOpts);
	const batchMs = performance.now() - b0;
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
		chunks: lastGpuHorizonTiming?.chunks,
		cpuMsPerEye: cpuMs / sampleN,
		cpuMsExtrapolated: (cpuMs / sampleN) * eyes.length,
		speedup: ((cpuMs / sampleN) * eyes.length) / batchMs,
		sampledParityWorst: worst,
	};
	releaseHorizonGpu(mosaics);
	store.clear();
	return res;
}

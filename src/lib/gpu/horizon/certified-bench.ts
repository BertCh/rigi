// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Browser side of scripts/gpu/horizon-cert-bench.mjs: f64 vs certified-f32 on one photo's eye.
 *
 *   const { benchCertified } = await import('/src/lib/gpu/horizon/certified-bench.ts');
 *   await benchCertified({ id, lat, lon, h })
 *
 * The app's horizon (LITE_RINGS mosaics to 120 km from Mapterhorn, 0.05° step, k = 0.13, 2 m minimum
 * distance) marched on the GPU, then:
 * - stage A (tan → degrees): computeHorizonGpu with precision "f64" vs "certified-f32", elevation and
 *   distance bits compared;
 * - stages B + C (ENU + 8192-column resample): skylineDirs "f64" vs "certified-f32" on the same profile,
 *   direction bits compared;
 * - the raw GPU certificates against the CPU emulation (certified-cpu.ts) of the same stages: per-output
 *   agreement of the flags (information: GPU division / sqrt need not round like the emulation's) and,
 *   where both certified, of the bits (must agree: both equal the f64 path);
 * - the device probe's verdict, and warm timings (median of 5).
 * Returns small JSON.
 */
import { blobHeights, MAPTERHORN } from "#/lib/dem";
import { REFRACTION_K } from "#/lib/geodesy";
import {
	LITE_RINGS,
	loadMosaics,
	type Mosaic,
	TileStore,
} from "#/lib/horizon-fast/mosaic";
import { getComputeDevice } from "../device";
import {
	certifiedRaw,
	lastCertStats,
	probeStrictIeee,
	skylineDirs,
} from "./certified";
import {
	emuStageA,
	emuStageB,
	emuStageC,
	enuLump,
	enuLumpRel,
	FLAG_CERT,
	packAzimuths,
	packColumns,
	packConsts,
	packProfile,
} from "./certified-cpu";
import { GPU_COLUMNS } from "./dirs-cpu";
import { computeHorizonGpu, releaseHorizonGpu } from "./index";

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

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[s.length >> 1];
};
function diffBits(a: Float32Array, b: Float32Array) {
	if (a.length !== b.length) return Math.max(a.length, b.length);
	const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
	const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
	let n = 0;
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++;
	return n;
}

export type CertBenchIn = { id: string; lat: number; lon: number; h: number };

export async function benchCertified(o: CertBenchIn) {
	const device = await getComputeDevice();
	if (!device) throw new Error("no WebGPU compute device");
	const probe = await probeStrictIeee(device);
	const mosaics: Mosaic[] = await loadMosaics(o.lat, o.lon, store, {
		rings: LITE_RINGS,
		maxDistance: 120_000,
	});
	const eye = { lat: o.lat, lon: o.lon, h: o.h };
	const opts = {
		step: 0.05,
		k: REFRACTION_K,
		maxDistance: 120_000,
		minDistance: 2,
		noRidges: true,
	};
	const job = { lat: o.lat, lon: o.lon, k: REFRACTION_K };
	try {
		// ---- stage A ----
		const t64: number[] = [];
		const tC: number[] = [];
		let p64 = (await computeHorizonGpu(device, mosaics, [eye], opts))[0];
		let pC = (
			await computeHorizonGpu(device, mosaics, [eye], {
				...opts,
				precision: "certified-f32",
			})
		)[0];
		const coldA = lastCertStats.elevations;
		for (let r = 0; r < 5; r++) {
			let t = performance.now();
			p64 = (await computeHorizonGpu(device, mosaics, [eye], opts))[0];
			t64.push(performance.now() - t);
			t = performance.now();
			pC = (
				await computeHorizonGpu(device, mosaics, [eye], {
					...opts,
					precision: "certified-f32",
				})
			)[0];
			tC.push(performance.now() - t);
		}
		const statsA = lastCertStats.elevations; // the last warm call
		const stageA = {
			samples: p64.elevation.length,
			elevationBitsDiffer: diffBits(p64.elevation, pC.elevation),
			distanceBitsDiffer: diffBits(p64.distance, pC.distance),
			ties: statsA?.ties ?? -1,
			fellBack: statsA?.fellBack,
			marchF64Ms: median(t64),
			marchCertifiedMs: median(tC),
			certGpuMs: statsA?.gpuMs ?? -1,
			certGpuColdMs: coldA?.gpuMs ?? -1,
			spotChecked: statsA?.spotChecked ?? 0,
		};

		// ---- stages B + C ----
		const d64: number[] = [];
		const dC: number[] = [];
		let r64 = await skylineDirs(device, p64, job, o.h, "f64");
		let rC = await skylineDirs(device, p64, job, o.h, "certified-f32");
		for (let r = 0; r < 5; r++) {
			let t = performance.now();
			r64 = await skylineDirs(device, p64, job, o.h, "f64");
			d64.push(performance.now() - t);
			t = performance.now();
			rC = await skylineDirs(device, p64, job, o.h, "certified-f32");
			dC.push(performance.now() - t);
		}
		const stageBC = {
			columns: GPU_COLUMNS.length,
			kept: r64.dirs.length / 3,
			dirsBitsDiffer: diffBits(r64.dirs, rC.dirs),
			ties: rC.stats.ties,
			fellBack: rC.stats.fellBack,
			f64Ms: median(d64),
			certifiedMs: median(dC),
			certGpuMs: rC.stats.gpuMs,
			certFinishMs: rC.stats.finishMs,
			spotChecked: rC.stats.spotChecked ?? 0,
		};

		// ---- raw GPU certificates vs the CPU emulation ----
		const n = p64.elevation.length;
		const td = new Float32Array(2 * n);
		for (let i = 0; i < n; i++) {
			// the march's t for stage A: tan of the f64 elevation (the GPU's own t is not kept here)
			td[2 * i] =
				p64.elevation[i] <= -90
					? -3e38
					: Math.tan((p64.elevation[i] * Math.PI) / 180);
			td[2 * i + 1] = p64.distance[i];
		}
		const gA = await certifiedRaw.stageAGpu(device, td, n);
		const eA = emuStageA(td, n);
		const gC = await certifiedRaw.stageBCGpu(device, p64, job, o.h);
		const consts = packConsts({ ...job, eyeH: o.h });
		const az = packAzimuths(p64.i0, n, p64.step);
		const samp = emuStageB(
			packProfile(p64),
			az,
			consts,
			n,
			enuLump(o.lat, o.lon),
			enuLumpRel(o.lat, o.lon),
		);
		const eC = emuStageC(
			samp,
			az,
			packColumns(p64.step, GPU_COLUMNS),
			consts,
			n,
			GPU_COLUMNS.length,
		);
		const agree = (g: Uint32Array, e: Uint32Array, stride: number) => {
			let gpuOnly = 0;
			let emuOnly = 0;
			let both = 0;
			let bothBitsDiffer = 0;
			for (let i = 0; i < g.length / stride; i++) {
				const fg = g[stride * i + stride - 1] & FLAG_CERT;
				const fe = e[stride * i + stride - 1] & FLAG_CERT;
				if (fg && fe) {
					both++;
					for (let k = 0; k < stride - 1; k++)
						if (g[stride * i + k] !== e[stride * i + k]) {
							bothBitsDiffer++;
							break;
						}
				} else if (fg) gpuOnly++;
				else if (fe) emuOnly++;
			}
			return { both, gpuOnly, emuOnly, bothBitsDiffer };
		};
		return {
			id: o.id,
			probe: {
				ok: probe.ok,
				ms: probe.ms,
				failures: probe.failures,
				worst: probe.worst,
				error: probe.error,
			},
			stageA,
			stageBC,
			gpuVsEmulation: {
				stageA: agree(gA, eA, 2),
				stageC: agree(gC, eC, 4),
			},
		};
	} finally {
		releaseHorizonGpu(mosaics);
	}
}

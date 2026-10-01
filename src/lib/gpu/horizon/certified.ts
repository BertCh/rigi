// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Certified-f32 horizon stages on the GPU (README.md "Certified f32"). Opt-in (`precision:
// "certified-f32"`; the default "f64" is the CPU path, unchanged). Outputs are bit-identical to the
// f64 path by construction: the GPU computes in double-f32 with a tracked error bound, certifies an
// output only when every value within the bound rounds to the same f32, and the CPU recomputes the
// rest with the f64 code (the tie path).
//
//   const { elevation } = await horizonElevations(device, td, n, "certified-f32");  // D7: tan → degrees
//   const { dirs } = await skylineDirs(device, prof, job, eyeH, "certified-f32");    // D8: ENU + resample
//
// Before the first certified call on a device, the shared strict-IEEE probe (../precision/ieee-probe.ts,
// cached per device) checks the f32 arithmetic the bounds assume. A failed probe, a missing device or any GPU
// error gives the f64 path (stats.fellBack says why).
//
// The kernels read plain storage buffers (td = the march's [t, d] pairs, prof = [elevation, distance]),
// so a later page-device horizon can bind the march output directly instead of these uploads. Each
// call is one core ComputeGraph run (group "horizon-cert"): A alone, or B → C with the per-sample
// buffer as a transient.
import { Buffer, type Device } from "@luma.gl/core";
import { cachedGraph } from "#/lib/gpu/core/graph";
import { defineKernel, warmKernelsAsync } from "#/lib/gpu/core/kernel";
import { pooledStorage, pooledUniform, withLease } from "#/lib/gpu/core/pool";
import { type IeeeProbe, probeStrictIeee } from "../precision/ieee-probe";
import {
	planSpotCheck,
	recordSpotCheck,
	SPOT_CHECKS,
	spotKey,
} from "../precision/spot-policy";
import { STAGE_A_WGSL, STAGE_B_WGSL, STAGE_C_WGSL } from "./certified.wgsl";
import {
	CERT_MAX_LAT,
	elevationF64,
	emuSampleB,
	emuStageA,
	emuStageC,
	enuLump,
	enuLumpRel,
	FLAG_CERT,
	finishStageA,
	finishStageC,
	type HorizonPrecision,
	NO_HIT_T,
	packAzimuths,
	packColumns,
	packConsts,
	packProfile,
} from "./certified-cpu";
import {
	GPU_COLUMNS,
	type SkylineJob,
	type SkylineProfile,
	skylineDirsF64,
} from "./dirs-cpu";

export type { HorizonPrecision };

const GROUP = "horizon-cert";
const LEASE = "horizon-cert";
const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
const STORAGE = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;

const opts = (label: string) => ({ group: GROUP, label });
export const K_CERT_A = defineKernel(
	"horizon-cert-a",
	STAGE_A_WGSL,
	[
		["u", "uniform"],
		["consts", "read-only-storage"],
		["td", "read-only-storage"],
		["outA", "storage"],
	],
	opts("horizon-cert-a"),
);
export const K_CERT_B = defineKernel(
	"horizon-cert-b",
	STAGE_B_WGSL,
	[
		["u", "uniform"],
		["consts", "read-only-storage"],
		["az", "read-only-storage"],
		["prof", "read-only-storage"],
		["samp", "storage"],
	],
	opts("horizon-cert-b"),
);
export const K_CERT_C = defineKernel(
	"horizon-cert-c",
	STAGE_C_WGSL,
	[
		["u", "uniform"],
		["consts", "read-only-storage"],
		["az", "read-only-storage"],
		["samp", "read-only-storage"],
		["cols", "read-only-storage"],
		["outC", "storage"],
	],
	opts("horizon-cert-c"),
);

/** Compiles the certified kernels and the probe without blocking (e.g. while tiles decode). Never rejects. */
export function warmCertifiedAsync(device: Device): Promise<void> {
	return Promise.all([
		warmKernelsAsync(device, GROUP),
		warmKernelsAsync(device, "precision-probe"),
	]).then(() => {});
}

/** The shared strict-IEEE probe (re-exported for the benches). */
export { probeStrictIeee };

/** The 32-byte uniform every certified kernel reads. */
function uniformWords(n: number, nCols = 0, lumpEnu = 0, lumpEnuRel = 0) {
	const b = new ArrayBuffer(32);
	const u = new Uint32Array(b);
	const f = new Float32Array(b);
	u[0] = n;
	u[1] = nCols;
	u[2] = 0; // opq's zero
	f[3] = NO_HIT_T;
	f[4] = lumpEnu;
	f[5] = lumpEnuRel;
	return b;
}

// ---------- stage A: tan → elevation degrees ----------

/** outA (bits, flag) per sample for the march's [t, d] pairs. */
async function stageAGpu(device: Device, td: Float32Array, n: number) {
	return withLease(LEASE, async () => {
		const { graph } = cachedGraph<{ n: number }>(
			device,
			GROUP,
			`a${n}`,
			(g) => {
				const u = g.importBuffer("u", 32, undefined, UNIFORM);
				const consts = g.importBuffer("consts", packConsts(null).byteLength);
				const tdH = g.importBuffer("td", n * 8);
				const outA = g.transientBuffer("outA", n * 8, STORAGE);
				g.addKernel({
					id: "a",
					spec: K_CERT_A,
					bindings: { u, consts, td: tdH, outA },
					workgroups: (p) => [Math.ceil(p.n / 64)],
					writes: { outA: "full" },
				});
				g.readNode("read", [outA]);
				return undefined;
			},
		);
		const { reads } = await graph.run(
			{ n },
			{
				buffers: {
					u: pooledUniform(device, `${LEASE}/u`, uniformWords(n)),
					consts: pooledStorage(device, `${LEASE}/consts`, packConsts(null)),
					td: pooledStorage(device, `${LEASE}/td`, td.subarray(0, 2 * n)),
				},
			},
		);
		const [out] = reads.read ?? [];
		if (!out) throw new Error("stage A: read node did not run");
		return new Uint32Array(out, 0, 2 * n);
	});
}

export type CertStats = {
	precision: HorizonPrecision;
	/** why a certified-f32 request ran the f64 path instead */
	fellBack?: string;
	/** outputs the GPU certified / sent to the tie path */
	certified: number;
	ties: number;
	gpuMs: number;
	finishMs: number;
	/** GPU-certified outputs re-derived on the CPU emulation this call (all must agree) */
	spotChecked?: number;
	/** this call ran the full spot check (SPOT_CHECKS outputs; ../precision/spot-policy.ts) */
	spotFull?: boolean;
	probe?: IeeeProbe;
};

/**
 * Certified outputs a full spot check re-derives on the CPU emulation (README "Per-call spot check");
 * how many a call checks is ../precision/spot-policy.ts's planSpotCheck (full or SPOT_LIGHT, never 0).
 */
export { SPOT_CHECKS };

/** Up to k distinct random indices among those where pick(i) holds. */
function sampleIndices(n: number, k: number, pick: (i: number) => boolean) {
	const all: number[] = [];
	for (let i = 0; i < n; i++) if (pick(i)) all.push(i);
	for (let i = 0; i < Math.min(k, all.length); i++) {
		const j = i + Math.floor(Math.random() * (all.length - i));
		[all[i], all[j]] = [all[j], all[i]];
	}
	return all.slice(0, Math.min(k, all.length));
}

/**
 * Stage A spot check: `k` (default SPOT_CHECKS) random GPU-certified samples through the emulation
 * (emuStageA). The GPU's certificates equal the emulation's bit for bit (bench), so any difference
 * means this shader on this device does not compute what the probe and the node check vouched for.
 * Returns the count checked, or a reason string on a mismatch.
 */
export function spotCheckA(
	td: Float32Array,
	outA: Uint32Array,
	n: number,
	k = SPOT_CHECKS,
) {
	const idx = sampleIndices(n, k, (i) => !!(outA[2 * i + 1] & FLAG_CERT));
	const sub = new Float32Array(2 * idx.length);
	idx.forEach((i, q) => {
		sub[2 * q] = td[2 * i];
		sub[2 * q + 1] = td[2 * i + 1];
	});
	const emu = emuStageA(sub, idx.length);
	for (let q = 0; q < idx.length; q++) {
		const i = idx[q];
		if (!(emu[2 * q + 1] & FLAG_CERT) || emu[2 * q] !== outA[2 * i])
			return `spot check: sample ${i} differs from the emulation`;
	}
	return idx.length;
}

/**
 * Stages B + C spot check: `k` (default SPOT_CHECKS) random GPU-certified columns, the samples they
 * read emulated on demand (the cost scales with k: ~64 columns read ~170 samples).
 */
export function spotCheckC(
	prof: SkylineProfile,
	job: SkylineJob,
	eyeH: number,
	outC: Uint32Array,
	packed: PackedBC = packBC(null, prof, job, eyeH),
	k = SPOT_CHECKS,
) {
	const n = prof.elevation.length;
	const nCols = GPU_COLUMNS.length;
	const cols = sampleIndices(nCols, k, (j) => !!(outC[4 * j + 3] & FLAG_CERT));
	const { consts, az, pr } = packed;
	const lumpEnu = enuLump(job.lat, job.lon);
	const lumpRel = enuLumpRel(job.lat, job.lon);
	const samp = new Float32Array(n * 8);
	const done = new Uint8Array(n);
	const ensure = (m: number) => {
		if (done[m]) return;
		done[m] = 1;
		emuSampleB(samp, m, pr, az, consts, lumpEnu, lumpRel);
	};
	const emu = emuStageC(samp, az, packed.cols, consts, n, nCols, {
		columns: cols,
		ensure,
	});
	for (const j of cols)
		for (let w = 0; w < 4; w++)
			if (emu[4 * j + w] !== outC[4 * j + w])
				return `spot check: column ${j} differs from the emulation`;
	return cols.length;
}

/** Stats of the latest certified-f32 request in this realm, including one that ran f64 (benches, the worker's stats). */
export let lastCertStats: { elevations?: CertStats; dirs?: CertStats } = {};

/** Ledger keys of the stages' pipelines (../precision/spot-policy.ts spotKey). */
export const spotKeyA = (device: Device) =>
	spotKey(device, "horizon-cert-a", STAGE_A_WGSL);
export const spotKeyBC = (device: Device) =>
	spotKey(device, "horizon-cert-bc", STAGE_B_WGSL + STAGE_C_WGSL);

/** Why certified-f32 cannot run on `device` (null = it can). */
async function cannotCertify(device: Device | null) {
	if (!device) return { why: "no GPU device" };
	const probe = await probeStrictIeee(device);
	if (!probe.ok)
		return {
			why: `device probe failed: ${probe.error ?? JSON.stringify(probe.failures)}`,
			probe,
		};
	return { why: null, probe };
}

/**
 * Elevation degrees (f32) of the march's [t, d] pairs: index.ts collect's `t ≤ −3e38 ? −90 :
 * atan(t) / DEG`, bit for bit, under either precision.
 */
export async function horizonElevations(
	device: Device | null,
	td: Float32Array,
	n: number,
	precision: HorizonPrecision = "f64",
): Promise<{ elevation: Float32Array; stats: CertStats }> {
	const f64 = (fellBack?: string, probe?: IeeeProbe) => {
		const t0 = performance.now();
		const elevation = new Float32Array(n);
		for (let i = 0; i < n; i++) elevation[i] = elevationF64(td[2 * i]);
		const stats: CertStats = {
			precision,
			...(fellBack ? { fellBack } : {}),
			certified: 0,
			ties: n,
			gpuMs: 0,
			finishMs: performance.now() - t0,
			...(probe ? { probe } : {}),
		};
		// a certified-f32 request that ran f64 is recorded too (the harnesses report why)
		if (precision !== "f64")
			lastCertStats = { ...lastCertStats, elevations: stats };
		return { elevation, stats };
	};
	if (precision === "f64" || n === 0) return f64();
	const { why, probe } = await cannotCertify(device);
	if (why || !device) return f64(why ?? "no device", probe);
	const key = spotKeyA(device);
	const plan = planSpotCheck(key);
	if (plan.disabled)
		return f64(
			`spot check failed earlier on this adapter: ${plan.disabled}`,
			probe,
		);
	try {
		const t0 = performance.now();
		const outA = await stageAGpu(device, td, n);
		const t1 = performance.now();
		const spot = spotCheckA(td, outA, n, plan.count);
		recordSpotCheck(key, plan, spot);
		if (typeof spot === "string") return f64(spot, probe);
		const { elevation, ties } = finishStageA(td, outA, n);
		const stats: CertStats = {
			precision,
			certified: n - ties,
			ties,
			gpuMs: t1 - t0,
			finishMs: performance.now() - t1,
			spotChecked: spot,
			spotFull: plan.full,
			probe,
		};
		lastCertStats = { ...lastCertStats, elevations: stats };
		return { elevation, stats };
	} catch (e) {
		console.warn("[gpu] certified horizon elevations failed, using f64", e);
		return f64(`GPU error: ${String(e)}`, probe);
	}
}

// ---------- stages B + C: skyline directions ----------

const colCache = new WeakMap<Device, { step: number; cols: Float32Array }>();
function columnsFor(device: Device, step: number) {
	const hit = colCache.get(device);
	if (hit && hit.step === step) return hit.cols;
	const cols = packColumns(step, GPU_COLUMNS);
	colCache.set(device, { step, cols });
	return cols;
}

/** The buffers stages B + C read (built once per call; the spot check reuses them). */
type PackedBC = {
	consts: Float32Array;
	az: Float32Array;
	pr: Float32Array;
	cols: Float32Array;
};
function packBC(
	device: Device | null,
	prof: SkylineProfile,
	job: SkylineJob,
	eyeH: number,
): PackedBC {
	return {
		consts: packConsts({ lat: job.lat, lon: job.lon, k: job.k, eyeH }),
		az: packAzimuths(prof.i0, prof.elevation.length, prof.step),
		pr: packProfile(prof),
		cols: device
			? columnsFor(device, prof.step)
			: packColumns(prof.step, GPU_COLUMNS),
	};
}

async function stageBCGpu(
	device: Device,
	prof: SkylineProfile,
	job: SkylineJob,
	eyeH: number,
	packed: PackedBC = packBC(device, prof, job, eyeH),
) {
	const n = prof.elevation.length;
	const nCols = GPU_COLUMNS.length;
	const { consts, az, pr, cols } = packed;
	return withLease(LEASE, async () => {
		const { graph } = cachedGraph<{ n: number; nCols: number }>(
			device,
			GROUP,
			`bc${n},${nCols}`,
			(gr) => {
				const u = gr.importBuffer("u", 32, undefined, UNIFORM);
				const c = gr.importBuffer("consts", consts.byteLength);
				const azH = gr.importBuffer("az", az.byteLength);
				const prH = gr.importBuffer("prof", pr.byteLength);
				const colsH = gr.importBuffer("cols", cols.byteLength);
				const samp = gr.transientBuffer("samp", n * 32, STORAGE);
				const outC = gr.transientBuffer("outC", nCols * 16, STORAGE);
				gr.addKernel({
					id: "b",
					spec: K_CERT_B,
					bindings: { u, consts: c, az: azH, prof: prH, samp },
					workgroups: (p) => [Math.ceil(p.n / 64)],
					writes: { samp: "full" },
				});
				gr.addKernel({
					id: "c",
					spec: K_CERT_C,
					bindings: { u, consts: c, az: azH, samp, cols: colsH, outC },
					workgroups: (p) => [Math.ceil(p.nCols / 64)],
					writes: { outC: "full" },
				});
				gr.readNode("read", [outC]);
				return undefined;
			},
		);
		const { reads } = await graph.run(
			{ n, nCols },
			{
				buffers: {
					u: pooledUniform(
						device,
						`${LEASE}/u`,
						uniformWords(
							n,
							nCols,
							enuLump(job.lat, job.lon),
							enuLumpRel(job.lat, job.lon),
						),
					),
					consts: pooledStorage(device, `${LEASE}/consts`, consts),
					az: pooledStorage(device, `${LEASE}/az`, az),
					prof: pooledStorage(device, `${LEASE}/prof`, pr),
					cols: pooledStorage(device, `${LEASE}/cols`, cols),
				},
			},
		);
		const [out] = reads.read ?? [];
		if (!out) throw new Error("stages B/C: read node did not run");
		return new Uint32Array(out, 0, nCols * 4);
	});
}

/**
 * The worker's ENU unit directions (dirs-cpu.ts skylineDirsF64), bit for bit, under either precision.
 * Requires n · step = 360 (the f64 path's wrap), like the worker.
 */
export async function skylineDirs(
	device: Device | null,
	prof: SkylineProfile,
	job: SkylineJob,
	eyeH: number,
	precision: HorizonPrecision = "f64",
): Promise<{ dirs: Float32Array; stats: CertStats }> {
	const f64 = (fellBack?: string, probe?: IeeeProbe) => {
		const t0 = performance.now();
		const dirs = skylineDirsF64(prof, job, eyeH);
		const stats: CertStats = {
			precision,
			...(fellBack ? { fellBack } : {}),
			certified: 0,
			ties: GPU_COLUMNS.length,
			gpuMs: 0,
			finishMs: performance.now() - t0,
			...(probe ? { probe } : {}),
		};
		if (precision !== "f64") lastCertStats = { ...lastCertStats, dirs: stats };
		return { dirs, stats };
	};
	if (precision === "f64") return f64();
	if (!(Math.abs(job.lat) <= CERT_MAX_LAT))
		return f64(
			`|latitude| > ${CERT_MAX_LAT}° (the latitude lump is unbounded near the poles)`,
		);
	const { why, probe } = await cannotCertify(device);
	if (why || !device) return f64(why ?? "no device", probe);
	const key = spotKeyBC(device);
	const plan = planSpotCheck(key);
	if (plan.disabled)
		return f64(
			`spot check failed earlier on this adapter: ${plan.disabled}`,
			probe,
		);
	try {
		const t0 = performance.now();
		const packed = packBC(device, prof, job, eyeH);
		const outC = await stageBCGpu(device, prof, job, eyeH, packed);
		const t1 = performance.now();
		const spot = spotCheckC(prof, job, eyeH, outC, packed, plan.count);
		recordSpotCheck(key, plan, spot);
		if (typeof spot === "string") return f64(spot, probe);
		const { dirs, ties } = finishStageC(prof, job, eyeH, outC);
		const stats: CertStats = {
			precision,
			certified: GPU_COLUMNS.length - ties,
			ties,
			gpuMs: t1 - t0,
			finishMs: performance.now() - t1,
			spotChecked: spot,
			spotFull: plan.full,
			probe,
		};
		lastCertStats = { ...lastCertStats, dirs: stats };
		return { dirs, stats };
	} catch (e) {
		console.warn("[gpu] certified skyline directions failed, using f64", e);
		return f64(`GPU error: ${String(e)}`, probe);
	}
}

/** Raw GPU outputs for benches: stage A's (bits, flag) and stage C's (bits ×3, flag). */
export const certifiedRaw = { stageAGpu, stageBCGpu };

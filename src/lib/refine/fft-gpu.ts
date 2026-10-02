// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU twin of init.ts's correlateCpu: the yaw correlations of every focal scale in ONE core
// ComputeGraph (group "refine-fft"), with luma GPUFFT1D doing the transforms.
//
//   upload real signals [H, H2, (W, WP, WX) × F]  (f32, 2 + 3F signals of M samples)
//   pack → GPUFFT1D(N2) → twiddle+transpose → GPUFFT1D(N1)         four-step forward (fourstep.ts)
//   product (4F pairs conj(Xa)·Xb, permuted order)
//   GPUFFT1D(N1, inverse) → twiddle+transpose → GPUFFT1D(N2, inverse)   four-step inverse, scale 1/M
//   gather the 2S+1 needed shifts, real part → read node (4F·(2S+1) f32)
//
// GPUFFT1D is limited to 2048 points, hence the four-step split for M = 8192 (N1 = 4, N2 = 2048);
// M ≤ 2048 is a single transform per signal (no twiddle stage). Twiddles are an f64-computed table
// (fourstep.ts twiddleTable) uploaded as f32. The result matches correlateCpu to f32 FFT accuracy
// (relative to max|C|, see scripts/gpu/refine-fft-dawn.ts), not bit for bit; the CPU path stays the
// reference and the fallback.
//
// Device caveat (found on macOS 14.1 / Apple Metal under Dawn, luma rigi.5): the Metal shader compiler
// miscompiles the `reverseLowBits` loop of GPUFFT1D's bit-reversal pass for some transform lengths
// (2^4, 2^6..2^8, 2^10, 2^11 returned garbage, 2^1..2^3, 2^5 and 2^9 were fine; the generated MSL is
// correct). A wrong shader gives wrong numbers, not an error, so correlateGpu spot-checks every result
// against direct f64 sums at three shifts, retries the split with 512-point transforms, and otherwise
// throws so refinePoseAsync uses the CPU. Buffers are pooled under "refine-fft/…" and the call holds the
// "refine-fft" lease from upload to readback.
import { Buffer, type Device } from "@luma.gl/core";
import { cachedGraph } from "#/lib/gpu/core/graph";
import { defineKernel } from "#/lib/gpu/core/kernel";
import { GPUFFT1D } from "#/lib/gpu/core/luma";
import { pooledStorage, pooledUniform, withLease } from "#/lib/gpu/core/pool";
import {
	DFT_FWD_WGSL,
	DFT_INV_WGSL,
	FFT_U,
	GATHER_WGSL,
	PACK_WGSL,
	PRODUCT_WGSL,
	TWIDDLE_FWD_WGSL,
	TWIDDLE_INV_WGSL,
} from "./fft-gpu.wgsl";
import { type FourStepPlan, planFourStep, twiddleTable } from "./fourstep";
import type { InitCorrelations, InitPrep } from "./init";

export const GROUP = "refine-fft";
export const K_PACK = defineKernel(
	"refine-fft-pack",
	PACK_WGSL,
	[
		["p", "uniform"],
		["x", "read-only-storage"],
		["a", "storage"],
	],
	{ group: GROUP, label: "refine-fft-pack" },
);
const twiddleLayout: [string, "uniform" | "read-only-storage" | "storage"][] = [
	["p", "uniform"],
	["a", "read-only-storage"],
	["tw", "read-only-storage"],
	["b", "storage"],
];
export const K_TWIDDLE_FWD = defineKernel(
	"refine-fft-twiddle-fwd",
	TWIDDLE_FWD_WGSL,
	twiddleLayout,
	{ group: GROUP, label: "refine-fft-twiddle-fwd" },
);
export const K_TWIDDLE_INV = defineKernel(
	"refine-fft-twiddle-inv",
	TWIDDLE_INV_WGSL,
	twiddleLayout,
	{ group: GROUP, label: "refine-fft-twiddle-inv" },
);
export const K_DFT_FWD = defineKernel(
	"refine-fft-dft-fwd",
	DFT_FWD_WGSL,
	twiddleLayout,
	{ group: GROUP, label: "refine-fft-dft-fwd" },
);
export const K_DFT_INV = defineKernel(
	"refine-fft-dft-inv",
	DFT_INV_WGSL,
	twiddleLayout,
	{ group: GROUP, label: "refine-fft-dft-inv" },
);
const K_PRODUCT = defineKernel(
	"refine-fft-product",
	PRODUCT_WGSL,
	[
		["p", "uniform"],
		["spec", "read-only-storage"],
		["prod", "storage"],
	],
	{ group: GROUP, label: "refine-fft-product" },
);
const K_GATHER = defineKernel(
	"refine-fft-gather",
	GATHER_WGSL,
	[
		["p", "uniform"],
		["y", "read-only-storage"],
		["out", "storage"],
	],
	{ group: GROUP, label: "refine-fft-gather" },
);

const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
const MAX_GROUPS = 65535;
const TWIDDLES = new Map<number, Float32Array>();

/** True when the GPU correlator can do a grid of M samples with the default 5 focal scales and a ±30° window. */
export function gpuCorrelationSupported(M: number, nFScales = 5): boolean {
	return planFourStep(M) !== null && (2 + 3 * nFScales) * M <= MAX_GROUPS * 256;
}

/** The graph for (M, F, nShift) and the given import capacities. */
function correlationGraph(
	device: Device,
	plan: FourStepPlan,
	dft: boolean,
	F: number,
	nShift: number,
	bytes: { x: number; tw: number },
) {
	const { M, N1, N2 } = plan;
	const nSig = 2 + 3 * F;
	const nPair = 4 * F;
	const key = `${M}x${N1}${dft ? "d" : ""}:${F}:${nShift}:${bytes.x}:${bytes.tw}`;
	return cachedGraph<void, undefined>(device, GROUP, key, (g) => {
		const u = g.importBuffer("p", FFT_U.byteLength, undefined, UNIFORM);
		const x = g.importBuffer("x", bytes.x);
		const tw = g.importBuffer("tw", bytes.tw);
		const sigBytes = nSig * M * 8;
		const pairBytes = nPair * M * 8;
		const A = g.transientBuffer("a", sigBytes);
		const B = g.transientBuffer("b", sigBytes);
		const C = g.transientBuffer("c", pairBytes);
		const D = g.transientBuffer("d", pairBytes);
		const out = g.transientBuffer("out", nPair * nShift * 4);
		const groups = (n: number): [number] => [Math.ceil(n / 256)];
		// complex views: ComputeGraph.view takes scalar formats only, float32x2 goes through the luma graph
		const cv = (h: typeof A, n: number) =>
			g.graph.createDataView(h, { format: "float32x2", length: n });
		g.addKernel({
			id: "pack",
			spec: K_PACK,
			bindings: { p: u, x, a: A },
			workgroups: groups(nSig * M),
		});
		const fwd = (id: string, src: typeof A, dst: typeof A, len: number) =>
			g.add(
				new GPUFFT1D({
					id,
					input: cv(src, nSig * M),
					output: cv(dst, nSig * M),
					length: len,
					batchCount: (nSig * M) / len,
					direction: "forward",
				}),
			);
		// the spectrum ends in B after both stages (or the single one)
		fwd("fft-a", A, B, N2);
		const spec = B;
		if (N1 > 1) {
			g.addKernel({
				id: "twiddle-fwd",
				spec: K_TWIDDLE_FWD,
				bindings: { p: u, a: B, tw, b: A },
				workgroups: groups(nSig * M),
			});
			if (dft)
				g.addKernel({
					id: "dft-fwd",
					spec: K_DFT_FWD,
					bindings: { p: u, a: A, tw, b: B },
					workgroups: groups(nSig * M),
				});
			else fwd("fft-b", A, B, N1);
		}
		g.addKernel({
			id: "product",
			spec: K_PRODUCT,
			bindings: { p: u, spec, prod: C },
			workgroups: groups(nPair * M),
		});
		const inv = (id: string, src: typeof A, dst: typeof A, len: number) =>
			g.add(
				new GPUFFT1D({
					id,
					input: cv(src, nPair * M),
					output: cv(dst, nPair * M),
					length: len,
					batchCount: (nPair * M) / len,
					direction: "inverse",
				}),
			);
		const y = D;
		if (N1 > 1) {
			if (dft)
				g.addKernel({
					id: "dft-inv",
					spec: K_DFT_INV,
					bindings: { p: u, a: C, tw, b: D },
					workgroups: groups(nPair * M),
				});
			else inv("ifft-a", C, D, N1);
			g.addKernel({
				id: "twiddle-inv",
				spec: K_TWIDDLE_INV,
				bindings: { p: u, a: D, tw, b: C },
				workgroups: groups(nPair * M),
			});
			inv("ifft-b", C, D, N2);
		} else inv("ifft-a", C, D, N2);
		g.addKernel({
			id: "gather",
			spec: K_GATHER,
			bindings: { p: u, y, out },
			workgroups: groups(nPair * nShift),
		});
		g.readNode("out", [{ buffer: out, size: nPair * nShift * 4 }]);
		g.compile();
		return undefined;
	});
}

/**
 * How a grid is split, tried in order (see the miscompile note above): `cap` is the largest GPUFFT1D
 * length (N2 = min(M, cap)); `dft` runs the N1-point stage as a direct DFT kernel (N1 <= 64) instead of
 * GPUFFT1D.
 */
export type GpuSplit = { cap: number; dft: boolean };
export const GPU_SPLITS: GpuSplit[] = [
	{ cap: 2048, dft: false },
	{ cap: 512, dft: false },
	{ cap: 512, dft: true },
];

/** Per device: grid size → the index into the splits that passed the spot check, or null when none did. */
const verified = new WeakMap<Device, Map<number, number | null>>();

/** The index into GPU_SPLITS that passed the spot check for this grid on this device (null: none did, undefined: not run yet). */
export const verifiedSplit = (device: Device, M: number) =>
	verified.get(device)?.get(M);

/**
 * The yaw correlations of every focal scale on the GPU (InitCorrelator contract: C1..C4 per
 * `prep.binned`, index k+S). Every result is spot-checked against direct f64 sums at three shifts
 * (a device whose compiler mishandles luma's FFT passes returns garbage, not an error): a failed
 * check retries the next split, and when none passes the grid size is remembered as bad for that
 * device and this throws, so refinePoseAsync takes the CPU path. Throws on any GPU problem.
 */
export async function correlateGpu(
	device: Device,
	prep: InitPrep,
	opts: { splits?: GpuSplit[] } = {},
): Promise<InitCorrelations[]> {
	const { M, S, binned } = prep;
	const F = binned.length;
	if (!gpuCorrelationSupported(M, F) || 2 * S + 1 > M)
		throw new Error(`refine-fft: unsupported problem M=${M} S=${S} F=${F}`);
	let memo = verified.get(device);
	if (!memo) {
		memo = new Map();
		verified.set(device, memo);
	}
	const known = memo.get(M);
	if (known === null)
		throw new Error(`refine-fft: no verified split for M=${M}`);
	const splits = opts.splits ?? GPU_SPLITS;
	const order = known !== undefined ? [known] : splits.keys();
	const tried = new Set<string>();
	for (const index of order) {
		const { cap, dft } = splits[index];
		const plan = planFourStep(M, cap);
		const id = `${plan?.N1}${dft}`;
		// a DFT stage is only for small N1, and N1 = 1 has no second stage to swap
		if (!plan || tried.has(id) || (dft && (plan.N1 === 1 || plan.N1 > 64)))
			continue;
		tried.add(id);
		const C = await runCorrelation(device, prep, plan, dft);
		if (spotCheck(prep, C)) {
			memo.set(M, index);
			return C;
		}
	}
	if (known !== undefined) memo.delete(M);
	else memo.set(M, null);
	throw new Error(`refine-fft: GPU correlation failed its spot check (M=${M})`);
}

/** Max relative deviation of the GPU correlations from direct f64 sums at shifts -S, 0, S (scale 1e-3 passes). */
function spotCheck(prep: InitPrep, C: InitCorrelations[]) {
	const { M, S, H, H2, binned } = prep;
	let hMax = 0;
	for (let j = 0; j < M; j++) hMax = Math.max(hMax, Math.abs(H[j]));
	const f = binned.length - 1;
	const B = binned[f];
	const sums = (a: Float64Array) => a.reduce((t, v) => t + Math.abs(v), 0);
	const scale = {
		C1: sums(B.WP) * hMax,
		C2: sums(B.W) * hMax,
		C3: sums(B.W) * hMax * hMax,
		C4: sums(B.WX) * hMax,
	};
	for (const k of [-S, 0, S]) {
		let c1 = 0;
		let c2 = 0;
		let c3 = 0;
		let c4 = 0;
		for (let j = 0; j < M; j++) {
			const u = (j + k + M) % M;
			c1 += B.WP[j] * H[u];
			c2 += B.W[j] * H[u];
			c3 += B.W[j] * H2[u];
			c4 += B.WX[j] * H[u];
		}
		const got = C[f];
		for (const [key, ref] of [
			["C1", c1],
			["C2", c2],
			["C3", c3],
			["C4", c4],
		] as const) {
			const v = got[key][k + S];
			if (!(Math.abs(v - ref) <= 1e-3 * Math.max(scale[key], 1e-12)))
				return false;
		}
	}
	return true;
}

/** One GPU run of the correlation graph for this split. */
function runCorrelation(
	device: Device,
	prep: InitPrep,
	plan: FourStepPlan,
	dft: boolean,
): Promise<InitCorrelations[]> {
	const { M, S, nShift, binned } = prep;
	const F = binned.length;
	const nSig = 2 + 3 * F;
	const nPair = 4 * F;
	const signals = new Float32Array(nSig * M);
	signals.set(prep.H, 0);
	signals.set(prep.H2, M);
	for (let f = 0; f < F; f++) {
		signals.set(binned[f].W, (2 + 3 * f) * M);
		signals.set(binned[f].WP, (3 + 3 * f) * M);
		signals.set(binned[f].WX, (4 + 3 * f) * M);
	}
	let tw = TWIDDLES.get(M);
	if (!tw) {
		tw = twiddleTable(M);
		TWIDDLES.set(M, tw);
	}
	return withLease(GROUP, async () => {
		const bufs = {
			p: pooledUniform(
				device,
				`${GROUP}/p`,
				FFT_U.pack({ M, N1: plan.N1, N2: plan.N2, nSig, nPair, nShift, S }),
			),
			x: pooledStorage(device, `${GROUP}/x`, signals),
			tw: pooledStorage(device, `${GROUP}/tw${M}`, tw),
		};
		const { graph } = correlationGraph(device, plan, dft, F, nShift, {
			x: bufs.x.byteLength,
			tw: bufs.tw.byteLength,
		});
		const { reads } = await graph.run(undefined, { buffers: bufs });
		const flat = new Float32Array(reads.out[0]);
		const take = (pair: number) => {
			const o = new Float64Array(nShift);
			for (let i = 0; i < nShift; i++) o[i] = flat[pair * nShift + i];
			return o;
		};
		return binned.map((_, f) => ({
			C1: take(4 * f),
			C2: take(4 * f + 1),
			C3: take(4 * f + 2),
			C4: take(4 * f + 3),
		}));
	});
}

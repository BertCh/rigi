// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU twin of init.ts's correlateCpu: the yaw correlations of every focal scale in ONE core
// ComputeGraph (group "refine-fft"), with luma GPUFFT1D doing the transforms.
//
//   upload real signals [H, H2, (W, WP, WX) × F]  (f32, 2 + 3F signals of M samples)
//   pack → GPUFFT1D(M, forward, batch 2 + 3F)
//   product (4F pairs conj(Xa)·Xb)
//   GPUFFT1D(M, inverse, batch 4F)      (scaled 1/M by luma)
//   gather the 2S+1 needed shifts, real part → read node (4F·(2S+1) f32)
//
// One transform per signal for any power-of-two M up to GPU_FFT1D_MAX_LENGTH (65536, luma rigi.6). The
// result matches correlateCpu to f32 FFT accuracy (relative to max|C|, see scripts/gpu/refine-fft-dawn.ts;
// per-length transform error in scripts/gpu/fft1d-lengths-dawn.ts), not bit for bit; the CPU path stays
// the reference and the fallback. History: luma rigi.5 limited GPUFFT1D to 2048 points (a four-step split)
// and its Metal bit reversal miscompiled at several lengths (a 512-point retry); rigi.6 fixed both and
// those workarounds are gone. A wrong shader still gives wrong numbers, not an error, so each result gets
// a cheap f64 spot check against direct sums (no extra readback); a device that fails it is remembered and
// refinePoseAsync uses the CPU. Buffers are pooled under "refine-fft/…" and the call holds the
// "refine-fft" lease from upload to readback.
import { Buffer, type Device } from "@luma.gl/core";
import { cachedGraph } from "#/lib/gpu/core/graph";
import { defineKernel } from "#/lib/gpu/core/kernel";
import { GPUFFT1D } from "#/lib/gpu/core/luma";
import { pooledStorage, pooledUniform, withLease } from "#/lib/gpu/core/pool";
import { isPow2 } from "./fft";
import { FFT_U, GATHER_WGSL, PACK_WGSL, PRODUCT_WGSL } from "./fft-gpu.wgsl";
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
/** luma's GPU_FFT1D_MAX_LENGTH (rigi.6); the constant is not re-exported through gpu/core/luma.ts. */
const MAX_LENGTH = 65536;

/** True when the GPU correlator can do a grid of M samples with the default 5 focal scales and a ±30° window. */
export function gpuCorrelationSupported(M: number, nFScales = 5): boolean {
	return (
		isPow2(M) &&
		M >= 2 &&
		M <= MAX_LENGTH &&
		(2 + 3 * nFScales) * M <= MAX_GROUPS * 256
	);
}

/** The graph for (M, F, nShift) and the given import capacity. */
function correlationGraph(
	device: Device,
	M: number,
	F: number,
	nShift: number,
	xBytes: number,
) {
	const nSig = 2 + 3 * F;
	const nPair = 4 * F;
	const key = `${M}:${F}:${nShift}:${xBytes}`;
	return cachedGraph<void, undefined>(device, GROUP, key, (g) => {
		const u = g.importBuffer("p", FFT_U.byteLength, undefined, UNIFORM);
		const x = g.importBuffer("x", xBytes);
		const A = g.transientBuffer("a", nSig * M * 8);
		const B = g.transientBuffer("b", nSig * M * 8);
		const C = g.transientBuffer("c", nPair * M * 8);
		const D = g.transientBuffer("d", nPair * M * 8);
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
		g.add(
			new GPUFFT1D({
				id: "fft",
				input: cv(A, nSig * M),
				output: cv(B, nSig * M),
				length: M,
				batchCount: nSig,
				direction: "forward",
			}),
		);
		g.addKernel({
			id: "product",
			spec: K_PRODUCT,
			bindings: { p: u, spec: B, prod: C },
			workgroups: groups(nPair * M),
		});
		g.add(
			new GPUFFT1D({
				id: "ifft",
				input: cv(C, nPair * M),
				output: cv(D, nPair * M),
				length: M,
				batchCount: nPair,
				direction: "inverse",
			}),
		);
		g.addKernel({
			id: "gather",
			spec: K_GATHER,
			bindings: { p: u, y: D, out },
			workgroups: groups(nPair * nShift),
		});
		g.readNode("out", [{ buffer: out, size: nPair * nShift * 4 }]);
		g.compile();
		return undefined;
	});
}

/** Devices whose result failed the spot check: the GPU path is refused for them from then on. */
const failedDevices = new WeakSet<Device>();

/**
 * The yaw correlations of every focal scale on the GPU (InitCorrelator contract: C1..C4 per
 * `prep.binned`, index k+S). The result is spot-checked against direct f64 sums at three shifts (a
 * device whose compiler mishandles luma's FFT passes returns garbage, not an error); on failure the
 * device is remembered as bad and this throws, so refinePoseAsync takes the CPU path. Throws on any
 * GPU problem.
 */
export async function correlateGpu(
	device: Device,
	prep: InitPrep,
): Promise<InitCorrelations[]> {
	const { M, S, binned } = prep;
	const F = binned.length;
	if (!gpuCorrelationSupported(M, F) || 2 * S + 1 > M)
		throw new Error(`refine-fft: unsupported problem M=${M} S=${S} F=${F}`);
	if (failedDevices.has(device))
		throw new Error("refine-fft: device failed the spot check");
	const C = await runCorrelation(device, prep);
	if (!spotCheck(prep, C)) {
		failedDevices.add(device);
		throw new Error(
			`refine-fft: GPU correlation failed its spot check (M=${M})`,
		);
	}
	return C;
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

/** One GPU run of the correlation graph. */
function runCorrelation(
	device: Device,
	prep: InitPrep,
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
	return withLease(GROUP, async () => {
		const bufs = {
			p: pooledUniform(
				device,
				`${GROUP}/p`,
				FFT_U.pack({ M, nSig, nPair, nShift, S }),
			),
			x: pooledStorage(device, `${GROUP}/x`, signals),
		};
		const { graph } = correlationGraph(device, M, F, nShift, bufs.x.byteLength);
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

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU RANSAC hypothesis scoring on a core ComputeGraph: K hypotheses × N correspondences in one
// dispatch, the arg-max on the GPU, and only the winner (16 B) read back.
//
//   SCORE  (one 64-thread workgroup per hypothesis, 2-D grid past 65535): inlier count + MSAC cost
//          over all N → score[k] = (count, bits(cost))
//   ARGMAX (one 256-thread workgroup): best k by count (chord, angular) or by lowest cost (reproj),
//          ties to the lowest k → best = (k, count, bits(cost), K)
//   read best
//
// The CPU twin is scoreBatchCpu in src/lib/pose6dof/ransac/batch.ts (same layouts, same modes, f64);
// the GPU computes in f32 (inputs are centred / unit, so the scores differ only for residuals within
// f32 rounding of the threshold). The drivers re-score the winner on the CPU in f64.
import { Buffer, type Device } from "@luma.gl/core";
import {
	type BatchWinner,
	HYP_STRIDE,
	type HypothesisBatch,
	winsByCost,
} from "#/lib/pose6dof/ransac/batch";
import { cachedGraph } from "../core/graph";
import { defineKernel } from "../core/kernel";
import {
	capacityFor,
	pooledStorage,
	pooledUniform,
	withLease,
} from "../core/pool";
import { defineUniformBlock } from "../core/uniform-block";

export const MODE_ID = { chord: 0, angular: 1, reproj: 2 } as const;
const MAX_X = 65535;

/** WGSL struct P. */
export const RANSAC_U = defineUniformBlock({
	n: "u32",
	k: "u32",
	mode: "u32",
	thr2: "f32",
	wx: "u32",
	byCost: "u32",
});

export const SCORE_WGSL = /* wgsl */ `
struct P { n: u32, k: u32, mode: u32, thr2: f32, wx: u32, byCost: u32 };
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> corr: array<vec4f>;
@group(0) @binding(2) var<storage, read> hyp: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> score: array<vec2u>;

var<workgroup> sc: array<u32, 64>;
var<workgroup> sf: array<f32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
	let k = wg.x + wg.y * prm.wx;
	let live = k < prm.k;
	let kk = min(k, prm.k - 1u);
	let h0 = hyp[kk * 4u];
	let h1 = hyp[kk * 4u + 1u];
	let h2 = hyp[kk * 4u + 2u];
	let h3 = hyp[kk * 4u + 3u];
	let r0 = h0.xyz;
	let r1 = vec3f(h0.w, h1.x, h1.y);
	let r2 = vec3f(h1.z, h1.w, h2.x);
	let t = h2.yzw;
	let fx = h3.x;
	let fy = h3.y;
	let thr2 = select(prm.thr2, h3.z, prm.mode == 1u);
	var cnt = 0u;
	var cost = 0.0;
	for (var i = li; i < prm.n; i += 64u) {
		let a = corr[i * 2u].xyz;
		let b = corr[i * 2u + 1u];
		let q = vec3f(dot(r0, a), dot(r1, a), dot(r2, a));
		var e2: f32;
		if (prm.mode == 0u) {
			let d = b.xyz - q;
			e2 = dot(d, d);
		} else if (prm.mode == 1u) {
			let d = normalize(vec3f(b.x / fx, b.y / fy, 1.0)) - q;
			e2 = dot(d, d);
		} else {
			let p = q + t;
			if (p.z > 0.0) {
				let du = fx * p.x / p.z - b.x;
				let dv = fy * p.y / p.z - b.y;
				e2 = du * du + dv * dv;
			} else {
				e2 = 3.0e38;
			}
		}
		if (e2 < thr2) {
			cnt += 1u;
			cost += e2;
		} else {
			cost += thr2;
		}
	}
	sc[li] = cnt;
	sf[li] = cost;
	workgroupBarrier();
	for (var s = 32u; s > 0u; s >>= 1u) {
		if (li < s) {
			sc[li] += sc[li + s];
			sf[li] += sf[li + s];
		}
		workgroupBarrier();
	}
	if (li == 0u && live) {
		score[k] = vec2u(sc[0], bitcast<u32>(sf[0]));
	}
}
`;

export const ARGMAX_WGSL = /* wgsl */ `
struct P { n: u32, k: u32, mode: u32, thr2: f32, wx: u32, byCost: u32 };
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> score: array<vec2u>;
@group(0) @binding(2) var<storage, read_write> best: array<vec4u>;

var<workgroup> bk: array<u32, 256>;
var<workgroup> bi: array<u32, 256>;

// higher key wins, then the lower index (cost >= 0, so its bits order like the floats)
fn keyOf(s: vec2u) -> u32 { return select(s.x, ~s.y, prm.byCost != 0u); }
fn better(ka: u32, ia: u32, kb: u32, ib: u32) -> bool { return ka > kb || (ka == kb && ia < ib); }

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
	var key = 0u;
	var idx = 0xffffffffu;
	for (var i = li; i < prm.k; i += 256u) {
		let kv = keyOf(score[i]);
		if (idx == 0xffffffffu || better(kv, i, key, idx)) {
			key = kv;
			idx = i;
		}
	}
	bk[li] = key;
	bi[li] = idx;
	workgroupBarrier();
	for (var s = 128u; s > 0u; s >>= 1u) {
		if (li < s) {
			let ok = bi[li + s];
			if (ok != 0xffffffffu && (bi[li] == 0xffffffffu || better(bk[li + s], ok, bk[li], bi[li]))) {
				bk[li] = bk[li + s];
				bi[li] = ok;
			}
		}
		workgroupBarrier();
	}
	if (li == 0u) {
		let i = bi[0];
		var s = vec2u(0u, 0x7f800000u);
		if (i != 0xffffffffu) { s = score[i]; }
		best[0] = vec4u(i, s.x, s.y, prm.k);
	}
}
`;

export const K_SCORE = defineKernel(
	"ransac-score",
	SCORE_WGSL,
	[
		["prm", "uniform"],
		["corr", "read-only-storage"],
		["hyp", "read-only-storage"],
		["score", "storage"],
	],
	{ group: "ransac", label: "ransac-score" },
);

export const K_ARGMAX = defineKernel(
	"ransac-argmax",
	ARGMAX_WGSL,
	[
		["prm", "uniform"],
		["score", "read-only-storage"],
		["best", "storage"],
	],
	{ group: "ransac", label: "ransac-argmax" },
);

type Params = { wx: number; wy: number };
const STORAGE = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;
const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
const OWNER = "ransac";

/** Correspondences as N × 2 vec4f (a.xyz, 0 | b.xyz or b.xy, 0). */
export function packCorrespondences(batch: HypothesisBatch): Float32Array {
	const { a, b, n } = batch;
	const out = new Float32Array(n * 8);
	const bw = batch.mode === "chord" ? 3 : 2;
	for (let i = 0; i < n; i++) {
		out[i * 8] = a[i * 3];
		out[i * 8 + 1] = a[i * 3 + 1];
		out[i * 8 + 2] = a[i * 3 + 2];
		for (let j = 0; j < bw; j++) out[i * 8 + 4 + j] = b[i * bw + j];
	}
	return out;
}

/** The uniform words and dispatch shape of a batch. */
export function packParams(batch: HypothesisBatch) {
	const wx = Math.min(batch.count, MAX_X);
	const wy = Math.ceil(batch.count / wx);
	const words = RANSAC_U.pack({
		n: batch.n,
		k: batch.count,
		mode: MODE_ID[batch.mode],
		thr2: batch.thr2,
		wx,
		byCost: winsByCost(batch.mode) ? 1 : 0,
	});
	return { wx, wy, words };
}

function graphFor(
	device: Device,
	bufs: Record<"prm" | "corr" | "hyp", Buffer>,
	scoreBytes: number,
) {
	const k = `c${bufs.corr.byteLength},h${bufs.hyp.byteLength},s${scoreBytes}`;
	return cachedGraph<Params>(device, "ransac", k, (g) => {
		const prm = g.importBuffer("prm", bufs.prm.byteLength, undefined, UNIFORM);
		const corr = g.importBuffer(
			"corr",
			bufs.corr.byteLength,
			undefined,
			STORAGE,
		);
		const hyp = g.importBuffer("hyp", bufs.hyp.byteLength, undefined, STORAGE);
		const score = g.transientBuffer("score", scoreBytes);
		const best = g.transientBuffer("best", 16);
		g.addKernel({
			id: "score",
			spec: K_SCORE,
			bindings: { prm, corr, hyp, score },
			workgroups: (p) => [p.wx, p.wy],
		});
		g.addKernel({
			id: "argmax",
			spec: K_ARGMAX,
			bindings: { prm, score, best },
			workgroups: [1],
			dependsOn: ["score"],
		});
		g.readNode("best", [{ buffer: best, size: 16 }]);
		return undefined;
	});
}

/**
 * The winner of `batch` scored on `device`: index, count and MSAC cost as the GPU computed them (f32).
 * `corr` may carry pre-packed correspondences (packCorrespondences) when one set is scored in many batches.
 */
export function scoreBatchGpu(
	device: Device,
	batch: HypothesisBatch,
	corr?: Float32Array,
): Promise<BatchWinner> {
	return withLease(OWNER, async () => {
		const hyps = new Float32Array(batch.count * HYP_STRIDE);
		for (let i = 0; i < hyps.length; i++) hyps[i] = batch.hyps[i];
		const { wx, wy, words } = packParams(batch);
		const bufs = {
			prm: pooledUniform(device, `${OWNER}/prm`, words),
			corr: pooledStorage(
				device,
				`${OWNER}/corr`,
				corr ?? packCorrespondences(batch),
			),
			hyp: pooledStorage(device, `${OWNER}/hyp`, hyps),
		};
		const { graph } = graphFor(device, bufs, capacityFor(batch.count * 8));
		await graph.compileAsync();
		const { reads } = await graph.run({ wx, wy }, { buffers: bufs });
		const u = new Uint32Array(reads.best[0]);
		const f = new Float32Array(reads.best[0]);
		const index = u[0] === 0xffffffff ? -1 : u[0];
		return { index, count: u[1], cost: f[2] };
	});
}

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The basin-gap grid's coarse rotation search on a core ComputeGraph (the GPU twin of rotSearchCpu in
// ./basin.ts): one graph per grid shape, one submit, only the winners read back.
//
//   SCORE (one 64-thread workgroup per candidate × node, 2-D dispatch: x = candidate, y = node, the
//          candidate range split over y past the dispatch limit): rotScore. The projected skyline's
//          top row per image column goes through a workgroup atomicMin on the f32 bits of v (v >= 0, so
//          the bits order like the floats), then S is summed over the columns.
//   TOP3  (one 256-thread workgroup per node): topHyps, three rounds of a parallel arg-max over the
//          finite candidates not within 1 deg (yaw wrapped, and pitch) of an accepted one, ties to the
//          lowest index (the stable sort).
//   read  the nodes × 3 × (score f32, index u32) winners.
//
// Buffers: the inputs (S, dirs, cand rotations, uniforms) are pooled imports under the "basin-grid"
// lease; `scores` (nodes × cands × 4 B) and `best` are graph transients. Clear audit: SCORE writes
// scores[node · K + cand] for every node < nodes and cand < K (its only return is the range guard,
// taken by the whole workgroup), TOP3 writes best[node · 3 + round] for every round, and the reads and
// TOP3 touch only those ranges: both are "full" writes and need no clear. Nothing is atomic in global
// memory.
//
// f32 against the f64 reference: the projection and the column sums are f32, so a candidate's score
// differs by ~1e-6 and an exact near-tie or a pixel-boundary projection can pick another candidate;
// the NMS compares the f32 yaw / pitch with a 1e-4 deg slack so a step that is exactly 1 deg is
// suppressed as on the CPU.
import type { Device } from "@luma.gl/core";
import { Buffer } from "@luma.gl/core";
import type { Pose } from "#/lib/camera";
import {
	type ComputeGraph,
	cachedGraph,
	releaseCachedGraphs,
} from "#/lib/gpu/core/graph";
import { defineKernel } from "#/lib/gpu/core/kernel";
import {
	capacityFor,
	pooledStorage,
	pooledUniform,
	withLease,
} from "#/lib/gpu/core/pool";
import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";
import { type GridScorer, type RotHyp, rotSearchCpu } from "./basin";
import { poseToR } from "./geometry";

/** cachedGraph group of the basin-grid graphs (also the lease / pool prefix). */
export const BASIN_GRAPH_GROUP = "basin-grid";
const MAX_GRAPHS = 2;
/** Edge-map width the workgroup row table holds. */
export const BASIN_MAX_W = 512;
const TOP = 3;
/** Score of a candidate with fewer than 20 directions in view (finite so it can be stored). */
const NEG = -3.4e38;

/** WGSL struct P (SCORE and TOP3). */
export const BASIN_U = defineUniformBlock({
	W: "f32",
	H: "f32",
	f: "f32",
	w: "u32",
	h: "u32",
	nDirs: "u32",
	K: "u32",
	nodes: "u32",
	wx: "u32",
	wyc: "u32",
});

const PARAMS = /* wgsl */ `
struct P { W: f32, H: f32, f: f32, w: u32, h: u32, nDirs: u32, K: u32, nodes: u32, wx: u32, wyc: u32 };
@group(0) @binding(0) var<uniform> prm: P;
`;

export const SCORE_WGSL = /* wgsl */ `${PARAMS}
@group(0) @binding(1) var<storage, read> S: array<f32>;
@group(0) @binding(2) var<storage, read> dirs: array<vec4f>;
@group(0) @binding(3) var<storage, read> cand: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> scores: array<f32>;

const INF_BITS = 0x7f800000u;
var<workgroup> rows: array<atomic<u32>, ${BASIN_MAX_W}>;
var<workgroup> inView: atomic<u32>;
var<workgroup> ssum: array<f32, 64>;
var<workgroup> scol: array<u32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
	let node = wg.y / prm.wyc;
	let k = wg.x + (wg.y % prm.wyc) * prm.wx;
	if (k >= prm.K || node >= prm.nodes) { return; }
	for (var i = li; i < prm.w; i += 64u) { atomicStore(&rows[i], INF_BITS); }
	if (li == 0u) { atomicStore(&inView, 0u); }
	workgroupBarrier();
	let r0 = cand[k * 4u].xyz;
	let r1 = cand[k * 4u + 1u].xyz;
	let r2 = cand[k * 4u + 2u].xyz;
	let wf = f32(prm.w);
	let hf = f32(prm.h);
	var kc = 0u;
	for (var i = li; i < prm.nDirs; i += 64u) {
		let d = dirs[node * prm.nDirs + i].xyz;
		let z = dot(r2, d);
		if (!(z > 0.1)) { continue; }
		let u = ((prm.W / 2.0 + prm.f * dot(r0, d) / z) / prm.W) * wf;
		let v = ((prm.H / 2.0 + prm.f * dot(r1, d) / z) / prm.H) * hf;
		if (!(u >= 0.0 && u < wf && v >= 0.0 && v < hf)) { continue; }
		kc += 1u;
		atomicMin(&rows[u32(u)], bitcast<u32>(v));
	}
	atomicAdd(&inView, kc);
	workgroupBarrier();
	var sum = 0.0;
	var ncol = 0u;
	for (var c = li; c < prm.w; c += 64u) {
		let rb = atomicLoad(&rows[c]);
		if (rb == INF_BITS) { continue; }
		ncol += 1u;
		sum += S[u32(bitcast<f32>(rb)) * prm.w + c];
	}
	ssum[li] = sum;
	scol[li] = ncol;
	workgroupBarrier();
	for (var s = 32u; s > 0u; s >>= 1u) {
		if (li < s) {
			ssum[li] += ssum[li + s];
			scol[li] += scol[li + s];
		}
		workgroupBarrier();
	}
	if (li == 0u) {
		var score = ${NEG.toExponential()};
		if (atomicLoad(&inView) >= 20u) {
			let nc = f32(scol[0]);
			score = ssum[0] / max(nc, 1.0) * min(1.0, nc / (0.6 * wf));
		}
		scores[node * prm.K + k] = score;
	}
}
`;

export const TOP3_WGSL = /* wgsl */ `${PARAMS}
@group(0) @binding(1) var<storage, read> cand: array<vec4f>;
@group(0) @binding(2) var<storage, read> scores: array<f32>;
@group(0) @binding(3) var<storage, read_write> best: array<vec2u>;

const NONE = 0xffffffffu;
var<workgroup> bs: array<f32, 256>;
var<workgroup> bi: array<u32, 256>;
var<workgroup> accYaw: array<f32, ${TOP}>;
var<workgroup> accPitch: array<f32, ${TOP}>;

fn dang(a: f32, b: f32) -> f32 {
	let d = a - b + 540.0;
	return d - 360.0 * floor(d / 360.0) - 180.0;
}
// higher score wins, then the lower index
fn better(sa: f32, ia: u32, sb: f32, ib: u32) -> bool {
	return sa > sb || (sa == sb && ia < ib);
}

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
	let node = wg.x;
	if (node >= prm.nodes) { return; }
	for (var round = 0u; round < ${TOP}u; round++) {
		var bestS = 0.0;
		var bestI = NONE;
		for (var c = li; c < prm.K; c += 256u) {
			let s = scores[node * prm.K + c];
			if (s <= -1.0e38) { continue; }
			let pc = cand[c * 4u + 3u];
			var ok = true;
			for (var a = 0u; a < round; a++) {
				if (abs(dang(pc.x, accYaw[a])) <= 1.0001 && abs(pc.y - accPitch[a]) <= 1.0001) { ok = false; }
			}
			if (!ok) { continue; }
			if (bestI == NONE || s > bestS) { bestS = s; bestI = c; }
		}
		bs[li] = bestS;
		bi[li] = bestI;
		workgroupBarrier();
		for (var st = 128u; st > 0u; st >>= 1u) {
			if (li < st) {
				let oi = bi[li + st];
				if (oi != NONE && (bi[li] == NONE || better(bs[li + st], oi, bs[li], bi[li]))) {
					bs[li] = bs[li + st];
					bi[li] = oi;
				}
			}
			workgroupBarrier();
		}
		if (li == 0u) {
			let i = bi[0];
			best[node * ${TOP}u + round] = vec2u(bitcast<u32>(select(0.0, bs[0], i != NONE)), i);
			if (i != NONE) {
				accYaw[round] = cand[i * 4u + 3u].x;
				accPitch[round] = cand[i * 4u + 3u].y;
			}
		}
		workgroupBarrier();
	}
}
`;

const spec = (id: string) => `basin-grid-${id}`;
export const K_SCORE = defineKernel(
	spec("score"),
	SCORE_WGSL,
	[
		["prm", "uniform"],
		["S", "read-only-storage"],
		["dirs", "read-only-storage"],
		["cand", "read-only-storage"],
		["scores", "storage"],
	],
	{ group: BASIN_GRAPH_GROUP, label: spec("score") },
);
export const K_TOP3 = defineKernel(
	spec("top3"),
	TOP3_WGSL,
	[
		["prm", "uniform"],
		["cand", "read-only-storage"],
		["scores", "read-only-storage"],
		["best", "storage"],
	],
	{ group: BASIN_GRAPH_GROUP, label: spec("top3") },
);

type Params = { wx: number; wyc: number; nodes: number; K: number };
const STORAGE = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;
const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
type Inputs = Record<"prm" | "S" | "dirs" | "cand", Buffer>;

/** Candidates as 4 × vec4f: R rows 0-2 (xyz), then (yaw, pitch). R in f64, rounded once. */
export function packCandidates(cands: Pose[]): Float32Array {
	const out = new Float32Array(cands.length * 16);
	cands.forEach((c, k) => {
		const R = poseToR(c);
		for (let r = 0; r < 3; r++)
			for (let j = 0; j < 3; j++) out[k * 16 + r * 4 + j] = R[r * 3 + j];
		out[k * 16 + 12] = c.yaw;
		out[k * 16 + 13] = c.pitch;
	});
	return out;
}

/** The nodes' horizon directions as nodes × nDirs vec4f. */
export function packNodeDirs(
	nodeDirs: Float64Array[],
	nDirs: number,
): Float32Array {
	const out = new Float32Array(nodeDirs.length * nDirs * 4);
	nodeDirs.forEach((d, n) => {
		for (let i = 0; i < nDirs; i++)
			for (let j = 0; j < 3; j++) out[(n * nDirs + i) * 4 + j] = d[i * 3 + j];
	});
	return out;
}

function graphFor(
	device: Device,
	bufs: Inputs,
	scoreBytes: number,
	bestBytes: number,
) {
	const k = `s${bufs.S.byteLength},d${bufs.dirs.byteLength},c${bufs.cand.byteLength},sc${scoreBytes},b${bestBytes}`;
	return cachedGraph<Params, void>(
		device,
		BASIN_GRAPH_GROUP,
		k,
		(g: ComputeGraph<Params>) => {
			const prm = g.importBuffer(
				"prm",
				bufs.prm.byteLength,
				undefined,
				UNIFORM,
			);
			const S = g.importBuffer("S", bufs.S.byteLength, undefined, STORAGE);
			const dirs = g.importBuffer(
				"dirs",
				bufs.dirs.byteLength,
				undefined,
				STORAGE,
			);
			const cand = g.importBuffer(
				"cand",
				bufs.cand.byteLength,
				undefined,
				STORAGE,
			);
			const scores = g.transientBuffer("scores", scoreBytes);
			const best = g.transientBuffer("best", bestBytes);
			g.addKernel({
				id: "score",
				spec: K_SCORE,
				bindings: { prm, S, dirs, cand, scores },
				workgroups: (p) => [p.wx, p.nodes * p.wyc],
			});
			g.addKernel({
				id: "top3",
				spec: K_TOP3,
				bindings: { prm, cand, scores, best },
				workgroups: (p) => [p.nodes],
				dependsOn: ["score"],
			});
			g.readNode("read", [{ buffer: best, size: (p) => p.nodes * TOP * 8 }]);
		},
		MAX_GRAPHS,
	);
}

/** Destroy this device's cached basin-grid graphs. */
export function releaseBasinGpu(device: Device): Promise<void> {
	return releaseCachedGraphs(device, BASIN_GRAPH_GROUP);
}

/** The GPU grid scorer: same contract as rotSearchCpu. Throws on a GPU failure (the caller falls back). */
export function rotSearchGpu(device: Device): GridScorer {
	return async (nodeDirs, cands, sk, W, H, f) => {
		const nodes = nodeDirs.length;
		const K = cands.length;
		if (!nodes || !K) return nodeDirs.map(() => []);
		// the workgroup row table holds BASIN_MAX_W columns
		if (sk.w > BASIN_MAX_W) return rotSearchCpu(nodeDirs, cands, sk, W, H, f);
		const nDirs = nodeDirs[0].length / 3;
		const maxDim = device.limits.maxComputeWorkgroupsPerDimension;
		const wx = Math.min(K, maxDim);
		const wyc = Math.ceil(K / wx);
		if (nodes * wyc > maxDim)
			throw new Error("basin-gpu: grid too large for one dispatch");
		return withLease(BASIN_GRAPH_GROUP, async () => {
			const S = new Float32Array(sk.S.length);
			for (let i = 0; i < S.length; i++) S[i] = sk.S[i];
			const bufs: Inputs = {
				prm: pooledUniform(
					device,
					`${BASIN_GRAPH_GROUP}/prm`,
					BASIN_U.pack({ W, H, f, w: sk.w, h: sk.h, nDirs, K, nodes, wx, wyc }),
				),
				S: pooledStorage(device, `${BASIN_GRAPH_GROUP}/S`, S),
				dirs: pooledStorage(
					device,
					`${BASIN_GRAPH_GROUP}/dirs`,
					packNodeDirs(nodeDirs, nDirs),
				),
				cand: pooledStorage(
					device,
					`${BASIN_GRAPH_GROUP}/cand`,
					packCandidates(cands),
				),
			};
			const { graph } = graphFor(
				device,
				bufs,
				capacityFor(nodes * K * 4),
				capacityFor(nodes * TOP * 8),
			);
			await graph.compileAsync();
			const { reads } = await graph.run(
				{ wx, wyc, nodes, K },
				{ buffers: bufs },
			);
			const raw = reads.read?.[0];
			if (!raw) throw new Error("basin-gpu: read node did not run");
			const f32 = new Float32Array(raw);
			const u32 = new Uint32Array(raw);
			return nodeDirs.map((_, n) => {
				const out: RotHyp[] = [];
				for (let r = 0; r < TOP; r++) {
					const index = u32[(n * TOP + r) * 2 + 1];
					if (index === 0xffffffff) break;
					out.push({
						score: f32[(n * TOP + r) * 2],
						pose: cands[index],
						index,
					});
				}
				return out;
			});
		});
	};
}

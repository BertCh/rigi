// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// solve coarse on a core ComputeGraph: the GPU path of coarseGpu / solveCoarse (./index.ts).
//
// One shape-keyed graph per (buffer capacities):
//   clear blocks → COARSE (./coarse.wgsl.ts: per (row, 256-pitch block) min + band)
//   → clear rows → FOLD (one thread per row: the f64 block fold below, exactly) → read rows (16 B/row)
// `blocks` and `rows` are graph transients (never imports), read through a read node.
//
// The rows equal the f64 CPU fold of the blocks (foldBlocks), by construction:
// - The row minimum g is folded on ordered bits (a total order that equals Math.min's on non-NaN
//   values, -0 < +0 included), not with WGSL min (NaN-indeterminate). Any NaN block minimum is flagged
//   explicitly, and the CPU then sets g = NaN, which takes the non-finite → CPU-grid fallback.
// - The band union needs `v > g + 2ε` with the CPU's f64 threshold. The fold decides it in f32 only when
//   |v − (g + f32(2ε))| exceeds 4u·(|g| + 2ε) (≥ 2× the f32-vs-f64 threshold error). A block within
//   that margin flags its row; any flagged row reruns the call on the blocks variant of the graph
//   (clear blocks → COARSE → read blocks, the same kernel on the same inputs) and folds the blocks on
//   the CPU in f64 (foldBlocks; stats.cpuFold). That is the fold the removed single-dispatch path ran
//   on the same kernel's output, so the rows the selection sees are the same either way.
// - The CPU selection (index.ts selectBounded) and its exact f64 re-scores are the same for both.
//
// The horizon profile (hz) stays on the GPU: one resident buffer per device, re-uploaded only when the
// profile's bits change (the unknown-pose worker solves 3 focal seeds × cascade stages on one profile).
// It is compared bitwise with a CPU copy on every call, so it can never serve a stale profile.
// A GPU-side import of scene-profile's march output was not done: the profile is atan()'d to degrees in
// f64 on the CPU, which a GPU node would not reproduce bit for bit.
import { Buffer, type Device } from "@luma.gl/core";
import { cachedGraph } from "../core/graph";
import { defineKernel } from "../core/kernel";
import { onLost } from "../core/lifecycle";
import { capacityFor, pooledStorage, pooledUniform } from "../core/pool";
import { type CoarsePlan, type CoarseResult, coarseCpu } from "./cpu";
import {
	type CoarseGpuOptions,
	type CoarseGpuResult,
	type CoarseGpuStats,
	K_COARSE,
	packCoarse,
	rowsDigest,
	selectBounded,
} from "./index";

/**
 * Per yaw row r (one thread): over its nBlk blocks (bitcast min, first, last, 0) →
 * rows[r] = (bits of g, band from, band to, flags); flags: 1 NaN block minimum, 2 a block too close to
 * the 2ε threshold to decide in f32, 4 the band is non-empty.
 */
export const FOLD_WGSL = /* wgsl */ `
struct FU { nYaw: u32, nBlk: u32, nPitch: u32, e2: f32 };
@group(0) @binding(0) var<uniform> fu: FU;
@group(0) @binding(1) var<storage, read> blocks: array<vec4u>;
@group(0) @binding(2) var<storage, read_write> rows: array<vec4u>;

// f32 bits → u32 key, monotone in the float order (-0 < +0; NaN handled by the caller)
fn key(b: u32) -> u32 { return select(b ^ 0x80000000u, ~b, (b & 0x80000000u) != 0u); }
fn unkey(k: u32) -> u32 { return select(~k, k ^ 0x80000000u, (k & 0x80000000u) != 0u); }
const U32_EPS = 5.9604644775390625e-8; // 2^-24

// @workgroup_size(64): one thread per yaw row; nBlk is small (⌈nPitch / 256⌉)
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	let r = gid.x;
	if (r >= fu.nYaw) { return; }
	let base = r * fu.nBlk;
	var mk = 0xffffffffu;
	var nan = false;
	for (var b = 0u; b < fu.nBlk; b++) {
		let bits = blocks[base + b].x;
		if ((bits & 0x7fffffffu) > 0x7f800000u) { nan = true; } else { mk = min(mk, key(bits)); }
	}
	if (nan) {
		rows[r] = vec4u(0x7fc00000u, 0u, 0u, 1u);
		return;
	}
	let gb = unkey(mk);
	let g = bitcast<f32>(gb);
	let thr = g + fu.e2;
	let margin = 4.0 * U32_EPS * (abs(g) + fu.e2);
	var lo = 0xffffffffu;
	var hi = 0u;
	var flags = 0u;
	for (var b = 0u; b < fu.nBlk; b++) {
		let e = blocks[base + b];
		if (e.y > e.z) { continue; }
		let v = bitcast<f32>(e.x);
		if (abs(v - thr) <= margin) { flags |= 2u; }
		if (v > thr) { continue; }
		lo = min(lo, e.y);
		hi = max(hi, e.z);
		flags |= 4u;
	}
	rows[r] = vec4u(gb, lo, hi, flags);
}
`;

export const K_FOLD = defineKernel(
	"solve-fold",
	FOLD_WGSL,
	[
		["fu", "uniform"],
		["blocks", "read-only-storage"],
		["rows", "storage"],
	],
	{ group: "solve", label: "solve-fold" },
);

type Params = { nYaw: number; nBlk: number };
const STORAGE = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;
const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
const key = (slot: string) => `solve/${slot}`;

// ---------- resident horizon profile ----------

type Resident = { buf: Buffer; bits: Uint32Array };
const resident = new WeakMap<Device, Resident>();

/** The device's hz buffer holding exactly `hz` (uploaded only when its bits changed). Call under the "solve" lease. */
function residentHz(
	device: Device,
	hz: Float32Array,
): { buf: Buffer; uploaded: boolean } {
	const bits = new Uint32Array(hz.buffer, hz.byteOffset, hz.length);
	let r = resident.get(device);
	if (r && r.bits.length === bits.length) {
		let same = true;
		for (let i = 0; i < bits.length; i++)
			if (r.bits[i] !== bits[i]) {
				same = false;
				break;
			}
		if (same) return { buf: r.buf, uploaded: false };
	}
	if (!r || r.buf.byteLength < hz.byteLength) {
		// the old buffer's users all finished: every call awaits its readback under the lease
		r?.buf.destroy();
		const created: Resident = {
			buf: device.createBuffer({
				id: "solve-hz-resident",
				usage: STORAGE,
				byteLength: capacityFor(hz.byteLength),
			}),
			bits: new Uint32Array(0),
		};
		if (!r)
			onLost(device, () => {
				resident.get(device)?.buf.destroy();
				resident.delete(device);
			});
		r = created;
		resident.set(device, r);
	}
	r.buf.write(hz);
	r.bits = bits.slice();
	return { buf: r.buf, uploaded: true };
}

/** Make `hz` the device's resident profile now (./fused.ts; call under the "solve" lease). */
export function primeResidentHz(device: Device, hz: Float32Array) {
	return residentHz(device, hz).uploaded;
}

/** Drop the resident profile of `device` (tests; the next call re-uploads). */
export function releaseResidentHz(device: Device) {
	resident.get(device)?.buf.destroy();
	resident.delete(device);
}

// ---------- the graph ----------

/**
 * The coarse graph for these buffers. `fold` (default): COARSE → FOLD → read rows; false: the blocks
 * variant, COARSE → read blocks (the CPU folds them in f64; `bufs.fu` is not used).
 */
function graphFor(
	device: Device,
	bufs: Record<string, Buffer>,
	blocksBytes: number,
	rowsBytes: number,
	fold = true,
) {
	const sizes = Object.entries(bufs).map(([k, b]) => `${k}${b.byteLength}`);
	const k = `${sizes.join(",")},blk${blocksBytes},${fold ? `rows${rowsBytes}` : "blocks"}`;
	return cachedGraph<Params>(device, "solve-coarse", k, (g) => {
		const imp = (id: string, usage = STORAGE) =>
			g.importBuffer(id, bufs[id].byteLength, undefined, usage);
		const u = imp("u", UNIFORM);
		const obs = imp("obs");
		const yaws = imp("yaws");
		const pitch = imp("pitch");
		const hz = imp("hz");
		const blocks = g.transientBuffer("blocks", blocksBytes);
		// COARSE writes every (row, block) entry it dispatches and FOLD every row, and the read covers
		// only those: the clears are the house rule for aliasing transients (cheap: ≤ 120 KB)
		g.clearNode("clear-blocks", {
			buffer: blocks,
			size: (p) => p.nYaw * p.nBlk * 16,
		});
		g.addKernel({
			id: "coarse",
			spec: K_COARSE,
			bindings: { u, obs, yaws, pitch, hz, rowMin: blocks },
			workgroups: (p) => [p.nYaw, p.nBlk],
			writes: { rowMin: "partial" },
		});
		if (!fold) {
			g.readNode("blocks", [
				{ buffer: blocks, size: (p) => p.nYaw * p.nBlk * 16 },
			]);
			g.compile();
			return undefined;
		}
		const fu = imp("fu", UNIFORM);
		const rows = g.transientBuffer("rows", rowsBytes);
		g.clearNode("clear-rows", { buffer: rows, size: (p) => p.nYaw * 16 });
		g.addKernel({
			id: "fold",
			spec: K_FOLD,
			bindings: { fu, blocks, rows },
			workgroups: (p) => [Math.ceil(p.nYaw / 64)],
			writes: { rows: "partial" },
		});
		g.readNode("rows", [{ buffer: rows, size: (p) => p.nYaw * 16 }]);
		g.compile();
		return undefined;
	});
}

/**
 * The f64 CPU fold of COARSE's blocks (nYaw × nBlk × (min, first, last, 0)) into the per-row
 * (g, band from, band to) the selection starts from: g is the minimum block minimum; the band is the
 * union of the bands of the blocks whose minimum is within 2ε of g (a block with a higher minimum
 * measured its band from that, so it still covers every pitch ≤ g + 2ε).
 */
export function foldBlocks(
	out: ArrayBuffer,
	nYaw: number,
	nBlk: number,
	nPitch: number,
	eps: number,
) {
	const bu = new Uint32Array(out);
	const bf = new Float32Array(out);
	const g = new Float64Array(nYaw);
	for (let r = 0; r < nYaw; r++) {
		let m = Number.POSITIVE_INFINITY;
		for (let b = 0; b < nBlk; b++) m = Math.min(m, bf[(r * nBlk + b) * 4]);
		g[r] = m;
	}
	const from = new Int32Array(nYaw).fill(nPitch);
	const to = new Int32Array(nYaw).fill(-1);
	for (let r = 0; r < nYaw; r++)
		for (let b = 0; b < nBlk; b++) {
			const o = (r * nBlk + b) * 4;
			if (bf[o] > g[r] + 2 * eps || bu[o + 1] > bu[o + 2]) continue;
			from[r] = Math.min(from[r], bu[o + 1]);
			to[r] = Math.max(to[r], bu[o + 2]);
		}
	return { g, from, to };
}

/** coarseGpu's body (call under the "solve" lease, as coarseGpu does). */
export async function coarseGraphOnce(
	device: Device,
	p: CoarsePlan,
	o: CoarseGpuOptions,
): Promise<CoarseGpuResult> {
	const t0 = performance.now();
	const nYaw = p.dys.length;
	const nPitch = p.dps.length;
	const stats: CoarseGpuStats = {
		uploadMs: 0,
		gpuMs: 0,
		selectMs: 0,
		nCells: nYaw * nPitch,
		rescored: 0,
		rescoredCells: 0,
		eps: 0,
		maxErr: 0,
		fellBack: false,
		readBytes: 0,
	};
	const fallback = () => {
		stats.fellBack = true;
		return { ...coarseCpu(p), ms: performance.now() - t0, stats };
	};
	const pk = packCoarse(p, o);
	if (!pk) return fallback();
	const { nBlk, hz, obU, yU, pitch, ub } = pk;
	stats.eps = pk.eps;

	const fb = new ArrayBuffer(16);
	new Uint32Array(fb).set([nYaw, nBlk, nPitch]);
	new Float32Array(fb)[3] = 2 * stats.eps;
	const hzR = residentHz(device, hz);
	stats.hzUploaded = hzR.uploaded;
	const bufs = {
		u: pooledUniform(device, key("u"), ub),
		fu: pooledUniform(device, key("g-fu"), fb),
		obs: pooledStorage(device, key("obs"), obU),
		yaws: pooledStorage(device, key("yaws"), yU),
		pitch: pooledStorage(device, key("pitch"), pitch),
		hz: hzR.buf,
	};
	const { graph } = graphFor(
		device,
		bufs,
		capacityFor(nYaw * nBlk * 16),
		capacityFor(nYaw * 16),
	);
	const t1 = performance.now();
	const { reads } = await graph.run({ nYaw, nBlk }, { buffers: bufs });
	const t2 = performance.now();
	stats.uploadMs = t1 - t0;
	stats.gpuMs = t2 - t1;
	stats.readBytes = nYaw * 16;
	const out = reads.rows[0];
	const ru = new Uint32Array(out);
	const rf = new Float32Array(out);
	let g = new Float64Array(nYaw);
	let from = new Int32Array(nYaw);
	let to = new Int32Array(nYaw);
	let close = false;
	for (let r = 0; r < nYaw; r++) {
		const f = ru[r * 4 + 3];
		g[r] = f & 1 ? Number.NaN : rf[r * 4];
		const has = (f & 4) !== 0;
		from[r] = has ? ru[r * 4 + 1] : nPitch;
		to[r] = has ? ru[r * 4 + 2] : -1;
		if (f & 2) close = true;
	}
	if (!g.every(Number.isFinite)) return fallback();
	if (close || o.forceCpuFold) {
		// a band threshold f32 cannot call: re-run COARSE on the blocks variant (same kernel, same
		// inputs, hz still resident) and fold its blocks in f64 on the CPU
		stats.cpuFold = true;
		const { fu: _, ...coarseBufs } = bufs;
		const blocks = graphFor(
			device,
			coarseBufs,
			capacityFor(nYaw * nBlk * 16),
			capacityFor(nYaw * 16),
			false,
		).graph;
		const r = await blocks.run({ nYaw, nBlk }, { buffers: coarseBufs });
		stats.readBytes += nYaw * nBlk * 16;
		({ g, from, to } = foldBlocks(
			r.reads.blocks[0],
			nYaw,
			nBlk,
			nPitch,
			stats.eps,
		));
		if (!g.every(Number.isFinite)) return fallback();
	}
	if (o.digest) stats.digest = rowsDigest(g, from, to);
	let res: CoarseResult;
	try {
		res = selectBounded(p, g, from, to, stats);
	} catch (e) {
		console.warn("[solve] bounded selection failed, using the CPU grid", e);
		return fallback();
	}
	stats.selectMs = performance.now() - t2;
	return { ...res, ms: performance.now() - t0, stats };
}

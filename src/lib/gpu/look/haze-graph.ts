// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU haze fit's two submits on core ComputeGraphs (fitHazeGpu(device, input) in ./haze.ts; the
// only GPU path since the pooled dispatch path was removed on 2026-10-01), plus fitHazeFromPrep, which
// finishes the fit from textures.ts hazePrepTex's GPU-resident outputs, and prepAndFitHazeTex, which
// runs that prep and the fit's GPU part under ONE haze lease (the safe entry point for textures).
//
// Submit 1 (one graph per N = W·H, cached, group "look-haze-prep"):
//   prep → dilh → clear counts → bin (atomic counts) → sel-init
//   → 3 × (clear hist → hist (atomic) → scan)                      radix select, 288 order statistics
//   → cnt → offs (GPUScan, exclusive) → starts → scatter             72-list stable compaction
//   → gather                                                         the airlight band's lin
//   → read node "head": counts, state, starts, the lists' first `head` slots, the band's lin
// Submit 2 (one graph, group "look-haze-grid"): grid → read node "err" (5 550 floats).
// Between them the CPU middle stage and after submit 2 the arg-min + refinement run in f64 on the CPU,
// unchanged (haze.ts hazeFitTail): the round trip is inherent (the grid's inputs come from f64 code).
//
// Determinism (the removed dispatch path gave the same bits; look-bench compares with the CPU fit):
// - Every node is one of haze.ts's kernel specs, in a fixed order with fixed workgroup counts.
//   Consecutive nodes share a compute pass; WebGPU orders dispatches and their storage writes within
//   a pass exactly as across passes.
// - Custom kernels plus one luma primitive, the lists' exclusive GPUScan (haze.ts addListOffsets):
//   u32 adds only, so subgroup / tree order cannot change a bit. No float sums. Radix select (288 concurrent selections) and the 72-way compaction do not map onto
//   GPUHistogram / GPUCompaction (luma-master-design §2.4).
// - Transients are never zeroed and alias: counts and hist are the only read-modify-write transients
//   (atomics), each has a clear node before every use (compile() lints it: writes: "atomic"). Every
//   other transient is fully written by the node that first touches it (lin, flags, flagsH, bins per
//   pixel; state per selection; blk per (list, block) by cnt; offs per (list, block) by the scan;
//   starts by starts), so aliased bytes are never read.
// - Imports (inputs and the lists, which the tail read may need after the submit) are pooled buffers
//   bound with the run's exact byte ranges. No kernel uses arrayLength(), so the binding size does
//   not reach the numerics.
// - Min / max / NaN: the graph adds no min/max. The kernels' own min/max/clamp are integer (indices,
//   bins, digits) except the grid's clamp(select(0, num/den, den > 1e-12), 0, A), unchanged. The
//   f32 order statistics are selected on u32 bit patterns (lin ≥ 0). The grid's arg-min is JS
//   (haze.ts hazeFitTail): `e < gMin` / `e <= tol` are false for NaN, so NaN cells are never
//   candidates (all NaN: no candidate, the default start), as before.
//
// The first read (head) holds `head` list slots; lists longer than that need a second, exact-length
// read (one more round trip). The head is adaptive: the last run's list total per device (as a
// fraction of N) × 1.5 + 1 024 (the look photos' totals span 0.050–0.070·N, so a switch between
// photos rarely overflows it), 0.27·N + 512 on a device's first run. The fit does not depend on the head (the tail read completes the lists; the
// look bench forces a 64-slot head). No GPU condition / indirect dispatch: the only remaining round
// trips end in CPU reads whose sizes are CPU-side (WebGPU copy sizes), and every GPU consumer's
// dispatch size is already known on the CPU.
import { Buffer, type Device, Texture } from "@luma.gl/core";
import type { Vec3 } from "../../look/atmosphere";
import type { HazeFit, HazeFitInput } from "../../look/haze-fit";
import { type CachedGraph, cachedGraph, type GraphRange } from "../core/graph";
import type { GraphBufferHandle } from "../core/luma";
import {
	addListOffsets,
	airlightBand,
	gridUploads,
	HM_PRIOR,
	hazeFitTail,
	K_HZ_BIN,
	K_HZ_CNT,
	K_HZ_DILH,
	K_HZ_GATHER,
	K_HZ_GRID,
	K_HZ_HIST,
	K_HZ_PREP,
	K_HZ_SCAN,
	K_HZ_SCATTER,
	K_HZ_SEL_INIT,
	NBINS,
	type Prep,
	pointAtOf,
	prepUploads,
	SCAN_GROUPS,
	SRGB_LUT,
	statOf,
} from "./haze";
import { BLOCK, BUCKETS, LISTS, SEL } from "./haze.wgsl";
import {
	pooledStorage,
	pooledUniform,
	type ReadRange,
	readBack,
	withLease,
} from "./kernel";
import {
	type HazePrepResult,
	type HazeTexInput,
	hazePrepGen,
	hazePrepTexThen,
} from "./textures";

const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
const STORAGE = Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST;
/** textures.ts slots are STORAGE | COPY_SRC | COPY_DST; ask for what the graph uses */
const PREP_IN = Buffer.STORAGE | Buffer.COPY_SRC;
/** cached prep / compaction graphs per device (one per N; the look's N is fixed per window size) */
const MAX_SHAPES = 2;

/** Last graph-path run's list statistics (for the bench). */
export const hazeGraphStats: {
	head: number;
	total: number;
	tail: boolean;
	cacheHit: boolean;
	/** last prepGraph: uploads + cache lookup, then run + read (+ tail) */
	ms?: { upload: number; run: number };
	/** compiled stats of the last prep graph: logical vs physical transient bytes */
	transientBytes?: { logical: number; physical: number };
} = { head: 0, total: 0, tail: false, cacheHit: false };

// ---------- adaptive first-read length ----------

const lastFraction = new WeakMap<Device, number>();

/** List slots in the first read: explicit, else from the device's last total, else 0.27·N + 512. */
export function headFor(device: Device, N: number, listHead?: number): number {
	const f = lastFraction.get(device);
	const est =
		listHead ??
		(f === undefined
			? Math.ceil(0.27 * N) + 512
			: Math.ceil(1.5 * f * N) + 1024);
	return Math.min(3 * N, Math.max(1, Math.floor(est)));
}

const noteTotal = (device: Device, N: number, total: number) =>
	lastFraction.set(device, total / Math.max(1, N));

/** The lists of one run: the head read plus (when it overflowed) the tail read, as one array pair. */
function joinLists(
	head: [ArrayBuffer, ArrayBuffer],
	tail: [ArrayBuffer, ArrayBuffer] | null,
	guess: number,
	total: number,
) {
	let idx = new Uint32Array(head[0]);
	let val = new Float32Array(head[1]);
	if (tail) {
		const i2 = new Uint32Array(total);
		i2.set(idx);
		i2.set(new Uint32Array(tail[0]), guess);
		const v2 = new Float32Array(total);
		v2.set(val);
		v2.set(new Float32Array(tail[1]), guess);
		idx = i2;
		val = v2;
	}
	return { idx, val };
}

// ---------- submit 1 ----------

type PrepParams = {
	W: number;
	H: number;
	N: number;
	nBlk: number;
	K: number;
	head: number;
	photoBytes: number;
};

/** A binding of the run's first `size(p)` bytes (4-byte padded) of an import. */
const at = <P>(
	buffer: GraphBufferHandle,
	size: (p: P) => number,
): GraphRange<P> => ({
	buffer,
	size: (p: P) => Math.ceil(size(p) / 4) * 4,
});

function prepGraphFor(
	device: Device,
	N: number,
): CachedGraph<PrepParams, undefined> {
	return cachedGraph<PrepParams, undefined>(
		device,
		"look-haze-prep",
		`n${N}`,
		(g) => {
			const nBlk = Math.ceil(N / BLOCK);
			const uni = (id: string, bytes: number) =>
				g.importBuffer(id, bytes, undefined, UNIFORM);
			// per-run exact ranges of pooled imports (declared at 4 B: one graph for any photo size)
			const imp = (id: string) => g.importBuffer(id, 4, undefined, STORAGE);
			const prm = uni("prm", 48);
			const pass = [0, 1, 2].map((p) => uni(`pass${p}`, 16));
			const cprm = uni("cprm", 16);
			const photo = at<PrepParams>(imp("photo"), (p) => p.photoBytes);
			const xb = at<PrepParams>(imp("xb"), (p) => p.W * 8);
			const yb = at<PrepParams>(imp("yb"), (p) => p.H * 8);
			const lut = at<PrepParams>(imp("lut"), () => 256 * 4);
			const range = at<PrepParams>(imp("range"), (p) => p.N * 4);
			const psky = at<PrepParams>(imp("psky"), (p) => p.N * 4);
			const fgm = at<PrepParams>(imp("fgm"), (p) => Math.ceil(p.N / 32) * 4);
			const skyIdx = at<PrepParams>(imp("skyIdx"), (p) => Math.max(1, p.K) * 4);
			const outIdxH = imp("outIdx");
			const outValH = imp("outVal");
			const skyOutH = imp("skyOut");
			const outIdx = at<PrepParams>(outIdxH, (p) => 3 * p.N * 4);
			const outVal = at<PrepParams>(outValH, (p) => 3 * p.N * 4);
			const skyOut = at<PrepParams>(skyOutH, (p) => Math.max(1, 3 * p.K) * 4);
			const lin = g.transientBuffer("lin", N * 12);
			const flags = g.transientBuffer("flags", N * 4);
			const flagsH = g.transientBuffer("flagsH", N * 4);
			const bins = g.transientBuffer("bins", N * 4);
			const counts = g.transientBuffer("counts", NBINS * 4);
			const state = g.transientBuffer("state", SEL * 8);
			const hist = g.transientBuffer("hist", SEL * BUCKETS * 4);
			const blk = g.transientBuffer("blk", nBlk * LISTS * 4);
			const offs = g.transientBuffer("offs", nBlk * LISTS * 4);
			const starts = g.transientBuffer("starts", (LISTS + 1) * 4);
			const groups: [number] = [Math.ceil(N / 256)];
			const selGroups: [number] = [Math.ceil(SEL / 64)];
			const blkGroups: [number] = [Math.ceil(nBlk / 64)];
			g.addKernel({
				id: "prep",
				spec: K_HZ_PREP,
				bindings: { prm, photo, xb, yb, lut, range, fgm, lin, flags },
				workgroups: groups,
			});
			g.addKernel({
				id: "dilh",
				spec: K_HZ_DILH,
				bindings: { prm, flags, outf: flagsH },
				workgroups: groups,
			});
			g.clearNode("clear-counts", counts);
			g.addKernel({
				id: "bin",
				spec: K_HZ_BIN,
				bindings: { prm, flagsH, range, psky, bins, counts },
				workgroups: groups,
				writes: { counts: "atomic" },
			});
			g.addKernel({
				id: "sel-init",
				spec: K_HZ_SEL_INIT,
				bindings: { counts, state },
				workgroups: selGroups,
			});
			for (let p = 0; p < 3; p++) {
				g.clearNode(`clear-hist${p}`, hist);
				g.addKernel({
					id: `hist${p}`,
					spec: K_HZ_HIST,
					bindings: { prm: pass[p], bins, lin, state, hist },
					workgroups: groups,
					writes: { hist: "atomic" },
				});
				g.addKernel({
					id: `scan${p}`,
					spec: K_HZ_SCAN,
					bindings: { prm: pass[p], hist, state },
					workgroups: [SCAN_GROUPS],
				});
			}
			g.addKernel({
				id: "cnt",
				spec: K_HZ_CNT,
				bindings: { prm: cprm, bins, lin, state, blk },
				workgroups: blkGroups,
			});
			addListOffsets(g, { cprm, blk, offs, starts }, nBlk);
			g.addKernel({
				id: "scatter",
				spec: K_HZ_SCATTER,
				bindings: { prm: cprm, bins, lin, state, offs, outIdx, outVal },
				workgroups: blkGroups,
				// only [0, total) is written and only [0, total) is read (imports, not transients)
				writes: { outIdx: "full", outVal: "full" },
			});
			g.addKernel({
				id: "gather",
				spec: K_HZ_GATHER,
				bindings: { prm: cprm, idx: skyIdx, lin, outv: skyOut },
				// K = 0: one idle workgroup (every invocation returns), nothing read back
				workgroups: (p) => [Math.max(1, Math.ceil(p.K / 64))],
			});
			g.readNode("head", [
				counts,
				state,
				starts,
				{ buffer: outIdxH, size: (p) => p.head * 4 },
				{ buffer: outValH, size: (p) => p.head * 4 },
				{ buffer: skyOutH, size: (p) => 3 * p.K * 4 },
			]);
			return undefined;
		},
		MAX_SHAPES,
	);
}

/** Submit 1: per-pixel prep, bins, the percentile order statistics and the compacted lists. */
export function prepGraph(
	device: Device,
	photo: HazeFitInput["photo"],
	W: number,
	H: number,
	range: Float32Array,
	pSky: Float32Array,
	fgBits: Uint32Array,
	rad: number,
	fgRad: number,
	skyIdx: Uint32Array,
	listHead?: number,
): Promise<Prep> {
	const N = W * H;
	const { xb, yb, words } = prepUploads(photo, W, H, rad, fgRad);
	const K = skyIdx.length;
	const nBlk = Math.ceil(N / BLOCK);
	return withLease("look-haze", async () => {
		const tu = performance.now();
		const key = (k: string) => `look-haze/g/${k}`;
		const up = (k: string, data: ArrayBufferView) =>
			pooledStorage(device, key(k), data);
		const out = (k: string, bytes: number) =>
			pooledStorage(device, key(k), bytes, { zero: false });
		const head = headFor(device, N, listHead);
		const buffers = {
			prm: pooledUniform(device, key("prm"), words),
			pass0: pooledUniform(device, key("pass0"), new Uint32Array([W, H, 0, 0])),
			pass1: pooledUniform(device, key("pass1"), new Uint32Array([W, H, 1, 0])),
			pass2: pooledUniform(device, key("pass2"), new Uint32Array([W, H, 2, 0])),
			cprm: pooledUniform(
				device,
				key("cprm"),
				new Uint32Array([N, nBlk, K, 0]),
			),
			photo: up(
				"photo",
				new Uint8Array(
					photo.data.buffer,
					photo.data.byteOffset,
					photo.data.byteLength,
				),
			),
			xb: up("xb", xb),
			yb: up("yb", yb),
			lut: up("lut", SRGB_LUT),
			range: up("range", range),
			psky: up("psky", pSky),
			fgm: up("fgm", fgBits),
			skyIdx: up("skyIdx", K ? skyIdx : new Uint32Array(1)),
			outIdx: out("outIdx", 3 * N * 4),
			outVal: out("outVal", 3 * N * 4),
			skyOut: out("skyOut", Math.max(1, 3 * K) * 4),
		};
		const e = prepGraphFor(device, N);
		await e.graph.compileAsync();
		const tr = performance.now();
		const { reads } = await e.graph.run(
			{ W, H, N, nBlk, K, head, photoBytes: photo.data.byteLength },
			{ buffers },
		);
		const [c, s, st0, hi, hv, sk] = reads.head;
		const st = new Uint32Array(st0);
		const total = st[LISTS];
		noteTotal(device, N, total);
		let bytes = NBINS * 4 + SEL * 8 + (LISTS + 1) * 4 + head * 8 + 12 * K;
		let tailRead: [ArrayBuffer, ArrayBuffer] | null = null;
		if (total > head) {
			const rest = (total - head) * 4;
			const [ti, tv] = await readBack(
				device,
				() => {},
				[
					{ buffer: buffers.outIdx, offset: head * 4, size: rest },
					{ buffer: buffers.outVal, offset: head * 4, size: rest },
				],
				{ id: "look-haze-tail" },
			);
			tailRead = [ti, tv];
			bytes += 2 * rest;
		}
		const { idx, val } = joinLists([hi, hv], tailRead, head, total);
		const tt = performance.now();
		const ts = e.graph.stats;
		Object.assign(hazeGraphStats, {
			head,
			total,
			tail: total > head,
			cacheHit: !!e.hit,
			ms: { upload: tr - tu, run: tt - tr },
			transientBytes: ts && {
				logical: ts.logicalTransientBytes,
				physical: ts.physicalTransientBytes,
			},
		});
		return {
			counts: new Uint32Array(c),
			stat: statOf(s),
			sky: K ? new Float32Array(sk) : new Float32Array(0),
			list: (L: number) => ({
				idx: idx.subarray(st[L], st[L + 1]),
				val: val.subarray(st[L], st[L + 1]),
			}),
			bytes,
			tail: total > head,
		};
	});
}

// ---------- submit 2 ----------

type GridParams = { cells: number; repsBytes: number; S: number };

function gridGraphFor(device: Device): CachedGraph<GridParams, undefined> {
	return cachedGraph<GridParams, undefined>(
		device,
		"look-haze-grid",
		"grid",
		(g) => {
			const imp = (id: string) => g.importBuffer(id, 4, undefined, STORAGE);
			const prm = g.importBuffer("gprm", 64, undefined, UNIFORM);
			const reps = at<GridParams>(imp("reps"), (p) => p.repsBytes);
			const repOff = at<GridParams>(imp("repOff"), (p) => 3 * p.S * 8);
			const Iw = at<GridParams>(imp("Iw"), (p) => 3 * p.S * 8);
			const hmPrior = at<GridParams>(imp("hmPrior"), () => HM_PRIOR.byteLength);
			const cells = HM_PRIOR.length * 25 * 37;
			// every cell is written (no clear needed)
			const err = g.transientBuffer("err", cells * 4);
			g.addKernel({
				id: "grid",
				spec: K_HZ_GRID,
				bindings: { prm, reps, repOff, Iw, hmPrior, err },
				workgroups: (p) => [Math.ceil(p.cells / 64)],
			});
			g.readNode("err", [{ buffer: err, size: (p) => p.cells * 4 }]);
			return undefined;
		},
		1,
	);
}

/** Submit 2: the physical grid's cost per cell (a GridFn, ./haze.ts). */
export function gridGraph(
	device: Device,
	reps: Float64Array[][],
	Ic: number[][],
	wp: number[][],
	airlight: Vec3,
	lam: number,
	jBar: number,
	priorK: number,
): Promise<Float32Array> {
	const { flat, off, iw, words, cells } = gridUploads(
		reps,
		Ic,
		wp,
		airlight,
		lam,
		jBar,
		priorK,
	);
	return withLease("look-haze", async () => {
		const key = (k: string) => `look-haze/g/${k}`;
		const buffers = {
			gprm: pooledUniform(device, key("gprm"), words),
			reps: pooledStorage(device, key("reps"), flat),
			repOff: pooledStorage(device, key("repOff"), off),
			Iw: pooledStorage(device, key("Iw"), iw),
			hmPrior: pooledStorage(device, key("hmPrior"), HM_PRIOR),
		};
		const e = gridGraphFor(device);
		await e.graph.compileAsync();
		const { reads } = await e.graph.run(
			{ cells, repsBytes: flat.byteLength, S: Ic[0].length },
			{ buffers },
		);
		return new Float32Array(reads.err[0]);
	});
}

// ---------- the fit from textures.ts's GPU prep ----------

type CompactParams = { N: number; nBlk: number; head: number };
type GatherParams = { K: number; N: number };

function compactGraphFor(
	device: Device,
	N: number,
): CachedGraph<CompactParams, undefined> {
	return cachedGraph<CompactParams, undefined>(
		device,
		"look-haze-compact",
		`n${N}`,
		(g) => {
			const nBlk = Math.ceil(N / BLOCK);
			const cprm = g.importBuffer("cprm", 16, undefined, UNIFORM);
			const pin = (id: string, bytes: (p: CompactParams) => number) =>
				at<CompactParams>(g.importBuffer(id, 4, undefined, PREP_IN), bytes);
			const lin = pin("lin", (p) => p.N * 12);
			const bins = pin("bins", (p) => p.N * 4);
			const state = pin("state", () => SEL * 8);
			const outIdxH = g.importBuffer("outIdx", 4, undefined, STORAGE);
			const outValH = g.importBuffer("outVal", 4, undefined, STORAGE);
			const outIdx = at<CompactParams>(outIdxH, (p) => 3 * p.N * 4);
			const outVal = at<CompactParams>(outValH, (p) => 3 * p.N * 4);
			const blk = g.transientBuffer("blk", nBlk * LISTS * 4);
			const offs = g.transientBuffer("offs", nBlk * LISTS * 4);
			const starts = g.transientBuffer("starts", (LISTS + 1) * 4);
			const blkGroups: [number] = [Math.ceil(nBlk / 64)];
			g.addKernel({
				id: "cnt",
				spec: K_HZ_CNT,
				bindings: { prm: cprm, bins, lin, state, blk },
				workgroups: blkGroups,
			});
			addListOffsets(g, { cprm, blk, offs, starts }, nBlk);
			g.addKernel({
				id: "scatter",
				spec: K_HZ_SCATTER,
				bindings: { prm: cprm, bins, lin, state, offs, outIdx, outVal },
				workgroups: blkGroups,
			});
			g.readNode("head", [
				{
					buffer: g.importBuffer("counts", 4, undefined, PREP_IN),
					size: NBINS * 4,
				},
				state,
				starts,
				{ buffer: outIdxH, size: (p) => p.head * 4 },
				{ buffer: outValH, size: (p) => p.head * 4 },
				pin("range", (p) => p.N * 4),
				pin("pSky", (p) => p.N * 4),
			]);
			return undefined;
		},
		MAX_SHAPES,
	);
}

function gatherGraphFor(device: Device): CachedGraph<GatherParams, undefined> {
	return cachedGraph<GatherParams, undefined>(
		device,
		"look-haze-gather",
		"gather",
		(g) => {
			const cprm = g.importBuffer("cprm", 16, undefined, UNIFORM);
			const idx = at<GatherParams>(
				g.importBuffer("skyIdx", 4, undefined, STORAGE),
				(p) => p.K * 4,
			);
			const lin = at<GatherParams>(
				g.importBuffer("lin", 4, undefined, PREP_IN),
				(p) => p.N * 12,
			);
			const outvH = g.importBuffer("skyOut", 4, undefined, STORAGE);
			g.addKernel({
				id: "gather",
				spec: K_HZ_GATHER,
				bindings: { prm: cprm, idx, lin, outv: at(outvH, (p) => 3 * p.K * 4) },
				workgroups: (p) => [Math.ceil(p.K / 64)],
			});
			g.readNode("sky", [{ buffer: outvH, size: (p) => 3 * p.K * 4 }]);
			return undefined;
		},
		1,
	);
}

/** The geometry fitHazeFromPrep needs on the CPU (the representative pixels' ENU points). */
export type HazePrepGeometry = Pick<HazeFitInput, "geo" | "eyeAlt" | "sunDir">;

/** textures.ts's lease of the haze prep (PASS.haze): its buffers are only stable under it. */
const PREP_LEASE = "look-tex/haze";

/** `geo` must be the prep's grid: W × H values (× 4 for xyzr). */
function checkGeo(input: HazePrepGeometry, W: number, H: number) {
	const k = input.geo.kind === "xyzr" ? 4 : 1;
	if (input.geo.data.length !== W * H * k)
		throw new Error(
			`[haze-graph] geo.data has ${input.geo.data.length} values, the prep is ${W} × ${H}${k > 1 ? " × 4" : ""}`,
		);
}

/**
 * The prep's buffers are still this prep's (call under PREP_LEASE): not destroyed (a later prep
 * grew a slot and retired them), large enough, and no other haze prep has run since (it would have
 * overwritten them with another photo's / pose's data).
 */
function checkPrep(device: Device, prep: HazePrepResult) {
	const N = prep.W * prep.H;
	const need = {
		range: N * 4,
		pSky: N * 4,
		lin: N * 12,
		bins: N * 4,
		counts: NBINS * 4,
		state: SEL * 8,
	};
	for (const [k, bytes] of Object.entries(need)) {
		const b = prep.buffers[k as keyof typeof need];
		if (!b || b.destroyed)
			throw new Error(`[haze-graph] prep buffer ${k} was destroyed`);
		if (b.byteLength < bytes)
			throw new Error(`[haze-graph] prep buffer ${k} is too small`);
	}
	if (prep.gen !== hazePrepGen(device))
		throw new Error(
			`[haze-graph] stale prep: haze prep ${hazePrepGen(device)} ran after it (${prep.gen})`,
		);
}

type FitGpu = {
	lists: Prep;
	range: Float32Array;
	skyIdx: Uint32Array;
	t1: number;
};

/**
 * The fit's GPU part on the prep's buffers (compaction + head read, then the band gather + tail
 * read). The caller holds PREP_LEASE; this takes this module's "look-haze" lease (the nesting order
 * fitHazeFromPrep always used; prepGraph / gridGraph never take PREP_LEASE, so no cycle).
 */
function fitGpuPart(
	device: Device,
	prep: HazePrepResult,
	listHead: number | undefined,
): Promise<FitGpu> {
	const { W, H } = prep;
	const N = W * H;
	const nBlk = Math.ceil(N / BLOCK);
	const pb = prep.buffers;
	return withLease("look-haze", async () => {
		checkPrep(device, prep);
		const key = (k: string) => `look-haze/p/${k}`;
		const head = headFor(device, N, listHead);
		const outIdx = pooledStorage(device, key("outIdx"), 3 * N * 4, {
			zero: false,
		});
		const outVal = pooledStorage(device, key("outVal"), 3 * N * 4, {
			zero: false,
		});
		const c = compactGraphFor(device, N);
		await c.graph.compileAsync();
		const r1 = await c.graph.run(
			{ N, nBlk, head },
			{
				buffers: {
					cprm: pooledUniform(
						device,
						key("cprm"),
						new Uint32Array([N, nBlk, 0, 0]),
					),
					lin: pb.lin,
					bins: pb.bins,
					state: pb.state,
					counts: pb.counts,
					range: pb.range,
					pSky: pb.pSky,
					outIdx,
					outVal,
				},
			},
		);
		const [cnt, s, st0, hi, hv, rg, ps] = r1.reads.head;
		const st = new Uint32Array(st0);
		const total = st[LISTS];
		noteTotal(device, N, total);
		const range = new Float32Array(rg);
		const pSky = new Float32Array(ps);
		const skyIdx = airlightBand(range, pSky, W, H);
		const K = skyIdx.length;
		// submit 2: the band's lin, plus the lists' tail on the same encoder
		const rest = total > head ? (total - head) * 4 : 0;
		const tailRanges: ReadRange[] = rest
			? [
					{ buffer: outIdx, offset: head * 4, size: rest },
					{ buffer: outVal, offset: head * 4, size: rest },
				]
			: [];
		let sky = new Float32Array(0);
		let tail: ArrayBuffer[] = [];
		if (K) {
			const gg = gatherGraphFor(device);
			await gg.graph.compileAsync();
			const r2 = await gg.graph.run(
				{ K, N },
				{
					buffers: {
						cprm: pooledUniform(
							device,
							key("gprm"),
							new Uint32Array([N, nBlk, K, 0]),
						),
						skyIdx: pooledStorage(device, key("skyIdx"), skyIdx),
						lin: pb.lin,
						skyOut: pooledStorage(device, key("skyOut"), 3 * K * 4, {
							zero: false,
						}),
					},
					read: tailRanges,
				},
			);
			sky = new Float32Array(r2.reads.sky[0]);
			tail = r2.data;
		} else if (rest) tail = await readBack(device, () => {}, tailRanges);
		const { idx, val } = joinLists(
			[hi, hv],
			rest ? [tail[0], tail[1]] : null,
			head,
			total,
		);
		const t1 = performance.now();
		const lists: Prep = {
			counts: new Uint32Array(cnt),
			stat: statOf(s),
			sky,
			list: (L: number) => ({
				idx: idx.subarray(st[L], st[L + 1]),
				val: val.subarray(st[L], st[L + 1]),
			}),
			bytes:
				NBINS * 4 +
				SEL * 8 +
				(LISTS + 1) * 4 +
				head * 8 +
				N * 8 +
				12 * K +
				2 * rest,
			tail: rest > 0,
		};
		Object.assign(hazeGraphStats, {
			head,
			total,
			tail: rest > 0,
			cacheHit: !!c.hit,
		});
		return { lists, range, skyIdx, t1 };
	});
}

/** The CPU tail (and the grid, which takes the "look-haze" lease itself), after the leases. */
function fitTail(
	device: Device,
	W: number,
	H: number,
	input: HazePrepGeometry,
	T0: number,
	g: FitGpu,
): Promise<HazeFit> {
	return hazeFitTail(
		device,
		{
			range: g.range,
			skyIdx: g.skyIdx,
			pointAt: pointAtOf(input.geo, W, H, input.eyeAlt),
			eyeAlt: input.eyeAlt,
			sunDir: input.sunDir,
			T0,
			t1: T0,
			t2: g.t1,
		},
		g.lists,
		gridGraph,
	);
}

/**
 * The haze fit from textures.ts hazePrepTex / hazePrepArrays outputs (range, pSky, lin, bins, counts,
 * radix-select state, GPU-resident), with no re-upload of them: the 72 lists are compacted from the
 * prep's own buffers, and range / pSky / counts / state / the lists' head come back in one read.
 * The CPU then picks the airlight band (haze.ts airlightBand, on the prep's range / pSky), one more
 * submit gathers the band's lin (and the lists' tail, if any), and the rest is haze.ts hazeFitTail
 * with the grid on the graph. Given a prep bit-identical to fitHazeGpu's own (textures-bench: exact),
 * the fit is fitHazeGpu's, bit for bit.
 *
 * `geo` must be the prep's geometry as fitHazeGpu takes it (W × H = prep.W × prep.H, row 0 = bottom):
 * the representative pixels' ENU points come from it (its length is checked). The prep's buffers are
 * only valid until the next haze prep: this rejects (instead of reading another prep's data or a
 * destroyed buffer) when another prep ran between the two calls. For textures, prefer
 * prepAndFitHazeTex, which cannot be interleaved.
 */
export function fitHazeFromPrep(
	device: Device,
	prep: HazePrepResult,
	input: HazePrepGeometry,
	opts: { listHead?: number } = {},
): Promise<HazeFit> {
	const T0 = performance.now();
	try {
		checkGeo(input, prep.W, prep.H);
	} catch (e) {
		return Promise.reject(e);
	}
	return withLease(PREP_LEASE, () =>
		fitGpuPart(device, prep, opts.listHead),
	).then((g) => fitTail(device, prep.W, prep.H, input, T0, g));
}

/**
 * textures.ts hazePrepTex + fitHazeFromPrep under ONE haze lease: the prep's buffers cannot be
 * overwritten or retired by another haze prep before the fit has read them. Bit-identical to
 * fitHazeGpu on the same geometry / photo / masks (both halves are). `input.geo` must be the
 * texture's ×step grid (floor(width / step) × floor(height / step), row 0 = bottom).
 * `valid` is re-checked inside the lease just before the prep's submit: false (the caller's
 * texture was re-rendered while this call was queued) resolves null with nothing submitted.
 */
export async function prepAndFitHazeTex(
	device: Device,
	tex: HazeTexInput,
	input: HazePrepGeometry,
	opts: { listHead?: number; valid?: () => boolean } = {},
): Promise<HazeFit | null> {
	const T0 = performance.now();
	const geoTex =
		tex.geometry instanceof Texture ? tex.geometry : tex.geometry.texture;
	const step = tex.step ?? 2;
	const W = Math.floor(geoTex.width / step);
	const H = Math.floor(geoTex.height / step);
	checkGeo(input, W, H);
	const r = await hazePrepTexThen(
		device,
		tex,
		(prep) => fitGpuPart(device, prep, opts.listHead),
		{ valid: opts.valid },
	);
	if (!r) return null;
	return fitTail(device, W, H, input, T0, r);
}

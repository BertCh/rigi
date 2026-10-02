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
//   → list-key → GPUSort (stable radix) ∥ GPUHistogram → GPUScan → GPUGather + list-index   72-list compaction
//   → gather (luma GPUGather)                                        the airlight band's lin
//   → read node "head": counts, state, starts, the lists' first `head` slots, the band's lin
// Submit 2 (one graph, group "look-haze-grid"): grid → read node "err" (5 550 floats); by default the
//   arg-min program instead (group "look-haze-argmin", see below), read node "pick" (2 KiB).
// Between them the CPU middle stage and after submit 2 the arg-min + refinement run in f64 on the CPU,
// unchanged (haze.ts hazeFitTail): the round trip is inherent (the grid's inputs come from f64 code).
//
// Determinism / tolerance (the removed dispatch path gave the same bits; look-bench,
// scripts/gpu/haze-band-dawn.ts and scripts/gpu/haze-lists-dawn.ts compare with the CPU fit and
// emulation):
// - Every node is one of haze.ts's kernel specs or a core primitive, in a fixed order with fixed
//   workgroup counts. Consecutive nodes share a compute pass; WebGPU orders dispatches and their
//   storage writes within a pass exactly as across passes.
// - The 72-list compaction is core primitives around one key kernel (haze.ts addListCompaction:
//   GPUSort, GPUHistogram, GPUScan, GPUGather; all integer). The sort is stable, so the lists equal
//   the CPU's (pixel order within a list) and the Dawn script checks them exactly; the radix select
//   (288 concurrent selections) stays custom (its per-selection digit histogram as a 12N-key
//   GPUHistogram measured ~19x slower, see haze.ts / README). No float sums.
// - Every gather (the band's lin in the prep, gather and band graphs, the lists' range words in the
//   band graph) is a luma GPUGather: it copies 32-bit words, so gathered words are the source's bits.
//   GPUGather dispatches over its STATIC indices view: the prep / gather graphs are keyed by a slot
//   capacity (gatherCapacity: the band bound kMax, else the next power of two ≥ K) with the indices
//   padded by 0xFFFFFFFF (out of range: a zero row), the band graph gathers over kMax band slots and
//   3N list slots (slots past K / the list total hold stale indices and are never read; measured in
//   Dawn, haze-band-dawn.ts: no change in the GPU part's time against the old early-exit kernels).
// - Transients are never zeroed and alias: counts and hist are the only read-modify-write transients
//   (atomics), each has a clear node before every use (compile() lints it: writes: "atomic"). Every
//   other transient is fully written by the node that first touches it (lin, flags, flagsH, bins per
//   pixel; state per selection; the list compaction's keys / values / counts / starts by its
//   own nodes), so aliased bytes are never read.
// - Imports (inputs and the lists, which the tail read may need after the submit) are pooled buffers
//   bound with the run's exact byte ranges. No kernel uses arrayLength(), so the binding size does
//   not reach the numerics.
// - Min / max / NaN: the graph adds no min/max. The kernels' own min/max/clamp are integer (indices,
//   bins, digits) except the grid's clamp(select(0, num/den, den > 1e-12), 0, A), unchanged. The
//   f32 order statistics are selected on u32 bit patterns (lin ≥ 0). The grid's arg-min is JS
//   (haze.ts hazeFitTail): `e < gMin` / `e <= tol` are false for NaN, so NaN cells are never
//   candidates (all NaN: no candidate, the default start), as before.
//
// fitHazeFromPrep / prepAndFitHazeTex (the WebGPU engine's texture path) run the compaction on
// textures.ts's prep ("look-haze-compact", read node "head" with the range / P(sky) planes), the CPU
// airlight band, then "look-haze-gather" when `bandGpu: false` (or the GPU band is unusable: a short
// band, a failed spot check). By default (since 2026-10-01) the band runs on the GPU instead: one graph
// "look-haze-band" (compaction + ./haze-band.ts's band: hzb-top, hzb-flags and a luma GPUCompaction;
// lin and list-range GPUGathers; spot columns),
// one read, no planes; same band indices as the CPU, spot-checked per call.
//
// Submit 2 by default runs the grid's arg-min too, as a luma GPUProgram (./haze-argmin.ts, group
// "look-haze-argmin"): only the minimum and ≤ 256 candidate cells come back, the CPU
// re-applies its exact test (same candidates, same fit). The selection past 256 candidates is a
// GPU-indirect-gated node (the program's GPUConditionalOperation).
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
import {
	type CachedGraph,
	type ComputeGraph,
	cachedGraph,
	type GraphRange,
} from "../core/graph";
import { GPUCompaction, GPUGather, type GraphBufferHandle } from "../core/luma";
import { pooledStorage, pooledUniform, withLease } from "../core/pool";
import { type ReadRange, readBack } from "../core/readback";
import {
	addListCompaction,
	airlightBand,
	bandLength,
	GRID_CELLS,
	type GridPick,
	gridUploads,
	HM_PRIOR,
	hazeFitTail,
	hazeScanSubgroupsOn,
	K_HZ_BIN,
	K_HZ_DILH,
	K_HZ_GRID,
	K_HZ_HIST,
	K_HZ_PREP,
	K_HZ_SCAN,
	K_HZ_SCAN_SG,
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
import { buildArgminProgram, decodePick } from "./haze-argmin";
import {
	bandShape,
	bandWords,
	FLAGS_GROUP,
	K_HZB_FLAGS,
	K_HZB_SPOT,
	K_HZB_TOP,
	pickSpotColumns,
	SPOT_COLUMNS,
	verifyBand,
} from "./haze-band";
import {
	type HazePrepResult,
	type HazeTexInput,
	hazePrepGen,
	hazePrepTexThen,
} from "./textures";
import { HAZE_COUNT_PARAMS, HAZE_PASS_PARAMS } from "./uniform-blocks";

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
	/** ms of the last run's GPU part: prepGraph's whole run, or fitGpuPart / fitGpuPartBand (lease to last read) */
	gpuMs?: number;
	/** compiled stats of the last prep graph: logical vs physical transient bytes */
	transientBytes?: { logical: number; physical: number };
	/**
	 * fitHazeFromPrep's airlight band: "cpu" (range / P(sky) read back, haze.ts airlightBand),
	 * "gpu" (./haze-band.ts, one submit), "gpu-short" (GPU band under 20 pixels: the CPU band's
	 * fallback ran), "gpu-failed" (the spot check failed: the CPU band ran, the GPU band is off)
	 */
	band?: "cpu" | "gpu" | "gpu-short" | "gpu-failed";
} = { head: 0, total: 0, tail: false, cacheHit: false };

/**
 * Last run's gathered words, for the Dawn A/B (scripts/gpu/haze-band-dawn.ts): the band's pixel
 * indices and lin words, and (band path) the lists' pixel indices and range words, each as read back.
 */
export const hazeGraphProbe: {
	skyIdx?: Uint32Array;
	sky?: Float32Array;
	listIdx?: Uint32Array;
	listRange?: Float32Array;
} = {};

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
	return {
		idx: joinWords(Uint32Array, head[0], tail?.[0], guess, total),
		val: joinWords(Float32Array, head[1], tail?.[1], guess, total),
	};
}

/** One list array: the head read's words, then (when it overflowed) the tail read's from `guess`. */
function joinWords<A extends Uint32Array | Float32Array>(
	Kind: { new (b: ArrayBuffer | number): A },
	head: ArrayBuffer,
	tail: ArrayBuffer | undefined,
	guess: number,
	total: number,
): A {
	const a = new Kind(head);
	if (!tail) return a;
	const out = new Kind(total);
	out.set(a);
	out.set(new Kind(tail), guess);
	return out;
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

/** Index padding for a gather's unused slots: out of range, so GPUGather writes a zero row. */
const GATHER_PAD = 0xffffffff;

/**
 * Slots of a gather over the airlight band of K pixels on a W × H grid. GPUGather dispatches over
 * its static indices view, so the cached graph is keyed by this capacity: the band's own bound
 * (haze-band bandShape kMax) for every normal band, so a pose change never rebuilds the graph, and
 * the next power of two ≥ K for the fallback band (every sky pixel, which can be up to N).
 */
function gatherCapacity(W: number, H: number, K: number) {
	const { kMax } = bandShape(W, H);
	return K <= kMax ? kMax : 2 ** Math.ceil(Math.log2(K));
}

/** `indices` padded with GATHER_PAD to `capacity` slots (the pooled upload of a gather graph). */
function padIndices(indices: Uint32Array, capacity: number) {
	const out = new Uint32Array(capacity).fill(GATHER_PAD);
	out.set(indices);
	return out;
}

/** A view of `length` 3-word rows (12 B, as lin's xyz) over a graph buffer, for GPUGather. */
function rows3<P>(
	g: ComputeGraph<P>,
	buffer: GraphBufferHandle,
	length: number,
) {
	return g.graph.createDataView(buffer, { format: "float32x3", length });
}

function prepGraphFor(
	device: Device,
	N: number,
	gatherSlots: number,
): CachedGraph<PrepParams, undefined> {
	const scanSg = hazeScanSubgroupsOn(device);
	return cachedGraph<PrepParams, undefined>(
		device,
		"look-haze-prep",
		`n${N}-g${gatherSlots}${scanSg ? "-sg" : ""}`,
		(g) => {
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
			// the gather's views need real declared sizes: capacity-keyed (gatherSlots)
			const skyIdxH = g.importBuffer(
				"skyIdx",
				gatherSlots * 4,
				undefined,
				STORAGE,
			);
			// the lists' buffers are declared at their full size (the list compaction views them)
			const outIdxH = g.importBuffer("outIdx", 3 * N * 4, undefined, STORAGE);
			const outValH = g.importBuffer("outVal", 3 * N * 4, undefined, STORAGE);
			const skyOutH = g.importBuffer(
				"skyOut",
				gatherSlots * 12,
				undefined,
				STORAGE,
			);
			const lin = g.transientBuffer("lin", N * 12);
			const flags = g.transientBuffer("flags", N * 4);
			const flagsH = g.transientBuffer("flagsH", N * 4);
			const bins = g.transientBuffer("bins", N * 4);
			const counts = g.transientBuffer("counts", NBINS * 4);
			const state = g.transientBuffer("state", SEL * 8);
			const hist = g.transientBuffer("hist", SEL * BUCKETS * 4);
			const starts = g.transientBuffer("starts", (LISTS + 1) * 4);
			const groups: [number] = [Math.ceil(N / 256)];
			const selGroups: [number] = [Math.ceil(SEL / 64)];
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
					spec: scanSg ? K_HZ_SCAN_SG : K_HZ_SCAN,
					bindings: { prm: pass[p], hist, state },
					workgroups: [SCAN_GROUPS],
				});
			}
			// only [0, total) of outIdx / outVal is meaningful and only [0, total) is read
			addListCompaction(
				g,
				{ cprm, bins, state, lin, outIdx: outIdxH, outVal: outValH, starts },
				N,
			);
			// slots ≥ K carry GATHER_PAD indices (zero rows), and only [0, K) is read back
			g.add(
				new GPUGather({
					id: "gather",
					source: rows3(g, lin, N),
					indices: g.view(skyIdxH, "uint32", gatherSlots),
					output: rows3(g, skyOutH, gatherSlots),
				}),
			);
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
	const gatherSlots = gatherCapacity(W, H, K);
	return withLease("look-haze", async () => {
		const tu = performance.now();
		const key = (k: string) => `look-haze/g/${k}`;
		const up = (k: string, data: ArrayBufferView) =>
			pooledStorage(device, key(k), data);
		// outIdx / outVal share fitGpuPart's pooled lists (same size, same lease, read back before
		// it ends), so running both paths on a device does not hold two copies (2 × 3·N·4 B)
		const out = (k: string, bytes: number) =>
			pooledStorage(
				device,
				k === "outIdx" || k === "outVal" ? `look-haze/p/${k}` : key(k),
				bytes,
				{ zero: false },
			);
		const head = headFor(device, N, listHead);
		const buffers = {
			prm: pooledUniform(device, key("prm"), words),
			pass0: pooledUniform(
				device,
				key("pass0"),
				HAZE_PASS_PARAMS.pack({ W, H, pass_: 0 }),
			),
			pass1: pooledUniform(
				device,
				key("pass1"),
				HAZE_PASS_PARAMS.pack({ W, H, pass_: 1 }),
			),
			pass2: pooledUniform(
				device,
				key("pass2"),
				HAZE_PASS_PARAMS.pack({ W, H, pass_: 2 }),
			),
			cprm: pooledUniform(
				device,
				key("cprm"),
				HAZE_COUNT_PARAMS.pack({ N, nBlk, K }),
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
			skyIdx: up("skyIdx", padIndices(skyIdx, gatherSlots)),
			outIdx: out("outIdx", 3 * N * 4),
			outVal: out("outVal", 3 * N * 4),
			skyOut: out("skyOut", gatherSlots * 12),
		};
		const e = prepGraphFor(device, N, gatherSlots);
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
			gpuMs: tt - tu,
			transientBytes: ts && {
				logical: ts.logicalTransientBytes,
				physical: ts.physicalTransientBytes,
			},
		});
		hazeGraphProbe.skyIdx = skyIdx;
		hazeGraphProbe.sky = K ? new Float32Array(sk) : new Float32Array(0);
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

/** The grid kernel and its imports on `g`; returns its output `err` (GRID_CELLS f32, a transient). */
function addGrid(g: ComputeGraph<GridParams>) {
	const imp = (id: string) => g.importBuffer(id, 4, undefined, STORAGE);
	const prm = g.importBuffer("gprm", 64, undefined, UNIFORM);
	const reps = at<GridParams>(imp("reps"), (p) => p.repsBytes);
	const repOff = at<GridParams>(imp("repOff"), (p) => 3 * p.S * 8);
	const Iw = at<GridParams>(imp("Iw"), (p) => 3 * p.S * 8);
	const hmPrior = at<GridParams>(imp("hmPrior"), () => HM_PRIOR.byteLength);
	// every cell is written (no clear needed)
	const err = g.transientBuffer("err", GRID_CELLS * 4);
	g.addKernel({
		id: "grid",
		spec: K_HZ_GRID,
		bindings: { prm, reps, repOff, Iw, hmPrior, err },
		workgroups: [Math.ceil(GRID_CELLS / 64)],
	});
	return err;
}

function gridGraphFor(device: Device): CachedGraph<GridParams, undefined> {
	return cachedGraph<GridParams, undefined>(
		device,
		"look-haze-grid",
		"grid",
		(g) => {
			const err = addGrid(g);
			g.readNode("err", [{ buffer: err, size: (p) => p.cells * 4 }]);
			return undefined;
		},
		1,
	);
}

/** The grid + its arg-min as a luma GPUProgram (./haze-argmin.ts), group "look-haze-argmin". */
function gridPickGraphFor(device: Device): CachedGraph<GridParams, undefined> {
	return cachedGraph<GridParams, undefined>(
		device,
		"look-haze-argmin",
		"grid",
		() => undefined,
		1,
		(id) => buildArgminProgram<GridParams>(device, id, addGrid),
	);
}

/** Devices whose GPU arg-min failed (compile fault or per-call check): whole-grid reads from then on. */
const pickFailed = new WeakSet<Device>();

/** What the last gridGraph call did: "pick" (the arg-min program), "grid" (whole grid read). */
export const hazeArgminStats: {
	last?: "pick" | "grid";
	/** cells within the pick's superset tolerance (the last pick) */
	count?: number;
	/** why the program is off on the last device, if it failed */
	failed?: string;
} = {};

/**
 * Submit 2: the physical grid (a GridFn, ./haze.ts). By default (`opts.pick`) its
 * arg-min runs on the GPU too (./haze-argmin.ts, a luma GPUProgram) and only the candidates come
 * back (a GridPick: the same candidates, haze.ts gridCandidates); else the whole grid.
 */
export function gridGraph(
	device: Device,
	reps: Float64Array[][],
	Ic: number[][],
	wp: number[][],
	airlight: Vec3,
	lam: number,
	jBar: number,
	priorK: number,
	opts: { pick?: boolean } = {},
): Promise<Float32Array | GridPick> {
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
		const params = { cells, repsBytes: flat.byteLength, S: Ic[0].length };
		if (
			cells === GRID_CELLS &&
			!pickFailed.has(device) &&
			(opts.pick ?? true)
		) {
			let why = "";
			try {
				const e = gridPickGraphFor(device);
				await e.graph.compileAsync();
				const { reads } = await e.graph.run(params, { buffers });
				const pick = decodePick(reads.pick[0], reads.pick[1]);
				if (pick) {
					hazeArgminStats.last = "pick";
					hazeArgminStats.count = pick.count;
					return pick;
				}
				why = "per-call check failed";
			} catch (err) {
				if (device.isLost) throw err;
				why = String((err as Error)?.message ?? err).slice(0, 200);
			}
			// runtime guard: a broken program would silently change the haze fit's start
			pickFailed.add(device);
			hazeArgminStats.failed = why;
			console.warn(
				`[haze-graph] GPU grid arg-min off on this device (${why}); reading the whole grid`,
			);
		}
		const e = gridGraphFor(device);
		await e.graph.compileAsync();
		const { reads } = await e.graph.run(params, { buffers });
		hazeArgminStats.last = "grid";
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
			const cprm = g.importBuffer("cprm", 16, undefined, UNIFORM);
			const pin = (id: string, bytes: (p: CompactParams) => number) =>
				at<CompactParams>(g.importBuffer(id, 4, undefined, PREP_IN), bytes);
			// lin and the lists are declared at their full size (the list compaction views them)
			const linH = g.importBuffer("lin", N * 12, undefined, PREP_IN);
			const bins = pin("bins", (p) => p.N * 4);
			const state = pin("state", () => SEL * 8);
			const outIdxH = g.importBuffer("outIdx", 3 * N * 4, undefined, STORAGE);
			const outValH = g.importBuffer("outVal", 3 * N * 4, undefined, STORAGE);
			const starts = g.transientBuffer("starts", (LISTS + 1) * 4);
			addListCompaction(
				g,
				{
					cprm,
					bins,
					state,
					lin: linH,
					outIdx: outIdxH,
					outVal: outValH,
					starts,
				},
				N,
			);
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

/** The CPU band's lin gather ("look-haze-gather"): one GPUGather per (N, capacity), see gatherCapacity. */
function gatherGraphFor(
	device: Device,
	N: number,
	gatherSlots: number,
): CachedGraph<GatherParams, undefined> {
	return cachedGraph<GatherParams, undefined>(
		device,
		"look-haze-gather",
		`n${N}-g${gatherSlots}`,
		(g) => {
			const idx = g.importBuffer("skyIdx", gatherSlots * 4, undefined, STORAGE);
			const lin = g.importBuffer("lin", N * 12, undefined, PREP_IN);
			const outvH = g.importBuffer(
				"skyOut",
				gatherSlots * 12,
				undefined,
				STORAGE,
			);
			g.add(
				new GPUGather({
					id: "gather",
					source: rows3(g, lin, N),
					indices: g.view(idx, "uint32", gatherSlots),
					output: rows3(g, outvH, gatherSlots),
				}),
			);
			g.readNode("sky", [{ buffer: outvH, size: (p) => 3 * p.K * 4 }]);
			return undefined;
		},
		MAX_SHAPES,
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
		const tStart = performance.now();
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
						HAZE_COUNT_PARAMS.pack({ N, nBlk }),
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
		// a short GPU band sent this device here: back to the GPU band once a band is long again
		if (bandShort.get(device))
			bandShort.set(device, bandLength(range, pSky, W, H) < 20);
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
			const gatherSlots = gatherCapacity(W, H, K);
			const gg = gatherGraphFor(device, N, gatherSlots);
			await gg.graph.compileAsync();
			const r2 = await gg.graph.run(
				{ K, N },
				{
					buffers: {
						skyIdx: pooledStorage(
							device,
							key("skyIdx"),
							padIndices(skyIdx, gatherSlots),
						),
						lin: pb.lin,
						skyOut: pooledStorage(device, key("skyOut"), gatherSlots * 12, {
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
			gpuMs: t1 - tStart,
		});
		hazeGraphProbe.skyIdx = skyIdx;
		hazeGraphProbe.sky = sky;
		return { lists, range, skyIdx, t1 };
	});
}

// ---------- the airlight band on the GPU (default on the texture path, ./haze-band.ts) ----------

type BandParams = { N: number; nBlk: number; head: number };

/**
 * compactGraphFor's compaction plus the airlight band, its lin gather, the lists' range gather and
 * the spot columns, in one graph per W × H (group "look-haze-band"), one read node. Integer work
 * only (./haze-band.wgsl.ts); every dispatch and read size is CPU-side.
 */
function bandGraphFor(
	device: Device,
	W: number,
	H: number,
): CachedGraph<BandParams, undefined> {
	return cachedGraph<BandParams, undefined>(
		device,
		"look-haze-band",
		`${W}x${H}`,
		(g) => {
			const N = W * H;
			const { nCol, kMax } = bandShape(W, H);
			const cprm = g.importBuffer("cprm", 16, undefined, UNIFORM);
			const bprm = g.importBuffer("bprm", 32, undefined, UNIFORM);
			const pin = (id: string, bytes: (p: BandParams) => number) =>
				at<BandParams>(g.importBuffer(id, 4, undefined, PREP_IN), bytes);
			// the gathers' and the list compaction's views need real declared sizes (checkPrep
			// guarantees the prep's buffers)
			const linH = g.importBuffer("lin", N * 12, undefined, PREP_IN);
			const rangeH = g.importBuffer("range", N * 4, undefined, PREP_IN);
			const bins = pin("bins", (p) => p.N * 4);
			const state = pin("state", () => SEL * 8);
			const range = at<BandParams>(rangeH, (p) => p.N * 4);
			const psky = pin("pSky", (p) => p.N * 4);
			const imp = (id: string, bytes = 4) =>
				g.importBuffer(id, bytes, undefined, STORAGE);
			const outIdxH = imp("outIdx", 3 * N * 4);
			const outValH = imp("outVal", 3 * N * 4);
			const outRangeH = imp("outRange", 3 * N * 4);
			const bandLinH = imp("bandLin", 3 * kMax * 4);
			const cols = at<BandParams>(imp("cols"), () => SPOT_COLUMNS * 4);
			const starts = g.transientBuffer("starts", (LISTS + 1) * 4);
			const top = g.transientBuffer("top", nCol * 4);
			// the compaction's column-major input (nCol · H slots), flags and output; the output's
			// first K words are the band (the gather and the read use the first kMax)
			const slots = nCol * H;
			const elem = g.transientBuffer("bandElem", slots * 4);
			const flag = g.transientBuffer("bandFlag", slots * 4);
			const bandIdxT = g.transientBuffer("bandIdx", slots * 4);
			const total = g.transientBuffer("bandK", 4);
			const spot = g.transientBuffer("spot", SPOT_COLUMNS * H * 8);
			const colGroups: [number] = [Math.ceil(nCol / 64)];
			const slotGroups: [number] = [Math.ceil(slots / FLAGS_GROUP)];
			addListCompaction(
				g,
				{
					cprm,
					bins,
					state,
					lin: linH,
					outIdx: outIdxH,
					outVal: outValH,
					starts,
				},
				N,
			);
			// the lists' range words: a GPUGather over every list slot (3N); slots ≥ total hold stale
			// indices (a valid pixel or out of range: a harmless row) and are never read
			g.add(
				new GPUGather({
					id: "list-range",
					source: g.view(rangeH, "float32", N),
					indices: g.view(outIdxH, "uint32", 3 * N),
					output: g.view(outRangeH, "float32", 3 * N),
				}),
			);
			g.addKernel({
				id: "band-top",
				spec: K_HZB_TOP,
				bindings: { prm: bprm, range, psky, top },
				workgroups: colGroups,
			});
			g.addKernel({
				id: "band-flags",
				spec: K_HZB_FLAGS,
				bindings: { prm: bprm, range, psky, top, elem, flag },
				workgroups: slotGroups,
			});
			// stable compaction in slot order (column, then row: the CPU's push order); K lands in `total`
			g.add(
				new GPUCompaction({
					id: "band-compact",
					input: g.view(elem, "uint32", slots),
					flags: g.view(flag, "uint32", slots),
					output: g.view(bandIdxT, "uint32", slots),
					count: g.view(total, "uint32", 1),
				}),
			);
			// the band's lin over every band slot (kMax); slots ≥ K are stale indices, never read
			g.add(
				new GPUGather({
					id: "band-gather",
					source: rows3(g, linH, N),
					indices: g.view(bandIdxT, "uint32", kMax),
					output: rows3(g, bandLinH, kMax),
				}),
			);
			g.addKernel({
				id: "band-spot",
				spec: K_HZB_SPOT,
				bindings: { prm: bprm, cols, range, psky, spot },
				workgroups: [Math.ceil((SPOT_COLUMNS * H) / 64)],
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
				{ buffer: outRangeH, size: (p) => p.head * 4 },
				total,
				{ buffer: bandIdxT, size: kMax * 4 },
				{ buffer: bandLinH, size: 3 * kMax * 4 },
				spot,
			]);
			return undefined;
		},
		MAX_SHAPES,
	);
}

/** Devices whose GPU band failed its spot check (they take the CPU band from then on). */
const bandFailed = new WeakSet<Device>();
/** The device's last GPU band was under 20 pixels: take the CPU band until a band is long again. */
const bandShort = new WeakMap<Device, boolean>();

/**
 * fitHazeFromPrep's band choice: the option, else on; never after a failed spot check,
 * nor while the last band was short.
 */
function chooseBandGpu(device: Device, opt: boolean | undefined) {
	if (bandFailed.has(device)) return false;
	if (!(opt ?? true)) return false;
	return !bandShort.get(device);
}

/**
 * fitGpuPart with the airlight band on the GPU: one submit, no range / P(sky) planes read back.
 * Resolves null (nothing usable: the caller runs fitGpuPart, the CPU band) when the band has under
 * 20 pixels (airlightBand's fallback needs the whole range plane) or fails its spot check. The
 * caller holds PREP_LEASE; this takes "look-haze".
 */
function fitGpuPartBand(
	device: Device,
	prep: HazePrepResult,
	listHead: number | undefined,
): Promise<FitGpu | null> {
	const { W, H } = prep;
	const N = W * H;
	const nBlk = Math.ceil(N / BLOCK);
	const { kMax } = bandShape(W, H);
	const pb = prep.buffers;
	return withLease("look-haze", async () => {
		checkPrep(device, prep);
		const tStart = performance.now();
		const key = (k: string) => `look-haze/b/${k}`;
		const head = headFor(device, N, listHead);
		// outIdx / outVal share fitGpuPart's pooled lists (same size, same lease, read back before
		// it ends), so running both paths on a device does not hold two copies (2 × 3·N·4 B)
		const out = (k: string, bytes: number) =>
			pooledStorage(
				device,
				k === "outIdx" || k === "outVal" ? `look-haze/p/${k}` : key(k),
				bytes,
				{ zero: false },
			);
		const cols = pickSpotColumns(W);
		const buffers = {
			cprm: pooledUniform(
				device,
				key("cprm"),
				HAZE_COUNT_PARAMS.pack({ N, nBlk }),
			),
			bprm: pooledUniform(device, key("bprm"), bandWords(W, H)),
			lin: pb.lin,
			bins: pb.bins,
			state: pb.state,
			counts: pb.counts,
			range: pb.range,
			pSky: pb.pSky,
			outIdx: out("outIdx", 3 * N * 4),
			outVal: out("outVal", 3 * N * 4),
			outRange: out("outRange", 3 * N * 4),
			bandLin: out("bandLin", 3 * kMax * 4),
			cols: pooledStorage(device, key("cols"), cols),
		};
		const e = bandGraphFor(device, W, H);
		await e.graph.compileAsync();
		const r1 = await e.graph.run({ N, nBlk, head }, { buffers });
		const [cnt0, s, st0, hi, hv, hr, bk, bi, bl, sp] = r1.reads.head;
		const st = new Uint32Array(st0);
		const total = st[LISTS];
		noteTotal(device, N, total);
		const K = new Uint32Array(bk)[0];
		const bandIdx = new Uint32Array(bi);
		const failure = verifyBand(W, H, K, bandIdx, cols, new Uint32Array(sp));
		if (failure) {
			bandFailed.add(device);
			hazeGraphStats.band = "gpu-failed";
			// runtime guard: a wrong band would silently change the airlight
			console.warn(
				`[haze-graph] GPU airlight band failed its spot check (${failure}); the CPU band takes over on this device`,
			);
			return null;
		}
		if (K < 20) {
			bandShort.set(device, true);
			hazeGraphStats.band = "gpu-short";
			return null;
		}
		const rest = total > head ? (total - head) * 4 : 0;
		const tail = rest
			? await readBack(
					device,
					() => {},
					[
						{ buffer: buffers.outIdx, offset: head * 4, size: rest },
						{ buffer: buffers.outVal, offset: head * 4, size: rest },
						{ buffer: buffers.outRange, offset: head * 4, size: rest },
					],
					{ id: "look-haze-band-tail" },
				)
			: null;
		const idx = joinWords(Uint32Array, hi, tail?.[0], head, total);
		const val = joinWords(Float32Array, hv, tail?.[1], head, total);
		const rng = joinWords(Float32Array, hr, tail?.[2], head, total);
		const t1 = performance.now();
		const lists: Prep = {
			counts: new Uint32Array(cnt0),
			stat: statOf(s),
			sky: new Float32Array(bl, 0, 3 * K),
			list: (L: number) => ({
				idx: idx.subarray(st[L], st[L + 1]),
				val: val.subarray(st[L], st[L + 1]),
				range: rng.subarray(st[L], st[L + 1]),
			}),
			bytes:
				NBINS * 4 +
				SEL * 8 +
				(LISTS + 1) * 4 +
				head * 12 +
				4 +
				16 * kMax +
				SPOT_COLUMNS * H * 8 +
				3 * rest,
			tail: rest > 0,
		};
		Object.assign(hazeGraphStats, {
			head,
			total,
			tail: rest > 0,
			cacheHit: !!e.hit,
			gpuMs: t1 - tStart,
			band: "gpu",
		});
		hazeGraphProbe.skyIdx = bandIdx.subarray(0, K);
		hazeGraphProbe.sky = lists.sky;
		hazeGraphProbe.listIdx = idx;
		hazeGraphProbe.listRange = rng;
		return {
			lists,
			// the tail reads range through the lists (bit for bit range[idx])
			range: new Float32Array(0),
			skyIdx: bandIdx.subarray(0, K),
			t1,
		};
	});
}

/** The fit's GPU part: the GPU band when chosen and usable, else the CPU band (fitGpuPart). */
async function fitGpuPartAuto(
	device: Device,
	prep: HazePrepResult,
	opts: { listHead?: number; bandGpu?: boolean },
): Promise<FitGpu> {
	let band: typeof hazeGraphStats.band = "cpu";
	let fault: unknown = null;
	if (chooseBandGpu(device, opts.bandGpu)) {
		try {
			const r = await fitGpuPartBand(device, prep, opts.listHead);
			if (r) return r;
			band = hazeGraphStats.band;
		} catch (err) {
			if (device.isLost) throw err;
			fault = err;
			band = "gpu-failed";
		}
	}
	const r = await fitGpuPart(device, prep, opts.listHead);
	// the CPU band ran on the same prep, so the GPU band's fault was its own (a shader / pipeline
	// fault, not a stale prep, which fitGpuPart would have rejected too): off for this device
	if (fault) {
		bandFailed.add(device);
		console.warn(
			`[haze-graph] GPU airlight band faulted (${String((fault as Error)?.message ?? fault).slice(0, 200)}); the CPU band takes over on this device`,
		);
	}
	hazeGraphStats.band = band;
	return r;
}

/** The CPU tail (and the grid, which takes the "look-haze" lease itself), after the leases. */
function fitTail(
	device: Device,
	W: number,
	H: number,
	input: HazePrepGeometry,
	T0: number,
	g: FitGpu,
	argminGpu?: boolean,
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
		(...args) => gridGraph(...args, { pick: argminGpu }),
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
 *
 * `bandGpu` (default on; false = the CPU band) picks the airlight band on the GPU
 * (./haze-band.ts): one submit instead of two and no range / P(sky) planes read back, the same fit
 * bit for bit (integer work, spot-checked per call; a short band or a failed check takes the CPU band).
 */
export function fitHazeFromPrep(
	device: Device,
	prep: HazePrepResult,
	input: HazePrepGeometry,
	opts: { listHead?: number; bandGpu?: boolean; argminGpu?: boolean } = {},
): Promise<HazeFit> {
	const T0 = performance.now();
	try {
		checkGeo(input, prep.W, prep.H);
	} catch (e) {
		return Promise.reject(e);
	}
	return withLease(PREP_LEASE, () => fitGpuPartAuto(device, prep, opts)).then(
		(g) => fitTail(device, prep.W, prep.H, input, T0, g, opts.argminGpu),
	);
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
	opts: {
		listHead?: number;
		valid?: () => boolean;
		bandGpu?: boolean;
		argminGpu?: boolean;
	} = {},
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
		(prep) => fitGpuPartAuto(device, prep, opts),
		{ valid: opts.valid },
	);
	if (!r) return null;
	return fitTail(device, W, H, input, T0, r, opts.argminGpu);
}

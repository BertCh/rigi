// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The haze fit's grid arg-min on the GPU (WAG haze-graph), as a luma GPUProgram: submit 2 of the
// haze fit (./haze-graph.ts gridGraph) computes the 5 550-cell physical grid and, instead of reading
// every cell back for the CPU's candidate scan (haze.ts gridCandidates), reduces it on the GPU and
// reads back only the minimum, the candidate count and at most GRID_PICK_CAP candidates (2 KiB
// instead of 22 KiB). The CPU re-applies its exact f64 test to them, so the candidates (and the
// whole HazeFit) are the same bit for bit (haze-argmin.check.ts: emulatePick, on adversarial grids).
//
// The program (GPUProgramCompiler, graph group "look-haze-argmin", one compiled graph per device):
//   [grid]       haze.ts K_HZ_GRID → err (5 550 f32)                        our kernel (lowered step)
//   [min]        NaN-skipping min of err on order keys → scalar gMin       our kernel, 1 workgroup
//   literals     zero, k1 = 1.01e-3, k2 = 2e-12, count = 0, cap            GPUProgramScalarLiteral
//   tolerance    tol = gMin + max(gMin, 0 − gMin)·k1 + k2                  scalarArithmetic × 5
//   [clear pick] [cand] cells with key(err) ≤ key(tol): atomic count, the first CAP into `pick`
//   over         count > cap                                               scalarCompare
//   if (over)    [select]: the CAP smallest by (err, index) into `pick`    GPUConditionalOperation:
//                                                                          GPU indirect-dispatch gate
//   [read]       gMin, tol, count, over (arena words 0–3) and `pick`       our read node
// [bracketed] = our core kernels, lowered into the program's graph by a registered lowering
// ("rigi-graph-step"): a ComputeGraph adopts the compiler's lowering graph, so the kernels keep the
// clear lint, read nodes and cachedGraph; the conditional gates our [select] node like any compute
// node of the program (fixed workgroups → upstream dispatchWorkgroups).
//
// Exactness. min, the candidate test and the ranking are integer compares on order keys of the f32
// bits (−0 folded onto +0, NaN never a candidate), so fast-math or subnormal flushing cannot change
// them. Only the tolerance is float arithmetic (luma's scalar kernels): it is a superset bound,
// k1 / k2 are 1 % / 2× above haze.ts's 1e-3 / 1e-12, far beyond f32 rounding, and the CPU checks it
// per call (tol ≥ gridTolerance(gMin), the pick's values within [gMin, tol], gMin among them). The
// cells within haze.ts's own tolerance are a prefix of the superset in (err, index) order, so the
// first CAP of the superset hold the first CAP of them. A failed check (or a compile fault) turns the
// program off for the device; gridGraph then reads the whole grid as before.
//
// Why not more of it in the program. Per-run values cannot be program inputs (literals are baked at
// compile time): the grid's S / airlight / weights stay in our uniform, and the read node's sizes are
// CPU-side (WebGPU copies cannot be GPU-sized), so the gate decides what is computed, not what is
// read.
import type { Device } from "@luma.gl/core";
import { ComputeGraph } from "../core/graph";
import {
	GPUConditionalOperation,
	type GPUOperation,
	GPUProgram,
	GPUProgramCompiler,
	GPUProgramScalarLiteral,
	type GraphBufferHandle,
	scalarArithmetic,
	scalarCompare,
} from "../core/luma";
import {
	GRID_CELLS,
	GRID_PICK_CAP,
	type GridPick,
	gridTolerance,
} from "./haze";
import { defineKernel } from "./kernel";

/** The superset tolerance's constants (f32 literals; haze.ts gridTolerance uses 1e-3 and 1e-12). */
export const PICK_K1 = 1.01e-3;
export const PICK_K2 = 2e-12;

/** Arena words the kernels address (the program declares these scalars first, in this order). */
const W_GMIN = 0;
const W_TOL = 1;
const W_COUNT = 2;
export const PICK_ARENA_WORDS = 4;

const KEYS = /* wgsl */ `
fn isNan(b: u32) -> bool { return (b & 0x7fffffffu) > 0x7f800000u; }
// f32 bits → u32 in float order; −0 folded onto +0 (the CPU compares them equal)
fn orderKey(b0: u32) -> u32 {
  let b = select(b0, 0u, b0 == 0x80000000u);
  return select(b | 0x80000000u, ~b, (b & 0x80000000u) != 0u);
}
`;

/** One workgroup: the min order key of the non-NaN cells → arena[W_GMIN] (f32 bits; none: +inf). */
const HZA_MIN = (cells: number) => /* wgsl */ `${KEYS}
@group(0) @binding(0) var<storage, read> err: array<u32>;
@group(0) @binding(1) var<storage, read_write> vals: array<u32>;
var<workgroup> part: array<u32, 256>;
var<workgroup> partBits: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  var m = 0xffffffffu;
  var mb = 0x7f800000u;
  for (var k = li; k < ${cells}u; k += 256u) {
    let b = err[k];
    let key = orderKey(b);
    if (!isNan(b) && key < m) { m = key; mb = b; }
  }
  part[li] = m;
  partBits[li] = mb;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (li < s && part[li + s] < part[li]) {
      part[li] = part[li + s];
      partBits[li] = partBits[li + s];
    }
    workgroupBarrier();
  }
  if (li == 0u) { vals[${W_GMIN}u] = partBits[0]; }
}
`;

/** Per cell: key(err) ≤ key(tol) → an atomic slot; the first CAP slots get (index, err bits). */
const HZA_CAND = (cells: number) => /* wgsl */ `${KEYS}
@group(0) @binding(0) var<storage, read> err: array<u32>;
@group(0) @binding(1) var<storage, read_write> vals: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> pick: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = id.x;
  if (k >= ${cells}u) { return; }
  let b = err[k];
  let tol = orderKey(atomicLoad(&vals[${W_TOL}u]));
  if (isNan(b) || orderKey(b) > tol) { return; }
  let slot = atomicAdd(&vals[${W_COUNT}u], 1u);
  if (slot < ${GRID_PICK_CAP}u) { pick[2u * slot] = k; pick[2u * slot + 1u] = b; }
}
`;

/** Per candidate (gated: count > CAP): its rank by (key, index); ranks < CAP into `pick`. */
const HZA_SELECT = (cells: number) => /* wgsl */ `${KEYS}
@group(0) @binding(0) var<storage, read> err: array<u32>;
@group(0) @binding(1) var<storage, read> vals: array<u32>;
@group(0) @binding(2) var<storage, read_write> pick: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = id.x;
  if (k >= ${cells}u) { return; }
  let b = err[k];
  let tol = orderKey(vals[${W_TOL}u]);
  if (isNan(b) || orderKey(b) > tol) { return; }
  let kb = orderKey(b);
  var r = 0u;
  for (var j = 0u; j < ${cells}u; j++) {
    let bj = err[j];
    if (isNan(bj)) { continue; }
    let kj = orderKey(bj);
    if (kj > tol) { continue; }
    if (kj < kb || (kj == kb && j < k)) { r++; }
  }
  if (r < ${GRID_PICK_CAP}u) { pick[2u * r] = k; pick[2u * r + 1u] = b; }
}
`;

/** The arg-min kernels for the haze grid (in the look's warm group: on by default). */
const K_HZA_MIN = defineKernel("hza-min", HZA_MIN(GRID_CELLS), [
	["err", "read-only-storage"],
	["vals", "storage"],
]);
const K_HZA_CAND = defineKernel("hza-cand", HZA_CAND(GRID_CELLS), [
	["err", "read-only-storage"],
	["vals", "storage"],
	["pick", "storage"],
]);
const K_HZA_SELECT = defineKernel("hza-select", HZA_SELECT(GRID_CELLS), [
	["err", "read-only-storage"],
	["vals", "read-only-storage"],
	["pick", "storage"],
]);

/** A program step whose lowering adds our core nodes to the program's graph (see the header). */
type StepContext<P> = {
	graph: ComputeGraph<P>;
	/** the program's scalar arena (a transient of the program's graph; words W_* hold our scalars) */
	arena: GraphBufferHandle;
};
class GraphStep<P> implements GPUOperation {
	readonly type = "rigi-graph-step";
	constructor(
		readonly id: string,
		readonly add: (s: StepContext<P>) => void,
	) {}
}

/**
 * Build the arg-min program around `grid` (which adds the grid kernel writing `err`, GRID_CELLS f32,
 * and returns that buffer) on a ComputeGraph adopting the compiler's lowering graph (not compiled).
 * Its read node "pick" holds arena words 0–3 (gMin, tol, count, over), then GRID_PICK_CAP (index,
 * err bits) pairs. Throws when the compiler's arena layout is not the one the kernels address.
 */
export function buildArgminProgram<P>(
	device: Device,
	id: string,
	grid: (g: ComputeGraph<P>) => GraphBufferHandle,
): ComputeGraph<P> {
	const program = new GPUProgram({ id });
	// declared first: arena words 0–3 (checked after compile)
	const gMin = program.scalar("gMin", "float32");
	const tol = program.scalar("tol", "float32");
	const count = program.scalar("count", "uint32");
	const over = program.scalar("over", "uint32");
	const zero = program.scalar("zero", "float32");
	const k1 = program.scalar("k1", "float32");
	const k2 = program.scalar("k2", "float32");
	const cap = program.scalar("cap", "uint32");
	const neg = program.scalar("neg", "float32");
	const absMin = program.scalar("absMin", "float32");
	const scaled = program.scalar("scaled", "float32");
	const sum = program.scalar("sum", "float32");

	let cg: ComputeGraph<P> | null = null;
	let err: GraphBufferHandle | null = null;
	let pick: GraphBufferHandle | null = null;
	const groups = Math.ceil(GRID_CELLS / 64);
	program.add(
		new GraphStep<P>("grid", ({ graph, arena }) => {
			err = grid(graph);
			graph.addKernel({
				id: "min",
				spec: K_HZA_MIN,
				bindings: { err, vals: arena },
				workgroups: [1],
			});
		}),
	);
	program.add([
		new GPUProgramScalarLiteral({ id: "zero", output: zero, value: 0 }),
		new GPUProgramScalarLiteral({ id: "k1", output: k1, value: PICK_K1 }),
		new GPUProgramScalarLiteral({ id: "k2", output: k2, value: PICK_K2 }),
		new GPUProgramScalarLiteral({ id: "count0", output: count, value: 0 }),
		new GPUProgramScalarLiteral({
			id: "cap",
			output: cap,
			value: GRID_PICK_CAP,
		}),
		scalarArithmetic({
			id: "neg",
			operation: "subtract",
			left: zero,
			right: gMin,
			output: neg,
		}),
		scalarArithmetic({
			id: "abs",
			operation: "max",
			left: gMin,
			right: neg,
			output: absMin,
		}),
		scalarArithmetic({
			id: "scale",
			operation: "multiply",
			left: absMin,
			right: k1,
			output: scaled,
		}),
		scalarArithmetic({
			id: "sum",
			operation: "add",
			left: gMin,
			right: scaled,
			output: sum,
		}),
		scalarArithmetic({
			id: "tol",
			operation: "add",
			left: sum,
			right: k2,
			output: tol,
		}),
	]);
	program.add(
		new GraphStep<P>("cand", ({ graph, arena }) => {
			if (!err) throw new Error(`${id}: the grid step did not run first`);
			pick = graph.transientBuffer("pick", GRID_PICK_CAP * 8);
			graph.clearNode("clear-pick", pick);
			graph.addKernel({
				id: "cand",
				spec: K_HZA_CAND,
				bindings: { err, vals: arena, pick },
				workgroups: [groups],
				writes: { pick: "partial" },
			});
		}),
	);
	program.add(
		scalarCompare({
			id: "over",
			operation: "greater-than",
			left: count,
			right: cap,
			output: over,
		}),
	);
	program.add(
		new GPUConditionalOperation({
			id: "if-over",
			predicate: {
				id: "over",
				source: "gpu",
				value: over,
				expression: "count > cap",
			},
			body: new GraphStep<P>("select", ({ graph, arena }) => {
				if (!err || !pick) throw new Error(`${id}: select before cand`);
				graph.addKernel({
					id: "select",
					spec: K_HZA_SELECT,
					bindings: { err, vals: arena, pick },
					workgroups: [groups],
					writes: { pick: "partial" },
				});
			}),
		}),
	);
	program.add(
		new GraphStep<P>("read", ({ graph, arena }) => {
			if (!pick) throw new Error(`${id}: read before cand`);
			graph.readNode("pick", [
				{ buffer: arena, offset: 0, size: PICK_ARENA_WORDS * 4 },
				pick,
			]);
		}),
	);

	const compiler = new GPUProgramCompiler<P>(device);
	compiler.lowerings.register<GraphStep<P>>("rigi-graph-step", (op, c) => {
		cg ??= new ComputeGraph<P>(device, id, { graph: c.graph });
		const arena = c.resolveScalar(gMin).arena.buffer;
		op.add({ graph: cg, arena });
		c.recordDecision({
			operationId: op.id,
			operationType: op.type,
			lowering: "rigi-compute-graph",
			reason: "core ComputeGraph kernels lowered into the program's graph",
		});
	});
	const compilation = compiler.compile(program);
	const words = [gMin, tol, count, over].map(
		(s) => compilation.scalars.get(s.id)?.wordOffset,
	);
	if (words.some((w, i) => w !== i) || !cg)
		throw new Error(`${id}: unexpected arena layout ${words.join(",")}`);
	return cg;
}

/**
 * The read node's two ranges (arena words, pick pairs) → a GridPick, with the per-call checks (null:
 * they failed): tol ≥ haze.ts's f64 tolerance, every read value within [gMin, tol], gMin among them.
 */
export function decodePick(
	words: ArrayBuffer,
	pickBytes: ArrayBuffer,
): GridPick | null {
	const f = new Float32Array(words, 0, PICK_ARENA_WORDS);
	const u = new Uint32Array(words, 0, PICK_ARENA_WORDS);
	const gMin = f[W_GMIN];
	const tol = f[W_TOL];
	const count = u[W_COUNT];
	const pairs = new Uint32Array(pickBytes);
	const n = Math.min(count, GRID_PICK_CAP);
	const idx = new Uint32Array(n);
	const err = new Float32Array(n);
	const errBits = new Uint32Array(err.buffer);
	for (let i = 0; i < n; i++) {
		idx[i] = pairs[2 * i];
		errBits[i] = pairs[2 * i + 1];
	}
	// runtime guard: a wrong superset would silently change the haze fit's start
	if (!(tol >= gridTolerance(gMin))) return null;
	let seenMin = count === 0;
	for (let i = 0; i < n; i++) {
		if (!(err[i] >= gMin && err[i] <= tol)) return null;
		if (err[i] === gMin) seenMin = true;
	}
	if (!seenMin) return null;
	return { gMin, count, idx, err };
}

/**
 * emulatePick: the program on the CPU (its integer logic exactly, the tolerance in f32 with
 * Math.fround), for haze-argmin.check.ts. `order` permutes the cand kernel's atomic slot order.
 */
export function emulatePick(
	g: Float32Array,
	order: (n: number) => number[] = (n) => [...Array(n).keys()],
): [ArrayBuffer, ArrayBuffer] {
	const bits = new Uint32Array(g.buffer, g.byteOffset, g.length);
	const isNan = (b: number) => (b & 0x7fffffff) >>> 0 > 0x7f800000;
	const key = (b0: number) => {
		const b = b0 === 0x80000000 ? 0 : b0;
		return (b & 0x80000000 ? ~b : b | 0x80000000) >>> 0;
	};
	let m = 0xffffffff;
	let mb = 0x7f800000;
	for (let k = 0; k < g.length; k++)
		if (!isNan(bits[k]) && key(bits[k]) < m) {
			m = key(bits[k]);
			mb = bits[k];
		}
	const words = new ArrayBuffer(PICK_ARENA_WORDS * 4);
	const pairs = new ArrayBuffer(GRID_PICK_CAP * 8);
	const u = new Uint32Array(words);
	const f = new Float32Array(words);
	u[W_GMIN] = mb;
	const gMin = f[W_GMIN];
	const fr = Math.fround;
	const absMin = fr(Math.max(gMin, fr(0 - gMin)));
	f[W_TOL] = fr(fr(gMin + fr(absMin * fr(PICK_K1))) + fr(PICK_K2));
	const tolKey = key(u[W_TOL]);
	const inS = (b: number) => !isNan(b) && key(b) <= tolKey;
	const pick = new Uint32Array(pairs);
	let count = 0;
	for (const k of order(g.length)) {
		if (!inS(bits[k])) continue;
		const slot = count++;
		if (slot < GRID_PICK_CAP) {
			pick[2 * slot] = k;
			pick[2 * slot + 1] = bits[k];
		}
	}
	u[W_COUNT] = count;
	u[3] = count > GRID_PICK_CAP ? 1 : 0;
	if (count > GRID_PICK_CAP) {
		const s: number[] = [];
		for (let k = 0; k < g.length; k++) if (inS(bits[k])) s.push(k);
		for (const k of s) {
			let r = 0;
			for (const j of s) {
				const kj = key(bits[j]);
				const kb = key(bits[k]);
				if (kj < kb || (kj === kb && j < k)) r++;
			}
			if (r < GRID_PICK_CAP) {
				pick[2 * r] = k;
				pick[2 * r + 1] = bits[k];
			}
		}
	}
	return [words, pairs];
}

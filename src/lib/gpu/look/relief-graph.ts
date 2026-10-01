// The GPU relief passes (relief.ts reliefPassesGpu) on a core ComputeGraph: the default of
// reliefPassesGpu(…) / buildReliefFieldGpu(…); { graph: false } runs the pooled single-encoder
// path in relief.ts.
//
//   clear shadow → SHADOW (atomicOr)          ┐
//   DOWN → clear acc8 → SVF → SUM             ├→ PACK → read (field, gen)
//
// Same five KernelSpecs as relief.ts (unchanged WGSL: RELIEF_SUM keeps its fixed k = 0..7 f32 order,
// the CPU's Float32Array order), same uniform words (built by relief.ts), same workgroup counts. What
// changes: shadow, Hh, hull, acc8, acc, field and gen are graph TRANSIENTS sized exactly and aliased
// by lifetime (hull / Hh / acc8 die before field / gen are born); H and the uniforms are pooled
// imports; field and gen come back through a read node (one readback slot, as before).
//
// Clear audit (graph transients are never zeroed and alias other transients' bytes):
// - shadow: written with atomicOr ("atomic") → clear node, always. ONE graph serves every sun: the
//   SHADOW node carries a CPU condition on the run's `degenerate` parameter (below the horizon /
//   zenith), so a degenerate sun skips that dispatch as the old path does, and the cleared shadow
//   transient reaches PACK (which binds it but writes the constant byte);
// - acc8: SVF writes every element of all 8 direction planes (every texel lies on exactly one sweep
//   line per direction), but the old path clears it, so it is declared "partial" and cleared here
//   too (zero-cost insurance, and the clear lint then guards it);
// - hull: fully written by SVF before any read (a line reads only hull entries it wrote) → "full";
// - Hh, acc, field, gen: one write per element (i < count, the dispatch covers the count) → "full".
// The lint in core/graph.ts throws at compile() if a declared atomic / partial transient has no
// clear node before it.
//
// NaN semantics: unchanged kernels, so exactly the old GPU path's (a NaN height is not ≤ HOLE, so it
// is not a hole; it propagates through the f32 maths and the u32() casts of PACK). The bench compares
// outputs as raw bytes, NaN inputs included.
import { Buffer, type Device } from "@luma.gl/core";
import { type ComputeGraph, cachedGraph } from "../core/graph";
import { pooledStorage, pooledUniform, withLease } from "../core/pool";
import {
	K_RELIEF_DOWN,
	K_RELIEF_PACK,
	K_RELIEF_SHADOW,
	K_RELIEF_SUM,
	K_RELIEF_SVF,
} from "./relief";

/** Per-run graph parameters: `degenerate` skips the SHADOW dispatch (CPU condition). */
type Params = { degenerate: boolean };

const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
export const RELIEF_GRAPH_GROUP = "look-relief";

/** Exact byte sizes of the relief intermediates at `res` (the old path pools each at pow2 capacity). */
export function reliefScratchBytes(res: number) {
	const N = res * res;
	const NH = (res >> 1) * (res >> 1);
	return {
		shadow: N,
		Hh: NH * 4,
		hull: 8 * NH * 4,
		acc8: 8 * NH * 4,
		acc: NH * 4,
		field: N * 4,
		gen: N * 4,
	};
}

/**
 * Build the relief graph for `res` (imports sized `hBytes` / `prmBytes`), run with
 * `{ degenerate }`. `unsafeSkipClears` exists only for the bench's lint check (compile must throw).
 * `_degenerate` is ignored (kept for the bench's call signature): the SHADOW node is always added,
 * with a CPU condition on the run's parameters (a graph run with `undefined` parameters, as the
 * bench's lint graph is typed, counts as a non-degenerate sun).
 */
export function buildReliefGraph<P extends Params | undefined = Params>(
	g: ComputeGraph<P>,
	res: number,
	hBytes: number,
	prmBytes: number,
	_degenerate?: boolean,
	unsafeSkipClears = false,
) {
	const resH = res >> 1;
	const NH = resH * resH;
	const sz = reliefScratchBytes(res);
	const prm = g.importBuffer("prm", prmBytes, undefined, UNIFORM);
	const H = g.importBuffer("H", hBytes);
	const t = (id: keyof typeof sz) => g.transientBuffer(id, sz[id]);
	const shadow = t("shadow");
	const Hh = t("Hh");
	const hull = t("hull");
	const acc8 = t("acc8");
	const acc = t("acc");
	const field = t("field");
	const gen = t("gen");
	if (!unsafeSkipClears) g.clearNode("clear-shadow", shadow);
	g.addKernel({
		id: "shadow",
		spec: K_RELIEF_SHADOW,
		bindings: { prm, H, shadow },
		// one workgroup: the rows run strictly in order
		workgroups: [1],
		writes: { shadow: "atomic" },
		condition: { id: "sun", source: "cpu", evaluate: (p) => !p?.degenerate },
	});
	g.addKernel({
		id: "down",
		spec: K_RELIEF_DOWN,
		bindings: { prm, Hf: H, Hh },
		workgroups: [Math.ceil(NH / 256)],
	});
	if (!unsafeSkipClears) g.clearNode("clear-acc8", acc8);
	g.addKernel({
		id: "svf",
		spec: K_RELIEF_SVF,
		bindings: { prm, Hh, hull, acc8 },
		workgroups: [Math.ceil((2 * resH) / 64), 8],
		writes: { acc8: "partial" },
	});
	g.addKernel({
		id: "sum",
		spec: K_RELIEF_SUM,
		bindings: { prm, acc8, acc },
		workgroups: [Math.ceil(NH / 256)],
	});
	g.addKernel({
		id: "pack",
		spec: K_RELIEF_PACK,
		bindings: { prm, H, shadow, acc, field, gen },
		workgroups: [Math.ceil(res / 16), Math.ceil(res / 16)],
	});
	g.readNode("read", [field, gen]);
}

/** Last graph run's shape-cache hit and compiled stats (bench / tests). */
export const lastReliefGraphRun: {
	hit?: boolean;
	stats?: ComputeGraph<Params>["stats"];
} = {};

/** reliefPassesGpu's passes on the graph (`words`: relief.ts's uniform block for this call). */
export function reliefGraphPasses(
	device: Device,
	H: Float32Array,
	res: number,
	words: ArrayBuffer,
	degenerate: boolean,
): Promise<{ field: Uint8Array; gen: Uint8Array }> {
	return withLease("look-relief-graph", async () => {
		const prm = pooledUniform(device, "look-relief-graph/prm", words);
		const gH = pooledStorage(device, "look-relief-graph/H", H);
		const key = `${res}|H${gH.byteLength}|u${prm.byteLength}`;
		const { graph, hit } = cachedGraph<Params, void>(
			device,
			RELIEF_GRAPH_GROUP,
			key,
			(g) => buildReliefGraph(g, res, gH.byteLength, prm.byteLength),
		);
		await graph.compileAsync();
		const { reads } = await graph.run(
			{ degenerate },
			{
				buffers: { prm, H: gH },
			},
		);
		lastReliefGraphRun.hit = hit;
		lastReliefGraphRun.stats = graph.stats;
		const [f, g] = reads.read;
		return { field: new Uint8Array(f), gen: new Uint8Array(g) };
	});
}

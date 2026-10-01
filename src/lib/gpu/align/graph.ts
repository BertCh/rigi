// The align kernels (./pose-grid.ts POSE_GRID, ./pose-bound.ts POSE_BOUND) on a core ComputeGraph:
// the default path of scorePoseGridGpu and poseBoundSession (`{ graph: false }` keeps the pooled
// single dispatch). Both are one-pose-per-workgroup kernels with one storage output, so one shape:
//
//   clear out → KERNEL (unchanged WGSL / spec) → read out[0, nPoses · stride)
//
// Inputs stay graph IMPORTS: the very pooled buffers the pooled path binds (u, poses, dirs, the edge
// planes uploaded once per photo, the sky planes; pose-bound's private per-session skyCum copy keeps
// its own "align/refine-skycum" slot and session-writer check), bound per run at their full byte
// length, so every input binding has the pooled path's byte size and contents. The output is a graph
// TRANSIENT of capacityFor(nPoses · stride) (the pooled slot's size class), read through a read node.
//
// Bit-identity with the pooled path: same kernel spec (WGSL, pipeline, layout), same uniform bytes,
// same input buffers, same nPoses workgroups. Neither kernel calls arrayLength() and both write only
// out[pi < nPoses], so the output binding's capacity cannot reach a value.
// Clear: out is written in full for the read range (every workgroup's lane 0 writes its pose's
// words), but transients are never zeroed and may hold a previous run's bytes, so it is cleared over
// the read range first (≤ 2525 · 48 B) and declared "partial" (the core clear lint enforces it). For
// pose-bound this keeps the stale-data guard sound on the graph: a silently skipped dispatch leaves
// zeros, and the per-call nonce (never 0), the pose-index echo and the tan(vfov/2) echo all reject
// them, exactly as they reject a stale pooled slot.
//
// Per-call overhead: static import; the run parameters and buffer record are built once per call;
// graphs are cached per (kernel, input byte lengths, output capacity) with core cachedGraph, and the
// caller already holds the "align" lease (the graph's own lease is queued synchronously after the
// lookup, so an eviction lands after this run).
import { Buffer, type Device } from "@luma.gl/core";
import { cachedGraph } from "#/lib/gpu/core/graph";
import type { KernelSpec } from "#/lib/gpu/core/kernel";
import { capacityFor } from "#/lib/gpu/core/pool";

type Params = { n: number };

const STORAGE = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;
const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;

/** cachedGraph group of the align graphs. */
export const ALIGN_GRAPH_GROUP = "align-pose";

/**
 * Run `spec` (one workgroup per pose) over `nPoses` with `inputs` (every layout name but `out`,
 * pooled buffers) and read `out`'s first nPoses · `stride` bytes. Call under the "align" lease.
 */
export async function runPoseGraph(
	device: Device,
	spec: KernelSpec,
	inputs: Record<string, Buffer>,
	out: string,
	stride: number,
	nPoses: number,
): Promise<ArrayBuffer> {
	const outCap = capacityFor(nPoses * stride);
	let key = `${spec.id},o${outCap}`;
	for (const [name] of spec.layout)
		if (name !== out) key += `,${name}${inputs[name].byteLength}`;
	const { graph } = cachedGraph<Params>(device, ALIGN_GRAPH_GROUP, key, (g) => {
		const bindings: Record<string, ReturnType<typeof g.importBuffer>> = {};
		for (const [name, kind] of spec.layout)
			if (name !== out)
				bindings[name] = g.importBuffer(
					name,
					inputs[name].byteLength,
					undefined,
					kind === "uniform" ? UNIFORM : STORAGE,
				);
		const o = g.transientBuffer(out, outCap, STORAGE);
		bindings[out] = o;
		g.clearNode("clear-out", { buffer: o, size: (p) => p.n * stride });
		g.addKernel({
			id: spec.label,
			spec,
			bindings,
			workgroups: (p) => [p.n],
			writes: { [out]: "partial" },
		});
		g.readNode("read", [{ buffer: o, size: (p) => p.n * stride }]);
		g.compile();
		return undefined;
	});
	// run() cancels every staged slot it does not hand back, whatever throws (incl. the core
	// workgroup-limit guard in encodeDispatch: the caller then goes CPU, as on the pooled path)
	const { reads } = await graph.run({ n: nPoses }, { buffers: inputs });
	const buf = reads.read?.[0];
	if (!buf) throw new Error(`${graph.id}: read node did not run`);
	return buf;
}

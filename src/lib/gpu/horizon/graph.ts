// Horizon march chunks on a core ComputeGraph: the GPU path of computeHorizonGpu (./index.ts).
//
// Each chunk is one encoding of a 1-kernel graph:
//   clear stats → MARCH (./horizon.wgsl.ts, unchanged) → read [out, stats] (one slot)
// `out` and `stats` are graph transients. stats is atomically accumulated, so its clear is required.
// out needs no clear: every in-range invocation writes both of its words (the kernel's only early
// return is the out-of-range guard), so the read range [0, nE·nAz·8) is fully written ("full").
// u / params / the mosaic pages stay imports: params and u are pooled uploads written per chunk, the
// pages are the persistent per-mosaic-set buffers.
//
// Bindings: params / out / stats are bound as per-run ranges of exactly paramsBytes / outBytes /
// statsBytes, although the graph is keyed on their power-of-two capacities (this kept the outputs
// bit-identical to the pooled single dispatch this replaced, removed 2026-10-01).
//
// Chunk overlap is kept: index.ts packs and submits chunk c+1 before collecting chunk c. Chunks share
// the graph's transients and the pooled u / params; WebGPU queue order puts chunk c's read copy before
// chunk c+1's writeBuffer / clear. core/readback maps with the raw mapAsync, so collecting c waits for
// c only. The graph's lease is held for the whole call (inside the "horizon" lease).
//
// Per-call overhead: the u slot is only sized here (not written twice), and the run parameters and
// bindings record are built once per call and reused by every chunk.
import { Buffer, type Device } from "@luma.gl/core";
import { cachedGraph } from "#/lib/gpu/core/graph";
import type { KernelSpec } from "#/lib/gpu/core/kernel";
import { submit } from "#/lib/gpu/core/kernel";
import { acquire, capacityFor, pooledUniform } from "#/lib/gpu/core/pool";
import type { StagedRead } from "#/lib/gpu/core/readback";

type Params = {
	nAz: number;
	nE: number;
	paramsBytes: number;
	outBytes: number;
	statsBytes: number;
};

export type ChunkShape = {
	/** the march kernel spec (index.ts MARCH) */
	spec: KernelSpec;
	/** the 4 page bindings (unused ones: the 16-byte dummy range) */
	pages: { buffer: Buffer; size: number }[];
	paramsBytes: number;
	outBytes: number;
	statsBytes: number;
};

export type Chunker = {
	/** Upload u / params, encode one chunk, submit; the read resolves [out, stats] like stageReads. */
	submit: (
		ub: ArrayBuffer,
		params: Uint8Array,
		nAz: number,
		nE: number,
	) => StagedRead;
	/** Release the graph's lease (after the last read). */
	release: () => void;
};

const STORAGE = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;

/** Hold `lease` until the returned release() is called. */
function hold(lease: (fn: () => Promise<void>) => Promise<void>) {
	return new Promise<() => void>((granted) => {
		void lease(() => new Promise<void>((done) => granted(done)));
	});
}

const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
const PARAMS = Buffer.STORAGE | Buffer.COPY_DST;

/**
 * The chunk runner of one computeHorizonGpu call. Call inside the "horizon" lease (the pooled u /
 * params slots and the cached graphs of group "horizon-march" are only touched under it).
 */
export async function graphChunker(
	device: Device,
	lease: string,
	s: ChunkShape,
): Promise<Chunker> {
	// the u slot as pooledUniform(64 B) sizes it (no write here: submit() writes it per chunk)
	const uBytes = acquire(device, `${lease}/u`, 64, UNIFORM).byteLength;
	const paramsCap = capacityFor(s.paramsBytes);
	const outCap = capacityFor(s.outBytes);
	const statsCap = capacityFor(s.statsBytes);
	let key = `u${uBytes},p${paramsCap},o${outCap},s${statsCap}`;
	for (let i = 0; i < s.pages.length; i++)
		key += `,pg${i}:${s.pages[i].buffer.byteLength}/${s.pages[i].size}`;
	const { graph } = cachedGraph<Params>(device, "horizon-march", key, (g) => {
		const u = g.importBuffer("u", uBytes, undefined, UNIFORM);
		const params = g.importBuffer("params", paramsCap, undefined, PARAMS);
		const pg = s.pages.map((p, i) =>
			g.importBuffer(`pg${i}`, p.buffer.byteLength, undefined, Buffer.STORAGE),
		);
		const out = g.transientBuffer("out", outCap, STORAGE);
		const stats = g.transientBuffer("stats", statsCap, STORAGE);
		// out: no clear (fully written for the read range, see the header); stats: atomics
		g.clearNode("clear-stats", { buffer: stats, size: (p) => p.statsBytes });
		g.addKernel({
			id: "march",
			spec: s.spec,
			bindings: {
				u,
				params: { buffer: params, size: (p) => p.paramsBytes },
				pg0: { buffer: pg[0], size: s.pages[0].size },
				pg1: { buffer: pg[1], size: s.pages[1].size },
				pg2: { buffer: pg[2], size: s.pages[2].size },
				pg3: { buffer: pg[3], size: s.pages[3].size },
				outTD: { buffer: out, size: (p) => p.outBytes },
				stats: { buffer: stats, size: (p) => p.statsBytes },
			},
			workgroups: (p) => [Math.ceil(p.nAz / 64), p.nE, 1],
			writes: { stats: "atomic" },
		});
		g.readNode("read", [
			{ buffer: out, size: (p) => p.nE * p.nAz * 8 },
			{ buffer: stats, size: (p) => p.nE * 12 },
		]);
		return undefined;
	});
	const release = await hold((fn) => graph.lease(fn));
	try {
		if (!graph.isCompiled) await graph.compileAsync();
	} catch (e) {
		release();
		throw e;
	}
	const bufs: Record<string, Buffer> = {
		pg0: s.pages[0].buffer,
		pg1: s.pages[1].buffer,
		pg2: s.pages[2].buffer,
		pg3: s.pages[3].buffer,
	};
	const p: Params = {
		nAz: 0,
		nE: 0,
		paramsBytes: s.paramsBytes,
		outBytes: s.outBytes,
		statsBytes: s.statsBytes,
	};
	return {
		submit(ub, params, nAz, nE) {
			// pooled u / params slots (the "horizon" lease), written per chunk
			bufs.u = pooledUniform(device, `${lease}/u`, ub);
			bufs.params = acquire(device, `${lease}/params`, s.paramsBytes, PARAMS);
			bufs.params.write(params);
			p.nAz = nAz;
			p.nE = nE;
			const enc = device.createCommandEncoder({ id: "horizon-march" });
			const { reads } = graph.encodeReads(enc, p, bufs);
			submit(device, enc); // a throwing submit cancels the staged read
			return {
				read: async () => (await reads.read()).read,
				cancel: reads.cancel,
			};
		},
		release,
	};
}

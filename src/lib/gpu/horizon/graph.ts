// Horizon march chunks on a core ComputeGraph (opt-in: computeHorizonGpu(…, { graph: true }); the
// pooled single-dispatch path in ./index.ts stays the default).
//
// Each chunk is one encoding of a 1-kernel graph:
//   clear out, clear stats → MARCH (./horizon.wgsl.ts, unchanged) → read [out, stats] (one slot)
// `out` and `stats` are graph transients (stats is atomically accumulated, so its clear is required;
// out is fully written for the read range, and cleared anyway by the house rule). u / params / the
// mosaic pages stay imports: params and u are pooled uploads written per chunk, the pages are the
// persistent per-mosaic-set buffers.
//
// Bit-identity with the pooled path: same kernel spec, same uniforms and params bytes, and every
// binding has the old path's byte size (params / out / stats are bound as per-run ranges of exactly
// paramsBytes / outBytes / statsBytes, although the graph is keyed on their power-of-two capacities).
//
// Chunk overlap is kept: index.ts packs and submits chunk c+1 before collecting chunk c. Chunks share
// the graph's transients and the pooled u / params; WebGPU queue order puts chunk c's read copy before
// chunk c+1's writeBuffer / clear. core/readback maps with the raw mapAsync, so collecting c waits for
// c only. The graph's lease is held for the whole call (inside the "horizon" lease).
import { Buffer, type Device } from "@luma.gl/core";
import { cachedGraph } from "#/lib/gpu/core/graph";
import { submit } from "#/lib/gpu/core/kernel";
import { acquire, capacityFor, pooledUniform } from "#/lib/gpu/core/pool";
import type { StagedRead } from "#/lib/gpu/core/readback";
import type { KernelSpec } from "#/lib/gpu/core/kernel";

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

/**
 * The chunk runner of one computeHorizonGpu call. Call inside the "horizon" lease (the pooled u /
 * params slots and the cached graphs of group "horizon-march" are only touched under it).
 */
export async function graphChunker(
	device: Device,
	lease: string,
	s: ChunkShape,
): Promise<Chunker> {
	const u0 = pooledUniform(device, `${lease}/u`, new ArrayBuffer(64));
	const paramsCap = capacityFor(s.paramsBytes);
	const outCap = capacityFor(s.outBytes);
	const statsCap = capacityFor(s.statsBytes);
	const key = [
		`u${u0.byteLength}`,
		`p${paramsCap}`,
		`o${outCap}`,
		`s${statsCap}`,
		...s.pages.map((p, i) => `pg${i}:${p.buffer.byteLength}/${p.size}`),
	].join(",");
	const { graph } = cachedGraph<Params>(device, "horizon-march", key, (g) => {
		const u = g.importBuffer(
			"u",
			u0.byteLength,
			undefined,
			Buffer.UNIFORM | Buffer.COPY_DST,
		);
		const params = g.importBuffer(
			"params",
			paramsCap,
			undefined,
			Buffer.STORAGE | Buffer.COPY_DST,
		);
		const pg = s.pages.map((p, i) =>
			g.importBuffer(`pg${i}`, p.buffer.byteLength, undefined, Buffer.STORAGE),
		);
		const out = g.transientBuffer("out", outCap, STORAGE);
		const stats = g.transientBuffer("stats", statsCap, STORAGE);
		g.clearNode("clear-out", { buffer: out, size: (p) => p.nE * p.nAz * 8 });
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
			writes: { stats: "atomic", outTD: "partial" },
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
	const bufs: Record<string, Buffer> = {};
	s.pages.forEach((p, i) => {
		bufs[`pg${i}`] = p.buffer;
	});
	return {
		submit(ub, params, nAz, nE) {
			// the same pooled slots as the default path (same lease), written per chunk
			bufs.u = pooledUniform(device, `${lease}/u`, ub);
			bufs.params = acquire(
				device,
				`${lease}/params`,
				s.paramsBytes,
				Buffer.STORAGE | Buffer.COPY_DST,
			);
			bufs.params.write(params);
			const enc = device.createCommandEncoder({ id: "horizon-march" });
			const { reads } = graph.encodeReads(
				enc,
				{
					nAz,
					nE,
					paramsBytes: s.paramsBytes,
					outBytes: s.outBytes,
					statsBytes: s.statsBytes,
				},
				bufs,
			);
			submit(device, enc); // a throwing submit cancels the staged read
			return {
				read: async () => (await reads.read()).read,
				cancel: reads.cancel,
			};
		},
		release,
	};
}

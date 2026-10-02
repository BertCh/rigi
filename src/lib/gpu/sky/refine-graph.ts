// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU sky refine (refine.ts refineSkyGpu) on gpu-core's GPUCommandGraph, via core/graph.ts
// ComputeGraph: the only GPU refine since 2026-10-01 (the pooled dispatchAll path it replaced gave
// bit-identical bytes and floats).
//
// The seven kernels of refine.ts in one linear chain (the graph's topological order is the insertion
// order, and the seven dispatches coalesce into one compute pass):
// - the ten intermediates (t, ab, band, abH, bandH, abS, pb, u4, u2, q) and the byte mask are graph
//   TRANSIENTS, sized exactly (a pool would round each to a power of two) and aliased by lifetime: the
//   low-res t / ab / band / … die before the full-res u4 / u2 / q / bytes are born;
// - the inputs (params, guideLo, P(sky), rgba, axis taps, LUT) are graph IMPORTS, still pooled under
//   the "sky-refine" lease (graph imports are caller-owned) and bound per run through
//   run({ buffers }). ORT's output GPUBuffer is wrapped per run (not owned), so the model output
//   never leaves the GPU;
// - the byte mask (and the float mask when asked) are read by a core readNode on the graph's encoder
//   (results in run().reads.read); the float range is sized 0 when not asked, which skips its copy;
// - compiled graphs are cached by shape (lw, lh, W, H) with core cachedGraph (group "sky-refine",
//   2 per device; radius / eps / band are uniforms, so they do not key the cache).
//
// Clear audit (aliasing hands a transient another transient's stale bytes, and transients are never
// zeroed per encoding): every kernel here writes every element of its outputs' logical ranges and
// none uses atomics (see refine.wgsl.ts: each output is written once per invocation index < count,
// and the dispatch covers the whole count), so every storage output is "full" (KernelNode.writes
// default) and no clearNode is needed; core's compile-time clear lint enforces the rule.
import { Buffer, type Device } from "@luma.gl/core";
import {
	type ComputeGraph,
	cachedGraph,
	releaseCachedGraphs,
} from "#/lib/gpu/core/graph";
import { pooledStorage, pooledUniform, withLease } from "#/lib/gpu/core/pool";
import {
	axisTable,
	inputBytes,
	isFloats,
	isHost,
	K_LO_H,
	K_LO_H2,
	K_LO_V,
	K_LO_V2,
	K_PACK,
	K_UP_H,
	K_UP_V,
	lutTable,
	type SkyRefineInput,
	type SkyRefineOutput,
	wrapGpu,
} from "./refine";
import { packSkyRefineParams } from "./uniforms";

const WG = 256;

/** cachedGraph group of the refine graphs. */
export const SKY_GRAPH_GROUP = "sky-refine";

/**
 * Compiled graphs kept per device. Each holds its transients (the refine's scratch), so keep
 * this small: photos in one session mostly share a size; a new size evicts the oldest.
 */
const MAX_GRAPHS = 2;

type Params = { floats: boolean };

type GraphStats = NonNullable<ComputeGraph<Params>["stats"]>;

/** Byte sizes of every intermediate (exact, before any pow2 rounding). */
export function skyScratchBytes(lw: number, lh: number, W: number, H: number) {
	const n = lw * lh;
	const N = W * H;
	return {
		t: n * 64,
		ab: n * 16,
		band: n * 4,
		abH: n * 16,
		bandH: n * 4,
		abS: n * 16,
		pb: n * 8,
		u4: W * lh * 16,
		u2: W * lh * 8,
		q: N * 4,
		bytes: Math.ceil(N / 4) * 4,
	};
}

/**
 * One texel (or packed word) per invocation, 1-D: past maxComputeWorkgroupsPerDimension · 256
 * (≈ 16.7 Mpx at the WebGPU default 65535) the up-v dispatch is invalid. Refuse (the worker then
 * takes the CPU refine) instead of submitting an invalid encoder.
 */
function checkDispatch(
	device: Device,
	lw: number,
	lh: number,
	W: number,
	H: number,
) {
	const maxWg = device.limits.maxComputeWorkgroupsPerDimension;
	if (Math.ceil(Math.max(W * H, W * lh, lw * lh) / WG) > maxWg)
		throw new Error(
			`refineSkyGraph: ${W}x${H} needs more than ${maxWg} workgroups per dispatch`,
		);
}

/** Add the refine nodes for one shape to `g` (the ORT / float P(sky) is imported per run). */
export function buildSkyGraph(
	g: ComputeGraph<Params>,
	lw: number,
	lh: number,
	W: number,
	H: number,
): void {
	const n = lw * lh;
	const N = W * H;
	const nWords = Math.ceil(N / 4);
	const prm = g.importBuffer(
		"prm",
		32,
		undefined,
		Buffer.UNIFORM | Buffer.COPY_DST,
	);
	const gl = g.importBuffer("gl", 3 * n * 4, undefined, Buffer.STORAGE);
	const gp = g.importBuffer("gp", n * 4, undefined, Buffer.STORAGE);
	const rgba = g.importBuffer("rgba", N * 4, undefined, Buffer.STORAGE);
	const axis = g.importBuffer(
		"axis",
		axisTable(lw, lh, W, H).byteLength,
		undefined,
		Buffer.STORAGE,
	);
	const lut = g.importBuffer("lut", 512 * 4, undefined, Buffer.STORAGE);
	const sz = skyScratchBytes(lw, lh, W, H);
	const tr = (id: keyof typeof sz) => g.transientBuffer(id, sz[id]);
	const t = tr("t");
	const ab = tr("ab");
	const band = tr("band");
	const abH = tr("abH");
	const bandH = tr("bandH");
	const abS = tr("abS");
	const pb = tr("pb");
	const u4 = tr("u4");
	const u2 = tr("u2");
	const q = tr("q");
	const bytes = tr("bytes");
	const lo: [number] = [Math.ceil(n / WG)];
	g.addKernel({
		id: "lo-h",
		spec: K_LO_H,
		bindings: { prm, gl, gp, t },
		workgroups: lo,
	})
		.addKernel({
			id: "lo-v",
			spec: K_LO_V,
			bindings: { prm, t, gp, ab, band },
			workgroups: lo,
		})
		.addKernel({
			id: "lo-h2",
			spec: K_LO_H2,
			bindings: { prm, ab, band, abH, bandH },
			workgroups: lo,
		})
		.addKernel({
			id: "lo-v2",
			spec: K_LO_V2,
			bindings: { prm, abH, bandH, gp, abS, pb },
			workgroups: lo,
		})
		.addKernel({
			id: "up-h",
			spec: K_UP_H,
			bindings: { prm, axis, abS, pb, u4, u2 },
			workgroups: [Math.ceil((W * lh) / WG)],
		})
		.addKernel({
			id: "up-v",
			spec: K_UP_V,
			bindings: { prm, axis, u4, u2, rgba, lut, q },
			workgroups: [Math.ceil(N / WG)],
		})
		.addKernel({
			id: "pack",
			spec: K_PACK,
			bindings: { prm, q, lut, bytes },
			workgroups: [Math.ceil(nWords / WG)],
		})
		// the float mask only when asked: a 0-byte range stages no copy
		.readNode("read", [
			{ buffer: bytes, size: nWords * 4 },
			{ buffer: q, size: (p) => (p.floats ? N * 4 : 0) },
		]);
}

/** Destroy this device's cached refine graphs (each after its runs). */
export function releaseSkyGraphs(device: Device): Promise<void> {
	return releaseCachedGraphs(device, SKY_GRAPH_GROUP);
}

/** Last-run info for benches (cache hit, the compiled graph's stats). */
export let lastSkyGraphRun:
	| { key: string; hit: boolean; stats: GraphStats }
	| undefined;

/** refineSkyGpu's body (refine.ts): the refine graph for this shape, run once. */
export async function refineSkyGraph(
	device: Device,
	input: SkyRefineInput,
): Promise<SkyRefineOutput> {
	const { W, H, lw, lh } = input;
	const n = lw * lh;
	const N = W * H;
	if (inputBytes(input.rgba) !== 4 * N || inputBytes(input.guideLo) !== 12 * n)
		throw new Error("refineSkyGraph: input sizes do not match");
	checkDispatch(device, lw, lh, W, H);
	return withLease(SKY_GRAPH_GROUP, async () => {
		const key = `${lw}x${lh}>${W}x${H}`;
		// cachedGraph inside the group's lease, run() queued synchronously after it (no await between),
		// so an eviction's destroy lands after this run
		const { graph, hit } = cachedGraph<Params, void>(
			device,
			SKY_GRAPH_GROUP,
			key,
			(g) => buildSkyGraph(g, lw, lh, W, H),
			MAX_GRAPHS,
		);
		graph.compile();
		lastSkyGraphRun = {
			key,
			hit: !!hit,
			stats: graph.stats as GraphStats,
		};
		const words = packSkyRefineParams({
			lw,
			lh,
			W,
			H,
			r: input.radius ?? 3,
			br: input.band ?? 3,
			eps: input.eps ?? 2e-3,
		});
		const prm = pooledUniform(device, "sky-refine/prm", words);
		const borrowed: Buffer[] = [];
		const gl = isHost(input.guideLo)
			? pooledStorage(device, "sky-refine/guideLo", input.guideLo)
			: wrapGpu(device, "sky-refine/guideLo", input.guideLo);
		if (!isHost(input.guideLo)) borrowed.push(gl);
		const gp: Buffer = isFloats(input.prob)
			? pooledStorage(device, "sky-refine/prob", input.prob)
			: // ORT's buffer, wrapped (not owned; destroying the wrapper leaves the handle alone)
				device.createBuffer({
					id: "sky-refine/ort-prob",
					handle: input.prob,
					byteLength: input.prob.size,
					usage: input.prob.usage,
				});
		try {
			let rgba: Buffer;
			if (isHost(input.rgba)) {
				const rgba8 = new Uint8Array(
					input.rgba.buffer,
					input.rgba.byteOffset,
					input.rgba.byteLength,
				);
				rgba = pooledStorage(
					device,
					"sky-refine/rgba",
					rgba8.byteOffset % 4 ? rgba8.slice() : rgba8,
				);
			} else {
				rgba = wrapGpu(device, "sky-refine/rgba", input.rgba);
				borrowed.push(rgba);
			}
			const axis = pooledStorage(
				device,
				"sky-refine/axis",
				axisTable(lw, lh, W, H),
			);
			const lut = pooledStorage(device, "sky-refine/lut", lutTable());
			const floats = !!input.floats;
			// run() cancels every staged slot it does not hand back, whatever throws
			const { reads } = await graph.run(
				{ floats },
				{ buffers: { prm, gl, gp, rgba, axis, lut } },
			);
			const [b, f] = reads.read ?? [];
			if (!b) throw new Error("refineSkyGraph: read node did not run");
			return {
				bytes:
					N % 4 ? new Uint8Array(b, 0, N).slice() : new Uint8Array(b, 0, N),
				q: floats && f ? new Float32Array(f) : undefined,
			};
		} finally {
			if (gp.props.handle) gp.destroy();
			for (const b of borrowed) b.destroy();
		}
	});
}

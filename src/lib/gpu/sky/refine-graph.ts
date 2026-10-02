// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU sky refine (refine.ts refineSkyGpu) on gpu-core's GPUCommandGraph, via core/graph.ts
// ComputeGraph: the only GPU refine since 2026-10-01. Since the luma-convolution adoption the box
// means are luma GPUConvolutions (direct strategy, all-ones kernel, zero boundary), so the output
// is within f32 tolerance of the CPU twin, not bit-identical to the former hand-written passes.
//
// The chain, one compute pass (the graph's topological order is the insertion order):
// - lo-prep writes 13 planes (I.rgb, p, I·p, the six I_a·I_b) into ONE stacked field s1 of width lw
//   and height 13·(lh + r): each plane is followed by r zero rows, so a vertical window never reaches
//   the next plane (see refine.wgsl.ts);
// - GPUConvolution horizontal (2r+1 × 1) s1 → s2, vertical (1 × 2r+1) s2 → s3: the box sums;
// - lo-solve divides by the analytic in-range count, solves the guided filter into the 4-plane stack
//   a1 and writes the band plane (2-D window max / min of p);
// - GPUConvolution H then V over a1 → a2 → a3 (radius r), and a 3×3 over the band plane;
// - lo-finish divides by the counts into abS / pb; up-h, up-v, pack as before;
// - the transients (s1..s3, a1..a3, band, bandS, abS, pb, u4, u2, q) and the byte mask are graph
//   TRANSIENTS, sized exactly (a pool would round each to a power of two) and aliased by lifetime;
// - the inputs (params, guideLo, P(sky), rgba, axis taps, LUT, the all-ones kernel) are graph IMPORTS,
//   pooled under the "sky-refine" lease (graph imports are caller-owned) and bound per run through
//   run({ buffers }). The nn model's output GPUBuffer is wrapped per run (not owned), so the model
//   output never leaves the GPU. In the fused graph (./fused-graph.ts) guideLo, P(sky) and rgba are
//   instead graph views of the prep's transients and the model's output (`SkyRefineSources`);
// - the byte mask (and the float mask when asked) are read by a core readNode on the graph's encoder
//   (results in run().reads.read); the float range is sized 0 when not asked, which skips its copy;
// - compiled graphs are cached by shape (lw, lh, W, H) and the guided-filter radius r (it shapes the
//   stacks and kernels) with core cachedGraph (group "sky-refine", 2 per device); the band radius and
//   eps are uniforms and do not key the cache.
//
// Clear audit (aliasing hands a transient another transient's stale bytes, and transients are never
// zeroed per encoding): lo-prep and lo-solve write every element of their outputs (the gap rows
// get zeros), each GPUConvolution writes all width·height elements of its output, lo-finish and the
// rest write each element once, and none uses atomics, so every storage output is "full"
// (KernelNode.writes default) and no clearNode is needed; core's compile-time clear lint enforces it.
import { Buffer, type Device } from "@luma.gl/core";
import {
	type ComputeGraph,
	cachedGraph,
	type GraphBinding,
	releaseCachedGraphs,
} from "#/lib/gpu/core/graph";
import { GPUConvolution } from "#/lib/gpu/core/luma";
import { pooledStorage, pooledUniform, withLease } from "#/lib/gpu/core/pool";
import {
	axisTable,
	inputBytes,
	isFloats,
	isHost,
	K_LO_FINISH,
	K_LO_PREP,
	K_LO_SOLVE,
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

/** Planes of the S1 / S2 / S3 stacks (see LO_PREP) and of the (a, b) stack. */
const STACK_PLANES = 13;
const AB_PLANES = 4;
/** Elements of the all-ones kernel buffer: the longest of the 1-D (2r+1) and the 3×3 band kernels. */
const onesLength = (r: number) => Math.max(2 * r + 1, 9);

/** Byte sizes of every intermediate (exact, before any pow2 rounding). */
export function skyScratchBytes(
	lw: number,
	lh: number,
	W: number,
	H: number,
	r = 3,
) {
	const n = lw * lh;
	const N = W * H;
	const plane = (lh + r) * lw * 4;
	return {
		s1: STACK_PLANES * plane,
		s2: STACK_PLANES * plane,
		s3: STACK_PLANES * plane,
		a1: AB_PLANES * plane,
		a2: AB_PLANES * plane,
		a3: AB_PLANES * plane,
		band: n * 4,
		bandS: n * 4,
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
export function checkDispatch(
	device: Device,
	lw: number,
	lh: number,
	W: number,
	H: number,
	r: number,
) {
	const maxWg = device.limits.maxComputeWorkgroupsPerDimension;
	// lo-prep writes the 13-plane stack (the largest 1-D dispatch of ours; the convolutions lay out
	// their own dispatch)
	const widest = Math.max(W * H, W * lh, STACK_PLANES * (lh + r) * lw);
	if (Math.ceil(widest / WG) > maxWg)
		throw new Error(
			`refineSkyGraph: ${W}x${H} needs more than ${maxWg} workgroups per dispatch`,
		);
	const maxBinding = device.limits.maxStorageBufferBindingSize;
	if (STACK_PLANES * (lh + r) * lw * 4 > maxBinding)
		throw new Error(
			`refineSkyGraph: ${lw}x${lh} stack exceeds maxStorageBufferBindingSize ${maxBinding}`,
		);
}

/** A graph buffer handle or view (what a kernel binding takes). */
type Source = GraphBinding;

/**
 * Where the refine reads its inputs from when they are not per-run imports: the low-res guide, P(sky)
 * and the full-res RGBA words (fused graph), and an alpha flag to read back with the byte mask.
 */
export interface SkyRefineSources {
	/** The graph's shared LUT import (the prep reads the same table). */
	lut?: Source;
	gl: Source;
	gp: Source;
	rgba: Source;
	flag?: Source;
}

/**
 * Add the refine nodes for one shape to `g`. By default guideLo / P(sky) / rgba are imports bound per
 * run (the nn model's or a float P(sky)); `src` binds them to graph resources instead and adds
 * `src.flag` to the read node (second, after the byte mask).
 */
export function buildSkyGraph(
	g: ComputeGraph<Params>,
	lw: number,
	lh: number,
	W: number,
	H: number,
	r: number,
	src?: SkyRefineSources,
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
	const gl = src
		? src.gl
		: g.importBuffer("gl", 3 * n * 4, undefined, Buffer.STORAGE);
	const gp = src
		? src.gp
		: g.importBuffer("gp", n * 4, undefined, Buffer.STORAGE);
	const rgba = src
		? src.rgba
		: g.importBuffer("rgba", N * 4, undefined, Buffer.STORAGE);
	const axis = g.importBuffer(
		"axis",
		axisTable(lw, lh, W, H).byteLength,
		undefined,
		Buffer.STORAGE,
	);
	const lut =
		src?.lut ?? g.importBuffer("lut", 512 * 4, undefined, Buffer.STORAGE);
	const ones = g.importBuffer(
		"ones",
		onesLength(r) * 4,
		undefined,
		Buffer.STORAGE,
	);
	const sz = skyScratchBytes(lw, lh, W, H, r);
	const tr = (id: keyof typeof sz) => g.transientBuffer(id, sz[id]);
	const s1 = tr("s1");
	const s2 = tr("s2");
	const s3 = tr("s3");
	const a1 = tr("a1");
	const a2 = tr("a2");
	const a3 = tr("a3");
	const band = tr("band");
	const bandS = tr("bandS");
	const abS = tr("abS");
	const pb = tr("pb");
	const u4 = tr("u4");
	const u2 = tr("u2");
	const q = tr("q");
	const bytes = tr("bytes");
	const pitch = lh + r;
	const sCount = STACK_PLANES * pitch * lw;
	const aCount = AB_PLANES * pitch * lw;
	// all-ones box kernels over the stacks: the (2r+1) window along one axis, zero boundary, direct
	// (a 5-7 tap loop per element; the FFT crossover is far away)
	const box = (
		id: string,
		input: typeof s1,
		output: typeof s1,
		count: number,
		kw: number,
		kh: number,
		height: number,
	) =>
		g.add(
			new GPUConvolution({
				id,
				width: lw,
				height,
				kernelWidth: kw,
				kernelHeight: kh,
				strategy: "direct",
				boundary: "zero",
				input: g.view(input, "float32", count),
				kernel: g.view(ones, "float32", kw * kh),
				output: g.view(output, "float32", count),
			}),
		);
	const k = 2 * r + 1;
	g.addKernel({
		id: "lo-prep",
		spec: K_LO_PREP,
		bindings: { prm, gl, gp, s1 },
		workgroups: [Math.ceil(sCount / WG)],
	});
	box("sky-box-h", s1, s2, sCount, k, 1, STACK_PLANES * pitch);
	box("sky-box-v", s2, s3, sCount, 1, k, STACK_PLANES * pitch);
	g.addKernel({
		id: "lo-solve",
		spec: K_LO_SOLVE,
		bindings: { prm, s3, gp, a1, band },
		workgroups: [Math.ceil((pitch * lw) / WG)],
	});
	box("sky-ab-h", a1, a2, aCount, k, 1, AB_PLANES * pitch);
	box("sky-ab-v", a2, a3, aCount, 1, k, AB_PLANES * pitch);
	box("sky-band", band, bandS, n, 3, 3, lh);
	g.addKernel({
		id: "lo-finish",
		spec: K_LO_FINISH,
		bindings: { prm, a3, b2: bandS, gp, abS, pb },
		workgroups: [Math.ceil(n / WG)],
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
			// the alpha flag (fused graph) sits before the float mask so its read index does not depend on `floats`
			...(src?.flag ? [src.flag] : []),
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
	const r = input.radius ?? 3;
	checkDispatch(device, lw, lh, W, H, r);
	return withLease(SKY_GRAPH_GROUP, async () => {
		const key = `${lw}x${lh}>${W}x${H}/r${r}`;
		// cachedGraph inside the group's lease, run() queued synchronously after it (no await between),
		// so an eviction's destroy lands after this run
		const { graph, hit } = cachedGraph<Params, void>(
			device,
			SKY_GRAPH_GROUP,
			key,
			(g) => buildSkyGraph(g, lw, lh, W, H, r),
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
			r,
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
			: // the nn model's buffer, wrapped (not owned; destroying the wrapper leaves the handle alone)
				device.createBuffer({
					id: "sky-refine/nn-prob",
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
			const ones = pooledStorage(
				device,
				"sky-refine/ones",
				new Float32Array(onesLength(r)).fill(1),
			);
			const floats = !!input.floats;
			// run() cancels every staged slot it does not hand back, whatever throws
			const { reads } = await graph.run(
				{ floats },
				{ buffers: { prm, gl, gp, rgba, axis, lut, ones } },
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

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The sky segmenter's steady-state GPU path as ONE core ComputeGraph (one submission, one readback):
//   padded RGBA rows → prep kernels (gpu/sky/prep.ts buildPrepGraph) → the nn model's forward
//   (`forward` hook: nn.forwardInto on this graph, sky/fused.ts) → the refine nodes (refine-graph.ts
//   buildSkyGraph) → the byte mask (and the prep's alpha flag) read back.
// The three-step path (prepSkyGpu → inferSkyModelGpu → refineSkyGpu) is three awaited submissions with
// the intermediates (rgba, rgbLo, input, P(sky)) as caller-owned buffers; here they are graph
// transients aliased by lifetime, except P(sky), the model output, which is an imported buffer that
// lives with the cached graph (the `forward` hook's destroy frees it when the graph is evicted).
// The graph imports the model's weight buffers at build time, so it is keyed by the model identity and
// must be released before the model is disposed (releaseFusedGraphs); a device loss drops it.
// Per run the caller supplies the photo as padded rows (`fill` writes them into the pooled `pad`),
// the pooled tables and the params; the kernels are the same as the three-step path's.
import { Buffer, type Device } from "@luma.gl/core";
import {
	type ComputeGraph,
	cachedGraph,
	releaseCachedGraphs,
} from "#/lib/gpu/core/graph";
import type { GraphDataView } from "#/lib/gpu/core/luma";
import { pooledStorage, pooledUniform, withLease } from "#/lib/gpu/core/pool";
import { buildPrepGraph, prepTables, skyPrepUnsupported } from "./prep";
import { axisTable, lutTable } from "./refine";
import { buildSkyGraph, checkDispatch } from "./refine-graph";
import { packSkyPrepParams, packSkyRefineParams } from "./uniforms";

/** cachedGraph (and lease) group of the fused graphs. */
export const FUSED_GROUP = "sky-fused";

/** Compiled fused graphs per device: each holds the prep + refine scratch and the model output. */
const MAX_GRAPHS = 2;

type Params = { floats: boolean };

/** How the nn model is recorded into the fused graph (sky/fused.ts supplies it). */
export interface FusedModelHooks {
	/** Identity of the model whose weights the graph imports; part of the cache key. */
	key: string;
	/**
	 * Record the forward into `g`: `input` is the normalised NCHW f32 view (3·lw·lh); return P(sky) as a
	 * view (lw·lh f32) and a `destroy` that frees its output buffer (called when the graph is destroyed).
	 */
	forward(
		g: ComputeGraph<Params>,
		input: GraphDataView<"float32">,
		lw: number,
		lh: number,
	): { prob: GraphDataView<"float32">; destroy(): void };
}

export interface FusedSkyInput {
	/** Working size and model size (lw, lh). */
	W: number;
	H: number;
	lw: number;
	lh: number;
	model: FusedModelHooks;
	/** Write the photo as RGBA rows padded to `rowBytes` into `pad` (queue order puts the graph after it). */
	fill(pad: Buffer, rowBytes: number): void;
	/** Guided-filter radius / band radius / eps (refine defaults 3 / 3 / 2e-3). */
	radius?: number;
	band?: number;
	eps?: number;
	/** Also read the float mask (checks only). */
	floats?: boolean;
}

export interface FusedSkyOutput {
	/** P(sky)·255, row-major W × H. */
	bytes: Uint8Array;
	/** Every pixel's alpha was 255 (the precondition of the bitmap bytes equalling getImageData's). */
	opaque: boolean;
	q?: Float32Array;
}

/** The cache key: the shape, the refine radius and the model identity (the weights are imported). */
export const fusedGraphKey = (
	W: number,
	H: number,
	lw: number,
	lh: number,
	radius: number,
	modelKey: string,
) => `${W}x${H}>${lw}x${lh}/r${radius}/${modelKey}`;

/** Why the fused graph cannot run this shape on `device` (undefined: it can). */
export function fusedUnsupported(
	device: Device,
	W: number,
	H: number,
	lw: number,
	lh: number,
	radius = 3,
): string | undefined {
	const why = skyPrepUnsupported(device, W, H, lw, lh);
	if (why) return why;
	try {
		checkDispatch(device, lw, lh, W, H, radius);
	} catch (e) {
		return String(e);
	}
	return undefined;
}

/** Record prep → model → refine for one shape into `g`. */
function buildFusedGraph(
	g: ComputeGraph<Params>,
	W: number,
	H: number,
	lw: number,
	lh: number,
	r: number,
	model: FusedModelHooks,
) {
	const lut = g.importBuffer("lut", 512 * 4, undefined, Buffer.STORAGE);
	const prep = buildPrepGraph(g, W, H, lw, lh, { prefix: "p-", lut });
	const { prob, destroy } = model.forward(
		g,
		g.view(prep.input as never, "float32", 3 * lw * lh),
		lw,
		lh,
	);
	g.own([{ destroy }]);
	buildSkyGraph(g, lw, lh, W, H, r, {
		lut,
		gl: prep.rgbLo,
		gp: prob,
		rgba: prep.rgba,
		flag: prep.flag,
	});
}

/** Destroy this device's cached fused graphs (each after its runs); call before disposing the model. */
export function releaseFusedGraphs(device: Device): Promise<void> {
	return releaseCachedGraphs(device, FUSED_GROUP);
}

/** Last-run info for checks and benches. */
export let lastFusedRun: { key: string; hit: boolean } | undefined;

/** The fused graph for this shape, run once: one submission, the byte mask (+ alpha flag) read back. */
export async function runFusedSky(
	device: Device,
	input: FusedSkyInput,
): Promise<FusedSkyOutput> {
	const { W, H, lw, lh } = input;
	const r = input.radius ?? 3;
	const why = fusedUnsupported(device, W, H, lw, lh, r);
	if (why) throw new Error(`sky fused: ${why}`);
	const N = W * H;
	const rowBytes = Math.ceil((W * 4) / 256) * 256;
	return withLease(FUSED_GROUP, async () => {
		const key = fusedGraphKey(W, H, lw, lh, r, input.model.key);
		// cachedGraph inside the group's lease, run() right after it (no await between), so an
		// eviction's destroy lands after this run
		const { graph, hit } = cachedGraph<Params, void>(
			device,
			FUSED_GROUP,
			key,
			(g) => buildFusedGraph(g, W, H, lw, lh, r, input.model),
			MAX_GRAPHS,
		);
		graph.compile();
		lastFusedRun = { key, hit: !!hit };
		const t = prepTables(W, H, lw, lh);
		const slot = (name: string) => `${FUSED_GROUP}/${name}`;
		const pad = pooledStorage(device, slot("pad"), rowBytes * H, {
			zero: false,
		});
		input.fill(pad, rowBytes);
		const floats = !!input.floats;
		const buffers = {
			"p-prm": pooledUniform(
				device,
				slot("p-prm"),
				packSkyPrepParams(W, H, lw, lh, rowBytes),
			),
			"p-pad": pad,
			"p-axH": pooledStorage(device, slot("p-axH"), t.axH),
			"p-axV": pooledStorage(device, slot("p-axV"), t.axV),
			"p-cst": pooledStorage(device, slot("p-cst"), t.cst),
			// zeroed per run: prep-alpha only sets it
			"p-flag": pooledStorage(device, slot("p-flag"), 4),
			lut: pooledStorage(device, slot("lut"), lutTable()),
			prm: pooledUniform(
				device,
				slot("prm"),
				packSkyRefineParams({
					lw,
					lh,
					W,
					H,
					r,
					br: input.band ?? 3,
					eps: input.eps ?? 2e-3,
				}),
			),
			axis: pooledStorage(device, slot("axis"), axisTable(lw, lh, W, H)),
			ones: pooledStorage(
				device,
				slot("ones"),
				new Float32Array(Math.max(2 * r + 1, 9)).fill(1),
			),
		};
		const { reads } = await graph.run({ floats }, { buffers });
		const [b, flag, f] = reads.read ?? [];
		if (!b || !flag) throw new Error("sky fused: read node did not run");
		return {
			bytes: N % 4 ? new Uint8Array(b, 0, N).slice() : new Uint8Array(b, 0, N),
			opaque: new Uint32Array(flag)[0] === 0,
			q: floats && f ? new Float32Array(f) : undefined,
		};
	});
}

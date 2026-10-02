// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside's per-photo depth pipeline on the core ComputeGraph: GPU-resident hand-offs, and the CPU
// reads back only what it has to decide with. Per photo, under one lease ("nearfield-depth"):
//
//   upload   the photo ONCE as a depth-grid W x H raster (an ImageBitmap the browser resized with
//            createImageBitmap, or padded rows in node); gpu/sky/prep.ts resamples it to the net input on
//            the GPU: `rgba` (W·H words, the lift's colours) and `rgbLo` (3·ih·iw planar RGB 0..1, the net
//            input; MogeDepthNet.record still does the ImageNet sub/div with the checkpoint's own
//            constants, so the input is the old chain's to the last bit of the resample). The prep keeps its
//            own graph and submission ("sky-prep"); this pipeline's graphs queue after it.
//   graph 1  cachedGraph group nearfield-depth/<grid>, key <H>x<W>#<net>: the net recorded with
//            nn.forwardInto on the prep's rgbLo (bound per run as the import "netIn", so the graph is
//            reused for every photo of a shape). Its z / mask / normal outputs stay on the GPU; ONLY
//            points64, mask64 and metricScale (64·64·4·4 B ≈ 66 KB) are read back.
//   CPU      solveCamera: the focal / z-shift fit on those 64 x 64 samples (./focal-shift.ts, unchanged).
//   graph 2  cachedGraph group nearfield-compose, key <W>x<H>/<head>: K_COMPOSE on graph 1's z / mask /
//            normal buffers (bound per run: they are graph 1's outputs, not copies), K_NORMALS for weights
//            without the normal head, then the lift kernel (./lift-gpu.ts K_LIFT) on that depth / normal
//            and the prep's rgba. One submission, one read of depth (W·H f32), normal (3·W·H f32; the
//            CPU consumers need both) and the lift records.
//   valid = depth > 0 on the CPU (a pass over a Uint8Array).
//
// Ownership: graph 1's outputs live as long as its cached graph (the graph `own`s their disposal) and
// are overwritten by the next run of that graph, which the lease keeps off until graph 2 has run. The
// prep's buffers are this call's and are destroyed at the end (WebGPU defers the destroy past the
// submitted work). Nothing GPU-resident outlives estimateDepthGraph: the lift runs in the same job, so
// the client caches CPU depth + the lift records and builds the cloud only when asked.
import { Buffer, type Device } from "@luma.gl/core";
import {
	type ComputeGraph,
	cachedGraph,
	releaseCachedGraphs,
	viewRange,
} from "#/lib/gpu/core/graph";
import {
	capacityFor,
	pooledStorage,
	pooledUniform,
	withLease,
} from "#/lib/gpu/core/pool";
import type { ReadRange } from "#/lib/gpu/core/readback";
import { prepSkyGpu, prepSkyGpuFromRows } from "#/lib/gpu/sky/prep";
import type { Tensor } from "#/lib/nn";
import type { GpuNn } from "#/lib/nn/gpu/gpu-nn";
import type { GaussianCloud, NearFieldDepth } from "../types";
import { solveCamera } from "./compose";
import {
	COMPOSE_GROUP,
	composeParamWords,
	composeWorkgroups,
	K_COMPOSE,
	K_NORMALS,
	normalsParamWords,
} from "./compose-gpu";
import {
	DEPTH_GRAPH_GROUP,
	type DepthNetOutput,
	FOCAL_GRID,
	MOGE2_VITS,
	type MogeDepthNet,
	tokenGrid,
} from "./depth-net";
import {
	type IntrinsicsNorm,
	LIFT_DEFAULTS,
	LIFT_RECORD_WORDS,
	type LiftParams,
	liftGrid,
} from "./lift";
import { K_LIFT, LIFT_PRM, liftGaussiansGpu, liftParamWords } from "./lift-gpu";

/** The lease the whole per-photo pipeline (prep → graph 1 → CPU → graph 2 → reads) runs under. */
export const PIPELINE_LEASE = DEPTH_GRAPH_GROUP;

/** The photo as pixels on the depth grid: an ImageBitmap (browser) or 256 B-padded RGBA rows (node). */
export type PhotoPixels = ImageBitmap | { rows: Uint8Array };

export type DepthPhoto = {
	/** the depth grid (service decode_image: round(w · s)) */
	width: number;
	height: number;
	/** token grid; the net input is 14·bh x 14·bw */
	bh: number;
	bw: number;
	/** exactly width x height */
	pixels: PhotoPixels;
	/**
	 * Only for a photo smaller than the net input (width < 14·bw or height < 14·bh), which the prep
	 * cannot upsample: the same photo as an exactly 14·bw x 14·bh raster (the browser's own resize).
	 */
	netPixels?: PhotoPixels;
};

/** Sizes of one photo's pipeline: buffers, readbacks, grids (pure; specced). */
export type DepthPlan = {
	width: number;
	height: number;
	bh: number;
	bw: number;
	/** net input size */
	ih: number;
	iw: number;
	/** the net input is an upsample of the photo: needs DepthPhoto.netPixels */
	upsample: boolean;
	/** rgbLo (the net input, f32) */
	netInBytes: number;
	/** depth (W·H f32), normal (3·W·H f32), rgba words (W·H u32) */
	depthBytes: number;
	normalBytes: number;
	rgbaBytes: number;
	/** lift cells and records */
	cells: number;
	recordsBytes: number;
	/** graph 1 readback: points64 + mask64 + metricScale */
	graph1ReadBytes: number;
	/** graph 2 readback: depth + normal + records */
	graph2ReadBytes: number;
};

export function planDepthPipeline(
	width: number,
	height: number,
	tokens: number,
	stride = LIFT_DEFAULTS.stride,
): DepthPlan {
	const [bh, bw] = tokenGrid(tokens, width / height);
	const ih = bh * MOGE2_VITS.patch;
	const iw = bw * MOGE2_VITS.patch;
	const grid = liftGrid(width, height, stride);
	const n = width * height;
	const recordsBytes = grid.cells * LIFT_RECORD_WORDS * 4;
	const [fh, fw] = FOCAL_GRID;
	const graph1ReadBytes = (fh * fw * 3 + fh * fw + 1) * 4;
	return {
		width,
		height,
		bh,
		bw,
		ih,
		iw,
		upsample: width < iw || height < ih,
		netInBytes: 3 * ih * iw * 4,
		depthBytes: n * 4,
		normalBytes: 3 * n * 4,
		rgbaBytes: n * 4,
		cells: grid.cells,
		recordsBytes,
		graph1ReadBytes,
		graph2ReadBytes: n * 4 + 3 * n * 4 + recordsBytes,
	};
}

/** What the CPU path of the same photo reads back: z, mask, normal (head only), points64, mask64, scale. */
export function cpuPathReadBytes(
	width: number,
	height: number,
	hasNormalHead: boolean,
): number {
	const n = width * height;
	const [fh, fw] = FOCAL_GRID;
	return (n + n + (hasNormalHead ? 3 * n : 0) + fh * fw * 3 + fh * fw + 1) * 4;
}

type Graph1Extra = {
	out: DepthNetOutput;
	/** points64, mask64, metricScale */
	reads: ReadRange[];
	z: Buffer;
	mask: Buffer;
	normal: Buffer | null;
};

let netSerial = 0;
const netIds = new WeakMap<object, number>();
const netId = (net: MogeDepthNet) => {
	const id = netIds.get(net);
	if (id) return id;
	netSerial++;
	netIds.set(net, netSerial);
	return netSerial;
};

const MAX_GRAPHS = 2;

/** Graph 1: the net on a rebindable input. Build inside the pipeline lease. */
function depthGraph(
	device: Device,
	net: MogeDepthNet,
	plan: DepthPlan,
	consts: Awaited<ReturnType<MogeDepthNet["gridConsts"]>>,
) {
	const nn = net.nn as unknown as GpuNn;
	return cachedGraph<void, Graph1Extra>(
		device,
		consts.group,
		`${plan.height}x${plan.width}#${netId(net)}`,
		(g: ComputeGraph<void>) => {
			const n = 3 * plan.ih * plan.iw;
			const input = g.view(g.importBuffer("netIn", n * 4), "float32", n);
			const out = nn.forwardInto(g, () =>
				net.record(
					nn.fromView(g, input, [1, 3, plan.ih, plan.iw]),
					[plan.height, plan.width],
					consts,
				),
			);
			const rangeOf = (t: Tensor): ReadRange =>
				viewRange(nn.toView(g, t), nn.bufferOf(t));
			const owned = Object.values(out).filter((t): t is Tensor => t !== null);
			// the outputs are this graph's: disposed with it (an eviction, a release, device loss)
			g.own([
				{
					destroy: () => {
						try {
							nn.dispose(owned);
						} catch {
							// the runtime is gone with the device
						}
					},
				},
			]);
			return {
				out,
				reads: [out.points64, out.mask64, out.metricScale].map(rangeOf),
				z: nn.bufferOf(out.z),
				mask: nn.bufferOf(out.mask),
				normal: out.normal ? nn.bufferOf(out.normal) : null,
			};
		},
		MAX_GRAPHS,
	);
}

const STORAGE = Buffer.STORAGE | Buffer.COPY_DST;
const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;

type Graph2Extra = { cells: number };

/** Graph 2: compose (+ normals) + lift on graph 1's buffers and the prep's rgba. */
function composeGraph(device: Device, plan: DepthPlan, hasNormalHead: boolean) {
	return cachedGraph<void, Graph2Extra>(
		device,
		COMPOSE_GROUP,
		`${plan.width}x${plan.height}/${hasNormalHead ? "head" : "derived"}`,
		(g: ComputeGraph<void>) => {
			const n = plan.width * plan.height;
			const imp = (id: string, bytes: number) =>
				g.importBuffer(id, bytes, undefined, STORAGE);
			const prm = g.importBuffer("prm", 16, undefined, UNIFORM);
			const z = imp("z", n * 4);
			const mask = imp("mask", n * 4);
			const normalIn = imp("normalIn", hasNormalHead ? 3 * n * 4 : 16);
			const rgba = imp("rgba", n * 4);
			const depth = g.transientBuffer("depth", plan.depthBytes);
			const normal = g.transientBuffer("normal", plan.normalBytes);
			g.addKernel({
				id: "compose",
				spec: K_COMPOSE,
				bindings: { prm, z, mask, normalIn, depth, normalOut: normal },
				workgroups: composeWorkgroups(n),
			});
			if (!hasNormalHead) {
				const nprm = g.importBuffer("nprm", 32, undefined, UNIFORM);
				g.addKernel({
					id: "normals",
					spec: K_NORMALS,
					bindings: { prm: nprm, depth, normalOut: normal },
					workgroups: [Math.ceil(plan.width / 8), Math.ceil(plan.height / 8)],
				});
			}
			const targets = [depth, normal];
			if (plan.cells) {
				const grid = liftGrid(plan.width, plan.height, LIFT_DEFAULTS.stride);
				const lprm = g.importBuffer(
					"lprm",
					LIFT_PRM.byteLength,
					undefined,
					UNIFORM,
				);
				const records = g.transientBuffer("records", plan.recordsBytes);
				g.addKernel({
					id: "lift",
					spec: K_LIFT,
					bindings: { prm: lprm, depth, normal, rgba, records },
					workgroups: [Math.ceil(grid.gw / 8), Math.ceil(grid.gh / 8)],
				});
				targets.push(records);
			}
			// every word of depth / normal / records of the cells is written above (no clear needed)
			g.readNode("read", targets);
			return { cells: plan.cells };
		},
		MAX_GRAPHS,
	);
}

export type DepthGraphResult = {
	depth: NearFieldDepth & { focal: number; shift: number };
	/** the lift's records (cloudFromRecords) */
	records: Float32Array;
	cells: number;
	/** bytes read back from the GPU for this photo (both graphs) */
	readBytes: number;
};

export type DepthGraphOptions = {
	signal?: AbortSignal;
	/** NearFieldDepth.model */
	model: string;
	lift?: Partial<LiftParams>;
};

/**
 * One photo through the pipeline above. `net` must be on the GPU nn backend of `device`. Rejects with the
 * signal's reason when aborted, with the GPU error otherwise (the caller maps it to a NearFieldError).
 */
export function estimateDepthGraph(
	device: Device,
	net: MogeDepthNet,
	photo: DepthPhoto,
	opts: DepthGraphOptions,
): Promise<DepthGraphResult> {
	const { signal } = opts;
	return withLease(
		PIPELINE_LEASE,
		() => runPipeline(device, net, photo, opts),
		{ signal },
	);
}

async function runPipeline(
	device: Device,
	net: MogeDepthNet,
	photo: DepthPhoto,
	opts: DepthGraphOptions,
): Promise<DepthGraphResult> {
	const { signal } = opts;
	const t0 = performance.now();
	const { width: W, height: H, bh, bw } = photo;
	const plan = planDepthPipeline(W, H, bh * bw);
	// the plan's token count only picks the grid; the photo's own grid is authoritative
	if (plan.bh !== bh || plan.bw !== bw) {
		plan.bh = bh;
		plan.bw = bw;
		plan.ih = bh * MOGE2_VITS.patch;
		plan.iw = bw * MOGE2_VITS.patch;
		plan.upsample = W < plan.iw || H < plan.ih;
		plan.netInBytes = 3 * plan.ih * plan.iw * 4;
	}
	if (plan.upsample && !photo.netPixels)
		throw new Error(
			`nearfield: ${W}x${H} is smaller than the ${plan.iw}x${plan.ih} net input and needs netPixels`,
		);
	const prepOf = (
		px: PhotoPixels,
		w: number,
		h: number,
		lw: number,
		lh: number,
	) =>
		"rows" in px
			? prepSkyGpuFromRows(device, px.rows, w, h, lw, lh)
			: prepSkyGpu(device, px, w, h, lw, lh);
	const preps: Awaited<ReturnType<typeof prepSkyGpu>>[] = [];
	try {
		// the photo prep: rgba always; rgbLo too unless the net input is an upsample of the photo
		const main = await prepOf(
			photo.pixels,
			W,
			H,
			plan.upsample ? W : plan.iw,
			plan.upsample ? H : plan.ih,
		);
		preps.push(main);
		let net0 = main;
		if (plan.upsample) {
			net0 = await prepOf(
				photo.netPixels as PhotoPixels,
				plan.iw,
				plan.ih,
				plan.iw,
				plan.ih,
			);
			preps.push(net0);
		}
		signal?.throwIfAborted();

		// graph 1: the net; read 64 x 64 samples and the metric scale
		const aspect = W / H;
		const consts = await net.gridConsts(bh, bw, aspect);
		const g1 = depthGraph(device, net, plan, consts);
		if (!g1.graph.isCompiled) await g1.graph.compileAsync();
		const r1 = await g1.graph.run(undefined, {
			buffers: { netIn: net0.rgbLoBuffer },
			read: g1.extra.reads,
			signal,
		});
		const points64 = new Float32Array(r1.data[0]);
		const mask64 = new Float32Array(r1.data[1]);
		const metricScale = new Float32Array(r1.data[2])[0];

		// the focal / shift fit (CPU, 64 x 64 samples)
		const cam = solveCamera(points64, mask64, W, H, FOCAL_GRID);
		signal?.throwIfAborted();

		// graph 2: compose (+ normals) + lift, one submission, one read
		const hasHead = g1.extra.normal !== null;
		const n = W * H;
		const g2 = composeGraph(device, plan, hasHead);
		if (!g2.graph.isCompiled) await g2.graph.compileAsync();
		const K = cam.intrinsicsNorm;
		const bufs: Record<string, Buffer> = {
			prm: pooledUniform(
				device,
				`${COMPOSE_GROUP}/prm`,
				composeParamWords(n, hasHead, cam.shift, metricScale),
			),
			z: g1.extra.z,
			mask: g1.extra.mask,
			normalIn:
				g1.extra.normal ?? pooledStorage(device, `${COMPOSE_GROUP}/n0`, 16),
			rgba: main.rgbaBuffer,
		};
		if (!hasHead)
			bufs.nprm = pooledUniform(
				device,
				`${COMPOSE_GROUP}/nprm`,
				normalsParamWords(W, H, K),
			);
		if (plan.cells)
			bufs.lprm = pooledUniform(
				device,
				`${COMPOSE_GROUP}/lprm`,
				liftParamWords(
					W,
					H,
					liftGrid(W, H, LIFT_DEFAULTS.stride),
					{ ...LIFT_DEFAULTS, ...opts.lift },
					true,
					K,
				),
			);
		const r2 = await g2.graph.run(undefined, { buffers: bufs, signal });
		const [depthBytes, normalBytes, recordBytes] = r2.reads.read;
		const depth = new Float32Array(depthBytes);
		const valid = new Uint8Array(n);
		for (let k = 0; k < n; k++) if (depth[k] > 0) valid[k] = 1;
		return {
			depth: {
				width: W,
				height: H,
				depth,
				valid,
				normal: new Float32Array(normalBytes),
				intrinsicsNorm: K,
				model: opts.model,
				seconds: (performance.now() - t0) / 1000,
				focal: cam.focal,
				shift: cam.shift,
			},
			records: recordBytes
				? new Float32Array(recordBytes)
				: new Float32Array(0),
			cells: plan.cells,
			readBytes: plan.graph1ReadBytes + plan.graph2ReadBytes,
		};
	} finally {
		for (const p of preps) p.dispose();
	}
}

/**
 * The lift of a depth that exists only on the CPU (a persistent-cache hit): the photo's rgba words come
 * from a GPU prep of `photo` (read back once, W·H·4 B), then liftGaussiansGpu's CPU-array path.
 */
export function liftCachedDepth(
	device: Device,
	photo: DepthPhoto,
	depth: NearFieldDepth,
	signal?: AbortSignal,
): Promise<GaussianCloud> {
	return withLease(
		PIPELINE_LEASE,
		async () => {
			const { width: W, height: H } = photo;
			const plan = planDepthPipeline(W, H, photo.bh * photo.bw);
			const px = photo.pixels;
			const lw = Math.min(W, plan.iw);
			const lh = Math.min(H, plan.ih);
			const prep =
				"rows" in px
					? await prepSkyGpuFromRows(device, px.rows, W, H, lw, lh)
					: await prepSkyGpu(device, px, W, H, lw, lh);
			try {
				const rgba = await prep.readRgba();
				signal?.throwIfAborted();
				return await liftGaussiansGpu(
					device,
					{
						width: W,
						height: H,
						depth: depth.depth,
						valid: depth.valid,
						normal: depth.normal ?? null,
						rgba,
						K: depth.intrinsicsNorm as IntrinsicsNorm,
					},
					undefined,
					signal,
				);
			} finally {
				prep.dispose();
			}
		},
		{ signal },
	);
}

/** Destroy every cached graph of this pipeline on `device` (the net's own are released by MogeDepthNet.dispose). */
export function releaseComposeGraphs(device: Device): Promise<void> {
	return releaseCachedGraphs(device, COMPOSE_GROUP);
}

export { capacityFor };

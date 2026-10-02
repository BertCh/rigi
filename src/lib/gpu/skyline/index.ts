// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU skyline detector. detectSkylineGpu runs the whole of geo/skyline.ts detectSkyline as ONE ComputeGraph
// per (w, h, gradient, refinePasses) (group "skyline"): feature images and prior, then per stage the sky-model
// fit (IRLS: per-workgroup partial sums + one solve workgroup, 4 iterations), the model image, the Viterbi
// unary costs, the single-workgroup DP with backtrack, and finally the per-column part of finishSkyline. One
// submit, one readback: rows + weight (2·w floats) and, with returnSky, the sky plane as bytes. The
// continuity / trend tail (finishSkylineColumns) runs on the CPU on those columns. The CPU detectSkyline is
// the reference (f32 here against f64 fits there): ?skylineGpu=off.
// openSkylineGpu is the older diagnostic path (feature graph with readbacks, stages for detectSkylineWith),
// kept for the Dawn scripts that compare the cost images and measure the old CPU-fit hybrid.
// The five box blurs are luma GPUConvolution nodes (direct strategy, zero boundary, all-ones kernel; a y blur
// is one conv per plane through byteOffset views) followed by a FIX kernel that adds the clamp-to-edge
// correction and divides by 2r+1, so the sums agree with the CPU boxBlur to f32 rounding, not bit for bit.
import type { Device } from "@luma.gl/core";
import {
	type Features,
	finishSkylineColumns,
	type RGBALike,
	resolveOptions,
	type SkylineObservation,
	type SkylineOptions,
	type SkylineStages,
	type SkyModel,
} from "#/lib/geo/skyline";
import { type ComputeGraph, cachedGraph } from "#/lib/gpu/core/graph";
import {
	type BindKind,
	defineKernel,
	release,
	storage,
	uniform,
} from "#/lib/gpu/core/kernel";
import { GPUConvolution, type GraphBufferHandle } from "#/lib/gpu/core/luma";
import { withLease } from "#/lib/gpu/core/pool";
import { readBack } from "#/lib/gpu/core/readback";
import { getComputeDevice } from "#/lib/gpu/device";
import {
	SKYLINE_COLUMN,
	SKYLINE_DP,
	SKYLINE_FIT_PARTIAL,
	SKYLINE_FIT_WG,
	SKYLINE_MODEL_G,
	SKYLINE_MODEL_WORDS,
	SKYLINE_PACK,
	SKYLINE_UNARY,
	skylineFitAccumLayout,
	skylineFitAccumSource,
	skylineFitSolveSource,
} from "./detect.wgsl";
import { addSobelMagnitude } from "./raster-edges";
import {
	SKYLINE_EDGE,
	SKYLINE_GRAD,
	SKYLINE_LUM,
	SKYLINE_MODEL,
	SKYLINE_PRIOR,
	SKYLINE_UNPACK,
	skylineBlurFixSource,
} from "./skyline.wgsl";
import { packSkylineDetect, packSkylineParams } from "./uniforms";

const GROUP = "skyline";
const WG = 256;
const RO = "read-only-storage" as const;
const def = (id: string, src: string, layout: [string, BindKind][]) =>
	defineKernel(id, src, layout, { group: GROUP, label: `skyline-${id}` });
const blurFix = (axis: "x" | "y", r: number, nc: number) =>
	def(`blurfix-${axis}${r}-c${nc}`, skylineBlurFixSource(axis, r, nc), [
		["prm", "uniform"],
		["src", RO],
		["tmp", RO],
		["dst", "storage"],
	]);

const K_UNPACK = def("unpack", SKYLINE_UNPACK, [
	["prm", "uniform"],
	["rgba", RO],
	["p0", "storage"],
	["ones", "storage"],
]);
const K_FIX_X1 = blurFix("x", 1, 3);
const K_FIX_Y1 = blurFix("y", 1, 3);
const K_FIX_X2 = blurFix("x", 2, 3);
const K_FIX_X3 = blurFix("x", 3, 1);
const K_FIX_Y3 = blurFix("y", 3, 1);
const K_GRAD = def("grad", SKYLINE_GRAD, [
	["prm", "uniform"],
	["rgb", RO],
	["grad", "storage"],
]);
const K_LUM = def("lum", SKYLINE_LUM, [
	["prm", "uniform"],
	["rgb", RO],
	["lum", "storage"],
]);
const K_EDGE = def("edge", SKYLINE_EDGE, [
	["prm", "uniform"],
	["cs", RO],
	["edge", "storage"],
	["stp", "storage"],
]);
const K_PRIOR = def("prior", SKYLINE_PRIOR, [
	["prm", "uniform"],
	["rgb", RO],
	["tex", RO],
	["prior", "storage"],
]);
const K_MODEL = def("model", SKYLINE_MODEL, [
	["prm", "uniform"],
	["rgb", RO],
	["tex", RO],
	["rows", RO],
	["sky", "storage"],
]);

const sKernel = (id: string, src: string, names: [string, BindKind][]) =>
	def(id, src, [["prm", "uniform"], ...names]);
const K_FIT_ACCUM = (["seed", "refit"] as const).flatMap((kind) =>
	([true, false] as const).map((first) => {
		const seed = kind === "seed";
		const names = skylineFitAccumLayout(seed, first).slice(1);
		return [
			`${kind}-${first ? 0 : 1}`,
			sKernel(
				`fit-${kind}-${first ? "first" : "next"}`,
				skylineFitAccumSource(seed, first),
				names.map(
					(n) => [n, n === "partials" ? "storage" : RO] as [string, BindKind],
				),
			),
		] as const;
	}),
);
const fitAccumKernel = new Map(K_FIT_ACCUM);
const K_FIT_SOLVE = [true, false].map((first) =>
	sKernel(
		`fit-solve-${first ? "first" : "next"}`,
		skylineFitSolveSource(first),
		[
			["partials", RO],
			["model", "storage"],
		],
	),
);
const K_MODEL_G = sKernel("model-g", SKYLINE_MODEL_G, [
	["rgb", RO],
	["tex", RO],
	["model", RO],
	["fallback", RO],
	["sky", "storage"],
]);
const K_UNARY = sKernel("unary", SKYLINE_UNARY, [
	["sky", RO],
	["edge", RO],
	["cumA", "storage"],
	["cumB", "storage"],
	["unary", "storage"],
]);
const K_DP = sKernel("dp", SKYLINE_DP, [
	["unary", RO],
	["dp", "storage"],
	["back", "storage"],
	["bound", "storage"],
]);
const K_COLUMN = sKernel("column", SKYLINE_COLUMN, [
	["sky", RO],
	["edge", RO],
	["stp", RO],
	["bound", RO],
	["out", "storage"],
]);
const K_PACK = sKernel("pack", SKYLINE_PACK, [
	["sky", RO],
	["packed", "storage"],
]);

type Params = Record<string, never>;
/** Run parameters of the whole-detector graph: read the packed sky plane back. */
type DetectParams = { sky: boolean };
const F4 = 4;
/** GPUBufferUsage.UNIFORM | COPY_DST */
const UNIFORM_COPY_DST = 0x40 | 0x08;

/**
 * Gradient stage of the local-texture feature. "central" (default): the hand-written blurred-luminance
 * central difference, border pixels 0 (the CPU twin). "sobel": luma gpu-raster Sobel magnitude on the
 * blurred luminance (scale 1/4, clamped borders): a [1 2 1] smoothed central difference, so tex differs
 * from the CPU twin by more than rounding (scripts/gpu/skyline-raster-dawn.ts measures the row shift).
 */
export type SkylineGradient = "central" | "sobel";

function buildFeatureGraph<P>(
	g: ComputeGraph<P>,
	w: number,
	h: number,
	gradient: SkylineGradient,
	/** "import": outputs are imported buffers the caller reads; "transient": they stay in the graph. */
	outputs: "import" | "transient" = "import",
) {
	const n = w * h;
	const imp = (id: string, bytes: number, usage?: number) =>
		g.importBuffer(id, bytes, undefined, usage);
	const prm = imp("prm", 32, UNIFORM_COPY_DST);
	const rgba = imp("rgba", n * F4);
	const out = (id: string, bytes: number) =>
		outputs === "import" ? imp(id, bytes) : g.transientBuffer(id, bytes);
	const rgb = out("rgb", 3 * n * F4);
	const tex = out("tex", n * F4);
	const edge = out("edge", n * F4);
	const stp = out("stp", n * F4);
	const prior = out("prior", n * F4);
	const p0 = g.transientBuffer("p0", 3 * n * F4);
	const t1 = g.transientBuffer("t1", 3 * n * F4);
	const cs = g.transientBuffer("cs", 3 * n * F4);
	const grad = g.transientBuffer("grad", n * F4);
	const gt = g.transientBuffer("gt", n * F4);
	const ones = g.transientBuffer("ones", 8 * F4);
	const wg1: [number] = [Math.ceil(n / WG)];
	/** One clamp-to-edge box blur of `nc` planes of w × h: GPUConvolution window sums, then the edge fix. */
	const blur = (
		id: string,
		axis: "x" | "y",
		r: number,
		nc: number,
		fix: typeof K_FIX_X1,
		src: GraphBufferHandle,
		dst: GraphBufferHandle,
	) => {
		const taps = g.view(ones, "float32", 2 * r + 1);
		const sums = g.transientBuffer(`${id}-sums`, nc * n * F4);
		const kw = axis === "x" ? 2 * r + 1 : 1;
		const kh = axis === "x" ? 1 : 2 * r + 1;
		// x: planes stacked vertically never couple along x, so one conv over w × nc·h; y: one per plane
		for (let c = 0; c < (axis === "x" ? 1 : nc); c++) {
			const len = axis === "x" ? nc * n : n;
			const at = axis === "x" ? 0 : c * n * F4;
			g.add(
				new GPUConvolution({
					id: `${id}-conv${c}`,
					width: w,
					height: axis === "x" ? nc * h : h,
					kernelWidth: kw,
					kernelHeight: kh,
					strategy: "direct",
					boundary: "zero",
					input: g.view(src, "float32", len, at),
					kernel: taps,
					output: g.view(sums, "float32", len, at),
				}),
			);
		}
		g.addKernel({
			id,
			spec: fix,
			bindings: { prm, src, tmp: sums, dst },
			workgroups: [Math.ceil((nc * n) / WG)],
		});
	};
	g.addKernel({
		id: "unpack",
		spec: K_UNPACK,
		bindings: { prm, rgba, p0, ones },
		workgroups: wg1,
	});
	blur("bx1", "x", 1, 3, K_FIX_X1, p0, t1);
	blur("by1", "y", 1, 3, K_FIX_Y1, t1, rgb);
	blur("bx2", "x", 2, 3, K_FIX_X2, p0, cs);
	if (gradient === "sobel") {
		const lum = g.transientBuffer("lum", n * F4);
		g.addKernel({
			id: "lum",
			spec: K_LUM,
			bindings: { prm, rgb, lum },
			workgroups: wg1,
		});
		addSobelMagnitude(g, "grad-sobel", w, h, lum, grad, 0.25);
	} else
		g.addKernel({
			id: "grad",
			spec: K_GRAD,
			bindings: { prm, rgb, grad },
			workgroups: wg1,
		});
	blur("bx3", "x", 3, 1, K_FIX_X3, grad, gt);
	blur("by3", "y", 3, 1, K_FIX_Y3, gt, tex);
	g.addKernel({
		id: "edge",
		spec: K_EDGE,
		bindings: { prm, cs, edge, stp },
		workgroups: wg1,
	}).addKernel({
		id: "prior",
		spec: K_PRIOR,
		bindings: { prm, rgb, tex, prior },
		workgroups: wg1,
	});
	return { prm, rgba, rgb, tex, edge, stp, prior };
}

function buildModelGraph(g: ComputeGraph<Params>, w: number, h: number) {
	const n = w * h;
	const imp = (id: string, bytes: number, usage?: number) =>
		g.importBuffer(id, bytes, undefined, usage);
	const prm = imp("prm", 32, UNIFORM_COPY_DST);
	const rgb = imp("rgb", 3 * n * F4);
	const tex = imp("tex", n * F4);
	const rows = imp("rows", h * 9 * F4);
	const sky = imp("sky", n * F4);
	g.addKernel({
		id: "model",
		spec: K_MODEL,
		bindings: { prm, rgb, tex, rows, sky },
		workgroups: [Math.ceil(n / WG)],
	});
}

/** Why the GPU skyline cannot run for this shape on `device` (undefined: it can). */
export function skylineGpuUnsupported(device: Device, w: number, h: number) {
	const n = w * h;
	if (Math.ceil((3 * n) / WG) > device.limits.maxComputeWorkgroupsPerDimension)
		return "dispatch over maxComputeWorkgroupsPerDimension";
	if (3 * n * F4 > device.limits.maxStorageBufferBindingSize)
		return "image over maxStorageBufferBindingSize";
	return undefined;
}

/** CPU modelSky's per-row quadratic in u (rowPoly), as f32 words: h × [ar, br, qr, ag, bg, qg, ab, bb, qb]. */
export function skylineModelRows(m: SkyModel, h: number) {
	const out = new Float32Array(h * 9);
	for (let y = 0; y < h; y++) {
		const v = y / h - 0.5;
		for (let c = 0; c < 3; c++) {
			const k = m.coef[c];
			out[y * 9 + c * 3] = k[0] + k[2] * v + k[5] * v * v + k[6] * v * v * v;
			out[y * 9 + c * 3 + 1] = k[1] + k[4] * v + k[7] * v * v;
			out[y * 9 + c * 3 + 2] = k[3];
		}
	}
	return out;
}

/** The GPU stages of one image, for detectSkylineWith. Call dispose() when done. */
export interface SkylineGpuSession {
	stages: SkylineStages;
	dispose(): void;
}

/**
 * Upload `img`, run the feature graph and return the stages that read its images back. Not leased:
 * detectSkylineGpu holds the group lease around a whole detection.
 */
export async function openSkylineGpu(
	device: Device,
	img: RGBALike,
	gradient: SkylineGradient = "central",
): Promise<SkylineGpuSession> {
	const { width: w, height: h } = img;
	const n = w * h;
	const why = skylineGpuUnsupported(device, w, h);
	if (why) throw new Error(`skyline GPU: ${why}`);
	const words = new Uint32Array(n);
	new Uint8Array(words.buffer).set(img.data.subarray(0, 4 * n));
	const rgba = storage(device, words);
	const rgb = storage(device, 3 * n * F4);
	const tex = storage(device, n * F4);
	const edge = storage(device, n * F4);
	const stp = storage(device, n * F4);
	const prior = storage(device, n * F4);
	const sky = storage(device, n * F4);
	const rows = storage(device, h * 9 * F4);
	const bufs = [rgba, rgb, tex, edge, stp, prior, sky, rows];
	const dispose = () => {
		for (const b of bufs) b.destroy();
	};
	try {
		const prm = uniform(device, packSkylineParams(w, h, 0));
		const feat = cachedGraph<Params, void>(
			device,
			GROUP,
			`feat-${w}x${h}${gradient === "sobel" ? "-sobel" : ""}`,
			(g) => buildFeatureGraph(g, w, h, gradient),
		).graph;
		await feat.run({}, { buffers: { prm, rgba, rgb, tex, edge, stp, prior } });
		prm.destroy();
		const f32 = (b: ArrayBuffer) => new Float32Array(b);
		const [rgbB, texB, edgeB, stpB, priorB] = await readBack(
			device,
			() => [
				{ buffer: rgb, size: 3 * n * F4 },
				{ buffer: tex, size: n * F4 },
				{ buffer: edge, size: n * F4 },
				{ buffer: stp, size: n * F4 },
				{ buffer: prior, size: n * F4 },
			],
			undefined,
			{ id: "skyline-features" },
		);
		const planes = f32(rgbB);
		const f: Features = {
			r: planes.subarray(0, n),
			g: planes.subarray(n, 2 * n),
			b: planes.subarray(2 * n, 3 * n),
			tex: f32(texB),
			edge: f32(edgeB),
			step: f32(stpB),
		};
		const model = cachedGraph<Params, void>(
			device,
			GROUP,
			`model-${w}x${h}`,
			(g) => buildModelGraph(g, w, h),
		).graph;
		return {
			dispose,
			stages: {
				features: async () => ({ f, prior: f32(priorB) }),
				modelSky: async (m: SkyModel) => {
					rows.write(skylineModelRows(m, h));
					const mp = uniform(device, packSkylineParams(w, h, m.sigma));
					try {
						await model.run({}, { buffers: { prm: mp, rgb, tex, rows, sky } });
					} finally {
						mp.destroy();
					}
					const [b] = await readBack(
						device,
						() => [{ buffer: sky, size: n * F4 }],
						undefined,
						{ id: "skyline-sky" },
					);
					return f32(b);
				},
			},
		};
	} catch (e) {
		dispose();
		throw e;
	}
}

/** Fit iterations per sky-model fit (fitSkyModel's loop). */
const FIT_ITERATIONS = 4;
const FIT_STEP = 4;

/** Why the whole-detector graph cannot run for this shape on `device` (undefined: it can). */
export function skylineDetectUnsupported(device: Device, w: number, h: number) {
	const base = skylineGpuUnsupported(device, w, h);
	if (base) return base;
	const ns = h + 1;
	const lim = device.limits;
	const samples = Math.ceil(w / FIT_STEP) * Math.ceil(h / FIT_STEP);
	if (
		Math.ceil(samples / SKYLINE_FIT_WG) > lim.maxComputeWorkgroupsPerDimension
	)
		return "fit over maxComputeWorkgroupsPerDimension";
	if (
		w * ns * F4 > lim.maxStorageBufferBindingSize ||
		ns * w * F4 > lim.maxBufferSize
	)
		return "Viterbi columns over maxStorageBufferBindingSize";
	if (
		lim.maxComputeWorkgroupSizeX < WG ||
		lim.maxComputeInvocationsPerWorkgroup < WG
	)
		return "workgroup size over device limits";
	// the fit workgroup keeps 62 · 64 f32 in shared memory
	if (
		lim.maxComputeWorkgroupStorageSize <
		SKYLINE_FIT_PARTIAL * SKYLINE_FIT_WG * F4
	)
		return "fit over maxComputeWorkgroupStorageSize";
	if (w < 1 || h < 1) return "empty image";
	return undefined;
}

/**
 * The whole detector as one graph: features (transients) → per stage [fit ×4 → model image → unary →
 * DP + backtrack] for the seed and each refit → finish columns + packed sky → one read node.
 */
function buildDetectGraph(
	g: ComputeGraph<DetectParams>,
	w: number,
	h: number,
	gradient: SkylineGradient,
	refinePasses: number,
) {
	const n = w * h;
	const ns = h + 1;
	const { prm, rgba, rgb, tex, edge, stp, prior } = buildFeatureGraph(
		g,
		w,
		h,
		gradient,
		"transient",
	);
	const sprm = g.importBuffer("sprm", 64, undefined, UNIFORM_COPY_DST);
	const samples = Math.ceil(w / FIT_STEP) * Math.ceil(h / FIT_STEP);
	const nwg = Math.ceil(samples / SKYLINE_FIT_WG);
	const tb = (id: string, bytes: number) => g.transientBuffer(id, bytes);
	const partials = tb("partials", nwg * SKYLINE_FIT_PARTIAL * F4);
	const cumA = tb("cumA", ns * w * F4);
	const cumB = tb("cumB", ns * w * F4);
	const unary = tb("unary", ns * w * F4);
	const dp = tb("dp", 2 * ns * F4);
	const back = tb("back", ns * w * F4);
	let last = "prior";
	const chain = (id: string) => {
		const dependsOn = [last];
		last = id;
		return dependsOn;
	};
	let prevSky: GraphBufferHandle = prior;
	let prevBound: GraphBufferHandle | undefined;
	for (let s = 0; s <= refinePasses; s++) {
		const seed = s === 0;
		const model = tb(`model${s}`, SKYLINE_MODEL_WORDS * F4);
		for (let it = 0; it < FIT_ITERATIONS; it++) {
			const first = it === 0;
			const spec = fitAccumKernel.get(
				`${seed ? "seed" : "refit"}-${first ? 0 : 1}`,
			);
			if (!spec) throw new Error("skyline fit kernel");
			const id = `fit${s}-${it}`;
			g.addKernel({
				id,
				spec,
				bindings: {
					prm: sprm,
					rgb,
					prior,
					...(seed ? {} : { bound: prevBound as GraphBufferHandle }),
					...(first ? {} : { model }),
					partials,
				},
				workgroups: [nwg],
				dependsOn: chain(id),
			});
			const sid = `solve${s}-${it}`;
			g.addKernel({
				id: sid,
				spec: K_FIT_SOLVE[first ? 0 : 1],
				bindings: { prm: sprm, partials, model },
				workgroups: [1],
				dependsOn: chain(sid),
			});
		}
		const sky = tb(`sky${s}`, n * F4);
		g.addKernel({
			id: `model${s}`,
			spec: K_MODEL_G,
			bindings: { prm: sprm, rgb, tex, model, fallback: prevSky, sky },
			workgroups: [Math.ceil(n / WG)],
			dependsOn: chain(`model${s}`),
		});
		g.addKernel({
			id: `unary${s}`,
			spec: K_UNARY,
			bindings: { prm: sprm, sky, edge, cumA, cumB, unary },
			workgroups: [Math.ceil(w / 64)],
			dependsOn: chain(`unary${s}`),
		});
		const bound = tb(`bound${s}`, w * F4);
		g.addKernel({
			id: `dp${s}`,
			spec: K_DP,
			bindings: { prm: sprm, unary, dp, back, bound },
			workgroups: [1],
			dependsOn: chain(`dp${s}`),
		});
		prevSky = sky;
		prevBound = bound;
	}
	const cols = tb("cols", 2 * w * F4);
	const packedBytes = Math.ceil(n / 4) * 4;
	const packed = tb("packed", packedBytes);
	g.addKernel({
		id: "column",
		spec: K_COLUMN,
		bindings: {
			prm: sprm,
			sky: prevSky,
			edge,
			stp,
			bound: prevBound as GraphBufferHandle,
			out: cols,
		},
		workgroups: [Math.ceil(w / 64)],
		dependsOn: chain("column"),
	});
	g.addKernel({
		id: "pack",
		spec: K_PACK,
		bindings: { prm: sprm, sky: prevSky, packed },
		workgroups: [Math.ceil(n / 4 / WG)],
		dependsOn: chain("pack"),
	});
	g.readNode(
		"read",
		[cols, { buffer: packed, size: (p) => (p.sky ? packedBytes : 0) }],
		{ dependsOn: ["column", "pack"] },
	);
	return { prm, sprm, rgba };
}

/**
 * detectSkyline on the GPU compute device: one graph run (see buildDetectGraph) and a CPU column tail;
 * null when there is no device or refinePasses is not 0, 1 or 2 (the caller takes the CPU path). Throws on a
 * GPU error (detectSkylineAsync catches and falls back).
 */
export async function detectSkylineGpu(
	img: RGBALike,
	opts: SkylineOptions = {},
	gradient: SkylineGradient = "central",
): Promise<SkylineObservation | null> {
	const { width: w, height: h } = img;
	const { o, refinePasses, minWeight, returnSky } = resolveOptions(h, opts);
	if (!(refinePasses === 0 || refinePasses === 1 || refinePasses === 2))
		return null;
	const device = await getComputeDevice();
	if (!device) return null;
	return withLease(GROUP, async () => {
		const why = skylineDetectUnsupported(device, w, h);
		if (why) throw new Error(`skyline GPU: ${why}`);
		const n = w * h;
		const { graph } = cachedGraph<DetectParams, void>(
			device,
			GROUP,
			`detect-${w}x${h}-p${refinePasses}${gradient === "sobel" ? "-sobel" : ""}`,
			(g) => {
				buildDetectGraph(g, w, h, gradient, refinePasses);
			},
		);
		await graph.compileAsync();
		const words = new Uint32Array(n);
		new Uint8Array(words.buffer).set(img.data.subarray(0, 4 * n));
		const rgba = storage(device, words);
		const prm = uniform(device, packSkylineParams(w, h, 0));
		const sprm = uniform(
			device,
			packSkylineDetect(w, h, {
				belowBand: Math.round(o.belowBand),
				aboveBand: Math.round(o.aboveBand),
				edgeWeight: o.edgeWeight,
				jumpCost: o.jumpCost,
				jumpCap: o.jumpCap,
			}),
		);
		try {
			const { reads } = await graph.run(
				{ sky: returnSky },
				{ buffers: { prm, sprm, rgba } },
			);
			const [colBuf, skyBuf] = reads.read;
			const rows = new Float32Array(colBuf.slice(0, w * F4));
			const weight = new Float32Array(colBuf.slice(w * F4, 2 * w * F4));
			finishSkylineColumns(rows, weight, w, h, minWeight);
			const out: SkylineObservation = { width: w, height: h, rows, weight };
			if (returnSky) out.sky = new Uint8Array(skyBuf.slice(0, n));
			return out;
		} finally {
			release(rgba, prm, sprm);
		}
	});
}

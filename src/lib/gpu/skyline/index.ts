// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU skyline cost images: the per-pixel stages of geo/skyline.ts detectSkyline (feature images, the
// heuristic sky prior, and the sky-model probability) as two ComputeGraphs (group "skyline"). The sky-model
// fits (f64 IRLS) and the Viterbi passes stay on the CPU; detectSkylineGpu feeds them through
// detectSkylineWith. The CPU path is the reference (f32 here vs f64 arithmetic there): ?skylineGpu=off.
import type { Device } from "@luma.gl/core";
import {
	detectSkylineWith,
	type Features,
	type RGBALike,
	type SkylineObservation,
	type SkylineOptions,
	type SkylineStages,
	type SkyModel,
} from "#/lib/geo/skyline";
import { getComputeDevice } from "#/lib/gpu/core/device";
import { type ComputeGraph, cachedGraph } from "#/lib/gpu/core/graph";
import {
	type BindKind,
	defineKernel,
	storage,
	uniform,
} from "#/lib/gpu/core/kernel";
import { withLease } from "#/lib/gpu/core/pool";
import { readBack } from "#/lib/gpu/core/readback";
import {
	SKYLINE_EDGE,
	SKYLINE_GRAD,
	SKYLINE_MODEL,
	SKYLINE_PRIOR,
	SKYLINE_UNPACK,
	skylineBlurSource,
} from "./skyline.wgsl";

const GROUP = "skyline";
const WG = 256;
const RO = "read-only-storage" as const;
const def = (id: string, src: string, layout: [string, BindKind][]) =>
	defineKernel(id, src, layout, { group: GROUP, label: `skyline-${id}` });
const blur = (axis: "x" | "y", r: number, nc: number) =>
	def(`blur-${axis}${r}-c${nc}`, skylineBlurSource(axis, r, nc), [
		["prm", "uniform"],
		["src", RO],
		["dst", "storage"],
	]);

const K_UNPACK = def("unpack", SKYLINE_UNPACK, [
	["prm", "uniform"],
	["rgba", RO],
	["p0", "storage"],
]);
const K_BLUR_X1 = blur("x", 1, 3);
const K_BLUR_Y1 = blur("y", 1, 3);
const K_BLUR_X2 = blur("x", 2, 3);
const K_BLUR_X3 = blur("x", 3, 1);
const K_BLUR_Y3 = blur("y", 3, 1);
const K_GRAD = def("grad", SKYLINE_GRAD, [
	["prm", "uniform"],
	["rgb", RO],
	["grad", "storage"],
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

type Params = Record<string, never>;
const F4 = 4;
/** GPUBufferUsage.UNIFORM | COPY_DST */
const UNIFORM_COPY_DST = 0x40 | 0x08;

function buildFeatureGraph(g: ComputeGraph<Params>, w: number, h: number) {
	const n = w * h;
	const imp = (id: string, bytes: number, usage?: number) =>
		g.importBuffer(id, bytes, undefined, usage);
	const prm = imp("prm", 32, UNIFORM_COPY_DST);
	const rgba = imp("rgba", n * F4);
	const rgb = imp("rgb", 3 * n * F4);
	const tex = imp("tex", n * F4);
	const edge = imp("edge", n * F4);
	const stp = imp("stp", n * F4);
	const prior = imp("prior", n * F4);
	const p0 = g.transientBuffer("p0", 3 * n * F4);
	const t1 = g.transientBuffer("t1", 3 * n * F4);
	const cs = g.transientBuffer("cs", 3 * n * F4);
	const grad = g.transientBuffer("grad", n * F4);
	const gt = g.transientBuffer("gt", n * F4);
	const wg1: [number] = [Math.ceil(n / WG)];
	const wg3: [number] = [Math.ceil((3 * n) / WG)];
	g.addKernel({
		id: "unpack",
		spec: K_UNPACK,
		bindings: { prm, rgba, p0 },
		workgroups: wg1,
	})
		.addKernel({
			id: "bx1",
			spec: K_BLUR_X1,
			bindings: { prm, src: p0, dst: t1 },
			workgroups: wg3,
		})
		.addKernel({
			id: "by1",
			spec: K_BLUR_Y1,
			bindings: { prm, src: t1, dst: rgb },
			workgroups: wg3,
		})
		.addKernel({
			id: "bx2",
			spec: K_BLUR_X2,
			bindings: { prm, src: p0, dst: cs },
			workgroups: wg3,
		})
		.addKernel({
			id: "grad",
			spec: K_GRAD,
			bindings: { prm, rgb, grad },
			workgroups: wg1,
		})
		.addKernel({
			id: "bx3",
			spec: K_BLUR_X3,
			bindings: { prm, src: grad, dst: gt },
			workgroups: wg1,
		})
		.addKernel({
			id: "by3",
			spec: K_BLUR_Y3,
			bindings: { prm, src: gt, dst: tex },
			workgroups: wg1,
		})
		.addKernel({
			id: "edge",
			spec: K_EDGE,
			bindings: { prm, cs, edge, stp },
			workgroups: wg1,
		})
		.addKernel({
			id: "prior",
			spec: K_PRIOR,
			bindings: { prm, rgb, tex, prior },
			workgroups: wg1,
		});
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

function paramWords(w: number, h: number, sigma: number) {
	const words = new ArrayBuffer(32);
	new Uint32Array(words).set([w, h, w * h]);
	new Float32Array(words)[4] = sigma;
	return words;
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
		const prm = uniform(device, paramWords(w, h, 0));
		const feat = cachedGraph<Params, void>(
			device,
			GROUP,
			`feat-${w}x${h}`,
			(g) => buildFeatureGraph(g, w, h),
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
					const mp = uniform(device, paramWords(w, h, m.sigma));
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

/**
 * detectSkyline with the cost images on the GPU compute device; null when there is no device (the caller
 * takes the CPU path). Throws on a GPU error (detectSkylineAsync catches and falls back).
 */
export async function detectSkylineGpu(
	img: RGBALike,
	opts: SkylineOptions = {},
): Promise<SkylineObservation | null> {
	const device = await getComputeDevice();
	if (!device) return null;
	return withLease(GROUP, async () => {
		const session = await openSkylineGpu(device, img);
		try {
			return await detectSkylineWith(img, opts, session.stages);
		} finally {
			session.dispose();
		}
	});
}

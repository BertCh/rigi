// GPU twin of sky/core.ts refineToWorking(rgbWork, W, H, low, true, opts) followed by toBytes: the
// sky worker's guided-filter refine. The low-res P(sky) may be a Float32Array or, when ONNX Runtime
// runs on this same device (sky/model.ts shareOrtDevice), the model's output GPUBuffer itself, so
// the model output never leaves the GPU and only the final byte mask is read back.
// Parity with the CPU refine: scripts/gpu/sky-bench.mjs (float mask ~1e-6, bytes almost all equal;
// see refine.wgsl.ts for what is exact and what is f32-vs-f64). The kernels run as one core
// ComputeGraph (./refine-graph.ts: aliased transients, inputs pooled under the lease "sky-refine",
// one submit, one readback); the pooled dispatchAll path it replaced was removed on 2026-10-01.
import type { Device } from "@luma.gl/core";
import {
	type BindKind,
	defineKernel,
	warmKernelsAsync,
} from "#/lib/gpu/core/kernel";
import { LO_H, LO_H2, LO_V, LO_V2, PACK, UP_H, UP_V } from "./refine.wgsl";

const GROUP = "sky";
const def = (id: string, src: string, layout: [string, BindKind][]) =>
	defineKernel(id, src, layout, { group: GROUP, label: `sky-${id}` });
const RO = "read-only-storage" as const;

export const K_LO_H = def("lo-h", LO_H, [
	["prm", "uniform"],
	["gl", RO],
	["gp", RO],
	["t", "storage"],
]);
export const K_LO_V = def("lo-v", LO_V, [
	["prm", "uniform"],
	["t", RO],
	["gp", RO],
	["ab", "storage"],
	["band", "storage"],
]);
export const K_LO_H2 = def("lo-h2", LO_H2, [
	["prm", "uniform"],
	["ab", RO],
	["band", RO],
	["abH", "storage"],
	["bandH", "storage"],
]);
export const K_LO_V2 = def("lo-v2", LO_V2, [
	["prm", "uniform"],
	["abH", RO],
	["bandH", RO],
	["gp", RO],
	["abS", "storage"],
	["pb", "storage"],
]);
export const K_UP_H = def("up-h", UP_H, [
	["prm", "uniform"],
	["axis", RO],
	["abS", RO],
	["pb", RO],
	["u4", "storage"],
	["u2", "storage"],
]);
export const K_UP_V = def("up-v", UP_V, [
	["prm", "uniform"],
	["axis", RO],
	["u4", RO],
	["u2", RO],
	["rgba", RO],
	["lut", RO],
	["q", "storage"],
]);
export const K_PACK = def("pack", PACK, [
	["prm", "uniform"],
	["q", RO],
	["lut", RO],
	["bytes", "storage"],
]);

/** Compile the sky kernels off the critical path (never throws; resolves the failure count). */
export const warmSkyKernels = (device: Device) =>
	warmKernelsAsync(device, GROUP);

/** Low-res P(sky): CPU floats, or a GPUBuffer on `device.handle` holding lw·lh f32 (ORT's output). */
export type SkyProb = Float32Array | GPUBuffer;

export interface SkyRefineInput {
	/** Working size and its RGBA bytes (the photo the CPU turns into rgbWork with rgbPlanes). */
	W: number;
	H: number;
	rgba: Uint8Array | Uint8ClampedArray;
	/** Model (low) resolution. */
	lw: number;
	lh: number;
	/** resamplePlanes(rgbWork, W, H, 3, lw, lh): the guided filter's low-res guide. */
	guideLo: Float32Array;
	prob: SkyProb;
	/** refineToWorking's RefineOptions (defaults radius 3, eps 2e-3, band 3). */
	radius?: number;
	eps?: number;
	band?: number;
	/** Also read the float mask back (the parity bench); the app needs bytes only. */
	floats?: boolean;
}

export interface SkyRefineOutput {
	/** toBytes(refineToWorking(…)): P(sky)·255, row-major, W × H. */
	bytes: Uint8Array;
	/** refineToWorking(…) itself, when `floats` was asked for. */
	q?: Float32Array;
}

/**
 * The exact per-output taps of sky/core.ts resampleAxis (n → m): area average when downsampling,
 * bilinear when upsampling. Weights are rounded to f32 (the CPU keeps them in f64).
 */
function axisTaps(n: number, m: number) {
	const taps: [number, number][][] = [];
	const scale = n / m;
	for (let j = 0; j < m; j++) {
		if (scale > 1) {
			const a = j * scale;
			const b = a + scale;
			const i0 = Math.floor(a);
			const i1 = Math.min(n, Math.ceil(b));
			const t: [number, number][] = [];
			for (let i = i0; i < i1; i++)
				t.push([i, (Math.min(b, i + 1) - Math.max(a, i)) / scale]);
			taps.push(t);
		} else {
			const t = (j + 0.5) * scale - 0.5;
			const i0 = Math.max(0, Math.min(n - 1, Math.floor(t)));
			const i1 = Math.min(n - 1, i0 + 1);
			const f = Math.max(0, Math.min(1, t - i0));
			taps.push([
				[i0, 1 - f],
				[i1, f],
			]);
		}
	}
	return taps;
}

const axisCache = new Map<string, Uint32Array>();

/** axis[j] = (start, count) for columns (j < W) then rows; taps follow as (index, f32 bits). */
export function axisTable(
	lw: number,
	lh: number,
	W: number,
	H: number,
): Uint32Array {
	const key = `${lw}x${lh}>${W}x${H}`;
	let tab = axisCache.get(key);
	if (tab) return tab;
	const all = [...axisTaps(lw, W), ...axisTaps(lh, H)];
	const nt = all.reduce((s, t) => s + t.length, 0);
	tab = new Uint32Array(2 * (all.length + nt));
	const f = new Float32Array(tab.buffer);
	let at = all.length;
	all.forEach((t, j) => {
		tab[2 * j] = at;
		tab[2 * j + 1] = t.length;
		for (const [i, w] of t) {
			tab[2 * at] = i;
			f[2 * at + 1] = w;
			at++;
		}
	});
	if (axisCache.size > 8) axisCache.clear();
	axisCache.set(key, tab);
	return tab;
}

/** The CPU's toBytes as data: v ≤ 0 → 0, v ≥ 1 → 255, else Math.round(v·255). */
const toByte = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));

let lutCache: Float32Array | undefined;

/**
 * lut[0..255] = fround(d / 255) (rgbPlanes); lut[256 + k − 1] = the least f32 v with toByte(v) ≥ k,
 * k = 1..255 (found from the f64 midpoint by stepping ulps, then checked).
 */
export function lutTable(): Float32Array {
	if (lutCache) return lutCache;
	const lut = new Float32Array(512);
	for (let d = 0; d < 256; d++) lut[d] = d / 255;
	const one = new Float32Array(1);
	const bits = new Int32Array(one.buffer);
	const step = (v: number, dir: number) => {
		one[0] = v;
		bits[0] += v > 0 ? dir : -dir;
		return one[0];
	};
	for (let k = 1; k < 256; k++) {
		let v = Math.fround((k - 0.5) / 255);
		while (toByte(v) >= k) v = step(v, -1);
		while (toByte(v) < k) v = step(v, 1);
		lut[256 + k - 1] = v;
	}
	lutCache = lut;
	return lut;
}

export const isFloats = (p: SkyProb): p is Float32Array =>
	p instanceof Float32Array;

/**
 * refineToWorking(rgbPlanes(rgba), W, H, { prob, width: lw, height: lh }, true, opts) → toBytes, on
 * `device`. A GPUBuffer `prob` must live on `device.handle` and stay alive until this resolves.
 */
export async function refineSkyGpu(
	device: Device,
	input: SkyRefineInput,
): Promise<SkyRefineOutput> {
	// ./refine-graph.ts imports this module's kernel specs and tables (hence the dynamic import)
	return (await import("./refine-graph")).refineSkyGraph(device, input);
}

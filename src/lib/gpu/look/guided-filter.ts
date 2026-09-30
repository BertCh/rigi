// GPU twin of look/guided-filter.ts guidedFilter (grey guide, (2r+1)² clamped box means). The batch
// form filters several masks against one guide in one submit and one readback, which is what
// CompositeLook.updateMasks needs (coverage, cut, people).
import type { Device } from "@luma.gl/core";
import { GF_H0, GF_H1, GF_V0, GF_V1 } from "./guided-filter.wgsl";
import {
	defineKernel,
	dispatch,
	kernel,
	release,
	stage,
	storage,
	uniform,
} from "./kernel";

const K_GF_H0 = defineKernel("gf-h0", GF_H0, [
	["prm", "uniform"],
	["gI", "read-only-storage"],
	["gp", "read-only-storage"],
	["outv", "storage"],
]);
const K_GF_V0 = defineKernel("gf-v0", GF_V0, [
	["prm", "uniform"],
	["inv", "read-only-storage"],
	["ab", "storage"],
]);
const K_GF_H1 = defineKernel("gf-h1", GF_H1, [
	["prm", "uniform"],
	["ab", "read-only-storage"],
	["outv", "storage"],
]);
const K_GF_V1 = defineKernel("gf-v1", GF_V1, [
	["prm", "uniform"],
	["inv", "read-only-storage"],
	["gI", "read-only-storage"],
	["q", "storage"],
]);

export type GuidedJob = { p: Float32Array; r: number; eps: number };

const WG = 256;

/** guidedFilter(I, p, w, h, r, eps) for each job, sharing the guide `I`. Same output as the CPU. */
export async function guidedFiltersGpu(
	device: Device,
	I: Float32Array,
	w: number,
	h: number,
	jobs: readonly GuidedJob[],
): Promise<Float32Array[]> {
	const n = w * h;
	const kH0 = kernel(device, K_GF_H0);
	const kV0 = kernel(device, K_GF_V0);
	const kH1 = kernel(device, K_GF_H1);
	const kV1 = kernel(device, K_GF_V1);
	const gI = storage(device, I);
	const t4 = storage(device, n * 16);
	const ab = storage(device, n * 8);
	const t2 = storage(device, n * 8);
	const owned = [gI, t4, ab, t2];
	const enc = device.createCommandEncoder({ id: "look-guided" });
	const groups = Math.ceil(n / WG);
	const reads = jobs.map((j) => {
		const words = new ArrayBuffer(16);
		new Uint32Array(words, 0, 3).set([w, h, j.r]);
		new Float32Array(words, 12, 1)[0] = j.eps;
		const prm = uniform(device, words);
		const gp = storage(device, j.p);
		const q = storage(device, n * 4);
		owned.push(prm, gp, q);
		dispatch(enc, kH0, { prm, gI, gp, outv: t4 }, groups);
		dispatch(enc, kV0, { prm, inv: t4, ab }, groups);
		dispatch(enc, kH1, { prm, ab, outv: t2 }, groups);
		dispatch(enc, kV1, { prm, inv: t2, gI, q }, groups);
		return stage(device, enc, q, n * 4);
	});
	device.submit(enc.finish());
	try {
		return (await Promise.all(reads.map((r) => r.read()))).map(
			(b) => new Float32Array(b),
		);
	} finally {
		release(...owned);
	}
}

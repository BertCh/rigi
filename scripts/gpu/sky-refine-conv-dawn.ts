// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU sky refine (src/lib/gpu/sky/refine-graph.ts: box means as luma GPUConvolutions) on a real
// luma WebGPU device in node (Dawn) against the CPU twin (sky/core.ts refineToWorking + toBytes), on
// deterministic synthetic working images and P(sky) fields: square, non-square and odd sizes, an
// upsample and a downsample, a window wider than the image (lw < 2r+1), radius 3 and 5, band 3.
// Per case: max / mean |dq| of the float mask, byte mismatches (count, max |d|), NaN / Inf count and
// the share of pixels whose sky decision at byte 128 flips. Tolerances asserted: max |dq| <= 1e-4,
// byte |d| <= 1, flips <= 1e-4 of the pixels. Warm wall time (median of 3) is informational.
// The public API (refineSkyGpu) is unchanged, so the same script runs on the base tree.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/sky-refine-conv-dawn.ts
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any tolerance failure.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { refineSkyGpu } from "../../src/lib/gpu/sky/refine";
import {
	refineToWorking,
	resamplePlanes,
	rgbPlanes,
	toBytes,
} from "../../src/lib/sky/core";

const ID = "sky-refine-conv-dawn";
const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log(`SKIP ${ID}: DAWN_DIR not set`);
	process.exit(0);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
// keep the instance referenced: Dawn drops pipelines of a collected instance
const gpu = create([]);
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const adapter = await gpu.requestAdapter();
if (!adapter) {
	console.log(`SKIP ${ID}: no adapter`);
	process.exit(0);
}
const handle = await adapter.requestDevice({});
const device = (await attachWebGPUDevice(handle, { id: ID }, true)) as Device;

/** mulberry32 */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A working RGBA image: sky gradient over a ridge, blobs, texture and noise (all channels vary). */
function makeImage(W: number, H: number, seed: number) {
	const rnd = rng(seed);
	const data = new Uint8ClampedArray(4 * W * H);
	const ph = [rnd() * 6, rnd() * 6, rnd() * 6];
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const u = x / W;
			const v = y / H;
			const ridge =
				0.45 + 0.12 * Math.sin(9 * u + ph[0]) + 0.05 * Math.sin(31 * u);
			const sky = v < ridge;
			const i = 4 * (y * W + x);
			const blob = Math.exp(-((u - 0.3) ** 2 + (v - 0.2) ** 2) / 0.01);
			const c = sky
				? [
						0.35 + 0.4 * v + 0.3 * blob,
						0.55 + 0.3 * v + 0.3 * blob,
						0.95 - 0.1 * v,
					]
				: [
						0.3 + 0.2 * Math.sin(40 * u + ph[1]) * Math.cos(25 * v),
						0.28 + 0.15 * Math.sin(33 * v + ph[2]),
						0.2 + 0.1 * Math.sin(50 * u * v),
					];
			for (let k = 0; k < 3; k++)
				data[i + k] = 255 * (c[k] + 0.04 * (rnd() - 0.5));
			data[i + 3] = 255;
		}
	}
	return data;
}

/** P(sky) at model resolution: soft ridge, a noisy unsure band, a few confident-wrong specks. */
function makeProb(lw: number, lh: number, seed: number) {
	const rnd = rng(seed ^ 0x9e3779b9);
	const prob = new Float32Array(lw * lh);
	const ph = rnd() * 6;
	for (let y = 0; y < lh; y++) {
		for (let x = 0; x < lw; x++) {
			const u = x / lw;
			const v = y / lh;
			const ridge =
				0.45 + 0.12 * Math.sin(9 * u + ph) + 0.05 * Math.sin(31 * u);
			let p = 1 / (1 + Math.exp((v - ridge) / 0.02));
			if (Math.abs(v - ridge) < 0.1)
				p = Math.min(1, Math.max(0, p + 0.25 * (rnd() - 0.5)));
			if (rnd() < 0.01) p = rnd() < 0.5 ? 0 : 1;
			prob[y * lw + x] = p;
		}
	}
	return prob;
}

type Case = {
	name: string;
	lw: number;
	lh: number;
	W: number;
	H: number;
	radius: number;
	band: number;
};
const CASES: Case[] = [
	{
		name: "64x48>128x96 r3",
		lw: 64,
		lh: 48,
		W: 128,
		H: 96,
		radius: 3,
		band: 3,
	},
	{
		name: "61x37>123x75 odd r3",
		lw: 61,
		lh: 37,
		W: 123,
		H: 75,
		radius: 3,
		band: 3,
	},
	{
		name: "100x75>200x150 r5",
		lw: 100,
		lh: 75,
		W: 200,
		H: 150,
		radius: 5,
		band: 3,
	},
	{
		name: "128x96>64x48 down r3",
		lw: 128,
		lh: 96,
		W: 64,
		H: 48,
		radius: 3,
		band: 3,
	},
	{
		name: "5x7>11x13 lw<2r+1 r5",
		lw: 5,
		lh: 7,
		W: 11,
		H: 13,
		radius: 5,
		band: 3,
	},
	{ name: "3x4>8x6 tiny r3", lw: 3, lh: 4, W: 8, H: 6, radius: 3, band: 3 },
	{
		name: "97x31>101x33 thin r3",
		lw: 97,
		lh: 31,
		W: 101,
		H: 33,
		radius: 3,
		band: 3,
	},
	{
		name: "256x256>512x384 r3",
		lw: 256,
		lh: 256,
		W: 512,
		H: 384,
		radius: 3,
		band: 3,
	},
];

let failed = 0;
const fail = (message: string) => {
	failed++;
	console.log(`FAIL ${message}`);
};
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

let worstDq = 0;
let worstByte = 0;
let worstFlips = 0;
let totalNaN = 0;
for (const [index, c] of CASES.entries()) {
	const { lw, lh, W, H, radius, band } = c;
	const rgba = makeImage(W, H, 100 + index);
	const prob = makeProb(lw, lh, 200 + index);
	const rgbWork = rgbPlanes({ width: W, height: H, data: rgba });
	const guideLo = resamplePlanes(rgbWork, W, H, 3, lw, lh);
	const cq = refineToWorking(
		rgbWork,
		W,
		H,
		{ prob, width: lw, height: lh },
		true,
		{ radius, band },
	);
	const cb = toBytes(cq);
	const input = {
		W,
		H,
		rgba,
		lw,
		lh,
		guideLo,
		prob,
		radius,
		band,
		floats: true,
	};
	let out = await refineSkyGpu(device, input);
	const times: number[] = [];
	for (let k = 0; k < 3; k++) {
		const t0 = performance.now();
		out = await refineSkyGpu(device, input);
		times.push(performance.now() - t0);
	}
	const q = out.q;
	if (!q) {
		fail(`${c.name}: no float mask`);
		continue;
	}
	let maxDq = 0;
	let sumDq = 0;
	let bad = 0;
	for (let i = 0; i < q.length; i++) {
		if (!Number.isFinite(q[i])) {
			bad++;
			continue;
		}
		const d = Math.abs(q[i] - cq[i]);
		sumDq += d;
		if (d > maxDq) maxDq = d;
	}
	let byteDiff = 0;
	let byteMax = 0;
	let flips = 0;
	for (let i = 0; i < cb.length; i++) {
		const e = Math.abs(out.bytes[i] - cb[i]);
		if (e) byteDiff++;
		if (e > byteMax) byteMax = e;
		if (out.bytes[i] >= 128 !== cb[i] >= 128) flips++;
	}
	const flipShare = flips / cb.length;
	console.log(
		`${c.name.padEnd(24)} max|dq| ${maxDq.toExponential(2)} mean|dq| ${(sumDq / q.length).toExponential(2)} bytes ${byteDiff}/${cb.length} differ, max|d| ${byteMax}, NaN/Inf ${bad}, flips@128 ${flips} (${flipShare.toExponential(1)}), warm ${med(times).toFixed(1)} ms`,
	);
	worstDq = Math.max(worstDq, maxDq);
	worstByte = Math.max(worstByte, byteMax);
	worstFlips = Math.max(worstFlips, flipShare);
	totalNaN += bad;
	if (bad) fail(`${c.name}: ${bad} non-finite floats`);
	if (maxDq > 1e-4) fail(`${c.name}: max|dq| ${maxDq} > 1e-4`);
	if (byteMax > 1) fail(`${c.name}: byte |d| ${byteMax} > 1`);
	if (flipShare > 1e-4) fail(`${c.name}: decision flips ${flipShare} > 1e-4`);
}
console.log(
	`summary: worst max|dq| ${worstDq.toExponential(2)}, worst byte |d| ${worstByte}, worst flip share ${worstFlips.toExponential(1)}, NaN/Inf ${totalNaN}`,
);
if (failed) {
	console.log(`FAIL ${ID}: ${failed} failures`);
	process.exit(1);
}
console.log(`PASS ${ID}`);
process.exit(0);

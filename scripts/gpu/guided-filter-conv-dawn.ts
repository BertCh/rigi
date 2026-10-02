// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU guided filter (src/lib/gpu/look/guided-filter-graph.ts: box means as luma GPUConvolutions,
// guidedFiltersGpu) on a real luma WebGPU device in node (Dawn) against the CPU twin
// (look/guided-filter.ts guidedFilter) on deterministic synthetic guides and masks: square, odd,
// thin and tiny sizes (w or h < 2r+1 included), several radii and eps, 1 to 3 jobs sharing the guide.
// Per case: max / mean |dq| vs the CPU, the byte histogram of round(255q) differences, non-finite
// count and warm wall time (median of 5). A NaN case checks that pixels farther than 4r+2 from the
// NaN equal the CPU run with the NaN zeroed, and that the NaN stays local (counts non-finite).
// Tolerances asserted: max |dq| <= 1e-4, byte |d| <= 1. With GF_OLD_OUT=<file> the q planes are
// saved (run it on the base tree to record the old GPU path); a later run with the file present also
// reports max |dq| vs the old GPU path and old-vs-new warm timings.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/guided-filter-conv-dawn.ts
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any tolerance failure.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { guidedFiltersGpu } from "../../src/lib/gpu/look/guided-filter";
import { guidedFilter } from "../../src/lib/look/guided-filter";

const ID = "guided-filter-conv-dawn";
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

/** A grey guide with a ridge, texture and noise, and a soft mask with a noisy band around the ridge. */
function makeScene(w: number, h: number, seed: number) {
	const rnd = rng(seed);
	const I = new Float32Array(w * h);
	const masks = [0, 1, 2].map(() => new Float32Array(w * h));
	const ph = rnd() * 6;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const u = x / w;
			const v = y / h;
			const ridge = 0.45 + 0.12 * Math.sin(9 * u + ph);
			const i = y * w + x;
			I[i] = Math.min(
				1,
				Math.max(
					0,
					(v < ridge ? 0.8 - 0.3 * v : 0.3 + 0.1 * Math.sin(40 * u * v)) +
						0.04 * (rnd() - 0.5),
				),
			);
			masks.forEach((m, k) => {
				const soft = 1 / (1 + Math.exp((v - ridge - 0.03 * k) / 0.03));
				m[i] = Math.min(1, Math.max(0, soft + 0.2 * (rnd() - 0.5)));
			});
		}
	return { I, masks };
}

type Case = {
	name: string;
	w: number;
	h: number;
	jobs: { m: number; r: number; eps: number }[];
};
const CASES: Case[] = [
	{
		name: "128x96 3 jobs",
		w: 128,
		h: 96,
		jobs: [
			{ m: 0, r: 2, eps: 4e-4 },
			{ m: 1, r: 2, eps: 3e-3 },
			{ m: 2, r: 3, eps: 1e-3 },
		],
	},
	{ name: "61x37 odd r4", w: 61, h: 37, jobs: [{ m: 0, r: 4, eps: 1e-3 }] },
	{
		name: "512x384 r4,r6",
		w: 512,
		h: 384,
		jobs: [
			{ m: 0, r: 4, eps: 4e-4 },
			{ m: 1, r: 4, eps: 3e-3 },
			{ m: 2, r: 6, eps: 1e-3 },
		],
	},
	{ name: "97x31 thin r5", w: 97, h: 31, jobs: [{ m: 0, r: 5, eps: 1e-2 }] },
	{
		name: "5x7 w,h<2r+1 r5",
		w: 5,
		h: 7,
		jobs: [
			{ m: 0, r: 5, eps: 1e-3 },
			{ m: 1, r: 2, eps: 1e-4 },
		],
	},
	{ name: "3x4 tiny r3", w: 3, h: 4, jobs: [{ m: 0, r: 3, eps: 1e-3 }] },
	{ name: "40x9 h<2r+1 r6", w: 40, h: 9, jobs: [{ m: 2, r: 6, eps: 5e-3 }] },
	{
		name: "256x256 r2 eps1e-5",
		w: 256,
		h: 256,
		jobs: [{ m: 1, r: 2, eps: 1e-5 }],
	},
];

let failed = 0;
const fail = (message: string) => {
	failed++;
	console.log(`FAIL ${message}`);
};
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const oldFile = process.env.GF_OLD_OUT;
const oldOut: Record<string, number[][]> | null =
	oldFile && fs.existsSync(oldFile)
		? JSON.parse(fs.readFileSync(oldFile, "utf8"))
		: null;
const record: Record<string, number[][]> = {};
const timings: Record<string, number> = {};

async function timeGpu(
	I: Float32Array,
	w: number,
	h: number,
	jobs: { p: Float32Array; r: number; eps: number }[],
) {
	let out = await guidedFiltersGpu(device, I, w, h, jobs);
	const times: number[] = [];
	for (let k = 0; k < 5; k++) {
		const t0 = performance.now();
		out = await guidedFiltersGpu(device, I, w, h, jobs);
		times.push(performance.now() - t0);
	}
	return { out, ms: med(times) };
}

let worstDq = 0;
let worstByte = 0;
for (const [index, c] of CASES.entries()) {
	const { w, h } = c;
	const { I, masks } = makeScene(w, h, 300 + index);
	const jobs = c.jobs.map((j) => ({ p: masks[j.m], r: j.r, eps: j.eps }));
	const cpu = jobs.map((j) => guidedFilter(I, j.p, w, h, j.r, j.eps));
	const { out, ms } = await timeGpu(I, w, h, jobs);
	timings[c.name] = ms;
	record[c.name] = out.map((q) => Array.from(q));
	let maxDq = 0;
	let sumDq = 0;
	let bad = 0;
	let byteMax = 0;
	const hist: Record<number, number> = {};
	let maxOld = 0;
	for (const [k, q] of out.entries()) {
		for (let i = 0; i < q.length; i++) {
			if (!Number.isFinite(q[i])) {
				bad++;
				continue;
			}
			const d = Math.abs(q[i] - cpu[k][i]);
			sumDq += d;
			if (d > maxDq) maxDq = d;
			const bd = Math.round(255 * q[i]) - Math.round(255 * cpu[k][i]);
			hist[bd] = (hist[bd] ?? 0) + 1;
			byteMax = Math.max(byteMax, Math.abs(bd));
			if (oldOut)
				maxOld = Math.max(maxOld, Math.abs(q[i] - oldOut[c.name][k][i]));
		}
	}
	const count = out.length * w * h;
	const histText = Object.entries(hist)
		.filter(([d]) => d !== "0")
		.map(([d, n]) => `${d}:${n}`)
		.join(" ");
	console.log(
		`${c.name.padEnd(22)} max|dq| ${maxDq.toExponential(2)} mean ${(sumDq / count).toExponential(2)} byte max ${byteMax} nonzero {${histText}} NaN/Inf ${bad}${oldOut ? ` vs old ${maxOld.toExponential(2)}` : ""} warm ${ms.toFixed(2)} ms`,
	);
	worstDq = Math.max(worstDq, maxDq);
	worstByte = Math.max(worstByte, byteMax);
	if (bad) fail(`${c.name}: ${bad} non-finite`);
	if (maxDq > 1e-4) fail(`${c.name}: max|dq| ${maxDq} > 1e-4`);
	if (byteMax > 1) fail(`${c.name}: byte |d| ${byteMax} > 1`);
}

// NaN case: one NaN in the mask; far pixels equal the CPU with the NaN zeroed
{
	const w = 96;
	const h = 64;
	const r = 3;
	const eps = 1e-3;
	const { I, masks } = makeScene(w, h, 999);
	const p = Float32Array.from(masks[0]);
	const nx = 30;
	const ny = 20;
	p[ny * w + nx] = Number.NaN;
	const pClean = Float32Array.from(p);
	pClean[ny * w + nx] = 0;
	const cpu = guidedFilter(I, pClean, w, h, r, eps);
	const [q] = await guidedFiltersGpu(device, I, w, h, [{ p, r, eps }]);
	let farMax = 0;
	let nearBad = 0;
	let farBad = 0;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const far = Math.max(Math.abs(x - nx), Math.abs(y - ny)) > 2 * r + 1;
			const v = q[y * w + x];
			if (!Number.isFinite(v)) {
				if (far) farBad++;
				else nearBad++;
			} else if (far) farMax = Math.max(farMax, Math.abs(v - cpu[y * w + x]));
		}
	console.log(
		`NaN case               far max|dq| ${farMax.toExponential(2)} non-finite near ${nearBad} far ${farBad}`,
	);
	if (farBad || farMax > 1e-4)
		fail(
			`NaN case: NaN leaks (far non-finite ${farBad}, far max|dq| ${farMax})`,
		);
}

if (oldFile && !oldOut) {
	fs.writeFileSync(oldFile, JSON.stringify(record));
	console.log(`recorded the q planes to ${oldFile}`);
	fs.writeFileSync(`${oldFile}.ms.json`, JSON.stringify(timings));
} else if (oldFile && fs.existsSync(`${oldFile}.ms.json`)) {
	const base = JSON.parse(fs.readFileSync(`${oldFile}.ms.json`, "utf8"));
	for (const [name, ms] of Object.entries(timings))
		console.log(
			`timing ${name.padEnd(22)} old ${Number(base[name]).toFixed(2)} ms  new ${ms.toFixed(2)} ms`,
		);
}
console.log(
	`summary: worst max|dq| ${worstDq.toExponential(2)}, worst byte |d| ${worstByte}`,
);
if (failed) {
	console.log(`FAIL ${ID}: ${failed} failures`);
	process.exit(1);
}
console.log(`PASS ${ID}`);
process.exit(0);

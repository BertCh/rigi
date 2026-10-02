// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU skyline feature graph (src/lib/gpu/skyline: box blurs as luma GPUConvolution + clamp-to-edge fix)
// against the CPU twin (src/lib/geo/skyline.ts) in node on a native WebGPU device (Dawn), on synthetic
// images only (deterministic): ridge images (like skyline.check.ts) and uniform-noise images, including
// odd sizes and widths / heights under the 2r+1 = 7 taps of the widest blur.
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/skyline-conv-dawn.ts
// Per image: max / mean |GPU - CPU| of every feature image (rgb blur, tex, edge, step, prior), NaN / Inf
// counts, then detectSkylineGpu vs detectSkyline (max / median |d row|, columns whose finiteness differs)
// and the warm GPU wall time. Asserts: features <= 1e-5 (edge only where |step| > 1e-4: the dl > 0
// polarity discontinuity flips its 0.4 / 1.0 weight, reported as edgeAll), max |d row| <= 0.05 px,
// finiteness differences 0, no NaN / Inf. Uses only the public API, so it also runs on the pre-conv tree.
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any tolerance failure.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import {
	computeFeatures,
	detectSkyline,
	heuristicSky,
	type RGBALike,
} from "../../src/lib/geo/skyline";
import { adoptRenderDevice } from "../../src/lib/gpu/device";
import { detectSkylineGpu, openSkylineGpu } from "../../src/lib/gpu/skyline";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP skyline-conv-dawn: DAWN_DIR not set");
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
	console.log("SKIP skyline-conv-dawn: no adapter");
	process.exit(0);
}
const { luma } = await import("@luma.gl/core");
const { webgpuAdapter } = await import("@luma.gl/webgpu");
const device = (await luma.createDevice({
	type: "webgpu",
	adapters: [webgpuAdapter],
	createCanvasContext: false,
} as never)) as Device;
adoptRenderDevice(device);

const FEATURE_TOL = 1e-5;
const ROW_TOL = 0.05;

function ridgeImage(w: number, h: number): RGBALike {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const ridge = h * 0.58 + 0.1 * h * Math.sin(x / 11) + (0.2 * x * h) / 120;
			const o = 4 * (y * w + x);
			if (y < ridge) {
				data[o] = 110 + y * 0.4;
				data[o + 1] = 160 + y * 0.3;
				data[o + 2] = 235;
			} else {
				data[o] = 60 + ((x * 7 + y * 13) % 17);
				data[o + 1] = 70 + ((x * 5 + y * 3) % 11);
				data[o + 2] = 50;
			}
			data[o + 3] = 255;
		}
	return { width: w, height: h, data };
}

function noiseImage(w: number, h: number, seed: number): RGBALike {
	let s = seed >>> 0;
	const rnd = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const data = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		data[4 * i] = rnd() * 256;
		data[4 * i + 1] = rnd() * 256;
		data[4 * i + 2] = rnd() * 256;
		data[4 * i + 3] = 255;
	}
	return { width: w, height: h, data };
}

/** A ridge image with +-12 levels of deterministic noise, so the detector still finds rows. */
function noisyRidgeImage(w: number, h: number, seed: number): RGBALike {
	const img = ridgeImage(w, h);
	const noise = noiseImage(w, h, seed).data;
	for (let i = 0; i < w * h * 4; i++)
		if (i % 4 !== 3) img.data[i] += (noise[i] - 128) / 10.7;
	return img;
}

const cases: [string, RGBALike][] = [
	["noisy ridge 128x96", noisyRidgeImage(128, 96, 7)],
	["noisy ridge 75x53 odd", noisyRidgeImage(75, 53, 8)],
	["ridge 160x120", ridgeImage(160, 120)],
	["ridge 97x61 odd", ridgeImage(97, 61)],
	["ridge 200x40 wide", ridgeImage(200, 40)],
	["ridge 40x160 tall", ridgeImage(40, 160)],
	["noise 64x48", noiseImage(64, 48, 1)],
	["noise 31x17 odd", noiseImage(31, 17, 2)],
	["noise 7x9 w=2r+1", noiseImage(7, 9, 3)],
	["noise 5x4 w<2r+1", noiseImage(5, 4, 4)],
	["noise 3x11 w<2r+1", noiseImage(3, 11, 5)],
	["noise 13x3 h<2r+1", noiseImage(13, 3, 6)],
];

let failed = 0;
const fail = (m: string) => {
	failed++;
	console.log(`FAIL ${m}`);
};
const e = (v: number) => v.toExponential(1);

function diff(
	a: ArrayLike<number>,
	b: ArrayLike<number>,
	keep?: (i: number) => boolean,
) {
	let max = 0;
	let sum = 0;
	let count = 0;
	let bad = 0;
	for (let i = 0; i < a.length; i++) {
		if (!Number.isFinite(b[i])) bad++;
		if (keep && !keep(i)) continue;
		const d = Math.abs(a[i] - b[i]);
		if (d > max) max = d;
		sum += d;
		count++;
	}
	return { max, mean: count ? sum / count : 0, bad };
}

const median = (v: number[]) => {
	const s = [...v].sort((p, q) => p - q);
	return s.length ? s[s.length >> 1] : 0;
};

const worst = { rgb: 0, tex: 0, edge: 0, step: 0, prior: 0, row: 0 };
for (const [label, img] of cases) {
	const { width: w, height: h } = img;
	const n = w * h;
	const f = computeFeatures(img);
	const prior = heuristicSky(f, n);
	const session = await openSkylineGpu(device, img);
	const { f: fg, prior: pg } = await session.stages.features(img);
	session.dispose();
	const feat = {
		rgb: diff([...f.r, ...f.g, ...f.b], [...fg.r, ...fg.g, ...fg.b]),
		tex: diff(f.tex, fg.tex),
		step: diff(f.step, fg.step),
		prior: diff(prior, pg),
		edge: diff(f.edge, fg.edge, (i) => Math.abs(f.step[i]) > 1e-4),
		edgeAll: diff(f.edge, fg.edge),
	};
	for (const k of ["rgb", "tex", "edge", "step", "prior"] as const) {
		worst[k] = Math.max(worst[k], feat[k].max);
		if (
			feat[k].max > FEATURE_TOL ||
			feat[k].bad > 0 ||
			Number.isNaN(feat[k].max)
		)
			fail(`${label}: ${k} max ${e(feat[k].max)} bad ${feat[k].bad}`);
	}
	if (feat.edgeAll.bad > 0)
		fail(`${label}: edge non-finite ${feat.edgeAll.bad}`);
	const cpu = detectSkyline(img);
	const run = () => detectSkylineGpu(img);
	const gp = await run();
	if (!gp) throw new Error("no compute device");
	const times: number[] = [];
	for (let i = 0; i < 3; i++) {
		const t = performance.now();
		await run();
		times.push(performance.now() - t);
	}
	let finiteMismatch = 0;
	let nan = 0;
	const dr: number[] = [];
	for (let x = 0; x < cpu.rows.length; x++) {
		const fc = Number.isFinite(cpu.rows[x]);
		const fgp = Number.isFinite(gp.rows[x]);
		if (fc !== fgp) finiteMismatch++;
		if (Number.isNaN(gp.weight[x])) nan++;
		if (fc && fgp) dr.push(Math.abs(cpu.rows[x] - gp.rows[x]));
	}
	const maxRow = dr.reduce((m, v) => Math.max(m, v), 0);
	worst.row = Math.max(worst.row, maxRow);
	if (maxRow > ROW_TOL) fail(`${label}: max |d row| ${maxRow}`);
	if (finiteMismatch)
		fail(`${label}: finiteness differs on ${finiteMismatch} columns`);
	if (nan) fail(`${label}: ${nan} NaN weights`);
	console.log(
		`${label.padEnd(20)} max/mean rgb ${e(feat.rgb.max)}/${e(feat.rgb.mean)} tex ${e(feat.tex.max)}/${e(feat.tex.mean)} edge ${e(feat.edge.max)}/${e(feat.edge.mean)} (all ${e(feat.edgeAll.max)}) step ${e(feat.step.max)}/${e(feat.step.mean)} prior ${e(feat.prior.max)}/${e(feat.prior.mean)} | rows finite ${cpu.rows.filter(Number.isFinite).length}/${cpu.rows.length} mismatch ${finiteMismatch} max ${e(maxRow)} med ${e(median(dr))} | gpu ${median(times).toFixed(1)} ms`,
	);
}
console.log(
	`worst: rgb ${e(worst.rgb)} tex ${e(worst.tex)} edge ${e(worst.edge)} step ${e(worst.step)} prior ${e(worst.prior)} row ${e(worst.row)}`,
);
device.destroy();
if (failed) {
	console.log(`FAIL skyline-conv-dawn (${failed})`);
	process.exit(1);
}
console.log("PASS skyline-conv-dawn");
process.exit(0);

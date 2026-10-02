// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Photo look on a real luma WebGPU device in node (Dawn): the GPU palette (unpack kernel + luma
// GPUKMeans in one ComputeGraph) against its CPU twin on 10 synthetic images, groupByLook (GPUKMeans +
// GPUSimilaritySearch ranking) and similarLooks (cosine, excludeSelf) against their CPU twins on
// synthetic clustered embeddings. Tolerances: palette centroids matched by nearest colour,
// Delta E OK <= 0.02, share delta <= 0.05; group assignment agreement >= 95% (up to relabelling);
// similarity top-k overlap >= 90%.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/photo-look-dawn.ts
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/device";
import {
	deltaEOk,
	LOOK_DIMS,
	type PhotoPixels,
	photoLookEmbedding,
	photoPaletteCpu,
	photoPaletteGpu,
} from "../../src/lib/gpu/palette";
import {
	groupByLookCpu,
	groupByLookGpu,
	similarLooksCpu,
	similarLooksGpu,
} from "../../src/lib/roll/look/lookGroups";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP photo-look-dawn: DAWN_DIR not set");
	process.exit(0);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const adapter = await gpu.requestAdapter();
if (!adapter) {
	console.log("SKIP photo-look-dawn: no adapter");
	process.exit(0);
}
const handle = await adapter.requestDevice({
	requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
});
const device = (await attachWebGPUDevice(
	handle,
	{ id: "photo-look-dawn" },
	true,
)) as Device;
console.log(`adapter ${JSON.stringify(adapter.info ?? {})}`);

let failed = 0;
const fail = (message: string) => {
	failed++;
	console.log(`FAIL ${message}`);
};

// deterministic PRNG
const rng = (seed: number) => () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 2 ** 32;
};

const SIZE = 64;
type Rgb = [number, number, number];
const image = (
	paint: (x: number, y: number, r: () => number) => Rgb,
	seed: number,
) => {
	const r = rng(seed);
	const data = new Uint8ClampedArray(SIZE * SIZE * 4);
	for (let y = 0; y < SIZE; y++)
		for (let x = 0; x < SIZE; x++) {
			const c = paint(x, y, r);
			data.set([c[0], c[1], c[2], 255], (y * SIZE + x) * 4);
		}
	return { width: SIZE, height: SIZE, data } satisfies PhotoPixels;
};
const blocks =
	(colors: Rgb[]) =>
	(x: number, y: number): Rgb =>
		colors[
			(Math.floor((x * colors.length) / SIZE) + (y >= SIZE / 2 ? 1 : 0)) %
				colors.length
		];
const jitter = (c: Rgb, r: () => number, amount: number): Rgb =>
	c.map((v) => Math.max(0, Math.min(255, v + (r() - 0.5) * amount))) as Rgb;

const images: [string, PhotoPixels][] = [
	["gradient-sky", image((_x, y) => [40 + y * 3, 90 + y * 2, 200 - y], 1)],
	["gradient-dusk", image((x, y) => [250 - y * 3, 120 - y, 60 + x], 2)],
	[
		"blocks-2",
		image(
			blocks([
				[220, 40, 40],
				[30, 60, 200],
			]),
			3,
		),
	],
	[
		"blocks-3",
		image(
			blocks([
				[240, 240, 230],
				[30, 120, 50],
				[90, 70, 40],
			]),
			4,
		),
	],
	[
		"blocks-4",
		image(
			blocks([
				[10, 10, 10],
				[250, 200, 20],
				[20, 160, 200],
				[200, 30, 150],
			]),
			5,
		),
	],
	[
		"blocks-5",
		image(
			blocks([
				[250, 250, 250],
				[200, 60, 30],
				[40, 90, 50],
				[60, 70, 160],
				[120, 100, 80],
			]),
			6,
		),
	],
	[
		"blocks-6",
		image(
			blocks([
				[255, 0, 0],
				[0, 255, 0],
				[0, 0, 255],
				[255, 255, 0],
				[0, 255, 255],
				[255, 0, 255],
			]),
			7,
		),
	],
	["noise", image((_x, _y, r) => [r() * 255, r() * 255, r() * 255], 8)],
	[
		"jittered-3",
		image(
			(x, y, r) =>
				jitter(
					blocks([
						[200, 180, 120],
						[60, 80, 90],
						[20, 20, 30],
					])(x, y),
					r,
					24,
				),
			9,
		),
	],
	["flat", image(() => [128, 128, 128], 10)],
];

console.log("\npalette: GPU vs CPU twin");
let worstE = 0;
let worstShare = 0;
for (const [name, pixels] of images) {
	const cpu = photoPaletteCpu(pixels);
	const gpuPalette = await photoPaletteGpu(device, pixels);
	let rowWorstE = 0;
	let rowWorstShare = 0;
	if (cpu.colors.length !== gpuPalette.colors.length)
		fail(
			`${name}: colour count cpu ${cpu.colors.length} gpu ${gpuPalette.colors.length}`,
		);
	for (const c of cpu.colors) {
		let best = Number.POSITIVE_INFINITY;
		let share = 1;
		for (const g of gpuPalette.colors) {
			const d = deltaEOk(c.oklab, g.oklab);
			if (d < best) {
				best = d;
				share = Math.abs(c.share - g.share);
			}
		}
		rowWorstE = Math.max(rowWorstE, best);
		rowWorstShare = Math.max(rowWorstShare, share);
	}
	worstE = Math.max(worstE, rowWorstE);
	worstShare = Math.max(worstShare, rowWorstShare);
	console.log(
		`  ${name.padEnd(14)} colours ${cpu.colors.length}/${gpuPalette.colors.length}  max dE ${rowWorstE.toExponential(2)}  max share d ${rowWorstShare.toExponential(2)}`,
	);
	if (rowWorstE > 0.02) fail(`${name}: centroid dE ${rowWorstE}`);
	if (rowWorstShare > 0.05) fail(`${name}: share delta ${rowWorstShare}`);
	const embedding = photoLookEmbedding(pixels, gpuPalette);
	if (
		embedding.length !== LOOK_DIMS ||
		embedding.some((v) => !Number.isFinite(v))
	)
		fail(`${name}: embedding`);
}
console.log(
	`  worst over ${images.length} images: dE ${worstE.toExponential(2)}, share ${worstShare.toExponential(2)}`,
);

// synthetic clustered embeddings: `groups` centres, noisy members, shuffled
const clustered = (rows: number, groups: number, seed: number) => {
	const r = rng(seed);
	const centres = Array.from({ length: groups }, () =>
		Float32Array.from({ length: LOOK_DIMS }, () => r() * 2),
	);
	const truth: number[] = [];
	const embeddings = Array.from({ length: rows }, () => {
		const g = Math.floor(r() * groups);
		truth.push(g);
		return Float32Array.from(centres[g], (v) => v + (r() - 0.5) * 0.15);
	});
	return { embeddings, truth };
};

/** Fraction of photos whose group matches under the best 1:1 relabelling (greedy on overlap). */
function agreement(a: Uint32Array, b: Uint32Array) {
	const na = Math.max(...a) + 1;
	const nb = Math.max(...b) + 1;
	const overlap = Array.from({ length: na }, () => new Array(nb).fill(0));
	a.forEach((g, i) => {
		overlap[g][b[i]]++;
	});
	let matched = 0;
	const usedA = new Set<number>();
	const usedB = new Set<number>();
	for (;;) {
		let best = -1;
		let bi = -1;
		let bj = -1;
		for (let i = 0; i < na; i++)
			for (let j = 0; j < nb; j++)
				if (!usedA.has(i) && !usedB.has(j) && overlap[i][j] > best) {
					best = overlap[i][j];
					bi = i;
					bj = j;
				}
		if (best < 0) break;
		matched += best;
		usedA.add(bi);
		usedB.add(bj);
	}
	return matched / a.length;
}

console.log("\ngroupByLook + similarLooks: GPU vs CPU twin");
for (const [rows, groups, seed] of [
	[24, 3, 21],
	[60, 4, 22],
	[120, 5, 23],
	[300, 6, 24],
] as const) {
	const { embeddings, truth } = clustered(rows, groups, seed);
	const cpu = groupByLookCpu(embeddings, groups);
	const g = await groupByLookGpu(device, embeddings, groups);
	const agree = agreement(cpu.groupOfPhoto, g.groupOfPhoto);
	const truthAgree = agreement(Uint32Array.from(truth), g.groupOfPhoto);
	// ranking: compare each matched group's first member by closeness (top-3 member overlap)
	let rankOverlap = 0;
	let rankTotal = 0;
	for (const cg of cpu.groups) {
		const gg = g.groups.find((x) => x.members.includes(cg.members[0]));
		if (!gg) continue;
		const top = cg.members.slice(0, 3);
		const gtop = new Set(gg.members.slice(0, 3));
		rankOverlap += top.filter((m) => gtop.has(m)).length;
		rankTotal += top.length;
	}
	console.log(
		`  rows ${String(rows).padStart(3)} k ${groups}: groups cpu/gpu ${cpu.groups.length}/${g.groups.length}, assignment agreement ${(agree * 100).toFixed(1)}%, vs truth ${(truthAgree * 100).toFixed(1)}%, rank top-3 overlap ${rankOverlap}/${rankTotal}`,
	);
	if (agree < 0.95) fail(`groupByLook ${rows}: agreement ${agree}`);
	if (rankTotal && rankOverlap / rankTotal < 0.9)
		fail(`groupByLook ${rows}: rank overlap`);
	const query = Math.floor(rows / 3);
	const k = Math.min(8, rows - 1);
	const sc = similarLooksCpu(embeddings, query, k);
	const sg = await similarLooksGpu(device, embeddings, query, k);
	const cset = new Set(sc.map((x) => x.index));
	const overlapK = sg.filter((x) => cset.has(x.index)).length;
	const selfSeen = sg.some((x) => x.index === query);
	const maxScoreDelta = Math.max(
		0,
		...sg.map((x, i) => Math.abs(x.score - (sc[i]?.score ?? 0))),
	);
	console.log(
		`  similarLooks rows ${rows}: top-${k} overlap ${overlapK}/${k}, self excluded ${!selfSeen}, max score d ${maxScoreDelta.toExponential(2)}`,
	);
	if (selfSeen) fail(`similarLooks ${rows}: includes self`);
	if (sg.length !== sc.length)
		fail(`similarLooks ${rows}: length ${sg.length} vs ${sc.length}`);
	if (overlapK / k < 0.9)
		fail(`similarLooks ${rows}: overlap ${overlapK}/${k}`);
}

console.log(
	failed ? `\nFAIL photo-look-dawn: ${failed}` : "\nPASS photo-look-dawn",
);
device.destroy();
process.exit(failed ? 1 : 0);

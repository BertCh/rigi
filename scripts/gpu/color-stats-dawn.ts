// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Colour band statistics (src/lib/gpu/look/color-stats.ts bandStatsGpu: BAND_STATS partials folded by a
// luma GPUGroupAggregation, then BAND_FINALIZE) on a real luma WebGPU device in node (Dawn), at 512x384,
// 1600x1200 and 3000x2000 synthetic scenes, against the CPU twin (look/color-stats.ts
// reduceBands(bandInputs(...)), float64). Prints the median wall time (several runs, same device) and the
// max abs / rel difference per ColorStats field, with and without subgroups. The fold's float adds are
// atomics, so the checks are tolerances, not equality: counts within 1e-4, means / stds within 1e-4 abs,
// no NaN. (A per-pixel GPUGroupAggregation formulation was measured 3-15x slower and is not in the code.)
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/color-stats-dawn.ts [reps]
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on a failed tolerance.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/device";
import {
	type BandStatsInput,
	bandStatsGpu,
} from "../../src/lib/gpu/look/color-stats";
import {
	bandInputs,
	type ColorStats,
	reduceBands,
} from "../../src/lib/look/color-stats";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP color-stats-dawn: DAWN_DIR not set");
	process.exit(0);
}
const REPS = Number(process.argv[2] ?? 9);
const TOLERANCE = 1e-4;
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
	console.log("SKIP color-stats-dawn: no adapter");
	process.exit(0);
}
const device = (await attachWebGPUDevice(
	await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
		// the sidecar's raised limits (device.ts RAISED_LIMITS), so the big scene fits one binding
		requiredLimits: {
			maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
			maxBufferSize: adapter.limits.maxBufferSize,
		},
	}),
	{ id: "color-stats-dawn" },
	true,
)) as Device;
console.log(
	`adapter ${JSON.stringify(adapter.info ?? {})} subgroups ${device.features.has("subgroups")}`,
);

let failed = 0;
const fail = (message: string) => {
	failed++;
	console.log(`FAIL ${message}`);
};

function makeRandom(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/** A synthetic photo / layer / range / people scene: ridge-shaped sky, four range bands, noise. */
function makeScene(w: number, h: number, seed: number): BandStatsInput {
	const random = makeRandom(seed);
	const photo = new Uint8ClampedArray(w * h * 4);
	const layer = new Float32Array(w * h * 4);
	const range = new Float32Array(w * h);
	const fg = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const ridge =
				h * (0.25 + 0.1 * Math.sin(x * 0.011) + 0.05 * Math.sin(x * 0.037));
			const isSky = y < ridge;
			range[i] = isSky
				? 0
				: 300 *
					2 ** (((y - ridge) / (h - ridge)) * 7 + 1.5) *
					(1 + 0.1 * random());
			const t = y / h;
			photo[i * 4] = 90 + 120 * t + 20 * random();
			photo[i * 4 + 1] = 100 + 80 * (1 - t) + 20 * random();
			photo[i * 4 + 2] = 140 + 40 * Math.sin(x * 0.01) + 20 * random();
			photo[i * 4 + 3] = 255;
			const alpha = random() < 0.02 ? 0.5 : 1;
			layer[i * 4] = alpha * (0.15 + 0.5 * t + 0.1 * random());
			layer[i * 4 + 1] = alpha * (0.2 + 0.3 * (1 - t) + 0.1 * random());
			layer[i * 4 + 2] = alpha * (0.25 + 0.2 * Math.sin(x * 0.01) ** 2);
			layer[i * 4 + 3] = alpha;
			fg[i] = x > w * 0.4 && x < w * 0.45 && y > h * 0.6 ? 1 : 0;
		}
	}
	return { photo, layer, w, h, range, fg, minRange: 200 };
}

const FIELDS = [
	"photoMean",
	"photoStd",
	"layerMean",
	"layerStd",
] as const satisfies readonly (keyof ColorStats)[];

function compare(a: ColorStats, b: ColorStats) {
	// the CPU twin rounds log10(range) to f32 before banding, so a handful of pixels next to a band
	// edge may land in the neighbouring band: counts agree within 1e-4 of the pixels, not exactly
	let countsEqual = a.valid === b.valid;
	for (let k = 0; k < a.count.length; k++)
		if (Math.abs(a.count[k] - b.count[k]) > 1e-4 * a.count[k] + 2)
			countsEqual = false;
	let maxAbs = 0;
	let maxRel = 0;
	let nan = 0;
	for (const field of FIELDS)
		for (let k = 0; k < a[field].length; k++) {
			const x = a[field][k];
			const y = b[field][k];
			if (!Number.isFinite(y)) nan++;
			const d = Math.abs(x - y);
			maxAbs = Math.max(maxAbs, d);
			maxRel = Math.max(maxRel, d / Math.max(1e-9, Math.abs(x)));
		}
	return { countsEqual, maxAbs, maxRel, nan };
}

const median = (xs: number[]) => [...xs].sort((p, q) => p - q)[xs.length >> 1];

async function time(run: () => Promise<unknown>) {
	await run();
	const ms: number[] = [];
	for (let i = 0; i < REPS; i++) {
		const t0 = performance.now();
		await run();
		ms.push(performance.now() - t0);
	}
	return median(ms);
}

for (const [w, h] of [
	[512, 384],
	[1600, 1200],
	[3000, 2000],
] as const) {
	const input = makeScene(w, h, w);
	const { a, b } = bandInputs(
		input.photo as Uint8ClampedArray,
		input.layer,
		w,
		h,
		(x, y) => input.range[y * w + x],
		(x, y) => (input.fg as Float32Array)[y * w + x],
		input.minRange ?? 0,
	);
	const cpu = reduceBands(a, b, w * h);
	console.log(
		`\n${w}x${h}: cpu counts ${Array.from(cpu.count)} valid ${cpu.valid}`,
	);
	for (const subgroups of [true, false]) {
		const opts = { subgroups };
		const got = await bandStatsGpu(device, input, opts);
		const c = compare(cpu, got);
		const ms = await time(() => bandStatsGpu(device, input, opts));
		console.log(
			`  sg=${subgroups ? 1 : 0} median ${ms.toFixed(2)} ms  vs cpu: counts ${c.countsEqual ? "equal" : "DIFFER"}, max abs ${c.maxAbs.toExponential(2)}, max rel ${c.maxRel.toExponential(2)}, nan ${c.nan}`,
		);
		if (!c.countsEqual)
			fail(
				`${w}x${h}: counts cpu ${Array.from(cpu.count)} gpu ${Array.from(got.count)}`,
			);
		if (c.maxAbs > TOLERANCE || c.nan) fail(`${w}x${h}: max abs ${c.maxAbs}`);
	}
}
console.log(
	failed ? `\nFAIL color-stats-dawn: ${failed}` : "\nPASS color-stats-dawn",
);
process.exit(failed ? 1 : 0);

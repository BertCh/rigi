// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Roll coverage (src/lib/roll/coverage) on a real luma WebGPU device in node (Dawn): the GPU heat grid
// (sample kernel + luma GPUGridAggregation) against its CPU twin on synthetic rolls of 1, 7, 60 and 500
// photos (max |cell delta|, relative to the total mass; float atomics have no defined order), and the
// GPUBVH + GPUBVHQuery point query against brute force on 2000 random points (identical photo sets after
// the exact wedge test).
//
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/roll-coverage-dawn.ts
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import {
	type CoveragePhoto,
	frameAround,
	wedgesOf,
} from "../../src/lib/roll/coverage/frame";
import {
	coverageGridCpu,
	coverageGridGpu,
} from "../../src/lib/roll/coverage/grid";
import { createWedgeIndex, whoSeesCpu } from "../../src/lib/roll/coverage/who";
import { seededRandom } from "../../src/test/helpers";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP roll-coverage-dawn: DAWN_DIR not set");
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
	console.log("SKIP roll-coverage-dawn: no adapter");
	process.exit(0);
}
console.log(`adapter ${JSON.stringify(adapter.info ?? {})}`);
const handle = await adapter.requestDevice({
	requiredLimits: {
		maxStorageBufferBindingSize: Math.min(
			adapter.limits.maxStorageBufferBindingSize,
			1 << 28,
		),
		maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 28),
	},
});
const device = (await attachWebGPUDevice(
	handle,
	{ id: "roll-coverage-dawn" },
	true,
)) as Device;

let failed = 0;
const fail = (message: string) => {
	failed++;
	console.log(`FAIL ${message}`);
};

/** A synthetic roll: n photos scattered over a few km, random headings, 3 in 10 uncertain. */
function syntheticRoll(count: number, seed: number): CoveragePhoto[] {
	const random = seededRandom(seed);
	const photos: CoveragePhoto[] = [];
	for (let i = 0; i < count; i++) {
		photos.push({
			lat: 46.6 + (random() - 0.5) * 0.04,
			lon: 7.8 + (random() - 0.5) * 0.06,
			yawDeg: random() * 360,
			hfovDeg: 40 + random() * 50,
			uncertain: random() < 0.3,
		});
	}
	return photos;
}

for (const count of [1, 7, 60, 500]) {
	const photos = syntheticRoll(count, 100 + count);
	const cpu = coverageGridCpu(photos);
	const t0 = performance.now();
	const gpuGrid = await coverageGridGpu(device, photos);
	const ms = performance.now() - t0;
	let maxAbs = 0;
	for (let i = 0; i < cpu.data.length; i++)
		maxAbs = Math.max(maxAbs, Math.abs(cpu.data[i] - gpuGrid.data[i]));
	const rel = maxAbs / Math.max(1e-9, cpu.total);
	const massRel =
		Math.abs(cpu.total - gpuGrid.total) / Math.max(1e-9, cpu.total);
	console.log(
		`coverage ${String(count).padStart(3)} photos: total cpu ${cpu.total.toFixed(2)} gpu ${gpuGrid.total.toFixed(2)} (rel ${massRel.toExponential(1)}), max cell cpu ${cpu.max.toFixed(3)} gpu ${gpuGrid.max.toFixed(3)}, max |d| ${maxAbs.toExponential(2)} (rel to total ${rel.toExponential(2)}), ${ms.toFixed(0)} ms`,
	);
	if (rel > 1e-4)
		fail(`coverage ${count}: max |d| / total ${rel.toExponential(2)} > 1e-4`);
	if (massRel > 1e-4)
		fail(`coverage ${count}: total mass rel delta ${massRel.toExponential(2)}`);
}

for (const count of [1, 7, 60, 500]) {
	const photos = syntheticRoll(count, 200 + count);
	const frame = frameAround(photos);
	const wedges = wedgesOf(photos, frame);
	const index = await createWedgeIndex(wedges, frame, device);
	const random = seededRandom(7 + count);
	let mismatches = 0;
	let hitsTotal = 0;
	let candidatesTotal = 0;
	let overflow = 0;
	const points = 2000;
	for (let k = 0; k < points; k++) {
		const point = { x: (random() - 0.5) * 9000, y: (random() - 0.5) * 9000 };
		const got = await index.query(point);
		const want = whoSeesCpu(wedges, point);
		hitsTotal += want.indices.length;
		candidatesTotal += got.candidates;
		if (got.overflow) overflow++;
		if (got.indices.join() !== want.indices.join()) mismatches++;
	}
	index.destroy();
	console.log(
		`who-sees ${String(count).padStart(3)} photos: ${points} points, ${hitsTotal} hits (mean ${(hitsTotal / points).toFixed(2)}), mean BVH candidates ${(candidatesTotal / points).toFixed(2)}, mismatches ${mismatches}, overflow ${overflow}`,
	);
	if (mismatches)
		fail(`who-sees ${count}: ${mismatches} points differ from brute force`);
	if (overflow) fail(`who-sees ${count}: ${overflow} overflows`);
}

console.log(
	failed ? `FAIL roll-coverage-dawn: ${failed}` : "PASS roll-coverage-dawn",
);
device.destroy();
process.exit(failed ? 1 : 0);

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU photo prep's edge graph (src/lib/gpu/photoprep/index.ts runEdgeGpu, the app's own
// ComputeGraph) on a real luma WebGPU device in node (Dawn): synthetic photos at 512x384, 1024x768 and
// 2048x1536 go through the graph, the four planes it keeps resident (coarse, fine, sky, skyCum) are read
// back and compared with emulate.ts (the JS twin of every kernel; the radix-select and colour
// histograms are integer counts, so the planes must still be Object.is-equal, not just close; the
// 2048x1536 emulation takes too long, so that size only reports timings and compares two GPU runs).
// Prints the median wall time of one graph run (inputs resident, several runs, same device).
// The radix select's histograms are luma GPUHistogram (pass 0 straight over the edge bits, passes 1 / 2
// over a key kernel's digit-or-reject column) and the sky colour counts a GPUGroupAggregation count.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/photoprep-hist-dawn.ts [reps]
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any plane mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Buffer, Device } from "@luma.gl/core";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/device";
import { emulateEdge } from "../../src/lib/gpu/photoprep/emulate";
import { allocPlanes, runEdgeGpu } from "../../src/lib/gpu/photoprep/index";
import { bandLimits, photoPrepDims } from "../../src/lib/gpu/photoprep/plan";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP photoprep-hist-dawn: DAWN_DIR not set");
	process.exit(0);
}
const REPS = Number(process.argv[2] ?? 9);
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
	console.log("SKIP photoprep-hist-dawn: no adapter");
	process.exit(0);
}
const device = (await attachWebGPUDevice(
	await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
	}),
	{ id: "photoprep-hist-dawn" },
	true,
)) as Device;
console.log(`adapter ${JSON.stringify(adapter.info ?? {})}`);

let failed = 0;
const fail = (message: string) => {
	failed++;
	console.log(`FAIL ${message}`);
};

/** A photo-like scene: sky gradient over a noisy ridge line, textured terrain, a person-sized mask. */
function makeScene(w: number, h: number) {
	let s = w * 7919 + h;
	const random = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
	const rgb = new Uint8ClampedArray(w * h * 4);
	const fg = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const ridge =
				h * (0.3 + 0.08 * Math.sin(x * 0.02) + 0.04 * Math.sin(x * 0.11));
			const i = (y * w + x) * 4;
			if (y < ridge) {
				rgb[i] = 90 + 60 * (y / h) + 3 * random();
				rgb[i + 1] = 140 + 50 * (y / h) + 3 * random();
				rgb[i + 2] = 230 - 40 * (y / h) + 3 * random();
			} else {
				const t = 40 + 80 * Math.sin(x * 0.05) * Math.cos(y * 0.07) ** 2;
				rgb[i] = t + 60 * random();
				rgb[i + 1] = t + 40 + 40 * random();
				rgb[i + 2] = t / 2 + 30 * random();
			}
			rgb[i + 3] = 255;
			fg[y * w + x] = x > w * 0.45 && x < w * 0.5 && y > h * 0.6 ? 1 : 0;
		}
	}
	return { rgb, fg };
}

const median = (xs: number[]) => [...xs].sort((p, q) => p - q)[xs.length >> 1];
const words = (d: Uint8ClampedArray) =>
	new Uint32Array(d.buffer, d.byteOffset, d.byteLength / 4);
const bits = (f: Float32Array) =>
	new Uint32Array(f.buffer, f.byteOffset, f.length);

async function readPlane(buffer: Buffer, n: number) {
	const bytes = (await buffer.readAsync(0, n * 4)).slice();
	return new Uint32Array(bytes.buffer, 0, n);
}

const sizes: [number, number][] = [
	[512, 384],
	[1024, 768],
	[2048, 1536],
];
for (const [w, h] of sizes) {
	const { rgb, fg } = makeScene(w, h);
	const planes = allocPlanes(device, w, h, fg);
	await runEdgeGpu(device, rgb, w, h, fg, planes);
	const read = async () => ({
		coarse: await readPlane(planes.coarse, w * h),
		fine: await readPlane(planes.fine, w * h),
		sky: await readPlane(planes.sky, w * h),
		skyCum: await readPlane(planes.skyCum, w * (h + 1)),
	});
	const first = await read();
	const times: number[] = [];
	for (let i = 0; i < REPS; i++) {
		const t0 = performance.now();
		await runEdgeGpu(device, rgb, w, h, fg, planes);
		times.push(performance.now() - t0);
	}
	const again = await read();
	// the emulation (soft-float JS) is too slow at the largest size: that one compares two GPU runs
	const emulated = w * h <= 1024 * 768;
	const reference = emulated ? "emulate.ts" : "again";
	const ref: Record<string, Uint32Array> = emulated
		? emulateEdge(photoPrepDims(w, h), words(rgb), bits(fg), bandLimits(w, h))
		: again;
	let mismatches = 0;
	for (const k of ["coarse", "fine", "sky", "skyCum"] as const)
		for (const got of [first[k], again[k]]) {
			const want = ref[k];
			for (let i = 0; i < want.length; i++)
				if (got[i] !== want[i]) {
					mismatches++;
					fail(`${w}x${h} ${k}[${i}]: ${got[i]} vs ${reference} ${want[i]}`);
					break;
				}
		}
	console.log(
		`${w}x${h}: median ${median(times).toFixed(2)} ms/run; planes vs ${reference}: ${mismatches ? `${mismatches} MISMATCH` : "identical"}`,
	);
	for (const b of Object.values(planes)) b.destroy();
}
console.log(
	failed
		? `\nFAIL photoprep-hist-dawn: ${failed}`
		: "\nPASS photoprep-hist-dawn",
);
process.exit(failed ? 1 : 0);

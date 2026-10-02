// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Single luma GPUFFT1D transforms at every power of two 2^1..2^13 and 2^16 (forward and inverse, batched)
// against the f64 FFT of fft.ts, on a real luma WebGPU device in node (Dawn). This is the proof that the
// rigi.5 Apple Metal bit-reversal miscompile is gone (rigi.6 loop-free bit reversal) and that lengths
// above 2048 work, which is what lets fft-gpu.ts run one 8192-point transform per signal.
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/fft1d-lengths-dawn.ts
// Prints the max error relative to the max magnitude per length and direction; exit 1 above 5e-5 or on NaN.
// SKIP (exit 0) without DAWN_DIR.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { ComputeGraph } from "../../src/lib/gpu/core/graph";
import { GPUFFT1D } from "../../src/lib/gpu/core/luma";
import { adoptRenderDevice } from "../../src/lib/gpu/device";
import { fft, ifft } from "../../src/lib/refine/fft";

const ID = "fft1d-lengths-dawn";
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
const { luma } = await import("@luma.gl/core");
const { webgpuAdapter } = await import("@luma.gl/webgpu");
const device = (await luma.createDevice({
	type: "webgpu",
	adapters: [webgpuAdapter],
	createCanvasContext: false,
} as never)) as Device;
adoptRenderDevice(device);
void gpu;

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return (s / 2 ** 32) * 2 - 1;
	};
}

const LENGTHS = [...Array.from({ length: 13 }, (_, i) => 2 ** (i + 1)), 65536];
const TOL = 5e-5;
let failed = 0;

async function transform(
	n: number,
	batch: number,
	direction: "forward" | "inverse",
	data: Float32Array,
) {
	const total = n * batch;
	const g = new ComputeGraph(device, `${ID}-${direction}-${n}`);
	const src = g.importBuffer("x", total * 8);
	const dst = g.transientBuffer("y", total * 8);
	g.add(
		new GPUFFT1D({
			id: "fft",
			input: g.graph.createDataView(src, {
				format: "float32x2",
				length: total,
			}),
			output: g.graph.createDataView(dst, {
				format: "float32x2",
				length: total,
			}),
			length: n,
			batchCount: batch,
			direction,
		}),
	);
	g.readNode("out", [dst]);
	g.compile();
	const x = device.createBuffer({
		usage: 0x80 | 0x08 | 0x04, // STORAGE | COPY_DST | COPY_SRC
		byteLength: data.byteLength,
	});
	x.write(data);
	const { reads } = await g.run(undefined, { buffers: { x } });
	return new Float32Array(reads.out[0]);
}

for (const n of LENGTHS) {
	const batch = n >= 16384 ? 2 : 4;
	const r = rng(n);
	const data = Float32Array.from({ length: 2 * n * batch }, r);
	const out: Record<string, number> = {};
	for (const direction of ["forward", "inverse"] as const) {
		const got = await transform(n, batch, direction, data);
		let err = 0;
		let max = 0;
		let nan = 0;
		for (let b = 0; b < batch; b++) {
			const re = new Float64Array(n);
			const im = new Float64Array(n);
			for (let k = 0; k < n; k++) {
				re[k] = data[2 * (b * n + k)];
				im[k] = data[2 * (b * n + k) + 1];
			}
			if (direction === "forward") fft(re, im);
			else ifft(re, im);
			for (let k = 0; k < n; k++) {
				const o = 2 * (b * n + k);
				if (!Number.isFinite(got[o]) || !Number.isFinite(got[o + 1])) nan++;
				err = Math.max(
					err,
					Math.abs(got[o] - re[k]),
					Math.abs(got[o + 1] - im[k]),
				);
				max = Math.max(max, Math.abs(re[k]), Math.abs(im[k]));
			}
		}
		out[direction] = err / max;
		if (!(err / max <= TOL) || nan) {
			failed++;
			console.log(`FAIL N=${n} ${direction} rel err ${err / max} NaN ${nan}`);
		}
	}
	console.log(
		`N=2^${Math.log2(n)} (${n}) batch ${batch}: forward max rel err ${out.forward.toExponential(2)}, inverse ${out.inverse.toExponential(2)}`,
	);
}
console.log(failed ? `FAIL ${ID}: ${failed}` : `PASS ${ID}`);
process.exit(failed ? 1 : 0);

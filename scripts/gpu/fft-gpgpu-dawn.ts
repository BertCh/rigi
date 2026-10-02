// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// LF5 probe: luma gpgpu GPUFFT1D against refine/fft.ts (the f64 CPU FFT behind the refine/init.ts yaw
// correlation), on Dawn in node (DAWN_DIR as in splat-sort-gpgpu-dawn.ts):
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/fft-gpgpu-dawn.ts
// Prints (1) which lengths GPUFFT1D supports (the app's grid is 8192; luma's cap is 2048), (2) luma's
// own impulse-oracle benchmark (a correctness gate), (3) CPU f64 ms at 2048 and 8192, and (4) the GPU
// wall ms (run + readback) of a 7-transform batch at 2048 and the argmax agreement of the circular
// correlation when both spectra are rounded to f32 (a CPU simulation of the f32 precision, not GPU output).
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import {
	getGPUFFT1DSupport,
	runGPUFFT1DBenchmark,
} from "@luma.gl/gpgpu/gpu-core";
import { ComputeGraph } from "../../src/lib/gpu/core/graph";
import { attachWebGPUDevice, GPUFFT1D } from "../../src/lib/gpu/core/luma";
import { correlateSpectra, rfft } from "../../src/lib/refine/fft";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.error("set DAWN_DIR to a directory with `npm i webgpu@0.3.0`");
	process.exit(2);
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
if (!adapter) process.exit(2);
const handle: GPUDevice = await adapter.requestDevice({
	requiredFeatures: ["subgroups"].filter((f) => adapter.features.has(f)),
});
const device: Device = await attachWebGPUDevice(handle, { id: "fft" }, true);
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const sig = (n: number) => {
	const x = new Float64Array(n);
	let v = 0;
	for (let i = 0; i < n; i++) x[i] = v += Math.random() - 0.5;
	return x;
};

for (const length of [2048, 4096, 8192]) {
	const s = getGPUFFT1DSupport(device, { length, batchCount: 7 });
	console.log(`length ${length}: supported=${s.supported} ${s.reason ?? ""}`);
}
try {
	await runGPUFFT1DBenchmark(device, { length: 2048, batchCount: 7 });
	console.log("luma impulse oracle: passed");
} catch (e) {
	console.log(
		"luma impulse oracle: FAILED on this Dawn:",
		String(e).slice(0, 120),
	);
}

for (const n of [2048, 8192]) {
	const x = sig(n);
	const t: number[] = [];
	for (let r = 0; r < 41; r++) {
		const t0 = performance.now();
		for (let k = 0; k < 7; k++) rfft(x);
		t.push(performance.now() - t0);
	}
	console.log(`CPU f64 7 x rfft(${n}): median ${med(t).toFixed(3)} ms`);
}

const N = 2048;
const B = 7;
const inp = new Float32Array(B * N * 2);
for (let b = 0; b < B; b++)
	sig(N).forEach((v, i) => {
		inp[(b * N + i) * 2] = v;
	});
const g = new ComputeGraph(device, "fft-probe");
const hi = g.importBuffer("in", inp.byteLength);
const ho = g.importBuffer("out", inp.byteLength);
g.add(
	new GPUFFT1D({
		input: g.graph.createDataView(hi, {
			format: "float32x2",
			length: B * N,
			byteOffset: 0,
		}),
		output: g.graph.createDataView(ho, {
			format: "float32x2",
			length: B * N,
			byteOffset: 0,
		}),
		length: N,
		batchCount: B,
		direction: "forward",
	}),
);
g.compile();
const bIn = device.createBuffer({
	byteLength: inp.byteLength,
	usage: 0x80 | 0x08 | 0x04,
	data: inp,
});
const bOut = device.createBuffer({
	byteLength: inp.byteLength,
	usage: 0x80 | 0x08 | 0x04,
});
const ms: number[] = [];
for (let r = 0; r < 41; r++) {
	const t0 = performance.now();
	await g.run(undefined as never, { buffers: { in: bIn, out: bOut } });
	await bOut.readAsync();
	ms.push(performance.now() - t0);
}
console.log(
	`GPUFFT1D ${B} x ${N} run + readback: median ${med(ms).toFixed(3)} ms`,
);

const round = (F: { re: Float64Array; im: Float64Array }) => ({
	re: Float64Array.from(F.re, Math.fround),
	im: Float64Array.from(F.im, Math.fround),
});
const argmax = (c: Float64Array) =>
	c.reduce((m, v, i, a) => (v > a[m] ? i : m), 0);
let agree = 0;
const TRIALS = 200;
for (let k = 0; k < TRIALS; k++) {
	const a = sig(N);
	const b = Float64Array.from(
		a,
		(_, i) => a[(i + 37) % N] + 0.3 * (Math.random() - 0.5),
	);
	const A = rfft(a);
	const Bf = rfft(b);
	if (
		argmax(correlateSpectra(A, Bf)) ===
		argmax(correlateSpectra(round(A), round(Bf)))
	)
		agree++;
}
console.log(
	`f32-rounded spectra: correlation argmax agrees ${agree}/${TRIALS} (CPU simulation)`,
);
process.exit(0);

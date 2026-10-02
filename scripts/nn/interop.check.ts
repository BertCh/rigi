// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// nn on a SHARED ComputeGraph (Dawn, node): a Rigi kernel writes a ramp, luma gpu-raster
// GPURasterGradientMagnitude (Sobel) turns it into an edge plane, an nn forward (conv2d + relu,
// `forwardInto`) consumes that plane as a GraphDataView with no copy, luma gpgpu GPUReduction sums the
// nn output, and everything is read back from the one submission. Compared with the CPU nn reference
// run on the read-back Sobel plane. SKIP without DAWN_DIR.
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nn/interop.check.ts
import { Buffer as LumaBuffer } from "@luma.gl/core";
import { ComputeGraph, viewRange } from "../../src/lib/gpu/core/graph";
import { defineKernel } from "../../src/lib/gpu/core/kernel";
import {
	GPURasterGradientMagnitude,
	GPUReduction,
} from "../../src/lib/gpu/core/luma";
import { CpuNn } from "../../src/lib/nn/cpu";
import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import { dawnDevice } from "./dawn";

const ID = "nn-interop";
const device = await dawnDevice(ID);
if (!device) {
	console.log(`SKIP ${ID}: DAWN_DIR not set or no adapter`);
	process.exit(0);
}
const W = 48;
const H = 32;
const N = W * H;
const CO = 4;
const RAMP = defineKernel(
	"nn-interop-ramp",
	`
@group(0) @binding(0) var<storage, read_write> ramp: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= ${N}u) { return; }
  let x = f32(i % ${W}u);
  let y = f32(i / ${W}u);
  ramp[i] = sin(x * 0.4) * 2.0 + cos(y * 0.3) + x * 0.1;
}`,
	{ group: "nn-interop" },
);
const STORAGE = LumaBuffer.STORAGE | LumaBuffer.COPY_SRC | LumaBuffer.COPY_DST;
const mkBuffer = (bytes: number) =>
	device.createBuffer({ usage: STORAGE, byteLength: bytes });

const nn = new GpuNn(device);
const weightData = Float32Array.from(
	{ length: CO * 9 },
	(_, i) => Math.sin(i * 1.7) * 0.4,
);
const w = nn.fromArray(weightData, [CO, 1, 3, 3]);

const g = new ComputeGraph(device, ID);
const ramp = g.transientView("ramp", "float32", N);
const edgeBuffer = mkBuffer(N * 4);
const edge = g.importView("edge", edgeBuffer, "float32", N);
const valid = g.transientView("valid", "uint32", N);
g.addKernel({
	id: "ramp",
	spec: RAMP,
	bindings: { ramp },
	workgroups: [Math.ceil(N / 64)],
});
g.add(
	new GPURasterGradientMagnitude({
		id: "sobel",
		width: W,
		height: H,
		input: {
			id: "ramp",
			format: "float32",
			storage: { kind: "buffer", values: ramp },
		},
		output: edge,
		outputValidity: valid,
		operator: "sobel",
		scale: 0.25,
	}),
);
const conv = nn.forwardInto(g, () => {
	const x = nn.fromView(g, edge, [1, 1, H, W]);
	return nn.relu(nn.conv2d(x, w, null, { padding: 1 }));
});
const convView = nn.toView(g, conv);
const sumBuffer = mkBuffer(16);
const sum = g.importView("sum", sumBuffer, "float32", 1);
g.add(
	new GPUReduction({
		id: "tally",
		operation: "sum",
		input: convView,
		output: sum,
	}),
);
g.compile();
const r = await g.run(undefined, {
	read: [
		viewRange(edge, edgeBuffer),
		viewRange(convView, nn.bufferOf(conv)),
		viewRange(sum, sumBuffer),
	],
});
const edgePlane = new Float32Array(r.data[0]).slice(0, N);
const gotConv = new Float32Array(r.data[1]).slice(0, CO * N);
const gotSum = new Float32Array(r.data[2])[0];

const cpu = new CpuNn();
const cpuConv = await cpu.read(
	cpu.relu(
		cpu.conv2d(
			cpu.fromArray(edgePlane, [1, 1, H, W]),
			cpu.fromArray(weightData, [CO, 1, 3, 3]),
			null,
			{ padding: 1 },
		),
	),
);
let maxErr = 0;
let maxAbs = 0;
let expectedSum = 0;
for (let i = 0; i < CO * N; i++) {
	maxErr = Math.max(maxErr, Math.abs(gotConv[i] - cpuConv[i]));
	maxAbs = Math.max(maxAbs, Math.abs(cpuConv[i]));
	expectedSum += cpuConv[i];
}
let edgeMax = 0;
for (const v of edgePlane) edgeMax = Math.max(edgeMax, v);
const sumErr = Math.abs(gotSum - expectedSum) / Math.max(1, expectedSum);
console.log(
	`${ID}: edge max ${edgeMax.toFixed(3)}, conv max abs err ${maxErr.toExponential(2)} (max |y| ${maxAbs.toFixed(3)}), sum ${gotSum.toFixed(3)} vs ${expectedSum.toFixed(3)} (rel ${sumErr.toExponential(2)})`,
);
let failed = 0;
if (!(edgeMax > 0.1)) {
	failed++;
	console.log("FAIL sobel plane is empty");
}
if (maxErr > 1e-4 * Math.max(1, maxAbs)) {
	failed++;
	console.log("FAIL conv parity");
}
if (sumErr > 1e-4) {
	failed++;
	console.log("FAIL reduction of the nn output");
}
// the tensor is an ordinary nn tensor afterwards: dispose frees its buffer
nn.dispose(conv);
console.log(failed ? `FAIL ${ID}` : `PASS ${ID}`);
process.exit(failed ? 1 : 0);

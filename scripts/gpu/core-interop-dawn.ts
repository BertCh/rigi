// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The luma-contributor interop of core/graph.ts on a real luma WebGPU device in node (Dawn):
//   Rigi defineKernel (layout derived from the WGSL)
//     -> luma gpgpu GPUElementwise multiply-add (inputs: a Rigi pooled buffer imported as a GraphDataView)
//     -> luma gpu-raster GPURasterThreshold (an addToGraph op) -> luma GPUReduction (sum of the mask)
//     -> readback of the Rigi-owned output buffers,
// all in ONE ComputeGraph with no glue buffers, compared exactly with a CPU reference. A second graph
// adds the same Rigi kernel as a KernelOp contributor (g.add), and a plain luma GPUCommandGraph runs a
// KernelOp next to a luma op to show that a Rigi kernel composes without ComputeGraph.
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/core-interop-dawn.ts
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Device, Buffer as LumaBuffer } from "@luma.gl/core";
import {
	ComputeGraph,
	KernelOp,
	viewRange,
} from "../../src/lib/gpu/core/graph";
import { defineKernel } from "../../src/lib/gpu/core/kernel";
import {
	GPUElementwise,
	GPURasterThreshold,
	GPUReduction,
} from "../../src/lib/gpu/core/luma";
import { pooledStorage } from "../../src/lib/gpu/core/pool";
import { submit } from "../../src/lib/gpu/core/queue";
import { adoptRenderDevice, COMPUTE_FEATURES } from "../../src/lib/gpu/device";

const ID = "core-interop-dawn";
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
const { attachWebGPUDevice } = await import("../../src/lib/gpu/core/luma");
const device = (await attachWebGPUDevice(
	await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
	}),
	{ id: ID },
	true,
)) as Device;
adoptRenderDevice(device);

let failed = 0;
const fail = (message: string) => {
	failed++;
	console.log(`FAIL ${message}`);
};

const W = 40;
const H = 16;
const N = W * H;
const SCALE = 2;
const BIAS = 1;
const LEVEL = 40;

// generated WGSL with the geometry baked in (luma gpu-core style); the layout is DERIVED
const RAMP = defineKernel(
	"interop-ramp",
	`
@group(0) @binding(0) var<storage, read_write> ramp: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= ${N}u) { return; }
  ramp[i] = f32(i % ${W}u) * 0.5 + f32(i / ${W}u);
}`,
	{ group: "interop" },
);

const ramp = (i: number) => (i % W) * 0.5 + Math.floor(i / W);
const expectedValue = (i: number) => ramp(i) * SCALE + BIAS;
const expectedMask = Array.from({ length: N }, (_, i) =>
	expectedValue(i) >= LEVEL ? 1 : 0,
);
const expectedCount = expectedMask.reduce<number>((a, b) => a + b, 0);

// Rigi-owned buffers: pooled constants in, plain storage out
const constantsB = new Float32Array(N).fill(SCALE);
const constantsC = new Float32Array(N).fill(BIAS);
const bufferB = pooledStorage(device, "interop/b", constantsB);
const bufferC = pooledStorage(device, "interop/c", constantsC);
const bytes = (n: number) => n * 4;
const mkOut = () =>
	device.createBuffer({
		usage: LumaBuffer.STORAGE | LumaBuffer.COPY_SRC | LumaBuffer.COPY_DST,
		byteLength: bytes(N),
	});

type Variant = "addKernel" | "KernelOp";
async function run(variant: Variant) {
	const g = new ComputeGraph(device, `${ID}-${variant}`);
	const b = g.importView("b", bufferB, "float32", N);
	const c = g.importView("c", bufferC, "float32", N);
	const rampView = g.transientView("ramp", "float32", N);
	const value = g.transientView("value", "float32", N);
	const maskBuffer = mkOut();
	const countBuffer = device.createBuffer({
		usage: LumaBuffer.STORAGE | LumaBuffer.COPY_SRC | LumaBuffer.COPY_DST,
		byteLength: 16,
	});
	const mask = g.importView("mask", maskBuffer, "uint32", N);
	const count = g.importView("count", countBuffer, "uint32", 1);

	const node = {
		id: "ramp",
		spec: RAMP,
		bindings: { ramp: rampView },
		workgroups: [Math.ceil(N / 64)] as [number],
	};
	if (variant === "addKernel") g.addKernel(node);
	else g.add(new KernelOp(node));
	g.add(
		new GPUElementwise({
			id: "affine",
			operation: "multiply-add",
			input: rampView,
			inputB: b,
			inputC: c,
			output: value,
		}),
	);
	// gpu-raster ops add their nodes themselves: g.add routes them through the audited mutators
	g.add(
		new GPURasterThreshold({
			id: "level",
			width: W,
			height: H,
			input: {
				id: "value",
				format: "float32",
				storage: { kind: "buffer", values: value },
			},
			output: mask,
			threshold: LEVEL,
			operation: "above",
		}),
	);
	g.add(
		new GPUReduction({
			id: "tally",
			operation: "sum",
			input: mask,
			output: count,
		}),
	);
	g.compile();
	const r = await g.run(undefined, {
		read: [viewRange(mask, maskBuffer), viewRange(count, countBuffer)],
	});
	const gotMask = new Uint32Array(r.data[0]);
	const gotCount = new Uint32Array(r.data[1])[0];
	const nodes = g.stats?.nodeCount ?? 0;
	let mismatches = 0;
	for (let i = 0; i < N; i++) if (gotMask[i] !== expectedMask[i]) mismatches++;
	if (mismatches) fail(`${variant}: ${mismatches}/${N} mask mismatches`);
	if (gotCount !== expectedCount)
		fail(`${variant}: count ${gotCount}, expected ${expectedCount}`);
	console.log(
		`${variant}: ${nodes} nodes, mask mismatches ${mismatches}, count ${gotCount}/${expectedCount}`,
	);
	maskBuffer.destroy();
	countBuffer.destroy();
}
await run("addKernel");
await run("KernelOp");

// a Rigi kernel in a PLAIN luma graph (no ComputeGraph), next to a luma op
{
	const { GPUCommandGraph } = await import("../../src/lib/gpu/core/luma");
	const g = new GPUCommandGraph<void>(device, { id: `${ID}-plain` });
	const rampBuffer = g.createTransientBuffer({
		id: "ramp",
		byteLength: bytes(N),
		usage: LumaBuffer.STORAGE | LumaBuffer.COPY_SRC | LumaBuffer.COPY_DST,
	});
	const rampView = g.createDataView(rampBuffer, {
		format: "float32",
		length: N,
	});
	const outBuffer = mkOut();
	const sumBuffer = device.createBuffer({
		usage: LumaBuffer.STORAGE | LumaBuffer.COPY_SRC,
		byteLength: 16,
	});
	const out = g.createDataView(
		g.importBuffer(
			{ id: "sum", byteLength: 16, usage: sumBuffer.usage },
			sumBuffer,
		),
		{ format: "float32", length: 1 },
	);
	void outBuffer;
	g.add(
		new KernelOp({
			id: "ramp",
			spec: RAMP,
			bindings: { ramp: rampView },
			workgroups: [Math.ceil(N / 64)],
		}),
	);
	g.add(
		new GPUReduction({
			id: "sum",
			operation: "sum",
			input: rampView,
			output: out,
		}),
	);
	const compiled = g.compile();
	const enc = device.createCommandEncoder();
	compiled.encode(enc, { parameters: undefined });
	const staged = device.createBuffer({
		usage: LumaBuffer.COPY_DST | LumaBuffer.MAP_READ,
		byteLength: 16,
	});
	enc.copyBufferToBuffer({
		sourceBuffer: sumBuffer,
		destinationBuffer: staged,
		size: 16,
	});
	submit(device, enc);
	const bytesRead = await staged.readAsync(0, 16);
	const got = new Float32Array(bytesRead.buffer, bytesRead.byteOffset, 1)[0];
	const want = Array.from({ length: N }, (_, i) => ramp(i)).reduce(
		(a, b) => a + b,
		0,
	);
	if (Math.abs(got - want) > 1e-3 * want)
		fail(`plain graph: sum ${got}, expected ${want}`);
	console.log(
		`plain luma graph: Rigi kernel + GPUReduction sum ${got} (expected ${want})`,
	);
	compiled.destroy();
	staged.destroy();
	outBuffer.destroy();
	sumBuffer.destroy();
}

void gpu;
console.log(failed ? `FAIL ${ID}: ${failed} failure(s)` : `PASS ${ID}`);
process.exit(failed ? 1 : 0);

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside depth → Gaussians lift (src/lib/nearfield/local/lift-gpu.ts, one kernel on a core
// ComputeGraph) on a real luma WebGPU device in node (Dawn), against its CPU twin
// (local/lift.ts liftGaussiansCpu, itself equal to the former service's splat.py lift_gaussians)
// on synthetic depth / normal / colour grids with flying edges, invalid pixels and missing normals.
// Same kept cells, colours exact, positions within 1e-5 of the depth, scales within 1e-4 of the largest axis, quaternions within
// 1e-5 (up to sign).
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/nearfield-lift-dawn.ts
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on a failed tolerance.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/device";
import {
	type LiftInput,
	liftGaussiansCpu,
} from "../../src/lib/nearfield/local/lift";
import { liftGaussiansGpu } from "../../src/lib/nearfield/local/lift-gpu";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP nearfield-lift-dawn: DAWN_DIR not set");
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
	console.log("SKIP nearfield-lift-dawn: no adapter");
	process.exit(0);
}
const device = (await attachWebGPUDevice(
	await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
	}),
	{ id: "nearfield-lift-dawn" },
	true,
)) as Device;

let failed = 0;
const fail = (m: string) => {
	failed++;
	console.log(`FAIL ${m}`);
};

function makeRandom(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

function scene(
	W: number,
	H: number,
	seed: number,
	withNormal: boolean,
): LiftInput {
	const r = makeRandom(seed);
	const n = W * H;
	const depth = new Float32Array(n);
	const valid = new Uint8Array(n);
	const normal = new Float32Array(3 * n);
	const rgba = new Uint8Array(4 * n);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const k = y * W + x;
			const inBox = x > W * 0.3 && x < W * 0.55 && y > H * 0.3 && y < H * 0.5;
			depth[k] = inBox ? 1.5 : 5 + 3 * Math.sin(x / 9) + y * 0.05;
			valid[k] = r() > 0.05 ? 1 : 0;
			const blank = y % 7 === 0;
			normal[3 * k] = blank ? 0 : r() * 2 - 1;
			normal[3 * k + 1] = blank ? 0 : r() * 2 - 1;
			normal[3 * k + 2] = blank ? 0 : r() * 2 - 1;
			for (let c = 0; c < 3; c++) rgba[4 * k + c] = Math.floor(r() * 256);
			rgba[4 * k + 3] = 255;
		}
	return {
		width: W,
		height: H,
		depth,
		valid,
		normal: withNormal ? normal : null,
		rgba,
		K: { fx: 0.9, fy: 1.2, cx: 0.48, cy: 0.53 },
	};
}

for (const [W, H, stride, withNormal] of [
	[130, 97, 2, true],
	[1024, 768, 2, true],
	[640, 480, 3, false],
] as const) {
	const inp = scene(W, H, W + H, withNormal);
	const cpu = liftGaussiansCpu(inp, { stride });
	const t0 = performance.now();
	const gpuCloud = await liftGaussiansGpu(device, inp, { stride });
	const ms = performance.now() - t0;
	const tag = `${W}x${H}/s${stride}${withNormal ? "" : "/no-normal"}`;
	if (gpuCloud.count !== cpu.count) {
		fail(`${tag}: count gpu ${gpuCloud.count} cpu ${cpu.count}`);
		continue;
	}
	let dp = 0;
	let ds = 0;
	let dq = 0;
	let dc = 0;
	for (let i = 0; i < cpu.count; i++) {
		// positions relative to the splat's depth, scales relative to its largest axis
		const z = cpu.positions[3 * i + 2];
		const sMax = Math.max(
			cpu.scales[3 * i],
			cpu.scales[3 * i + 1],
			cpu.scales[3 * i + 2],
		);
		for (let a = 0; a < 3; a++) {
			dp = Math.max(
				dp,
				Math.abs(gpuCloud.positions[3 * i + a] - cpu.positions[3 * i + a]) / z,
			);
			ds = Math.max(
				ds,
				Math.abs(gpuCloud.scales[3 * i + a] - cpu.scales[3 * i + a]) / sMax,
			);
		}
		let dot = 0;
		for (let a = 0; a < 4; a++)
			dot += gpuCloud.rotations[4 * i + a] * cpu.rotations[4 * i + a];
		dq = Math.max(dq, 1 - Math.abs(dot));
		for (let a = 0; a < 4; a++)
			dc = Math.max(
				dc,
				Math.abs(gpuCloud.colors[4 * i + a] - cpu.colors[4 * i + a]),
			);
	}
	console.log(
		`${tag}: ${cpu.count} splats, pos ${dp.toExponential(2)}, scale ${ds.toExponential(2)}, quat ${dq.toExponential(2)}, colour ${dc}, ${ms.toFixed(1)} ms`,
	);
	if (dp > 1e-5) fail(`${tag}: position ${dp}`);
	if (ds > 1e-4) fail(`${tag}: scale ${ds}`);
	if (dq > 1e-5) fail(`${tag}: quaternion ${dq}`);
	if (dc > 0) fail(`${tag}: colour ${dc}`);
}
console.log(failed ? `${failed} failed` : "ok");
process.exit(failed ? 1 : 0);

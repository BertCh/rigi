// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The haze prep's edge / people dilation on luma gpu-raster (src/lib/gpu/look/raster-dilate.ts,
// GPURasterDilation passes, radius chained past 8) vs the CPU dilate of look/haze-fit.ts, on a real
// luma WebGPU device in node (Dawn): random masks of several densities, grids that are not multiples
// of the 8x8 tile, radii 0..20. Binary data, so the expected difference is exactly 0 pixels.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/raster-dilate-dawn.ts
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Device, Buffer as LumaBuffer } from "@luma.gl/core";
import { ComputeGraph } from "../../src/lib/gpu/core/graph";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/device";
import { addSquareDilation } from "../../src/lib/gpu/look/raster-dilate";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP raster-dilate-dawn: DAWN_DIR not set");
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
	console.log("SKIP raster-dilate-dawn: no adapter");
	process.exit(0);
}
const device = (await attachWebGPUDevice(
	await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
	}),
	{ id: "raster-dilate-dawn" },
	true,
)) as Device;
console.log(`adapter ${JSON.stringify(adapter.info ?? {})}`);

/** look/haze-fit.ts dilate (same code): (2r+1)² square, separable, window clipped to the grid. */
function dilateCpu(m: Uint8Array, W: number, H: number, r: number) {
	const tmp = new Uint8Array(m.length);
	const out = new Uint8Array(m.length);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			let v = 0;
			for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r) && !v; k++)
				v = m[y * W + k];
			tmp[y * W + x] = v;
		}
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			let v = 0;
			for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r) && !v; k++)
				v = tmp[k * W + x];
			out[y * W + x] = v;
		}
	return out;
}

let seed = 12345;
const rnd = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 2 ** 32;
};

let failed = 0;
let cases = 0;
let worst = 0;
const STORAGE = LumaBuffer.STORAGE | LumaBuffer.COPY_DST | LumaBuffer.COPY_SRC;
for (const [W, H] of [
	[37, 29],
	[64, 48],
	[101, 75],
	[256, 192],
]) {
	for (const density of [0.002, 0.03, 0.4]) {
		const m = new Uint8Array(W * H);
		for (let i = 0; i < m.length; i++) m[i] = rnd() < density ? 1 : 0;
		for (const r of [0, 1, 2, 3, 5, 8, 9, 16, 20]) {
			const g = new ComputeGraph<undefined>(
				device,
				`rd-${W}x${H}-${density}-${r}`,
			);
			const n = W * H;
			const input = g.importBuffer("in", n * 4, undefined, STORAGE);
			const output = g.transientBuffer("out", n * 4);
			const validity = g.transientBuffer("valid", n * 4);
			addSquareDilation(g, {
				id: "d",
				width: W,
				height: H,
				radius: r,
				input: { buffer: input },
				output: { buffer: output },
				validity,
			});
			g.readNode("read", [output]);
			const words = Uint32Array.from(m);
			const buf = device.createBuffer({ usage: STORAGE, data: words });
			const { reads } = await g.run(undefined, { buffers: { in: buf } });
			const got = Uint8Array.from(new Uint32Array(reads.read[0]));
			const want = dilateCpu(m, W, H, r);
			let diff = 0;
			for (let i = 0; i < n; i++) if (got[i] !== want[i]) diff++;
			cases++;
			worst = Math.max(worst, diff);
			if (diff) {
				failed++;
				console.log(
					`FAIL ${W}x${H} density ${density} r ${r}: ${diff} px differ`,
				);
			}
			buf.destroy();
			g.destroy();
		}
	}
}
console.log(
	`${failed ? "FAIL" : "ok  "} raster dilation = CPU dilate on ${cases} cases (worst ${worst} differing px)`,
);
process.exit(failed ? 1 : 0);

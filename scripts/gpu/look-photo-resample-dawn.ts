// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The look bridge's GPU photo resample (src/lib/gpu/look/photo-resample.ts) on a real luma WebGPU
// device in node (Dawn), against the CPU box filter over the same sRGB bytes (photo-resample-math.ts
// boxResampleRgba) at the bridge's real grids: the mask grid (MASK_LONG_SIDE long side, composite.ts
// gridSize) and 1024 / 2048 px long-side haze grids. The source is uploaded as an
// rgba8unorm-srgb texture (the engine's photo format), so the kernel decodes, re-encodes and
// averages exactly as in the app. Prints mean / p99 / max |delta| (0-255) per channel. This is the
// kernel versus a CPU box filter; drawImage's own filter is a browser matter (not measured here).
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn [SRC_WIDTH=10000] npx tsx scripts/gpu/look-photo-resample-dawn.ts [photo.jpg]
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 when max |delta| exceeds the tolerance.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Buffer, type Device, Texture } from "@luma.gl/core";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/device";
import {
	resamplePhotoInto,
	warmPhotoResample,
} from "../../src/lib/gpu/look/photo-resample";
import { boxResampleRgba } from "../../src/lib/gpu/look/photo-resample-math";
import { gridSize, MASK_LONG_SIDE } from "../../src/lib/look/composite";
import { loadRGBA } from "../lib/node-io";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP look-photo-resample-dawn: DAWN_DIR not set");
	process.exit(0);
}
// the kernel averages the same bytes with the same rounding; the only difference is the f32
// sRGB encode of a decoded texel (an off-by-one byte at a rounding boundary at worst)
const MAX_TOLERANCE = 1;
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
	console.log("SKIP look-photo-resample-dawn: no adapter");
	process.exit(0);
}
const device = (await attachWebGPUDevice(
	await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
	}),
	{ id: "look-photo-resample-dawn" },
	true,
)) as Device;
warmPhotoResample(device);

const file =
	process.argv[2] ??
	path.join(import.meta.dirname, "../../public/photos/IMG_3304.jpg");
// full resolution, or SRC_WIDTH px wide (an upscaled copy exercises the strided-tap path)
const photo = await loadRGBA(
	file,
	process.env.SRC_WIDTH ? Number(process.env.SRC_WIDTH) : undefined,
);
const sw = photo.width;
const sh = photo.height;
console.log(`photo ${path.basename(file)} ${sw}x${sh}`);

const source = device.createTexture({
	id: "photo",
	format: "rgba8unorm-srgb",
	width: sw,
	height: sh,
	usage: Texture.SAMPLE | Texture.COPY_DST,
});
source.writeData(photo.data as never, {
	width: sw,
	height: sh,
	bytesPerRow: sw * 4,
});

let failed = 0;
const aspect = sw / sh;
const cases: [string, number, number][] = [
	["mask grid", ...gridSize(aspect, MASK_LONG_SIDE)],
	["haze 1024", ...gridSize(aspect, 1024)],
	["haze 2048", ...gridSize(aspect, 2048)],
	["strided taps (256 grid)", ...gridSize(aspect, 256)],
	[
		"upscale x1.5",
		Math.min(4096, Math.round(sw * 1.5)),
		Math.round(Math.min(4096, sw * 1.5) / aspect),
	],
];
for (const [label, w, h] of cases) {
	const target = device.createTexture({
		id: `out-${w}x${h}`,
		format: "rgba8unorm",
		width: w,
		height: h,
		usage: Texture.SAMPLE | Texture.COPY_DST | Texture.COPY_SRC,
	});
	let ok = false;
	for (let tries = 0; tries < 200 && !ok; tries++) {
		ok = resamplePhotoInto(device, source, target); // false while the kernel compiles
		if (!ok) await new Promise((r) => setTimeout(r, 25));
	}
	if (!ok) {
		console.log(`FAIL ${label}: resamplePhotoInto never ran`);
		failed++;
		continue;
	}
	const rowBytes = Math.ceil((w * 4) / 256) * 256;
	const buffer = device.createBuffer({
		usage: Buffer.COPY_DST | Buffer.MAP_READ,
		byteLength: rowBytes * h,
	});
	target.readBuffer({}, buffer);
	const raw = new Uint8Array(await buffer.readAsync());
	buffer.destroy();
	const got = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++)
		got.set(raw.subarray(y * rowBytes, y * rowBytes + w * 4), y * w * 4);
	const want = boxResampleRgba(photo.data, sw, sh, w, h);
	const names = ["r", "g", "b", "a"];
	const stats = names.map((name, c) => {
		const hist = new Uint32Array(256);
		let sum = 0;
		let max = 0;
		for (let i = 0; i < w * h; i++) {
			const d = Math.abs(got[i * 4 + c] - want[i * 4 + c]);
			hist[d]++;
			sum += d;
			if (d > max) max = d;
		}
		let acc = 0;
		let p99 = 0;
		for (let d = 0; d < 256; d++) {
			acc += hist[d];
			if (acc >= 0.99 * w * h) {
				p99 = d;
				break;
			}
		}
		return `${name}: mean ${(sum / (w * h)).toFixed(4)} p99 ${p99} max ${max}`;
	});
	const maxAll = Math.max(
		...names.map((_, c) => {
			let m = 0;
			for (let i = 0; i < w * h; i++)
				m = Math.max(m, Math.abs(got[i * 4 + c] - want[i * 4 + c]));
			return m;
		}),
	);
	console.log(`${label} ${w}x${h} (|delta| of 0-255): ${stats.join(" | ")}`);
	if (maxAll > MAX_TOLERANCE) {
		console.log(`FAIL ${label}: max |delta| ${maxAll} > ${MAX_TOLERANCE}`);
		failed++;
	}
	target.destroy();
}
console.log(
	failed
		? `FAIL look-photo-resample-dawn: ${failed}`
		: "PASS look-photo-resample-dawn",
);
process.exit(failed ? 1 : 0);

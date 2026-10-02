// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// readClearRangeGrid (src/lib/gpu/roll/clear-range.ts) on a real luma WebGPU device in node (Dawn):
// synthetic rgba32float targets (the geometry target's format, .w = range) with sky 0, NaN, +-Infinity,
// negatives, -0 and denormals go through the decimation graph and the grid must equal the old CPU chain
// (unpackGeometryCpu, then drape-clear decimateRange) byte for byte. Also prints the bytes read back
// old (w*h*4, the unpacked range plane; 16 B/texel without the GPU unpack) vs new at roll sizes.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/roll-clear-range-dawn.ts
//
// SKIP (exit 0) without DAWN_DIR; exit 1 on any mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { unpackGeometryCpu } from "../../src/lib/deck-webgpu/geo-unpack";
import {
	decimateRange,
	decimationStep,
} from "../../src/lib/roll/map/drape-clear";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP roll-clear-range-dawn: DAWN_DIR not set");
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
const { luma, Texture } = await import("@luma.gl/core");
const { webgpuAdapter } = await import("@luma.gl/webgpu");
const device = (await luma.createDevice({
	type: "webgpu",
	adapters: [webgpuAdapter],
	createCanvasContext: false,
} as never)) as Device;
const { readClearRangeGrid } = await import(
	"../../src/lib/gpu/roll/clear-range"
);

let failures = 0;
const check = (name: string, ok: boolean, info = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? ` ${info}` : ""}`);
};
let seed = 20261002;
const rand = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
};
const SPECIAL = [
	0x00000000, 0x80000000, 0x7fc00000, 0xffc00000, 0x7f800001, 0x7f800000,
	0xff800000, 0xbf800000, 0x80000001, 0x00000001, 0x007fffff, 0x00800000,
	0x7f7fffff,
];
function randomTarget(w: number, h: number) {
	const t = new Uint32Array(w * h * 4);
	const f = new Float32Array(t.buffer);
	for (let i = 0; i < w * h; i++) {
		for (let c = 0; c < 3; c++) f[i * 4 + c] = (rand() - 0.5) * 4000;
		const r = rand();
		t[i * 4 + 3] =
			r < 0.3
				? 0
				: r < 0.45
					? SPECIAL[Math.floor(rand() * SPECIAL.length)]
					: new Uint32Array(new Float32Array([10 + rand() * 9000]).buffer)[0];
	}
	return t;
}
const bytesEqual = (a: Uint32Array, b: Uint32Array) =>
	a.length === b.length && a.every((v, i) => v === b[i]);

const SIZES: [number, number][] = [
	[1, 1],
	[7, 5],
	[64, 48],
	[257, 100],
	[300, 513],
	[1024, 768],
	[1920, 1080],
];
for (const [w, h] of SIZES) {
	const words = randomTarget(w, h);
	const tex = device.createTexture({
		width: w,
		height: h,
		format: "rgba32float",
		usage: Texture.SAMPLE | Texture.COPY_DST,
		sampler: { minFilter: "nearest", magFilter: "nearest" },
	});
	tex.writeData(new Float32Array(words.buffer), {
		x: 0,
		y: 0,
		width: w,
		height: h,
	});
	const range = new Float32Array(w * h);
	unpackGeometryCpu(new Float32Array(words.buffer), range);
	const step = decimationStep(w, h);
	const want = decimateRange(range, w, h);
	const got = await readClearRangeGrid(device, tex, step);
	const ok =
		!!got &&
		got.w === want.w &&
		got.h === want.h &&
		bytesEqual(
			new Uint32Array(got.data.buffer),
			new Uint32Array(want.data.buffer),
		);
	check(
		`grid == CPU decimation ${w}x${h} step ${step}`,
		ok,
		got
			? `${got.w}x${got.h}; readback ${got.bytes} B vs ${w * h * 4} B (measured)`
			: "null",
	);
	tex.destroy();
}
console.log(
	failures
		? `FAIL roll-clear-range-dawn (${failures})`
		: "PASS roll-clear-range-dawn",
);
process.exit(failures ? 1 : 0);

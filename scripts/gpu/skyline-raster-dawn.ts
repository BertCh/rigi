// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The skyline GPU gradient stage on luma gpu-raster (GPURasterGradientMagnitude, Sobel) against the
// hand-written central difference and the CPU detectSkyline, in node over Dawn. Synthetic ridge images and
// the tracked demo photos (public/demo/photos-1024, resized to 800 px wide). Reports the tex feature
// difference and the detected skyline row shift (px) of both GPU variants vs the CPU rows.
// Asserts: central variant rows within 0.05 px (unchanged), sobel rows: median shift <= 0.5 px and
// the sobel max shift, p99 and finiteness differences are reported, not asserted (opt-in: tails reach 34 px).
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/skyline-raster-dawn.ts
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any tolerance failure.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { detectSkyline, type RGBALike } from "../../src/lib/geo/skyline";
import { adoptRenderDevice } from "../../src/lib/gpu/device";
import { detectSkylineGpu } from "../../src/lib/gpu/skyline";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP skyline-raster-dawn: DAWN_DIR not set");
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
	console.log("SKIP skyline-raster-dawn: no adapter");
	process.exit(0);
}
const { luma } = await import("@luma.gl/core");
const { webgpuAdapter } = await import("@luma.gl/webgpu");
const device = (await luma.createDevice({
	type: "webgpu",
	adapters: [webgpuAdapter],
	createCanvasContext: false,
} as never)) as Device;
adoptRenderDevice(device);

const photos = process.env.SKYLINE_PHOTOS !== "0";
const { createCanvas, loadImage } = await import("@napi-rs/canvas");

function ridgeImage(w: number, h: number): RGBALike {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const ridge = h * 0.58 + 0.1 * h * Math.sin(x / 11) + (0.2 * x * h) / 120;
			const o = 4 * (y * w + x);
			const noise = ((x * 7 + y * 13) % 17) - 8;
			if (y < ridge) {
				data[o] = 110 + y * 0.4 + noise / 4;
				data[o + 1] = 160 + y * 0.3;
				data[o + 2] = 235;
			} else {
				data[o] = 60 + noise + 8;
				data[o + 1] = 70 + ((x * 5 + y * 3) % 11);
				data[o + 2] = 50;
			}
			data[o + 3] = 255;
		}
	return { width: w, height: h, data };
}

async function photo(name: string, width: number): Promise<RGBALike> {
	const img = await loadImage(`public/demo/photos-1024/${name}.jpg`);
	const height = Math.round((img.height * width) / img.width);
	const c = createCanvas(width, height);
	const ctx = c.getContext("2d");
	ctx.drawImage(img, 0, 0, width, height);
	const d = ctx.getImageData(0, 0, width, height);
	return { width, height, data: new Uint8ClampedArray(d.data) };
}

const cases: [string, RGBALike][] = [
	["ridge 160x120", ridgeImage(160, 120)],
	["ridge 97x61 odd", ridgeImage(97, 61)],
];
if (photos)
	for (let i = 1; i <= 12; i++) {
		const name = `demo-${String(i).padStart(2, "0")}`;
		cases.push([name, await photo(name, 800)]);
	}

let failed = 0;
const fail = (m: string) => {
	failed++;
	console.log(`FAIL ${m}`);
};
const stat = (cpu: ArrayLike<number>, gpu: ArrayLike<number>) => {
	const d: number[] = [];
	let mismatch = 0;
	for (let x = 0; x < cpu.length; x++) {
		const a = Number.isFinite(cpu[x]);
		const b = Number.isFinite(gpu[x]);
		if (a !== b) mismatch++;
		if (a && b) d.push(Math.abs(cpu[x] - gpu[x]));
	}
	d.sort((p, q) => p - q);
	const q = (f: number) =>
		d[Math.min(d.length - 1, Math.floor(d.length * f))] ?? 0;
	return { med: q(0.5), p99: q(0.99), max: d[d.length - 1] ?? 0, mismatch };
};
const f2 = (v: number) => v.toFixed(3);

let worstSobelMed = 0;
let worstSobelMax = 0;
for (const [label, img] of cases) {
	const cpu = detectSkyline(img);
	const central = await detectSkylineGpu(img, {}, "central");
	const t0 = performance.now();
	const sobel = await detectSkylineGpu(img, {}, "sobel");
	const ms = performance.now() - t0;
	if (!central || !sobel) throw new Error("no compute device");
	const c = stat(cpu.rows, central.rows);
	const s = stat(cpu.rows, sobel.rows);
	if (c.max > 0.05) fail(`${label}: central max |d row| ${c.max}`);
	if (s.med > 0.5) fail(`${label}: sobel median |d row| ${s.med}`);
	if (c.mismatch) fail(`${label}: central finiteness differs on ${c.mismatch}`);
	worstSobelMed = Math.max(worstSobelMed, s.med);
	worstSobelMax = Math.max(worstSobelMax, s.max);
	console.log(
		`${label.padEnd(16)} central max ${f2(c.max)} | sobel d row med ${f2(s.med)} p99 ${f2(s.p99)} max ${f2(s.max)} px, finite mismatch ${s.mismatch} | ${ms.toFixed(0)} ms`,
	);
}
console.log(
	`worst sobel: median ${f2(worstSobelMed)} px, max ${f2(worstSobelMax)} px`,
);
device.destroy();
if (failed) {
	console.log(`FAIL skyline-raster-dawn (${failed})`);
	process.exit(1);
}
console.log("PASS skyline-raster-dawn");
process.exit(0);

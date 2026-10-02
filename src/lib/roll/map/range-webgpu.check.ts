// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check of the WebGPU range hand-off (range-webgpu.ts) against the CPU path it replaces.
//   DAWN_DIR=/path/with/webgpu npx tsx src/lib/roll/map/range-webgpu.check.ts
// Part 1 (always): range-handoff-reference.ts equals the old CPU pipeline (unpackGeometryCpu, then
// rangeMapFrom's isFinite fix-up, then drape-atlas coarsen) on random targets with sky (0), NaN,
// +-Infinity, negatives, -0 and denormals, at sizes that are not multiples of COARSE.
// Part 2 (needs a Dawn WebGPU device; SKIP without DAWN_DIR, exit 0): RangeGpuWebGpu.copyInto into
// the cells of an r32float atlas created as DrapeAtlas creates `range`, and RangeGpuWebGpu.coarse,
// against the reference byte for byte: every cell of a 3 x 2 atlas (the neighbours and the sentinel
// background stay untouched, the 6 copies are issued back to back), and every coarse grid.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { unpackGeometryCpu } from "#/lib/deck-webgpu/geo-unpack";
import { COARSE } from "./drape-atlas";
import {
	coarseSize,
	coarseWords,
	rangeCellWords,
} from "./range-handoff-reference";

const ID = "range-webgpu";
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
const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)];

const SPECIAL_W = [
	0x00000000, // +0 (sky)
	0x80000000, // -0
	0x7fc00000, // NaN
	0xffc00000, // -NaN
	0x7f800001, // sNaN
	0x7f800000, // +Infinity
	0xff800000, // -Infinity
	0xbf800000, // -1
	0x80000001, // -denormal
	0x00000001, // +denormal
	0x007fffff, // largest denormal
	0x00800000, // smallest normal
	0x7f7fffff, // largest finite
];

/** n rgba32float texels as u32 words (top-first): sky-heavy, with specials and random finite ranges. */
function randomTarget(w: number, h: number, skyShare: number) {
	const t = new Uint32Array(w * h * 4);
	const f = new Float32Array(t.buffer);
	for (let i = 0; i < w * h; i++) {
		for (let c = 0; c < 3; c++) f[i * 4 + c] = (rand() - 0.5) * 4000;
		const r = rand();
		t[i * 4 + 3] =
			r < skyShare
				? 0
				: r < skyShare + 0.12
					? pick(SPECIAL_W)
					: r < skyShare + 0.15
						? (1 + Math.floor(rand() * 0x7f7ffffe)) >>> 0
						: new Uint32Array(new Float32Array([10 + rand() * 9000]).buffer)[0];
	}
	return t;
}

/** The old CPU path: unpack (range = w > 0 ? w : +Inf), rangeMapFrom (finite ? r : 0), coarsen. */
function oldPath(texels: Uint32Array, w: number, h: number) {
	const range = new Float32Array(w * h);
	unpackGeometryCpu(new Float32Array(texels.buffer), range);
	const data = new Float32Array(range.length);
	for (let i = 0; i < data.length; i++)
		data[i] = Number.isFinite(range[i]) ? range[i] : 0;
	const cw = Math.ceil(w / COARSE);
	const ch = Math.ceil(h / COARSE);
	const coarse = new Float32Array(cw * ch);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = Math.floor(y / COARSE) * cw + Math.floor(x / COARSE);
			if (data[y * w + x] > coarse[i]) coarse[i] = data[y * w + x];
		}
	return { data, coarse };
}

const bytesEqual = (a: ArrayLike<number>, b: ArrayLike<number>) => {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
};

const SIZES: [number, number][] = [
	[1, 1],
	[7, 5],
	[8, 8],
	[9, 17],
	[33, 12],
	[64, 48],
	[100, 75],
	[129, 33],
];

// ---- part 1: reference == old CPU path
for (const [w, h] of SIZES) {
	const t = randomTarget(w, h, 0.3);
	const old = oldPath(t, w, h);
	const cell = rangeCellWords(t, w, h);
	const coarse = coarseWords(cell, w, h);
	const sz = coarseSize(w, h);
	check(
		`reference == old CPU path ${w}x${h}`,
		bytesEqual(cell, new Uint32Array(old.data.buffer)) &&
			bytesEqual(coarse, new Uint32Array(old.coarse.buffer)) &&
			sz.width * sz.height === old.coarse.length,
	);
}

// ---- part 2: the GPU
const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log(`SKIP ${ID} (GPU half): DAWN_DIR not set`);
	process.exit(failures ? 1 : 0);
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
const { luma, Buffer: LumaBuffer, Texture } = await import("@luma.gl/core");
const { webgpuAdapter } = await import("@luma.gl/webgpu");
const device = (await luma.createDevice({
	type: "webgpu",
	adapters: [webgpuAdapter],
	createCanvasContext: false,
} as never)) as Device;
const { RangeGpuWebGpu } = await import("./range-webgpu");
const { submit } = await import("#/lib/gpu/core/queue");

const hand = new RangeGpuWebGpu(device);
await hand.whenReady();
check("ok after whenReady", hand.ok);

const SENTINEL = 123.5;
const COLS = 3;
const ROWS = 2;
/** The atlas as DrapeAtlas creates `range` (default usage, nearest sampler), sentinel-filled. */
function makeAtlas(cw: number, ch: number) {
	const W = COLS * cw;
	const H = ROWS * ch;
	const tex = device.createTexture({
		width: W,
		height: H,
		format: "r32float",
		// luma's default usage is CopyDst | TextureBinding | RenderAttachment (what DrapeAtlas gets): the
		// hand-off needs only CopyDst; CopySrc is added here so the check can read the atlas back
		usage:
			Texture.SAMPLE | Texture.COPY_DST | Texture.COPY_SRC | Texture.RENDER,
		sampler: {
			minFilter: "nearest",
			magFilter: "nearest",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		},
	});
	tex.writeData(new Float32Array(W * H).fill(SENTINEL), {
		x: 0,
		y: 0,
		width: W,
		height: H,
	});
	return tex;
}

async function readTexture(tex: { width: number; height: number }) {
	const rowBytes = Math.ceil((tex.width * 4) / 256) * 256;
	const buf = device.createBuffer({
		usage: LumaBuffer.COPY_DST | LumaBuffer.MAP_READ,
		byteLength: rowBytes * tex.height,
	});
	const enc = device.createCommandEncoder({ id: "range-check-read" });
	enc.copyTextureToBuffer({
		sourceTexture: tex as never,
		width: tex.width,
		height: tex.height,
		origin: [0, 0, 0],
		destinationBuffer: buf,
		byteOffset: 0,
		bytesPerRow: rowBytes,
		rowsPerImage: tex.height,
	});
	submit(device, enc);
	const raw = new Uint32Array((await buf.readAsync()).slice().buffer);
	buf.destroy();
	const out = new Uint32Array(tex.width * tex.height);
	for (let y = 0; y < tex.height; y++)
		out.set(
			raw.subarray((y * rowBytes) / 4, (y * rowBytes) / 4 + tex.width),
			y * tex.width,
		);
	return out;
}

for (const [w, h] of SIZES) {
	const atlas = makeAtlas(w, h);
	const targets = Array.from({ length: COLS * ROWS }, () => {
		const words = randomTarget(w, h, 0.25 + rand() * 0.5);
		const tex = device.createTexture({
			width: w,
			height: h,
			format: "rgba32float",
			usage: Texture.SAMPLE | Texture.COPY_DST | Texture.COPY_SRC,
			sampler: {
				minFilter: "nearest",
				magFilter: "nearest",
				mipmapFilter: "none",
			},
		});
		tex.writeData(new Float32Array(words.buffer), {
			x: 0,
			y: 0,
			width: w,
			height: h,
		});
		return { words, tex };
	});
	// every cell, back to back (pool slots are reused; queue order must keep them apart)
	const wrote = targets.map((t, k) =>
		hand.copyInto(
			atlas,
			[(k % COLS) * w, Math.floor(k / COLS) * h],
			t.tex,
			w,
			h,
		),
	);
	check(`copyInto returns true ${w}x${h}`, wrote.every(Boolean));
	const coarse = await Promise.all(
		targets.map((t) => hand.coarse(t.tex, w, h, () => false)),
	);
	const atlasWords = await readTexture(atlas);
	const W = COLS * w;
	let cellsOk = true;
	let coarseOk = true;
	targets.forEach((t, k) => {
		const ref = rangeCellWords(t.words, w, h);
		const ox = (k % COLS) * w;
		const oy = Math.floor(k / COLS) * h;
		for (let y = 0; y < h && cellsOk; y++)
			for (let x = 0; x < w; x++)
				if (atlasWords[(oy + y) * W + ox + x] !== ref[y * w + x]) {
					console.log(
						`  cell ${k} (${x},${y}): got ${atlasWords[(oy + y) * W + ox + x].toString(16)} want ${ref[y * w + x].toString(16)}`,
					);
					cellsOk = false;
					break;
				}
		const c = coarse[k];
		const want = coarseWords(ref, w, h);
		const sz = coarseSize(w, h);
		if (
			!c ||
			c.grid.width !== sz.width ||
			c.grid.height !== sz.height ||
			!bytesEqual(new Uint32Array(c.grid.data.buffer), want)
		)
			coarseOk = false;
	});
	check(`GPU cells == reference, 6 cells ${w}x${h}`, cellsOk);
	check(`GPU coarse grids == reference ${w}x${h}`, coarseOk);
	const bytes = coarse[0]?.bytes ?? 0;
	check(
		`readback is the grid only ${w}x${h}`,
		bytes === (1 + coarseSize(w, h).width * coarseSize(w, h).height) * 4,
		`${bytes} B vs ${w * h * 4} B target`,
	);
	for (const t of targets) t.tex.destroy();
	atlas.destroy();
}

// cancelled -> null, wrong size -> false / null, non-r32float atlas -> false
{
	const tex = device.createTexture({
		width: 8,
		height: 8,
		format: "rgba32float",
		usage: Texture.SAMPLE | Texture.COPY_DST,
	});
	check(
		"cancelled coarse is null",
		(await hand.coarse(tex, 8, 8, () => true)) === null,
	);
	check(
		"size mismatch coarse is null",
		(await hand.coarse(tex, 9, 8)) === null,
	);
	const atlas = makeAtlas(8, 8);
	check(
		"size mismatch copyInto is false",
		!hand.copyInto(atlas, [0, 0], tex, 9, 8),
	);
	check(
		"cell outside the atlas is false",
		!hand.copyInto(atlas, [20, 0], tex, 8, 8),
	);
	atlas.destroy();
	tex.destroy();
}
hand.destroy();
check("not ok after destroy", !hand.ok);

console.log(failures ? `FAIL ${ID} (${failures})` : `PASS ${ID}`);
process.exit(failures ? 1 : 0);

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/gpu/photoprep/photoprep.check.ts [maxPhotos] [fuzzCases]
// Node check of the GPU photo prep's exactness (no browser, no GPU):
//  1. soft-float: the JS twin of softf64.wgsl.ts (add, sub, mul, div, divSmall, fround, widenings,
//     max/abs) against V8's hardware doubles on random and edge-case operands, every result bit-equal;
//  2. kernels: emulate.ts (the JS twin of every kernel, same u32 arithmetic) against align.ts on real
//     photos (public/photos/*.jpg, decoded and scaled to 512 px by macOS `sips` when it exists) and on
//     synthetic images, with and without a soft people mask, for buildEdgeMap's planes (coarse, fine,
//     sky, skyCum) and for the prior-row sky refit (scanLabels with prior rows + fitSkyModel): every
//     element Object.is-equal;
//  3. bandLimits (the CPU-evaluated stop ranges the scan kernel tests) against stopHasBand directly.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type EdgeMap,
	edgeMapFg,
	edgeMapFromPixels,
	fitSkyModel,
	scanLabels,
	stopHasBand,
} from "#/lib/align";
import { emulateEdge, emulateSky } from "./emulate";
import { bandLimits, photoPrepDims } from "./plan";
import * as F from "./softf64";

const maxPhotos = Number(process.argv[2] ?? 1e9);
const fuzzCases = Number(process.argv[3] ?? 400000);
let failures = 0;
const check = (name: string, ok: boolean, info = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? ` ${info}` : ""}`);
};

// ---------------- 1. soft-float vs hardware doubles ----------------
{
	let bad = 0;
	let first = "";
	const same = (got: F.V2, want: number, what: string) => {
		const w = F.bitsOf(want);
		if (got[0] !== w[0] || got[1] !== w[1]) {
			if (!bad) first = `${what}: got ${F.doubleOf(got)} want ${want}`;
			bad++;
		}
	};
	const specials = [
		0,
		-0,
		1,
		-1,
		0.5,
		1.5,
		2 ** -1022,
		2 ** -1074,
		2 ** 52,
		1 + 2 ** -52,
		255,
		1e-3,
		0.3,
	];
	const rnd = () => {
		const r = Math.random();
		if (r < 0.15)
			return (
				Math.floor(Math.random() * 1000) * (Math.random() < 0.5 ? 1 : 1 / 256)
			);
		if (r < 0.3) return Math.fround(Math.random() * 4);
		if (r < 0.4) return Math.fround(Math.random()) - Math.fround(Math.random());
		if (r < 0.5)
			return (
				(Math.random() - 0.5) * 2 ** (Math.floor(Math.random() * 120) - 60)
			);
		if (r < 0.55)
			return (
				(Math.random() - 0.5) * 2 ** (Math.floor(Math.random() * 2000) - 1000)
			);
		if (r < 0.6)
			return (
				(Math.random() < 0.5 ? -1 : 1) *
				2 ** -1074 *
				Math.floor(Math.random() * 2 ** 20)
			);
		if (r < 0.65) return specials[Math.floor(Math.random() * specials.length)];
		const v = F.doubleOf([
			Math.floor(Math.random() * 2 ** 32) >>> 0,
			Math.floor(Math.random() * 2 ** 32) >>> 0,
		]);
		return Number.isFinite(v) ? v : 1.25;
	};
	for (let i = 0; i < fuzzCases; i++) {
		const a = rnd();
		const b = rnd();
		const A = F.bitsOf(a);
		const B = F.bitsOf(b);
		if (Number.isFinite(a + b)) same(F.f64Add(A, B), a + b, `add(${a}, ${b})`);
		if (Number.isFinite(a - b)) same(F.f64Sub(A, B), a - b, `sub(${a}, ${b})`);
		if (Number.isFinite(a * b)) same(F.f64Mul(A, B), a * b, `mul(${a}, ${b})`);
		if (b !== 0 && Number.isFinite(a / b))
			same(F.f64Div(A, B), a / b, `div(${a}, ${b})`);
		const k =
			1 + Math.floor(Math.random() * (Math.random() < 0.5 ? 20 : 65535));
		same(F.f64DivSmall(A, k), a / k, `divSmall(${a}, ${k})`);
		const f = Math.fround(a);
		if (Number.isFinite(f)) {
			if (F.f64ToF32(A) !== F.f32Bits(f)) {
				if (!bad) first = `fround(${a})`;
				bad++;
			}
			same(F.f64FromF32(F.f32Bits(f)), f, `fromF32(${f})`);
		}
		const u = Math.floor(Math.random() * 2 ** (Math.random() * 32)) >>> 0;
		same(F.f64FromU32(u), u, `fromU32(${u})`);
		same(F.f64Max0(A), Math.max(a, 0), `max0(${a})`);
		same(F.f64Abs(A), Math.abs(a), `abs(${a})`);
		// binary32 subnormals and exact binary32 midpoints (the tie cases of fround)
		const t =
			(Math.random() - 0.5) * 2 ** (Math.floor(Math.random() * 60) - 160);
		if (F.f64ToF32(F.bitsOf(t)) !== F.f32Bits(Math.fround(t))) {
			if (!bad) first = `fround-subnormal(${t})`;
			bad++;
		}
		const g = Math.fround(Math.random() * 3);
		const mid = (g + Math.fround(g * (1 + 2 ** -23))) / 2;
		if (F.f64ToF32(F.bitsOf(mid)) !== F.f32Bits(Math.fround(mid))) {
			if (!bad) first = `fround-midpoint(${mid})`;
			bad++;
		}
	}
	check(
		`soft-float twin == hardware doubles (${fuzzCases} cases × 14 ops)`,
		bad === 0,
		bad ? `${bad} wrong, first ${first}` : "",
	);
}

// ---------------- inputs ----------------
type Img = { name: string; d: Uint8ClampedArray; w: number; h: number };

/** A 24/32-bit BMP (sips output) → RGBA bytes. */
function readBmp(file: string): { d: Uint8ClampedArray; w: number; h: number } {
	const b = fs.readFileSync(file);
	const off = b.readUInt32LE(10);
	const w = b.readInt32LE(18);
	const hRaw = b.readInt32LE(22);
	const bpp = b.readUInt16LE(28);
	const h = Math.abs(hRaw);
	if (bpp !== 24 && bpp !== 32) throw new Error(`${file}: ${bpp} bpp`);
	const stride = Math.ceil((w * bpp) / 32) * 4;
	const d = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		const row = off + (hRaw > 0 ? h - 1 - y : y) * stride;
		for (let x = 0; x < w; x++) {
			const s = row + (x * bpp) / 8;
			const i = (y * w + x) * 4;
			d[i] = b[s + 2];
			d[i + 1] = b[s + 1];
			d[i + 2] = b[s];
			d[i + 3] = 255;
		}
	}
	return { d, w, h };
}

function photos(): Img[] {
	const dir = path.resolve(import.meta.dirname, "../../../../public/photos");
	let sips = true;
	try {
		execFileSync("sips", ["--help"], { stdio: "ignore" });
	} catch {
		sips = false;
	}
	if (!sips || !fs.existsSync(dir)) {
		console.log("note no `sips` or no public/photos: synthetic images only");
		return [];
	}
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "photoprep-"));
	const out: Img[] = [];
	try {
		for (const f of fs
			.readdirSync(dir)
			.filter((f) => /\.jpe?g$/i.test(f))
			.sort()
			.slice(0, maxPhotos)) {
			const bmp = path.join(tmp, `${f}.bmp`);
			try {
				execFileSync(
					"sips",
					[
						"-s",
						"format",
						"bmp",
						"--resampleWidth",
						"512",
						path.join(dir, f),
						"--out",
						bmp,
					],
					{ stdio: "ignore" },
				);
				out.push({ name: f, ...readBmp(bmp) });
			} catch (e) {
				console.log(`note ${f}: not decoded (${(e as Error).message})`);
			}
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	return out;
}

/** Synthetic mountain photo: gradient sky with clouds, a ridge with snow, haze, noise; deterministic. */
function synthetic(w: number, h: number, seed: number): Img {
	let s = seed >>> 0;
	const rand = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const d = new Uint8ClampedArray(w * h * 4);
	const ph = rand() * 6;
	for (let x = 0; x < w; x++) {
		const ridge =
			h *
			(0.35 + 0.15 * Math.sin(x / (40 + seed) + ph) + 0.05 * Math.sin(x / 9));
		for (let y = 0; y < h; y++) {
			const i = (y * w + x) * 4;
			let r: number;
			let g: number;
			let b: number;
			if (y < ridge) {
				const t = y / h;
				r = 90 + 80 * t;
				g = 140 + 60 * t;
				b = 230 - 20 * t;
				if (Math.sin(x / 23 + y / 11 + ph) > 0.85) r = g = b = 240; // clouds
			} else {
				const snow = y < ridge + 12 && rand() < 0.7;
				r = snow ? 235 : 70 + 40 * Math.sin(y / 7);
				g = snow ? 238 : 80 + 30 * Math.sin(x / 13);
				b = snow ? 245 : 60;
			}
			d[i] = r + (rand() - 0.5) * 16;
			d[i + 1] = g + (rand() - 0.5) * 16;
			d[i + 2] = b + (rand() - 0.5) * 16;
			d[i + 3] = 255;
		}
	}
	// a few flat areas (zero gradients) and saturated pixels
	for (let k = 0; k < 4; k++) {
		const x0 = Math.floor(rand() * (w - 40));
		const y0 = Math.floor(rand() * (h - 30));
		const v = k < 2 ? 0 : 255;
		for (let y = y0; y < y0 + 25; y++)
			for (let x = x0; x < x0 + 35; x++)
				d.fill(v, (y * w + x) * 4, (y * w + x) * 4 + 3);
	}
	return { name: `synthetic-${w}x${h}-${seed}`, d, w, h };
}

/** A soft people mask at its own resolution (blobs with ramps, values 0..255). */
function mask(seed: number) {
	const width = 300 + seed * 7;
	const height = 220 + seed * 3;
	const data = new Uint8Array(width * height);
	for (let k = 0; k < 3; k++) {
		const cx = width * (0.2 + 0.3 * k);
		const cy = height * (0.55 + 0.1 * Math.sin(seed + k));
		const r = 20 + 10 * k;
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++) {
				const dd = Math.hypot((x - cx) / r, (y - cy) / (1.8 * r));
				const v = Math.round(255 * Math.min(1, Math.max(0, (1.3 - dd) / 0.6)));
				data[y * width + x] = Math.max(data[y * width + x], v);
			}
	}
	return { width, height, data };
}

/** Prior rows like skylineRows: near the real skyline (from the CPU fine map), some −1, some far. */
function priorRows(map: EdgeMap, seed: number) {
	const { w, h, fine } = map;
	const rows = new Float32Array(w);
	let s = seed >>> 0;
	const rand = () => {
		s = (Math.imul(s, 22695477) + 1) >>> 0;
		return s / 2 ** 32;
	};
	for (let x = 0; x < w; x++) {
		let best = 0;
		let by = -1;
		for (let y = Math.floor(h * 0.05); y < h * 0.85; y++)
			if (fine[y * w + x] > best) {
				best = fine[y * w + x];
				by = y;
			}
		const r = rand();
		rows[x] =
			r < 0.08
				? -1
				: r < 0.15
					? Math.fround(rand() * h)
					: Math.fround(by + (rand() - 0.5) * h * 0.15);
		if (rows[x] < 0) rows[x] = -1;
	}
	return rows;
}

const words = (d: Uint8ClampedArray) =>
	new Uint32Array(d.buffer, d.byteOffset, d.byteLength / 4);
const bits = (f: Float32Array) =>
	new Uint32Array(f.buffer, f.byteOffset, f.length);

/** Object.is on every element of a CPU Float32Array plane vs a kernel plane of binary32 bits. */
function samePlane(cpu: Float32Array, gpu: Uint32Array) {
	if (cpu.length !== gpu.length) return `length ${cpu.length} vs ${gpu.length}`;
	const g = new Float32Array(gpu.buffer, gpu.byteOffset, gpu.length);
	let n = 0;
	let first = -1;
	for (let i = 0; i < cpu.length; i++)
		if (!Object.is(cpu[i], g[i])) {
			if (first < 0) first = i;
			n++;
		}
	return n
		? `${n} differ, first #${first}: cpu ${cpu[first]} gpu ${g[first]}`
		: "";
}

// ---------------- 2. kernels vs align.ts ----------------
const imgs = [
	...photos(),
	synthetic(512, 384, 1),
	synthetic(512, 288, 2),
	synthetic(97, 61, 3),
	synthetic(512, 683, 4),
];
let planes = 0;
let elements = 0;
for (const [idx, img] of imgs.entries()) {
	for (const withMask of [false, true]) {
		const fgMask = withMask ? mask(idx) : null;
		const fg = edgeMapFg(img.w, img.h, fgMask);
		const t0 = performance.now();
		const cpu = edgeMapFromPixels(img.d, img.w, img.h, fg);
		const cpuMs = performance.now() - t0;
		const dims = photoPrepDims(img.w, img.h);
		const t1 = performance.now();
		const gpu = emulateEdge(
			dims,
			words(cpu.rgb),
			bits(fg),
			bandLimits(img.w, img.h),
		);
		const emuMs = performance.now() - t1;
		const errs: string[] = [];
		for (const k of ["coarse", "fine", "sky", "skyCum"] as const) {
			const e = samePlane(cpu[k], gpu[k]);
			planes++;
			elements += cpu[k].length;
			if (e) errs.push(`${k}: ${e}`);
		}
		// the prior-row refit (autoAlign's fitPriorSky) on the same map
		const rows = priorRows(cpu, idx * 2 + (withMask ? 1 : 0));
		const ref: EdgeMap = {
			...cpu,
			skyCum: new Float32Array(cpu.skyCum.length),
		};
		fitSkyModel(ref, scanLabels(ref, rows));
		const lim = bandLimits(img.w, img.h, rows);
		const sky2 = emulateSky(dims, words(cpu.rgb), bits(fg), lim);
		for (const k of ["sky", "skyCum"] as const) {
			const e = samePlane(ref[k], sky2[k]);
			planes++;
			elements += ref[k].length;
			if (e) errs.push(`prior ${k}: ${e}`);
		}
		check(
			`${img.name}${withMask ? " +mask" : ""} ${img.w}×${img.h}: 6 planes Object.is-equal`,
			errs.length === 0,
			errs.length
				? errs.join("; ")
				: `(cpu ${cpuMs.toFixed(0)} ms, emulated ${emuMs.toFixed(0)} ms)`,
		);
		// 3. the band limits against the predicate itself, every column and stop
		let limBad = 0;
		for (let x = 0; x < img.w; x++)
			for (let s = 3; s <= img.h - 2; s++)
				if (
					(s >= lim[2 * x] && s <= lim[2 * x + 1]) !==
					stopHasBand(s, x, img.h, rows)
				)
					limBad++;
		if (limBad)
			check(`${img.name} bandLimits == stopHasBand`, false, `${limBad} wrong`);
	}
}
check(`band limits == stopHasBand on every image, column and stop`, true);
console.log(`     ${planes} planes, ${elements} elements compared`);

console.log(
	failures
		? `FAIL: ${failures} check(s)`
		: "PASS: photo prep kernels are bit-exact twins of align.ts",
);
process.exit(failures ? 1 : 0);

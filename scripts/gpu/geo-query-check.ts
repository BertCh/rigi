// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check of the geometry point queries (src/lib/deck/geo-query.ts, deck-webgpu/geo-query-gpu.ts),
// no GPU:
// - (the kernels' binding layouts are covered by scripts/gpu/kernel-layout-check.mjs: defineKernel)
// - a JS emulation of the verdict kernel (f32 compares via Math.fround, raw-bit texel classes, the
//   clamped finite f32 threshold), followed by the CPU's resolution of undecided samples from the
//   gather kernel's raw texels (emulated as a bit copy), must equal the CPU test (the engine's
//   original peakLabels loop: cpuOcclusion) on random and adversarial inputs: texels exactly at /
//   next to / around the f64 threshold, zero / negative / denormal / Inf / NaN texels, thresholds
//   below zero or beyond float32, NaN and out-of-frame coordinates;
// - the skyline kernel's rows → skylineFromRows must equal look/labels skylineAt, including no-terrain
//   columns and non-finite texels.
// It checks the decision logic, the f32 threshold arithmetic and the packing; it cannot check a GPU's
// compares (those are raw f32 compares by construction) or the dispatch plumbing.
//   npx tsx scripts/gpu/geo-query-check.ts
import {
	bitsF32,
	cpuOcclusion,
	f32Bits,
	f32Floor,
	OCC_STRIDE,
	occThreshold,
	occThresholdF32,
	planOcclusion,
	resolveOcclusion,
	skylineFromRows,
} from "../../src/lib/deck/geo-query";
import { skylineAt } from "../../src/lib/look/labels";

let fails = 0;
const fail = (m: string) => {
	fails++;
	console.log(`FAIL ${m}`);
};

// ---- verdict kernel emulation ---------------------------------------------------------------------
// the WGSL, line by line (sampleState + main), with the texture as a Float32Array of w channels
function wgslSampleState(b: number, a: number): number {
	const e = (b >>> 23) & 0xff;
	const m = b & 0x7fffff;
	if ((b & 0x80000000) !== 0 || (e === 0 && m === 0) || e === 0xff) return 1;
	if (e === 0) return 2;
	if (Math.fround(bitsF32(b)) > Math.fround(a)) return 1;
	return 0;
}
function emulateVerdict(
	words: Uint32Array,
	w: number,
	tex: Float32Array,
	nonce: number,
) {
	const n = words.length / OCC_STRIDE;
	const out = new Uint32Array(n);
	const bits = (x: number, y: number) => f32Bits(tex[y * w + x]);
	for (let i = 0; i < n; i++) {
		const o = i * OCC_STRIDE;
		const a = bitsF32(words[o + 4]);
		if (!Number.isFinite(a))
			throw new Error("non-finite threshold reached the GPU");
		const s0 = wgslSampleState(bits(words[o], words[o + 1]), a);
		const s1 = wgslSampleState(bits(words[o + 2], words[o + 3]), a);
		out[i] = ((nonce << 16) | s0 | (s1 << 2)) >>> 0;
	}
	return out;
}

let seed = 12345;
const rnd = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 4294967296;
};

const W = 64;
const H = 48;
const SPECIAL = [
	0,
	-0,
	-1,
	-5e-39,
	5e-39,
	1e-45,
	1.17549435e-38,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	Number.NaN,
	1,
	50,
	51.5,
	3.4028234663852886e38,
];
let cases = 0;
let undecided = 0;
let gpuDecided = 0;

async function run(
	peaks: ({ u: number; v: number; range: number } | null)[],
	tex: Float32Array,
	label: string,
) {
	const plan = planOcclusion(peaks, W, H);
	const codes = emulateVerdict(plan.words, W, tex, 7);
	for (const c of codes) if (c >>> 16 !== 7) fail(`${label}: nonce lost`);
	const small = Array.from(codes, (c) => c & 0xffff);
	// undecided: count + the gather emulation (bit copy of the texels)
	for (const c of small) if ((c & 3) === 2 || ((c >> 2) & 3) === 2) undecided++;
	const got = await resolveOcclusion(plan, small, async (xy) => {
		const out = new Float32Array((xy.length / 2) * 4);
		for (let i = 0; i < xy.length / 2; i++)
			out[i * 4 + 3] = tex[xy[i * 2 + 1] * W + xy[i * 2]];
		return out;
	});
	if (!got) return fail(`${label}: resolve failed`);
	peaks.forEach((pr, i) => {
		if (!pr) return;
		cases++;
		if (plan.decided[i] === null) gpuDecided++;
		const want = cpuOcclusion(pr, W, H, (x, y) => tex[y * W + x]);
		if (got[i] !== want)
			fail(`${label}: peak ${JSON.stringify(pr)} gpu ${got[i]} cpu ${want}`);
	});
}

// 1. random textures, random peaks (some outside the frame band, some NaN)
for (let round = 0; round < 200; round++) {
	const tex = new Float32Array(W * H);
	for (let i = 0; i < tex.length; i++) {
		const r = rnd();
		tex[i] =
			r < 0.3
				? 0
				: r < 0.35
					? SPECIAL[Math.floor(rnd() * SPECIAL.length)]
					: Math.fround(1 + rnd() * 40000);
	}
	const peaks = Array.from({ length: 60 }, () => {
		const k = rnd();
		return {
			u: k < 0.03 ? Number.NaN : rnd(),
			v: k > 0.97 ? 1 + rnd() : rnd() * 1.02,
			range:
				rnd() < 0.05
					? SPECIAL[Math.floor(rnd() * SPECIAL.length)]
					: Math.fround(100 + rnd() * 60000),
		};
	});
	await run(peaks, tex, `random ${round}`);
}

// 2. adversarial: the texel is the f32 on / around the f64 threshold of the peak
for (let round = 0; round < 4000; round++) {
	const range =
		rnd() < 0.5 ? 100 + rnd() * 60000 : Math.fround(100 + rnd() * 60000);
	const T = occThreshold(range);
	const a = f32Floor(T);
	const next = bitsF32(f32Bits(a) + (a >= 0 ? 1 : -1));
	const prev = bitsF32(f32Bits(a) - (a > 0 ? 1 : -1));
	const pick = [
		a,
		next,
		prev,
		Math.fround(T),
		bitsF32(f32Bits(Math.fround(T)) + 1),
	];
	const tex = new Float32Array(W * H).fill(0);
	const u = rnd();
	const v = rnd() * 0.9;
	const x = Math.floor(u * W);
	for (const dv of [0.004, 0.009]) {
		const y = Math.floor((v + dv) * H);
		if (y >= 0 && y < H) tex[y * W + x] = pick[Math.floor(rnd() * pick.length)];
	}
	await run([{ u, v, range }], tex, `threshold ${round}`);
}

// 3. thresholds outside float32 / non-finite, texels at the extremes
for (const range of [
	0,
	1,
	51.5,
	51.54,
	1e30,
	3.5e38,
	1e38,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	-1e5,
	Number.NEGATIVE_INFINITY,
	2e36,
	3.4e38,
]) {
	for (const t of SPECIAL) {
		const tex = new Float32Array(W * H).fill(t);
		await run(
			[{ u: 0.5, v: 0.5, range }],
			tex,
			`extreme range ${range} texel ${t}`,
		);
	}
}

// 4. f32Floor itself
for (let i = 0; i < 20000; i++) {
	const x = (rnd() - 0.5) * 10 ** (rnd() * 80 - 40);
	const a = f32Floor(x);
	if (!(a <= x)) fail(`f32Floor(${x}) = ${a} > x`);
	const up = bitsF32(f32Bits(a) + (a >= 0 ? 1 : -1));
	if (Number.isFinite(up) && !(up > x))
		fail(`f32Floor(${x}) = ${a} is not the largest`);
	if (
		occThresholdF32(x) !==
		Math.max(-3.4028234663852886e38, Math.min(3.4028234663852886e38, a))
	)
		fail(`occThresholdF32(${x})`);
}

// ---- skyline ------------------------------------------------------------------------------------
const isDenormal = (x: number) => {
	const b = f32Bits(x);
	return ((b >>> 23) & 0xff) === 0 && (b & 0x7fffff) !== 0 && x > 0;
};
function emulateSkyline(tex: Float32Array, w: number, h: number) {
	const rows = new Uint32Array(w);
	for (let c = 0; c < w; c++) {
		let row = h;
		let odd = 0;
		for (let t = 0; t < h; t++) {
			const b = f32Bits(tex[t * w + c]);
			const e = (b >>> 23) & 0xff;
			const m = b & 0x7fffff;
			if ((b & 0x80000000) !== 0 || e === 0xff || (e === 0 && m === 0))
				continue;
			if (e === 0) odd = 1;
			row = t;
			break;
		}
		rows[c] = row | (odd << 31);
	}
	return rows;
}
for (let round = 0; round < 300; round++) {
	const tex = new Float32Array(W * H);
	const cutoff = Array.from({ length: W }, () => Math.floor(rnd() * (H + 8)));
	let hasDenorm = false;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const r = rnd();
			tex[y * W + x] =
				y < cutoff[x]
					? r < 0.2
						? SPECIAL[Math.floor(rnd() * SPECIAL.length)]
						: 0
					: Math.fround(1 + rnd() * 9000);
			if (y < cutoff[x] && isDenormal(tex[y * W + x])) hasDenorm = true;
		}
	// the engine's range buffer: w > 0 ? w : Infinity (geometry-source unpack)
	const range = Float32Array.from(tex, (r) =>
		r > 0 ? r : Number.POSITIVE_INFINITY,
	);
	const want = skylineAt(range, W, H, {
		rowsTopDown: true,
		stride: 1,
		channel: 0,
	});
	const rows = emulateSkyline(tex, W, H);
	const flagged = rows.some((r) => r >>> 31);
	// a flagged column sends the engine to the full readback; unflagged columns must be exact
	if (flagged) {
		if (!hasDenorm) fail(`skyline ${round}: flagged without a denormal`);
		continue;
	}
	const got = skylineFromRows(rows, H);
	for (let c = 0; c < W; c++)
		if (!Object.is(got[c], want[c]))
			fail(`skyline ${round} col ${c}: ${got[c]} vs ${want[c]}`);
}

console.log(
	`${fails ? "FAIL" : "PASS"}: ${cases} occlusion cases (${gpuDecided} through the kernel, ${undecided} undecided samples resolved on the CPU), skyline, layouts`,
);
process.exit(fails ? 1 : 0);

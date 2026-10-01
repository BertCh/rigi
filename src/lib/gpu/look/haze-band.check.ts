// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/gpu/look/haze-band.check.ts [scenes]   (exits 1 on failure; CI fast tier: 8)
// Node check of the GPU airlight band (./haze-band.ts, ?hazeBandGpu, default on), no GPU:
//  1. keyBelow / orderKey: for f32 x and the band's constants (0.5, 0.7) and random doubles,
//     `x < c` ⟺ orderKey(bits(x)) ≤ keyBelow(c), on random and adversarial x (±0, subnormals, ±∞,
//     the f32 neighbours of each constant);
//  2. emulateBand (the WGSL's integer logic) = haze.ts airlightBand bit for bit: on the planes of
//     synthetic scenes (with and without sky masks) and on random planes laced with NaN, ±0,
//     subnormals, ±∞ and the threshold neighbours, odd and even widths; where airlightBand falls
//     back (under 20 band pixels) the emulated K is under 20 too (the GPU path then takes the CPU band);
//  3. verifyBand accepts the true band and rejects a wrong count, a moved pixel, a dropped pixel
//     and a wrong K (teeth of the per-call runtime check);
//  4. end to end: the band path's Prep (band lin gathered by the emulated band, every list carrying
//     its range values, the tail's full range plane EMPTY) through haze.ts hazeFitTail equals
//     fitHaze bit for bit.
// Not covered (needs a browser with WebGPU): that the WGSL kernels compute what emulateBand does.
import { fitHaze } from "../../look/haze-fit";
import { bits32, fromBits32, nextDown32, nextUp32 } from "../precision/df32";
import { airlightBand, bandLength, hazeFitTail, type Prep } from "./haze";
import {
	bandShape,
	emulateBand,
	keyBelow,
	orderKey,
	pickSpotColumns,
	SPOT_COLUMNS,
	verifyBand,
} from "./haze-band";
import {
	emulatedGrid,
	emulatePrep,
	firstDifference,
	hazePixels,
	lcg,
	makeHazeScene,
	sceneOptions,
} from "./haze-emulate";

let failed = 0;
const fail = (msg: string) => {
	failed++;
	console.log(`FAIL ${msg}`);
};
const same = (a: ArrayLike<number>, b: ArrayLike<number>) =>
	a.length === b.length && Array.prototype.every.call(a, (v, i) => v === b[i]);

// adversarial f32 values around the band's tests
const SPECIAL = [
	0,
	-0,
	fromBits32(1),
	-fromBits32(1),
	fromBits32(0x007fffff),
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	Number.NaN,
	0.5,
	nextDown32(0.5),
	nextUp32(0.5),
	Math.fround(0.7),
	nextUp32(Math.fround(0.7)),
	nextDown32(Math.fround(0.7)),
	0.3,
	1,
	150,
	-1,
];

// ---------- 1. keys ----------
{
	const rnd = lcg(3);
	let bad = 0;
	let n = 0;
	const constants = [0.5, 0.7, 0, 0.3];
	for (let k = 0; k < 20; k++)
		constants.push((rnd() - 0.5) * 10 ** (rnd() * 6 - 3));
	for (const c of constants) {
		const key = keyBelow(c);
		const xs = [
			...SPECIAL,
			nextDown32(Math.fround(c)),
			Math.fround(c),
			nextUp32(Math.fround(c)),
		];
		for (let k = 0; k < 2000; k++)
			xs.push(Math.fround((rnd() - 0.5) * 4 * Math.max(1, Math.abs(c))));
		for (const x of xs) {
			if (Number.isNaN(x)) continue;
			n++;
			if (x < c !== orderKey(bits32(x)) <= key)
				if (bad++ < 3) fail(`key: ${x} < ${c}`);
		}
	}
	// x > 0 as the WGSL's positive(): key above +0's
	for (const x of SPECIAL) {
		if (Number.isNaN(x)) continue;
		n++;
		if (x > 0 !== orderKey(bits32(x)) > 0x80000000)
			if (bad++ < 3) fail(`positive: ${x}`);
	}
	console.log(
		`${bad ? "FAIL" : "ok  "} orderKey / keyBelow decide ${n} compares as f64 does`,
	);
}

// ---------- 2. emulateBand = airlightBand ----------
let bandCases = 0;
let shortCases = 0;
function compareBand(
	range: Float32Array,
	pSky: Float32Array,
	W: number,
	H: number,
	label: string,
) {
	const want = airlightBand(range, pSky, W, H);
	const got = emulateBand(
		new Uint32Array(range.buffer, range.byteOffset, range.length),
		new Uint32Array(pSky.buffer, pSky.byteOffset, pSky.length),
		W,
		H,
	);
	bandCases++;
	const long = bandLength(range, pSky, W, H);
	if (got.K !== long)
		return fail(`${label}: emulated K ${got.K}, CPU band ${long}`);
	if (long < 20) {
		shortCases++;
		return;
	}
	if (!same(got.idx, want)) fail(`${label}: emulated band ≠ airlightBand`);
	const { kMax } = bandShape(W, H);
	if (got.K > kMax) fail(`${label}: K ${got.K} > kMax ${kMax}`);
}
const scenes = Number(process.argv[2] ?? 8);
for (let s = 0; s < scenes; s++) {
	const opts = sceneOptions(100 + s);
	const { range, pSky } = hazePixels(makeHazeScene(opts));
	compareBand(range, pSky, opts.width, opts.height, `scene ${s}`);
}
{
	const rnd = lcg(11);
	for (let t = 0; t < 300; t++) {
		const W = 3 + Math.floor(rnd() * 120);
		const H = 3 + Math.floor(rnd() * 90);
		const range = new Float32Array(W * H);
		const pSky = new Float32Array(W * H);
		const skyline = rnd() * H;
		const lace = rnd() * 0.3;
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const i = y * W + x;
				const sky = y < skyline + 5 * Math.sin(x * 0.2 + t);
				range[i] = sky ? 0 : 100 + rnd() * 1e5;
				pSky[i] = sky ? 0.6 + rnd() * 0.4 : rnd() * 0.6;
				if (rnd() < lace)
					range[i] = SPECIAL[Math.floor(rnd() * SPECIAL.length)];
				if (rnd() < lace) pSky[i] = SPECIAL[Math.floor(rnd() * SPECIAL.length)];
			}
		compareBand(range, pSky, W, H, `random ${t} (${W}×${H})`);
	}
}
console.log(
	`${failed ? "FAIL" : "ok  "} emulateBand = airlightBand on ${bandCases} plane pairs (${shortCases} short: CPU fallback on both)`,
);

// ---------- 3. verifyBand ----------
{
	const opts = sceneOptions(7);
	const W = opts.width;
	const H = opts.height;
	const { range, pSky } = hazePixels(makeHazeScene(opts));
	const band = emulateBand(
		new Uint32Array(range.buffer),
		new Uint32Array(pSky.buffer),
		W,
		H,
	);
	// spot on every 2nd selected column with a band, so the faults below are seen
	const cols = pickSpotColumns(W, lcg(5));
	for (let s = 0; s < SPOT_COLUMNS; s++) {
		let j = (s * 7) % band.cnt.length;
		while (!band.cnt[j]) j = (j + 1) % band.cnt.length;
		cols[s] = 2 * j;
	}
	const spot = new Uint32Array(SPOT_COLUMNS * H * 2);
	const rb = new Uint32Array(range.buffer);
	const pb = new Uint32Array(pSky.buffer);
	for (let s = 0; s < SPOT_COLUMNS; s++)
		for (let y = 0; y < H; y++) {
			spot[2 * (s * H + y)] = rb[y * W + cols[s]];
			spot[2 * (s * H + y) + 1] = pb[y * W + cols[s]];
		}
	const ok = verifyBand(W, H, band.cnt, band.K, band.idx, cols, spot);
	if (ok) fail(`verifyBand rejects the true band: ${ok}`);
	const j0 = cols[0] / 2;
	let off0 = 0;
	for (let q = 0; q < j0; q++) off0 += band.cnt[q];
	const faults: [string, () => string | null][] = [
		[
			"wrong K",
			() => verifyBand(W, H, band.cnt, band.K + 1, band.idx, cols, spot),
		],
		[
			"moved pixel",
			() => {
				const idx = band.idx.slice();
				idx[off0] += W;
				return verifyBand(W, H, band.cnt, band.K, idx, cols, spot);
			},
		],
		[
			"count shifted between columns",
			() => {
				const cnt = band.cnt.slice();
				cnt[j0] -= 1;
				cnt[(j0 + 1) % cnt.length] += 1;
				return verifyBand(W, H, cnt, band.K, band.idx, cols, spot);
			},
		],
		[
			"dropped pixel",
			() => {
				const cnt = band.cnt.slice();
				cnt[j0] -= 1;
				const idx = Uint32Array.from([
					...band.idx.slice(0, off0),
					...band.idx.slice(off0 + 1),
				]);
				return verifyBand(W, H, cnt, band.K - 1, idx, cols, spot);
			},
		],
	];
	for (const [name, run] of faults) {
		const r = run();
		if (!r) fail(`verifyBand misses a ${name}`);
		else console.log(`ok   verifyBand catches a ${name} (${r})`);
	}
}

// ---------- 4. end to end through the tail ----------
{
	let n = 0;
	for (let s = 0; s < Math.min(scenes, 6); s++) {
		const input = makeHazeScene(sceneOptions(200 + s));
		const { prep, ctx, pixels } = emulatePrep(input);
		const W = input.geoW;
		const H = input.geoH;
		const band = emulateBand(
			new Uint32Array(pixels.range.buffer),
			new Uint32Array(pixels.pSky.buffer),
			W,
			H,
		);
		if (band.K < 20) continue;
		const sky = new Float32Array(3 * band.K);
		for (let k = 0; k < band.K; k++)
			for (let c = 0; c < 3; c++)
				sky[3 * k + c] = pixels.lin[band.idx[k] * 3 + c];
		const bandPrep: Prep = {
			...prep,
			sky,
			list: (L) => {
				const { idx, val } = prep.list(L);
				return {
					idx,
					val,
					range: Float32Array.from(idx, (i) => pixels.range[i]),
				};
			},
		};
		const want = fitHaze(input);
		const got = await hazeFitTail(
			null as never,
			{ ...ctx, range: new Float32Array(0), skyIdx: band.idx },
			bandPrep,
			emulatedGrid,
		);
		n++;
		const d = firstDifference(got, want);
		if (d) fail(`scene ${200 + s}: band-path tail ≠ fitHaze at ${d}`);
	}
	if (!n) fail("no scene reached the end-to-end comparison");
	else console.log(`ok   band-path tail = fitHaze on ${n} scenes`);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);

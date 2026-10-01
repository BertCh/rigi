// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The haze fit's airlight band on the GPU (WAG haze-cert, D16; ?hazeBandGpu, default on since 2026-10-01): the kernel
// specs and host-side pieces of ./haze-band.wgsl.ts, used by ./haze-graph.ts fitHazeFromPrep /
// prepAndFitHazeTex. With it, the fit's GPU part is ONE submit (compaction + band + gathers) instead
// of two, and the range / P(sky) planes (8 B per pixel) no longer come back: the band's lin and the
// lists' range values (what the CPU tail reads) are gathered on the GPU instead.
//
// Exactness. The band is integer work on f32 bit patterns (no float arithmetic, see the WGSL header),
// so it is exact by construction rather than certified: the strict-IEEE probe (../precision) has
// nothing to vouch for here and does not gate it. What could still go wrong is a broken kernel or a
// driver bug, so every call carries a runtime check (verifyBand): the column counts must add up to K
// and K must fit, and SPOT_COLUMNS random band columns are re-walked on the CPU with haze.ts's own
// airlightBandColumn on their range / P(sky) bits (read back with the band) and must give the same
// pixels. A failure falls back to the CPU band for that call and turns the GPU band off for the
// device. Fewer than 20 band pixels (airlightBand's fallback to every sky pixel) also takes the CPU
// band: that path needs the whole range plane.
//
// emulateBand is the WGSL's integer logic in TypeScript, for the node check haze-band.check.ts.
import { bits32, nextDown32 } from "../precision/df32";
import { airlightBandColumn, bandRows } from "./haze";
import {
	HZB_COUNT,
	HZB_GATHER,
	HZB_RANGE,
	HZB_SCATTER,
	HZB_SPOT,
	HZB_TOTAL,
	SPOT_COLUMNS,
} from "./haze-band.wgsl";
import { defineKernel } from "./kernel";

export { RANGE_GROUP, SPOT_COLUMNS } from "./haze-band.wgsl";

/** In the look's warm group (default on): warmed with the other look kernels. */
const BAND_KERNELS = {};

export const K_HZB_COUNT = defineKernel(
	"hzb-count",
	HZB_COUNT,
	[
		["prm", "uniform"],
		["range", "read-only-storage"],
		["psky", "read-only-storage"],
		["top", "storage"],
		["cnt", "storage"],
	],
	BAND_KERNELS,
);
export const K_HZB_TOTAL = defineKernel(
	"hzb-total",
	HZB_TOTAL,
	[
		["prm", "uniform"],
		["cnt", "read-only-storage"],
		["off", "read-only-storage"],
		["total", "storage"],
	],
	BAND_KERNELS,
);
export const K_HZB_SCATTER = defineKernel(
	"hzb-scatter",
	HZB_SCATTER,
	[
		["prm", "uniform"],
		["range", "read-only-storage"],
		["psky", "read-only-storage"],
		["top", "read-only-storage"],
		["off", "read-only-storage"],
		["bandIdx", "storage"],
	],
	BAND_KERNELS,
);
export const K_HZB_GATHER = defineKernel(
	"hzb-gather",
	HZB_GATHER,
	[
		["total", "read-only-storage"],
		["bandIdx", "read-only-storage"],
		["lin", "read-only-storage"],
		["bandLin", "storage"],
	],
	BAND_KERNELS,
);
export const K_HZB_RANGE = defineKernel(
	"hzb-range",
	HZB_RANGE,
	[
		["starts", "read-only-storage"],
		["outIdx", "read-only-storage"],
		["range", "read-only-storage"],
		["outRange", "storage"],
	],
	BAND_KERNELS,
);
export const K_HZB_SPOT = defineKernel(
	"hzb-spot",
	HZB_SPOT,
	[
		["prm", "uniform"],
		["cols", "read-only-storage"],
		["range", "read-only-storage"],
		["psky", "read-only-storage"],
		["spot", "storage"],
	],
	BAND_KERNELS,
);

/** The WGSL's orderKey: f32 bits → u32 whose unsigned order is the float order (NaN aside). */
export const orderKey = (b: number) =>
	(b & 0x80000000 ? ~b : b | 0x80000000) >>> 0;

/** The key of the largest f32 strictly below `c` (x < c for an f32 x ⟺ key(x) ≤ this). */
export function keyBelow(c: number) {
	let f = Math.fround(c);
	if (!(f < c)) f = nextDown32(f);
	return orderKey(bits32(f));
}

const isNanBits = (b: number) => (b & 0x7fffffff) >>> 0 > 0x7f800000;
const positiveBits = (b: number) => !isNanBits(b) && orderKey(b) > 0x80000000;
const belowBits = (b: number, key: number) =>
	!isNanBits(b) && orderKey(b) <= key;

/** The band's shape on a W × H grid: columns, rows per column, slots. */
export function bandShape(W: number, H: number) {
	const { a0, a1 } = bandRows(W);
	const nCol = Math.ceil(W / 2);
	const kMax = nCol * (a1 - a0 + 1);
	return { a0, a1, nCol, kMax, H };
}

/** hzb-*'s uniform: W, H, nCol, a0, a1, key below 0.5, key below 0.7, kMax. */
export function bandWords(W: number, H: number) {
	const { a0, a1, nCol, kMax } = bandShape(W, H);
	return new Uint32Array([
		W,
		H,
		nCol,
		a0,
		a1,
		keyBelow(0.5),
		keyBelow(0.7),
		kMax,
	]);
}

/** hzb-count / total / scatter on the CPU, on the planes' bit patterns: per-column counts and the band. */
export function emulateBand(
	rangeBits: Uint32Array,
	pSkyBits: Uint32Array,
	W: number,
	H: number,
) {
	const { a0, a1, nCol } = bandShape(W, H);
	const below05 = keyBelow(0.5);
	const below07 = keyBelow(0.7);
	const cnt = new Uint32Array(nCol);
	const idx: number[] = [];
	for (let j = 0; j < nCol; j++) {
		const x = 2 * j;
		let top = -1;
		for (let y = 0; y < H; y++) {
			const i = y * W + x;
			if (positiveBits(rangeBits[i]) && belowBits(pSkyBits[i], below05)) {
				top = y;
				break;
			}
		}
		if (top < 0) continue;
		for (let y = Math.max(0, top - a1); y <= top - a0; y++) {
			const i = y * W + x;
			if (positiveBits(rangeBits[i]) || belowBits(pSkyBits[i], below07))
				continue;
			idx.push(i);
			cnt[j]++;
		}
	}
	return { cnt, idx: Uint32Array.from(idx), K: idx.length };
}

/** SPOT_COLUMNS distinct band columns (x = 2j), uniformly at random; fewer when the grid is narrow. */
export function pickSpotColumns(W: number, random = Math.random): Uint32Array {
	const nCol = Math.ceil(W / 2);
	const cols = new Uint32Array(SPOT_COLUMNS);
	const chosen = new Set<number>();
	for (let s = 0; s < SPOT_COLUMNS; s++) {
		let j = Math.floor(random() * nCol);
		// distinct while there are enough columns (a repeat is harmless, just a weaker check)
		for (let tries = 0; chosen.has(j) && tries < 8; tries++)
			j = Math.floor(random() * nCol);
		chosen.add(j);
		cols[s] = 2 * j;
	}
	return cols;
}

/**
 * The per-call check of a GPU band: counts add up to K, K fits, and every spot column's band pixels
 * (re-walked by haze.ts airlightBandColumn on the read-back range / P(sky) bits) equal the GPU's.
 * Returns null when it holds, else what failed.
 */
export function verifyBand(
	W: number,
	H: number,
	cnt: Uint32Array,
	K: number,
	bandIdx: Uint32Array,
	cols: Uint32Array,
	spot: Uint32Array,
): string | null {
	const { a0, a1, kMax } = bandShape(W, H);
	let sum = 0;
	for (const c of cnt) sum += c;
	if (sum !== K) return `column counts add up to ${sum}, K is ${K}`;
	if (K > kMax) return `K ${K} exceeds ${kMax}`;
	// the spot columns as a W = 1 grid: column 0 of `range` / `pSky`
	const range = new Float32Array(H);
	const pSky = new Float32Array(H);
	const rangeBits = new Uint32Array(range.buffer);
	const pSkyBits = new Uint32Array(pSky.buffer);
	for (let s = 0; s < cols.length; s++) {
		for (let y = 0; y < H; y++) {
			rangeBits[y] = spot[2 * (s * H + y)];
			pSkyBits[y] = spot[2 * (s * H + y) + 1];
		}
		const rows: number[] = [];
		airlightBandColumn(range, pSky, 1, H, 0, a0, a1, rows);
		const j = cols[s] / 2;
		let off = 0;
		for (let q = 0; q < j; q++) off += cnt[q];
		if (cnt[j] !== rows.length)
			return `column ${cols[s]}: ${cnt[j]} band pixels, the CPU finds ${rows.length}`;
		for (let k = 0; k < rows.length; k++)
			if (bandIdx[off + k] !== rows[k] * W + cols[s])
				return `column ${cols[s]}: band pixel ${k} is ${bandIdx[off + k]}, the CPU's ${rows[k] * W + cols[s]}`;
	}
	return null;
}

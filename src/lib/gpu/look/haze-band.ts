// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The haze fit's airlight band on the GPU (WAG haze-cert, D16; the GPU band, default on since 2026-10-01): the kernel
// specs and host-side pieces of ./haze-band.wgsl.ts, used by ./haze-graph.ts fitHazeFromPrep /
// prepAndFitHazeTex. With it, the fit's GPU part is ONE submit (compaction + band + gathers) instead
// of two, and the range / P(sky) planes (8 B per pixel) no longer come back: the band's lin and the
// lists' range values (what the CPU tail reads) are gathered on the GPU instead.
//
// Exactness. The band's indices are integer work on f32 bit patterns (no float arithmetic, see the
// WGSL header): two small kernels (hzb-top, hzb-flags) lay the CPU's per-column walk out as a
// column-major (pixel index, in-band flag) array and luma's GPUCompaction (a GPUScan and a stable
// scatter) compacts it, giving the band in the CPU's push order and K. The strict-IEEE probe
// (../precision) has nothing to vouch for here and does not gate it. What could still go wrong is a
// broken kernel or a driver bug, so every call carries a runtime check (verifyBand): K must fit, the
// band must be in column-then-row order, and SPOT_COLUMNS random band columns are re-walked on the
// CPU with haze.ts's own airlightBandColumn on their range / P(sky) bits (read back with the band)
// and must give the same pixels. A failure falls back to the CPU band for that call and turns the
// GPU band off for the device. Fewer than 20 band pixels (airlightBand's fallback to every sky
// pixel) also takes the CPU band: that path needs the whole range plane.
//
// The band's lin and the lists' range words are gathered by luma GPUGather (word copies, haze-graph.ts).
// emulateBand is the kernels' and the compaction's logic in TypeScript, for the node check
// haze-band.check.ts (the Dawn check scripts/gpu/haze-band-dawn.ts compares the GPU with airlightBand).
import { bits32, nextDown32 } from "../precision/df32";
import { airlightBandColumn, bandRows } from "./haze";
import { HZB_FLAGS, HZB_SPOT, HZB_TOP, SPOT_COLUMNS } from "./haze-band.wgsl";
import { defineKernel } from "./kernel";
import { HAZE_BAND_PARAMS } from "./uniform-blocks";

export { FLAGS_GROUP, SPOT_COLUMNS } from "./haze-band.wgsl";

/** In the look's warm group (default on): warmed with the other look kernels. */
const BAND_KERNELS = {};

export const K_HZB_TOP = defineKernel(
	"hzb-top",
	HZB_TOP,
	[
		["prm", "uniform"],
		["range", "read-only-storage"],
		["psky", "read-only-storage"],
		["top", "storage"],
	],
	BAND_KERNELS,
);
export const K_HZB_FLAGS = defineKernel(
	"hzb-flags",
	HZB_FLAGS,
	[
		["prm", "uniform"],
		["range", "read-only-storage"],
		["psky", "read-only-storage"],
		["top", "read-only-storage"],
		["elem", "storage"],
		["flag", "storage"],
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
	return new Uint32Array(
		HAZE_BAND_PARAMS.pack({
			W,
			H,
			nCol,
			a0,
			a1,
			keyBelowHalf: keyBelow(0.5),
			keyBelow07: keyBelow(0.7),
			kMax,
		}),
	);
}

/**
 * hzb-top, hzb-flags and the compaction on the CPU, on the planes' bit patterns: the per-column top
 * rows, the column-major slots (pixel index, in-band flag), the compacted band (stable, slot order =
 * column then row, the CPU's push order) and K. `cnt` is the per-column count (for the checks).
 */
export function emulateBand(
	rangeBits: Uint32Array,
	pSkyBits: Uint32Array,
	W: number,
	H: number,
) {
	const { a0, a1, nCol } = bandShape(W, H);
	const below05 = keyBelow(0.5);
	const below07 = keyBelow(0.7);
	const top = new Int32Array(nCol).fill(-1);
	for (let j = 0; j < nCol; j++) {
		const x = 2 * j;
		for (let y = 0; y < H; y++) {
			const i = y * W + x;
			if (positiveBits(rangeBits[i]) && belowBits(pSkyBits[i], below05)) {
				top[j] = y;
				break;
			}
		}
	}
	const elem = new Uint32Array(nCol * H);
	const flag = new Uint32Array(nCol * H);
	const cnt = new Uint32Array(nCol);
	for (let j = 0; j < nCol; j++)
		for (let y = 0; y < H; y++) {
			const s = j * H + y;
			const i = y * W + 2 * j;
			elem[s] = i;
			const t = top[j];
			const inBand =
				t >= 0 &&
				y >= Math.max(0, t - a1) &&
				y <= t - a0 &&
				!(positiveBits(rangeBits[i]) || belowBits(pSkyBits[i], below07));
			flag[s] = inBand ? 1 : 0;
			cnt[j] += flag[s];
		}
	const idx: number[] = [];
	for (let s = 0; s < flag.length; s++) if (flag[s]) idx.push(elem[s]);
	return { top, elem, flag, cnt, idx: Uint32Array.from(idx), K: idx.length };
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
 * The per-call check of a GPU band: K fits, the band is in the CPU's push order (strictly increasing
 * column, then row, on band columns only), and every spot column's band pixels (re-walked by haze.ts
 * airlightBandColumn on the read-back range / P(sky) bits) are exactly the GPU's entries of that
 * column. Returns null when it holds, else what failed.
 */
export function verifyBand(
	W: number,
	H: number,
	K: number,
	bandIdx: Uint32Array,
	cols: Uint32Array,
	spot: Uint32Array,
): string | null {
	const { a0, a1, kMax } = bandShape(W, H);
	if (K > kMax) return `K ${K} exceeds ${kMax}`;
	if (bandIdx.length < K) return `K ${K}, only ${bandIdx.length} indices read`;
	let prev = -1;
	for (let k = 0; k < K; k++) {
		const x = bandIdx[k] % W;
		const y = Math.floor(bandIdx[k] / W);
		if (bandIdx[k] >= W * H || x % 2) return `band pixel ${k} is ${bandIdx[k]}`;
		const order = (x / 2) * H + y;
		if (order <= prev) return `band pixel ${k} (${bandIdx[k]}) is out of order`;
		prev = order;
	}
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
		const got: number[] = [];
		for (let k = 0; k < K; k++)
			if (bandIdx[k] % W === cols[s]) got.push(Math.floor(bandIdx[k] / W));
		if (got.length !== rows.length)
			return `column ${cols[s]}: ${got.length} band pixels, the CPU finds ${rows.length}`;
		for (let k = 0; k < rows.length; k++)
			if (got[k] !== rows[k])
				return `column ${cols[s]}: band pixel ${k} is row ${got[k]}, the CPU's ${rows[k]}`;
	}
	return null;
}

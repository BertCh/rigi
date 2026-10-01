// CPU twin of the GPU splat sort (./index.ts, ./splat-sort.wgsl.ts). The REFERENCE is the worker's
// sortSplatsByDepth (nearfield/splat-sort.worker.ts); this file twins the GPU's arithmetic so the
// identity argument can be checked in node (scripts/gpu/splat-sort-check.ts):
//
//   - splatKeysF32: the depth + key kernels with every WGSL f32 operation rounded by Math.fround
//     (no fused multiply-add: WGSL permits fusing, so a real GPU may differ from this by one ulp
//     of the depth, which can move a key by 1 at a bin edge; see README.md);
//   - radixOrderTiled: the tile / scanDigit / scanTotals / scatter kernels, step for step.

import { DIGITS, DROPPED_KEY, RADIX_BITS, TILE } from "./splat-sort.wgsl";

export { DIGITS, DROPPED_KEY, RADIX_BITS, TILE };

const f = Math.fround;

/**
 * Keys as the GPU computes them: f32 depth, f32 span / scale, truncating u32 conversion.
 * Dropped splats (depth <= 0) get DROPPED_KEY. Returns the kept count too.
 */
export function splatKeysF32(
	positions: Float32Array,
	count: number,
	row: readonly [number, number, number, number],
): { keys: Uint32Array; kept: number } {
	const a = f(row[0]);
	const b = f(row[1]);
	const c = f(row[2]);
	const d = f(row[3]);
	const dist = new Float32Array(count);
	let minD = Number.POSITIVE_INFINITY;
	let maxD = Number.NEGATIVE_INFINITY;
	let kept = 0;
	for (let i = 0; i < count; i++) {
		const j = 3 * i;
		const s = f(
			f(f(a * positions[j]) + f(b * positions[j + 1])) +
				f(c * positions[j + 2]),
		);
		const v = -f(s + d);
		if (v > 0) {
			dist[i] = v;
			if (v < minD) minD = v;
			if (v > maxD) maxD = v;
			kept++;
		} else dist[i] = -1;
	}
	const keys = new Uint32Array(count);
	const span = f(maxD - minD);
	const k = span > 0 ? f(65535 / span) : 0;
	for (let i = 0; i < count; i++) {
		if (dist[i] < 0) keys[i] = DROPPED_KEY;
		else keys[i] = Math.min(65535, Math.trunc(f(f(maxD - dist[i]) * k)));
	}
	return { keys, kept };
}

/**
 * The GPU's two stable radix passes over `keys` (17 bits, 9 per pass, LSD), literally: per-tile
 * ranks and histograms, per-digit scans over tiles, the digit-total scan, the scatter. Returns the
 * order of ALL `count` elements (dropped ones last).
 */
export function radixOrderTiled(keys: Uint32Array, count: number): Uint32Array {
	const blocks = Math.max(1, Math.ceil(count / TILE));
	let inIdx = new Uint32Array(count);
	let outIdx = new Uint32Array(count);
	const rank = new Uint32Array(count);
	const hist = new Uint32Array(DIGITS * blocks);
	const base = new Uint32Array(DIGITS);
	for (let pass = 0; pass < 2; pass++) {
		const shift = pass * RADIX_BITS;
		const first = pass === 0;
		const digitOf = (g: number) => {
			const e = first ? g : inIdx[g];
			return (keys[e] >>> shift) & (DIGITS - 1);
		};
		hist.fill(0);
		for (let w = 0; w < blocks; w++) {
			const lo = w * TILE;
			const hi = Math.min(count, lo + TILE);
			for (let g = lo; g < hi; g++) {
				const dg = digitOf(g);
				let r = 0;
				for (let j = lo; j < g; j++) if (digitOf(j) === dg) r++;
				rank[g] = r;
				hist[dg * blocks + w]++;
			}
		}
		for (let dgt = 0; dgt < DIGITS; dgt++) {
			let run = 0;
			for (let w = 0; w < blocks; w++) {
				const v = hist[dgt * blocks + w];
				hist[dgt * blocks + w] = run;
				run += v;
			}
			base[dgt] = run;
		}
		let acc = 0;
		for (let dgt = 0; dgt < DIGITS; dgt++) {
			const v = base[dgt];
			base[dgt] = acc;
			acc += v;
		}
		for (let g = 0; g < count; g++) {
			const e = first ? g : inIdx[g];
			const dg = digitOf(g);
			outIdx[base[dg] + hist[dg * blocks + ((g / TILE) | 0)] + rank[g]] = e;
		}
		[inIdx, outIdx] = [outIdx, inIdx];
	}
	return inIdx;
}

/** The whole GPU pipeline on the CPU: f32 keys, then the tiled stable radix. */
export function gpuSplatOrderCpu(
	positions: Float32Array,
	count: number,
	row: readonly [number, number, number, number],
) {
	const { keys, kept } = splatKeysF32(positions, count, row);
	return { order: radixOrderTiled(keys, count), keys, kept };
}

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU-side inputs of the photo-prep kernels that come from align.ts's own float expressions, evaluated
// here with the CPU's code so the kernels only ever compare integers against them.
import { stopHasBand } from "#/lib/align";
import { DIMS_WORDS, WG } from "./kernels.wgsl";

/**
 * The kernels' Dims uniform (kernels.wgsl.ts): sizes, the percentile rank, scanLabels' rows and the
 * run's nonce (≠ 0, echoed back by the last kernels).
 */
export function photoPrepDims(w: number, h: number, nonce = 1) {
	const n = w * h;
	const u = new Uint32Array(DIMS_WORDS);
	u[0] = w;
	u[1] = h;
	u[2] = n;
	u[3] = Math.floor(n * 0.97); // buildEdgeMap's kthSmallest rank (E.length = n)
	u[4] = Math.round(h * 0.12); // scanLabels: sky rows of a column without a stop
	u[5] = Math.round(h * 0.06); // scanLabels: terrain band height
	u[6] = Math.round(h * 0.8); // scanLabels: terrain from this row down
	u[7] = nonce;
	return u;
}

/**
 * Sizes the kernels support exactly: counts below 2^24 (fitSkyModel's Float32Array counts stay exact
 * integers, and n fits every u32 index product), a 1-D grid within WebGPU's 65535 workgroups, and the
 * edge loop's 5 × 3 stencil.
 */
export const photoPrepSupported = (w: number, h: number) =>
	w >= 3 && h >= 5 && w * h < 1 << 24 && Math.ceil((w * h) / WG) <= 65535;

/**
 * Per column x, the inclusive range [lim[2x], lim[2x+1]] of scan stops (3 ≤ stop ≤ h − 2, the rows
 * scanLabels can stop at) for which align.ts stopHasBand is true, evaluated by stopHasBand itself for
 * every candidate. Empty ranges are (1, 0). Throws when a column's set is not one interval (it always
 * is: every test in stopHasBand is an interval in `stop`), so the kernel's range test is exactly the
 * CPU's predicate.
 */
export function bandLimits(w: number, h: number, priorRows?: Float32Array) {
	const lim = new Int32Array(2 * w);
	const one = (x: number) => {
		let lo = 1;
		let hi = 0;
		let gaps = false;
		for (let s = 3; s <= h - 2; s++)
			if (stopHasBand(s, x, h, priorRows)) {
				if (hi >= lo && s !== hi + 1) gaps = true;
				if (hi < lo) lo = s;
				hi = s;
			}
		if (gaps)
			throw new Error(`photoprep: band stops of column ${x} not an interval`);
		lim[2 * x] = lo;
		lim[2 * x + 1] = hi;
	};
	if (!priorRows) {
		// no prior: the predicate does not depend on x
		one(0);
		for (let x = 1; x < w; x++) {
			lim[2 * x] = lim[0];
			lim[2 * x + 1] = lim[1];
		}
	} else for (let x = 0; x < w; x++) one(x);
	return lim;
}

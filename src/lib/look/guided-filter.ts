// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Guided filter (He, Sun & Tang 2013) on the CPU, grey guide: snaps a soft mask to the guide
// image's own edges. q = mean(a)·I + mean(b) with a = cov(I, p) / (var(I) + ε), b = mean(p) − a·mean(I),
// every mean a (2r+1)² box (clamped at the borders) from a summed-area table, so O(N) for any r.
// Runs once per pose settle at ≤ 512 px (look/composite.ts), a few ms.

/** Box mean of `src` (w × h) over a (2r+1)² window, clamped at the borders, into `out`. */
function boxMean(
	src: Float32Array,
	w: number,
	h: number,
	r: number,
	out: Float32Array,
	sat: Float64Array,
) {
	const W = w + 1;
	for (let y = 0; y < h; y++) {
		let row = 0;
		for (let x = 0; x < w; x++) {
			row += src[y * w + x];
			sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
		}
	}
	for (let y = 0; y < h; y++) {
		const y0 = Math.max(0, y - r);
		const y1 = Math.min(h, y + r + 1);
		for (let x = 0; x < w; x++) {
			const x0 = Math.max(0, x - r);
			const x1 = Math.min(w, x + r + 1);
			out[y * w + x] =
				(sat[y1 * W + x1] -
					sat[y0 * W + x1] -
					sat[y1 * W + x0] +
					sat[y0 * W + x0]) /
				((x1 - x0) * (y1 - y0));
		}
	}
}

/** Refine `p` (0..1, w × h) with guide `I` (0..1): window radius `r` px, regulariser `eps`. */
export function guidedFilter(
	I: Float32Array,
	p: Float32Array,
	w: number,
	h: number,
	r: number,
	eps: number,
): Float32Array {
	const n = w * h;
	const sat = new Float64Array((w + 1) * (h + 1));
	const mean = (src: Float32Array) => {
		const out = new Float32Array(n);
		boxMean(src, w, h, r, out, sat);
		return out;
	};
	const II = new Float32Array(n);
	const Ip = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		II[i] = I[i] * I[i];
		Ip[i] = I[i] * p[i];
	}
	const mI = mean(I);
	const mp = mean(p);
	const mII = mean(II);
	const mIp = mean(Ip);
	// reuse II / Ip for a / b
	for (let i = 0; i < n; i++) {
		const a = (mIp[i] - mI[i] * mp[i]) / (mII[i] - mI[i] * mI[i] + eps);
		II[i] = a;
		Ip[i] = mp[i] - a * mI[i];
	}
	const ma = mean(II);
	const mb = mean(Ip);
	const q = new Float32Array(n);
	for (let i = 0; i < n; i++)
		q[i] = Math.min(1, Math.max(0, ma[i] * I[i] + mb[i]));
	return q;
}

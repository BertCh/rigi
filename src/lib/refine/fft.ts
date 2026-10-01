// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Minimal iterative radix-2 complex FFT (in place, Float64) and a circular
 * cross-correlation helper. Sizes must be powers of two. Used by init.ts for
 * the 1-D yaw correlation of the photo skyline against the 360° horizon.
 */

export const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

const twiddles = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function table(n: number) {
	let t = twiddles.get(n);
	if (!t) {
		const cos = new Float64Array(n / 2);
		const sin = new Float64Array(n / 2);
		for (let i = 0; i < n / 2; i++) {
			cos[i] = Math.cos((2 * Math.PI * i) / n);
			sin[i] = Math.sin((2 * Math.PI * i) / n);
		}
		t = { cos, sin };
		twiddles.set(n, t);
	}
	return t;
}

/**
 * In-place FFT of (re, im). `inverse` computes the unnormalised inverse
 * (e^{+i...}); divide by n yourself, or use `ifft`.
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
	const n = re.length;
	if (!isPow2(n) || im.length !== n)
		throw new Error(`fft: size ${n} is not a power of two`);
	// Bit reversal.
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			let t = re[i];
			re[i] = re[j];
			re[j] = t;
			t = im[i];
			im[i] = im[j];
			im[j] = t;
		}
	}
	const { cos, sin } = table(n);
	const sgn = inverse ? 1 : -1;
	for (let len = 2; len <= n; len <<= 1) {
		const half = len >> 1;
		const stride = n / len;
		for (let i = 0; i < n; i += len) {
			for (let k = 0; k < half; k++) {
				const wr = cos[k * stride];
				const wi = sgn * sin[k * stride];
				const a = i + k;
				const b = a + half;
				const xr = re[b] * wr - im[b] * wi;
				const xi = re[b] * wi + im[b] * wr;
				re[b] = re[a] - xr;
				im[b] = im[a] - xi;
				re[a] += xr;
				im[a] += xi;
			}
		}
	}
}

export function ifft(re: Float64Array, im: Float64Array) {
	fft(re, im, true);
	const n = re.length;
	for (let i = 0; i < n; i++) {
		re[i] /= n;
		im[i] /= n;
	}
}

/** Forward FFT of a real signal; returns fresh (re, im) arrays. */
export function rfft(x: ArrayLike<number>) {
	const re = Float64Array.from(x);
	const im = new Float64Array(re.length);
	fft(re, im);
	return { re, im };
}

/**
 * Circular cross-correlation of real signals given the FFT of `a`
 * (the template) and of `b`: out[s] = Σ_j a[j]·b[(j+s) mod n].
 * Computed as IFFT(conj(A)·B).
 */
export function correlateSpectra(
	A: { re: Float64Array; im: Float64Array },
	B: { re: Float64Array; im: Float64Array },
): Float64Array {
	const n = A.re.length;
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		// conj(A)·B
		re[i] = A.re[i] * B.re[i] + A.im[i] * B.im[i];
		im[i] = A.re[i] * B.im[i] - A.im[i] * B.re[i];
	}
	ifft(re, im);
	return re;
}

/** x limited to [lo, hi] (NaN passes through). */
export const clamp = (x: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, x));

/** v limited to [0, 1] (NaN passes through). */
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Hermite 0..1 step between edges a and b (GLSL smoothstep). */
export function smoothstep(a: number, b: number, x: number) {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
}

/**
 * The k-th smallest value of `a` (0-based), as `Float32Array.from(a).sort()[k]` gives it, in O(n)
 * average: Hoare quickselect on `a` in place (it reorders `a`; pass a copy to keep the original).
 */
export function kthSmallest(a: Float32Array, k: number): number {
	let lo = 0;
	let hi = a.length - 1;
	while (hi > lo) {
		const pivot = a[(lo + hi) >> 1];
		let i = lo;
		let j = hi;
		while (i <= j) {
			while (a[i] < pivot) i++;
			while (a[j] > pivot) j--;
			if (i <= j) {
				const t = a[i];
				a[i] = a[j];
				a[j] = t;
				i++;
				j--;
			}
		}
		if (k <= j) hi = j;
		else if (k >= i) lo = i;
		else break;
	}
	return a[k];
}

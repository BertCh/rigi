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

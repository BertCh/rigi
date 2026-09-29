/** Hermite 0..1 step between edges a and b (GLSL smoothstep). */
export function smoothstep(a: number, b: number, x: number) {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
}

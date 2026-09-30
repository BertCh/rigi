/**
 * Bilinear sample of an S×S grid of pixel-centred samples at pixel coords (0..S), clamped to the outer
 * sample centres. Shared by deck/terrain-data, nearfield/near-dem and look/relief/heights
 * (terrain.ts keeps its own uv variant).
 */
export function sampleGrid(h: Float32Array, S: number, px: number, py: number) {
	const m = S - 1;
	const x = Math.min(Math.max(px - 0.5, 0), m);
	const y = Math.min(Math.max(py - 0.5, 0), m);
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = Math.min(x0 + 1, m);
	const y1 = Math.min(y0 + 1, m);
	const fx = x - x0;
	const fy = y - y0;
	const a = h[y0 * S + x0] * (1 - fx) + h[y0 * S + x1] * fx;
	const b = h[y1 * S + x0] * (1 - fx) + h[y1 * S + x1] * fx;
	return a * (1 - fy) + b * fy;
}

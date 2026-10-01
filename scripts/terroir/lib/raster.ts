// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Scanline polygon fill (even-odd over all rings of one feature) onto a lon/lat grid.
export type Grid = {
	w: number;
	s: number;
	e: number;
	n: number;
	W: number;
	H: number;
};

export function fillRings(
	g: Grid,
	rings: [number, number][][],
	put: (idx: number) => void,
) {
	const rows = new Map<number, number[]>();
	for (const ring of rings) {
		const m = ring.length;
		if (m < 3) continue;
		for (let i = 0, j = m - 1; i < m; j = i++) {
			let [x0, y0] = ring[j],
				[x1, y1] = ring[i];
			x0 = ((x0 - g.w) / (g.e - g.w)) * g.W;
			x1 = ((x1 - g.w) / (g.e - g.w)) * g.W;
			y0 = ((g.n - y0) / (g.n - g.s)) * g.H;
			y1 = ((g.n - y1) / (g.n - g.s)) * g.H;
			if (y0 === y1) continue;
			if (y0 > y1) {
				[x0, x1] = [x1, x0];
				[y0, y1] = [y1, y0];
			}
			const ya = Math.max(0, Math.ceil(y0 - 0.5)),
				yb = Math.min(g.H - 1, Math.ceil(y1 - 0.5) - 1);
			for (let y = ya; y <= yb; y++) {
				const x = x0 + ((y + 0.5 - y0) / (y1 - y0)) * (x1 - x0);
				let r = rows.get(y);
				if (!r) {
					r = [];
					rows.set(y, r);
				}
				r.push(x);
			}
		}
	}
	for (const [y, xs] of rows) {
		xs.sort((a, b) => a - b);
		for (let k = 0; k + 1 < xs.length; k += 2) {
			const xa = Math.max(0, Math.ceil(xs[k] - 0.5)),
				xb = Math.min(g.W - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
			for (let x = xa; x <= xb; x++) put(y * g.W + x);
		}
	}
}

/** Join OSM way geometries into closed rings (greedy endpoint matching). */
export function joinWays(ways: [number, number][][]): [number, number][][] {
	const rings: [number, number][][] = [];
	const pool = ways.filter((w) => w.length >= 2).map((w) => w.slice());
	const eq = (a: [number, number], b: [number, number]) =>
		Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
	while (pool.length) {
		let cur = pool.pop();
		if (!cur) break;
		let grew = true;
		while (grew && !eq(cur[0], cur[cur.length - 1])) {
			grew = false;
			for (let i = 0; i < pool.length; i++) {
				const w = pool[i];
				if (eq(cur[cur.length - 1], w[0])) cur = cur.concat(w.slice(1));
				else if (eq(cur[cur.length - 1], w[w.length - 1]))
					cur = cur.concat(w.slice(0, -1).reverse());
				else if (eq(cur[0], w[w.length - 1])) cur = w.concat(cur.slice(1));
				else if (eq(cur[0], w[0]))
					cur = w.slice().reverse().concat(cur.slice(1));
				else continue;
				pool.splice(i, 1);
				grew = true;
				break;
			}
		}
		if (cur.length >= 4 && eq(cur[0], cur[cur.length - 1])) rings.push(cur);
	}
	return rings;
}

/** Sutherland-Hodgman clip of a ring to a rectangle [w,s,e,n]. */
export function clipRing(
	ring: [number, number][],
	b: [number, number, number, number],
): [number, number][] {
	let pts = ring;
	const edges: [
		(p: [number, number]) => boolean,
		(a: [number, number], c: [number, number]) => [number, number],
	][] = [
		[
			(p) => p[0] >= b[0],
			(a, c) => [b[0], a[1] + ((c[1] - a[1]) * (b[0] - a[0])) / (c[0] - a[0])],
		],
		[
			(p) => p[0] <= b[2],
			(a, c) => [b[2], a[1] + ((c[1] - a[1]) * (b[2] - a[0])) / (c[0] - a[0])],
		],
		[
			(p) => p[1] >= b[1],
			(a, c) => [a[0] + ((c[0] - a[0]) * (b[1] - a[1])) / (c[1] - a[1]), b[1]],
		],
		[
			(p) => p[1] <= b[3],
			(a, c) => [a[0] + ((c[0] - a[0]) * (b[3] - a[1])) / (c[1] - a[1]), b[3]],
		],
	];
	for (const [inside, inter] of edges) {
		const out: [number, number][] = [];
		for (let i = 0; i < pts.length; i++) {
			const cur = pts[i],
				prev = pts[(i + pts.length - 1) % pts.length];
			if (inside(cur)) {
				if (!inside(prev)) out.push(inter(prev, cur));
				out.push(cur);
			} else if (inside(prev)) out.push(inter(prev, cur));
		}
		pts = out;
		if (!pts.length) break;
	}
	return pts;
}

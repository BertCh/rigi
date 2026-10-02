// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Depth range of a triangle mesh on a photo-space grid: per cell centre, the nearest and the farthest surface z
// along the cell's ray (camera frame, OpenCV axes, metres). The far value of a closed mesh is its back surface as seen
// from the photo eye: what src/lib/nearfield/complete/people.ts' BackDepthProvider returns.
import type { IntrinsicsNorm } from "#/lib/nearfield/geom";

export type DepthRange = {
	/** min z per cell (NaN where no triangle covers the cell centre) */
	near: Float32Array;
	/** max z per cell */
	far: Float32Array;
	/** covered cell count */
	covered: number;
};

/**
 * Rasterise `faces` of the camera-frame `vertices` [V · 3] onto a gridWidth × gridHeight grid over the photo (cell
 * (i, j) has its centre at u = (i + 0.5) / gridWidth, v = (j + 0.5) / gridHeight). Depth is interpolated
 * perspective-correctly (1/z linear in the image). Triangles with a vertex behind `minZ` are skipped.
 */
export function rasterDepthRange(
	vertices: ArrayLike<number>,
	faces: ArrayLike<number>,
	K: IntrinsicsNorm,
	gridWidth: number,
	gridHeight: number,
	minZ = 0.05,
): DepthRange {
	const N = gridWidth * gridHeight;
	const near = new Float32Array(N).fill(Number.NaN);
	const far = new Float32Array(N).fill(Number.NaN);
	const V = vertices.length / 3;
	const gx = new Float64Array(V);
	const gy = new Float64Array(V);
	const iz = new Float64Array(V);
	for (let i = 0; i < V; i++) {
		const z = vertices[3 * i + 2];
		iz[i] = z > minZ ? 1 / z : Number.NaN;
		gx[i] = (K.cx + (K.fx * vertices[3 * i]) / z) * gridWidth - 0.5;
		gy[i] = (K.cy + (K.fy * vertices[3 * i + 1]) / z) * gridHeight - 0.5;
	}
	let covered = 0;
	const F = faces.length / 3;
	for (let f = 0; f < F; f++) {
		const a = faces[3 * f];
		const b = faces[3 * f + 1];
		const c = faces[3 * f + 2];
		if (!(iz[a] > 0 && iz[b] > 0 && iz[c] > 0)) continue;
		const ax = gx[a];
		const ay = gy[a];
		const bx = gx[b];
		const by = gy[b];
		const cx = gx[c];
		const cy = gy[c];
		const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
		if (Math.abs(area) < 1e-12) continue;
		const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx)));
		const i1 = Math.min(gridWidth - 1, Math.floor(Math.max(ax, bx, cx)));
		const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy)));
		const j1 = Math.min(gridHeight - 1, Math.floor(Math.max(ay, by, cy)));
		if (i0 > i1 || j0 > j1) continue;
		const inv = 1 / area;
		const eps = -1e-9;
		for (let j = j0; j <= j1; j++)
			for (let i = i0; i <= i1; i++) {
				// barycentrics of the cell centre (either winding)
				const wa = ((bx - i) * (cy - j) - (by - j) * (cx - i)) * inv;
				const wb = ((cx - i) * (ay - j) - (cy - j) * (ax - i)) * inv;
				const wc = 1 - wa - wb;
				if (wa < eps || wb < eps || wc < eps) continue;
				const z = 1 / (wa * iz[a] + wb * iz[b] + wc * iz[c]);
				const k = j * gridWidth + i;
				if (Number.isNaN(near[k])) {
					near[k] = z;
					far[k] = z;
					covered++;
				} else {
					if (z < near[k]) near[k] = z;
					if (z > far[k]) far[k] = z;
				}
			}
	}
	return { near, far, covered };
}

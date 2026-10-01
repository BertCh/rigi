// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Heights for the relief field: the loaded DEM tiles (both engines keep each tile's size × size grid
// of metres ASL: three TerrainTile, deck TileMesh) resampled bilinearly onto a square ENU grid, with
// no heightAt lookups. Finer tiles overwrite coarser ones. Heights are ASL, not ENU z: within the
// field (±20 km) the curvature drop barely matters to shading, and ASL keeps the field view-independent.

import { sampleGrid } from "../../dem/grid";
import {
	latToTileY,
	lonToTileX,
	type TileKey,
	tileBounds,
} from "../../dem/tiles";
import type { EnuFrame } from "../../geodesy";

export type HeightTile = { key: TileKey; size: number; heights: Float32Array };
/** [minX, minY, maxX, maxY], ENU metres. */
export type Extent = [number, number, number, number];

/** Mercator lookup grid: frame.toGeo at G+1 × G+1 nodes, bilinear in between (< 1 m error at ±30 km). */
const G = 32;

/** res × res heights at texel centres (row 0 = south), `hole` where no tile covers. */
export function rasterizeHeights(
	tiles: readonly HeightTile[],
	frame: EnuFrame,
	extent: Extent,
	res: number,
	hole = Number.NaN,
): Float32Array {
	const [x0, y0, x1, y1] = extent;
	const px = (x1 - x0) / res;
	// zoom-0 mercator x / y per texel, relative to the extent's first node (float32 keeps ~1e-3 z14 px)
	const n = G + 1;
	const nx = new Float64Array(n * n);
	const ny = new Float64Array(n * n);
	for (let j = 0; j < n; j++)
		for (let i = 0; i < n; i++) {
			const g = frame.toGeo(
				x0 + ((x1 - x0) * i) / G,
				y0 + ((y1 - y0) * j) / G,
				0,
			);
			nx[j * n + i] = lonToTileX(g.lon, 0);
			ny[j * n + i] = latToTileY(g.lat, 0);
		}
	const ox = nx[0];
	const oy = ny[0];
	const mx = new Float32Array(res * res);
	const my = new Float32Array(res * res);
	for (let j = 0; j < res; j++) {
		const v = ((j + 0.5) / res) * G;
		const cj = Math.min(Math.floor(v), G - 1);
		const fv = v - cj;
		for (let i = 0; i < res; i++) {
			const u = ((i + 0.5) / res) * G;
			const ci = Math.min(Math.floor(u), G - 1);
			const fu = u - ci;
			const k = cj * n + ci;
			const w00 = (1 - fu) * (1 - fv);
			const w10 = fu * (1 - fv);
			const w01 = (1 - fu) * fv;
			const w11 = fu * fv;
			mx[j * res + i] =
				nx[k] * w00 +
				nx[k + 1] * w10 +
				nx[k + n] * w01 +
				nx[k + n + 1] * w11 -
				ox;
			my[j * res + i] =
				ny[k] * w00 +
				ny[k + 1] * w10 +
				ny[k + n] * w01 +
				ny[k + n + 1] * w11 -
				oy;
		}
	}

	const out = new Float32Array(res * res).fill(hole);
	const e = [0, 0, 0];
	for (const t of [...tiles].sort((a, b) => a.key.z - b.key.z)) {
		// texel box of the tile's corners (+1 texel), then an exact inside test per texel
		const b = tileBounds(t.key);
		let lx = Number.POSITIVE_INFINITY;
		let ly = Number.POSITIVE_INFINITY;
		let hx = Number.NEGATIVE_INFINITY;
		let hy = Number.NEGATIVE_INFINITY;
		for (const [lat, lon] of [
			[b.north, b.west],
			[b.north, b.east],
			[b.south, b.west],
			[b.south, b.east],
		]) {
			frame.fromGeo(lat, lon, 0, e);
			lx = Math.min(lx, e[0]);
			hx = Math.max(hx, e[0]);
			ly = Math.min(ly, e[1]);
			hy = Math.max(hy, e[1]);
		}
		const i0 = Math.max(0, Math.floor((lx - x0) / px) - 1);
		const i1 = Math.min(res - 1, Math.ceil((hx - x0) / px) + 1);
		const j0 = Math.max(0, Math.floor((ly - y0) / px) - 1);
		const j1 = Math.min(res - 1, Math.ceil((hy - y0) / px) + 1);
		if (i0 > i1 || j0 > j1) continue;
		const S = t.size;
		const s = 2 ** t.key.z;
		// tile pixel = ((o + m) · 2^z − key) · S
		const ax = (ox * s - t.key.x) * S;
		const ay = (oy * s - t.key.y) * S;
		const k = s * S;
		for (let j = j0; j <= j1; j++)
			for (let i = i0; i <= i1; i++) {
				const q = j * res + i;
				const tx = ax + mx[q] * k;
				const ty = ay + my[q] * k;
				if (tx >= 0 && tx < S && ty >= 0 && ty < S)
					out[q] = sampleGrid(t.heights, S, tx, ty);
			}
	}
	return out;
}

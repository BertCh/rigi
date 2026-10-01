// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU side of the batched terrain path (batched-terrain-layer.ts, opt-in: terrain-mode.ts).
//
// A tile is no longer meshed on the main thread. The vertex shader rebuilds exactly what
// terrain-data.ts buildMesh computes (positions, central-difference normals, uv, elevation,
// skirts) from three pieces of per-tile data:
//   - the DEM heights (uploaded as-is into a height texture array),
//   - a coarse "base grid": ENU of the ellipsoid surface (h = 0) at (G+1)² nodes, and
//   - the tile's Mercator / longitude parameters, for the local up vector.
// ENU(lat, lon, h) = ENU(lat, lon, 0) + h · up(lat, lon) holds exactly for ECEF on the ellipsoid
// (geodesy.ts toEcef), and fromGeo's refraction lift K·(e² + n²) / 2R is added in the shader on the
// final e, n. The base is bilinear between nodes; the dominant curvature term (e² + n²) / 2R is taken
// out before storing and re-added in the shader, so what gets interpolated is nearly planar.
// Residual interpolation error is < 0.25 m on z7–z8 tiles (≥ ~80 km away) and < 2 cm elsewhere.
import {
	type CpuHeightsTile,
	type DemRaster,
	type TileKey,
	tileBounds,
	tileId,
} from "../dem";
import {
	DEG,
	distanceM,
	EARTH_R,
	type EnuFrame,
	REFRACTION_K,
} from "../geodesy";
import type { TileMesh } from "./terrain-data";

/**
 * A loaded tile as the streamer meshes it: a DemRaster whose heights may be lazy (dem/cpu-heights.ts;
 * a GPU-decoded tile has `lazyHeights` + `heightStats` and no `heights` until a CPU consumer asks).
 */
export type StreamRaster = Omit<DemRaster, "heights"> & CpuHeightsTile;

export type BatchGrid = {
	/** Base cells per side (the base texture layer holds (G+1)² nodes). */
	G: number;
	/** (G+1)² × 4, row 0 = north: e, n, u + (e² + n²) / 2R of the h = 0 surface (no refraction), 0. */
	base: Float32Array;
	/** Frame origin (the shader's up vector is relative to it). */
	frameLat: number;
	frameLon: number;
	/** Mercator angle at the north edge (π − 2πy/2^z) and its span over the tile (2π/2^z). */
	merc0: number;
	mercSpan: number;
	/** West edge longitude minus the frame's, and the tile's longitude span (radians). */
	dlon0: number;
	dlonSpan: number;
	/** Skirt drop (m), as buildMesh. */
	skirt: number;
	/** ENU bounding sphere (cx, cy, cz, r), conservative. */
	sphere: [number, number, number, number];
};

/** Largest base grid (texture layer size is BASE_MAX + 1). */
export const BASE_MAX = 64;

const EMPTY_F32 = new Float32Array(0);
const EMPTY_U32 = new Uint32Array(0);

/** Base cells per side: 64 on the big far tiles (z ≤ 9), 32 elsewhere. */
export const baseCells = (z: number) => (z <= 9 ? 64 : 32);

/** Triangles buildMesh emits for `seg` (grid + 4 double-sided skirts). */
export const gridTriangles = (seg: number) => 2 * seg * seg + 16 * seg;

/** Triangle count of a mesh, full or batched-lite. */
export const meshTriangles = (m: TileMesh) =>
	m.indices.length ? m.indices.length / 3 : gridTriangles(m.seg);

/**
 * The batch grid of tile `key`. `heights` = the tile's heights, or their exact lo / hi
 * (dem/cpu-heights.ts HeightStats of a GPU-decoded tile): only the range is read.
 */
export function buildBatchGrid(
	frame: EnuFrame,
	key: TileKey,
	heights: Float32Array | { lo: number; hi: number },
): BatchGrid {
	const G = baseCells(key.z);
	const Z = 2 ** key.z;
	const b = tileBounds(key);
	const sizeM = distanceM(
		{ lat: b.south, lon: b.west },
		{ lat: b.south, lon: b.east },
	);
	const skirt = Math.max(30, sizeM * 0.03);
	const n = G + 1;
	const base = new Float32Array(n * n * 4);
	const tmp = [0, 0, 0];
	const lift = REFRACTION_K / (2 * EARTH_R);
	const merc0 = Math.PI - (2 * Math.PI * key.y) / Z;
	const mercSpan = (2 * Math.PI) / Z;
	const lonW = (key.x / Z) * 360 - 180;
	const lonSpan = 360 / Z;
	for (let j = 0; j < n; j++) {
		const lat = Math.atan(Math.sinh(merc0 - (j / G) * mercSpan)) / DEG;
		for (let i = 0; i < n; i++) {
			const lon = lonW + (i / G) * lonSpan;
			frame.fromGeo(lat, lon, 0, tmp);
			const d2 = tmp[0] * tmp[0] + tmp[1] * tmp[1];
			const k = (j * n + i) * 4;
			base[k] = tmp[0];
			base[k + 1] = tmp[1];
			// fromGeo's u has the refraction lift: take it out, and the curvature drop with it
			base[k + 2] = tmp[2] - d2 * lift + d2 / (2 * EARTH_R);
		}
	}
	// bounding box over a 9×9 subset of nodes at the lowest (skirt) and highest height
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	// a typed array (any realm) is scanned; anything else is the exact { lo, hi } of a lazy tile
	if (ArrayBuffer.isView(heights))
		for (let i = 0; i < heights.length; i++) {
			const h = heights[i];
			if (h < lo) lo = h;
			if (h > hi) hi = h;
		}
	else ({ lo, hi } = heights);
	if (!Number.isFinite(lo)) lo = hi = 0;
	const mn = [Infinity, Infinity, Infinity];
	const mx = [-Infinity, -Infinity, -Infinity];
	for (let j = 0; j <= 8; j++) {
		const lat = Math.atan(Math.sinh(merc0 - (j / 8) * mercSpan)) / DEG;
		for (let i = 0; i <= 8; i++) {
			const lon = lonW + (i / 8) * lonSpan;
			for (const h of [lo - skirt, hi]) {
				frame.fromGeo(lat, lon, h, tmp);
				for (let c = 0; c < 3; c++) {
					if (tmp[c] < mn[c]) mn[c] = tmp[c];
					if (tmp[c] > mx[c]) mx[c] = tmp[c];
				}
			}
		}
	}
	// the surface sags / bulges between sampled nodes by ≲ (size/8)² / 8R: pad generously
	const pad = 0.01 * sizeM + 20;
	const sphere: BatchGrid["sphere"] = [
		(mn[0] + mx[0]) / 2,
		(mn[1] + mx[1]) / 2,
		(mn[2] + mx[2]) / 2,
		Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2 + pad,
	];
	return {
		G,
		base,
		frameLat: frame.lat,
		frameLon: frame.lon,
		merc0,
		mercSpan,
		dlon0: (lonW - frame.lon) * DEG,
		dlonSpan: lonSpan * DEG,
		skirt,
		sphere,
	};
}

/**
 * A TileMesh without vertex arrays (the batched path builds them on the GPU). `dem` may be lazy
 * (no `heights`, a `lazyHeights` source and exact `heightStats`: a GPU-decoded tile).
 */
export function buildLiteMesh(
	frame: EnuFrame,
	dem: StreamRaster,
	seg: number,
	distance: number,
	focus: boolean,
): TileMesh {
	const range = dem.heights ?? dem.heightStats;
	// invariant: a lazy raster carries its exact stats (deck-webgpu/terrain-gpu-decode.ts)
	if (!range) throw new Error("buildLiteMesh: lazy tile without heightStats");
	return {
		id: tileId(dem.key),
		key: dem.key,
		distance,
		size: dem.size,
		heights: dem.heights,
		lazyHeights: dem.lazyHeights,
		gpuLayer: dem.gpuLayer,
		heightStats: dem.heightStats,
		sourceZ: dem.source.z,
		focus,
		seg,
		positions: EMPTY_F32,
		normals: EMPTY_F32,
		texCoords: EMPTY_F32,
		elev: EMPTY_F32,
		indices: EMPTY_U32,
		grid: buildBatchGrid(frame, dem.key, range),
	};
}

const gridCache = new Map<
	number,
	{ grid: Float32Array; indices: Uint32Array }
>();

/**
 * The shared grid of `seg` segments: per vertex (i, j, skirt), in buildMesh's vertex order (grid
 * rows, then the four edge copies) with buildMesh's indices, so the batched mesh is the same
 * triangulation.
 */
export function gridMesh(seg: number) {
	const hit = gridCache.get(seg);
	if (hit) return hit;
	const n = seg + 1;
	const vCount = n * n + 4 * n;
	const grid = new Float32Array(vCount * 3);
	for (let j = 0; j < n; j++)
		for (let i = 0; i < n; i++) {
			const k = (j * n + i) * 3;
			grid[k] = i;
			grid[k + 1] = j;
		}
	const indices = new Uint32Array(6 * seg * seg + 48 * seg);
	let w = 0;
	for (let j = 0; j < seg; j++)
		for (let i = 0; i < seg; i++) {
			const a = j * n + i;
			const c = a + n;
			indices[w++] = a;
			indices[w++] = c;
			indices[w++] = a + 1;
			indices[w++] = a + 1;
			indices[w++] = c;
			indices[w++] = c + 1;
		}
	const edges = [
		Array.from({ length: n }, (_, i) => i),
		Array.from({ length: n }, (_, i) => (n - 1) * n + i),
		Array.from({ length: n }, (_, j) => j * n),
		Array.from({ length: n }, (_, j) => j * n + n - 1),
	];
	let v = n * n;
	for (const edge of edges) {
		const start = v;
		for (const k of edge) {
			grid[v * 3] = grid[k * 3];
			grid[v * 3 + 1] = grid[k * 3 + 1];
			grid[v * 3 + 2] = 1;
			v++;
		}
		for (let i = 0; i < n - 1; i++) {
			const a = edge[i];
			const bb = edge[i + 1];
			const c = start + i;
			const d = start + i + 1;
			for (const x of [a, c, bb, bb, c, d, a, bb, c, bb, d, c])
				indices[w++] = x;
		}
	}
	const out = { grid, indices };
	gridCache.set(seg, out);
	return out;
}

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Renderer-agnostic terrain for the deck.gl path: the same quadtree tile selection and
// camera-anchored ENU meshing as ../terrain.ts, but emitted as plain typed arrays, plus
// CPU queries (height lookup, ray casting, line of sight) for labels, draping and picking.

import { cachedFetch, tilePriority } from "../cache";
import {
	type CpuHeightsTile,
	type DemRaster,
	getCpuHeights,
	latToTileY,
	lonToTileX,
	sampleGrid,
	type TileKey,
	tileBounds,
	tileId,
	tileNum,
	tileXToLon,
	tileYToLat,
} from "../dem";
import {
	bearingDeg,
	DEG,
	distanceM,
	EARTH_R,
	type EnuFrame,
	M_PER_DEG_LAT,
	REFRACTION_K,
	WGS84,
} from "../geodesy";
import { imageryTileUrls } from "../licences/imagery";
import type { BatchGrid } from "./batched-terrain-grid";

export type ImagerySource = "satellite" | "topo";

/**
 * A streamed tile. Heights are size × size (512 near the camera, 256 elsewhere, less on fallback),
 * read through getCpuHeights(tile) (dem/cpu-heights.ts): `heights` for a CPU-decoded tile, or
 * materialised on first use from `lazyHeights` for a GPU-decoded one (flag terrainGpuDecode), whose
 * `heightStats` carry the exact lo / hi the batch grid and the colour ramp need.
 */
export type TileMesh = CpuHeightsTile & {
	id: string;
	key: TileKey;
	distance: number;
	/** Height grid is size × size. */
	size: number;
	/** Zoom the DEM data actually came from (< key.z where the finer tile 404'd). */
	sourceZ: number;
	/** Inside the photo's viewing wedge (refined harder). */
	focus: boolean;
	/** Mesh segments per side. */
	seg: number;
	positions: Float32Array;
	normals: Float32Array;
	texCoords: Float32Array;
	elev: Float32Array;
	indices: Uint32Array;
	/**
	 * The batched path's per-tile data (batched-terrain-grid.ts; terrain-mode.ts "batched"). A mesh
	 * built for the batched path only has empty vertex arrays.
	 */
	grid?: BatchGrid;
};

/** Horizontal viewing wedge to refine harder (the photo's field of view plus a margin). */
export type ViewWedge = { headingDeg: number; halfAngleDeg: number };

export type TerrainStats = {
	tiles: number;
	/** Rendered tile count per zoom. */
	zooms: Record<number, number>;
	/** Tiles whose data came from an ancestor (404 / failed fetch). */
	fallbacks: number;
	/** Desired tiles standing in via a loaded parent/children while they load. */
	standIns: number;
	/** Desired tiles still queued or loading. */
	pending: number;
	/** Desired tiles given up on after repeated failed loads (stood in for; terrain-stream.ts). */
	failed?: number;
	triangles: number;
	/** Time from the view change that started this generation to its completion. */
	loadMs: number;
	/** Selection generations so far (1 = initial load). */
	generation: number;
	/** Main-thread ms spent building tile meshes / batch grids so far (all generations). */
	buildMs?: number;
};

/** TerrainSet.locate's result (reused across calls by the caller). */
export type TileLocation = { tile: TileMesh; px: number; py: number };

/**
 * TerrainSet.localMax over any height lookup: the start point, then a 9 × 9 grid over ±radiusM, in
 * this order (the GPU gathers record and replay these calls, deck-webgpu/height-gather.ts).
 */
export function localMaxOf(
	heightAt: (lat: number, lon: number) => number | null,
	lat: number,
	lon: number,
	radiusM = 150,
) {
	let best = {
		lat,
		lon,
		h: heightAt(lat, lon) ?? Number.NEGATIVE_INFINITY,
	};
	const dLat = radiusM / M_PER_DEG_LAT;
	const dLon = radiusM / (M_PER_DEG_LAT * Math.cos(lat * DEG));
	for (let i = -4; i <= 4; i++)
		for (let j = -4; j <= 4; j++) {
			const la = lat + (i / 4) * dLat;
			const lo = lon + (j / 4) * dLon;
			const h = heightAt(la, lo);
			if (h != null && h > best.h) best = { lat: la, lon: lo, h };
		}
	return best;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (i < items.length) await fn(items[i++]);
		}),
	);
}

export class TerrainSet {
	readonly frame: EnuFrame;
	readonly tiles: TileMesh[];
	private byId = new Map<number, TileMesh>();
	private zooms: number[];
	/** Load diagnostics (set by TerrainStreamer). */
	stats?: TerrainStats;

	constructor(frame: EnuFrame, tiles: TileMesh[]) {
		this.frame = frame;
		this.tiles = tiles;
		for (const t of tiles) this.byId.set(tileNum(t.key.z, t.key.x, t.key.y), t);
		this.zooms = [...new Set(tiles.map((t) => t.key.z))].sort((a, b) => b - a);
	}

	/** Metres above sea level from the finest loaded tile, or null outside coverage. */
	heightAt(lat: number, lon: number): number | null {
		// Mercator once (z 0), scaled by 2^z per zoom: the same values lonToTileX/latToTileY(…, z) give
		const mx = lonToTileX(lon, 0);
		const my = latToTileY(lat, 0);
		for (const z of this.zooms) {
			const fx = mx * 2 ** z;
			const fy = my * 2 ** z;
			const x = Math.floor(fx);
			const y = Math.floor(fy);
			const t = this.byId.get(tileNum(z, x, y));
			if (t)
				return sampleGrid(
					t.heights ?? getCpuHeights(t),
					t.size,
					(fx - x) * t.size,
					(fy - y) * t.size,
				);
		}
		return null;
	}

	/**
	 * heightAt's lookup without the heights: the finest loaded tile at (lat, lon) and the pixel position
	 * heightAt hands sampleGrid, written to `out` (same arithmetic as heightAt); null outside coverage.
	 * heightAt(lat, lon) === sampleGrid(getCpuHeights(out.tile), out.tile.size, out.px, out.py).
	 */
	locate(lat: number, lon: number, out: TileLocation): TileLocation | null {
		const mx = lonToTileX(lon, 0);
		const my = latToTileY(lat, 0);
		for (const z of this.zooms) {
			const fx = mx * 2 ** z;
			const fy = my * 2 ** z;
			const x = Math.floor(fx);
			const y = Math.floor(fy);
			const t = this.byId.get(tileNum(z, x, y));
			if (t) {
				out.tile = t;
				out.px = (fx - x) * t.size;
				out.py = (fy - y) * t.size;
				return out;
			}
		}
		return null;
	}

	/** Highest DEM point within `radiusM` (snaps OSM peak nodes onto the DEM summit). */
	localMax(lat: number, lon: number, radiusM = 150) {
		return localMaxOf((la, lo) => this.heightAt(la, lo), lat, lon, radiusM);
	}

	/**
	 * Fast ENU → (lat, lon, h) for ray marching: equirectangular about the origin, and the
	 * refraction-adjusted curvature drop undone analytically. Good to metres inside ~150 km.
	 */
	private enuToGeoFast(e: number, n: number, u: number) {
		const f = this.frame;
		const lat = f.lat + n / (EARTH_R * DEG);
		const lon = f.lon + e / (EARTH_R * DEG * Math.cos(f.lat * DEG));
		const h = f.h + u + ((1 - REFRACTION_K) * (e * e + n * n)) / (2 * EARTH_R);
		return { lat, lon, h };
	}

	/** Terrain clearance of an ENU point (positive = above ground; NaN = no data). */
	clearance(p: ArrayLike<number>) {
		const g = this.enuToGeoFast(p[0], p[1], p[2]);
		const h = this.heightAt(g.lat, g.lon);
		return h == null ? Number.NaN : g.h - h;
	}

	/** First terrain hit along a unit ENU ray, as range in metres (null = sky / no data). */
	raycast(
		origin: ArrayLike<number>,
		dir: ArrayLike<number>,
		maxRange = 150_000,
		minRange = 5,
	): number | null {
		const p = [0, 0, 0];
		const at = (t: number) => {
			p[0] = origin[0] + dir[0] * t;
			p[1] = origin[1] + dir[1] * t;
			p[2] = origin[2] + dir[2] * t;
			return this.clearance(p);
		};
		let prevT = minRange;
		let t = minRange;
		while (t < maxRange) {
			const c = at(t);
			if (c < 0) {
				let lo = prevT;
				let hi = t;
				for (let i = 0; i < 12; i++) {
					const mid = (lo + hi) / 2;
					if (at(mid) < 0) hi = mid;
					else lo = mid;
				}
				return hi;
			}
			prevT = t;
			// step with range, but never skip more than the clearance allows
			const step = Math.max(2, t * 0.004);
			t += Number.isNaN(c) ? step : Math.max(step, Math.min(c * 0.5, t * 0.02));
		}
		return null;
	}

	/** True if the straight line from `a` to `b` clears the terrain (b's own summit excluded). */
	lineOfSight(a: ArrayLike<number>, b: ArrayLike<number>, tolerance = 30) {
		// aim slightly above the target so a summit that just peeks over a ridge still counts
		const d = [b[0] - a[0], b[1] - a[1], b[2] + tolerance - a[2]];
		const len = Math.hypot(d[0], d[1], d[2]);
		const dir = d.map((v) => v / len);
		return this.raycast(a, dir, len - Math.max(150, len * 0.01), 20) == null;
	}
}

export function buildMesh(
	frame: EnuFrame,
	dem: DemRaster,
	seg: number,
	distance: number,
	focus: boolean,
): TileMesh {
	const { key, heights, size } = dem;
	const n = seg + 1;
	const b = tileBounds(key);
	const sizeM = distanceM(
		{ lat: b.south, lon: b.west },
		{ lat: b.south, lon: b.east },
	);
	const skirt = Math.max(30, sizeM * 0.03);
	const vCount = n * n + 4 * n;
	const pos = new Float32Array(vCount * 3);
	const uv = new Float32Array(vCount * 2);
	const elev = new Float32Array(vCount);
	// WGS84 → ECEF → ENU as frame.fromGeo does, with the latitude terms per row and the longitude
	// terms per column instead of per vertex (bit-identical; ../terrain.ts buildMesh)
	const { A, E2 } = WGS84;
	const cosLam = new Float64Array(n);
	const sinLam = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const lam = tileXToLon(key.x + i / seg, key.z) * DEG;
		cosLam[i] = Math.cos(lam);
		sinLam[i] = Math.sin(lam);
	}
	const tmp = [0, 0, 0];
	for (let j = 0; j < n; j++) {
		const phi = tileYToLat(key.y + j / seg, key.z) * DEG;
		const sp = Math.sin(phi);
		const N = A / Math.sqrt(1 - E2 * sp * sp);
		const cp = Math.cos(phi);
		for (let i = 0; i < n; i++) {
			const h = sampleGrid(heights, size, (i / seg) * size, (j / seg) * size);
			frame.fromEcef(
				(N + h) * cp * cosLam[i],
				(N + h) * cp * sinLam[i],
				(N * (1 - E2) + h) * sp,
				tmp,
			);
			const k = j * n + i;
			pos[k * 3] = tmp[0];
			pos[k * 3 + 1] = tmp[1];
			pos[k * 3 + 2] = tmp[2];
			uv[k * 2] = i / seg;
			uv[k * 2 + 1] = j / seg; // row 0 = north edge = top of the imagery tile
			elev[k] = h;
		}
	}

	// Grid normals by central differences (ENU is right-handed, rows run north → south).
	const nor = new Float32Array(vCount * 3);
	for (let j = 0; j < n; j++)
		for (let i = 0; i < n; i++) {
			const l = j * n + Math.max(i - 1, 0);
			const r = j * n + Math.min(i + 1, n - 1);
			const u = Math.max(j - 1, 0) * n + i;
			const d = Math.min(j + 1, n - 1) * n + i;
			const ex = pos[r * 3] - pos[l * 3];
			const ey = pos[r * 3 + 1] - pos[l * 3 + 1];
			const ez = pos[r * 3 + 2] - pos[l * 3 + 2];
			const sx = pos[u * 3] - pos[d * 3];
			const sy = pos[u * 3 + 1] - pos[d * 3 + 1];
			const sz = pos[u * 3 + 2] - pos[d * 3 + 2];
			let nx = ey * sz - ez * sy;
			let ny = ez * sx - ex * sz;
			let nz = ex * sy - ey * sx;
			const len = Math.hypot(nx, ny, nz) || 1;
			nx /= len;
			ny /= len;
			nz /= len;
			const k = (j * n + i) * 3;
			nor[k] = nx;
			nor[k + 1] = ny;
			nor[k + 2] = nz;
		}

	// Skirts: drop a copy of each edge to hide cracks between LOD levels.
	for (let e = 0; e < 4; e++)
		for (let t = 0; t < n; t++) {
			const k = edgeVertex(e, t, n);
			const v = n * n + e * n + t;
			pos[v * 3] = pos[k * 3];
			pos[v * 3 + 1] = pos[k * 3 + 1];
			pos[v * 3 + 2] = pos[k * 3 + 2] - skirt;
			uv[v * 2] = uv[k * 2];
			uv[v * 2 + 1] = uv[k * 2 + 1];
			elev[v] = elev[k] - skirt;
			nor[v * 3] = nor[k * 3];
			nor[v * 3 + 1] = nor[k * 3 + 1];
			nor[v * 3 + 2] = nor[k * 3 + 2];
		}
	return {
		id: tileId(key),
		key,
		distance,
		size,
		heights,
		sourceZ: dem.source.z,
		focus,
		seg,
		positions: pos,
		normals: nor,
		texCoords: uv,
		elev,
		// shared per seg (read-only: layers upload their own copy)
		indices: tileIndex(seg),
	};
}

/** Vertex t (0..n-1) along tile edge e (north, south, west, east) of an n×n grid. */
function edgeVertex(e: number, t: number, n: number) {
	return e === 0
		? t
		: e === 1
			? (n - 1) * n + t
			: e === 2
				? t * n
				: t * n + n - 1;
}

const tileIndexCache = new Map<number, Uint32Array>();

/** Triangle index of a (seg+1)² tile grid plus its four skirts (buildMesh's vertex layout). */
function tileIndex(seg: number): Uint32Array {
	const hit = tileIndexCache.get(seg);
	if (hit) return hit;
	const n = seg + 1;
	const index = new Uint32Array(seg * seg * 6 + 4 * (n - 1) * 12);
	let o = 0;
	const push = (...v: number[]) => {
		for (const x of v) index[o++] = x;
	};
	for (let j = 0; j < seg; j++)
		for (let i = 0; i < seg; i++) {
			const a = j * n + i;
			const c = a + n;
			push(a, c, a + 1, a + 1, c, c + 1);
		}
	for (let e = 0; e < 4; e++) {
		const start = n * n + e * n;
		for (let i = 0; i < n - 1; i++) {
			const a = edgeVertex(e, i, n);
			const b = edgeVertex(e, i + 1, n);
			const c = start + i;
			const d = start + i + 1;
			push(a, c, b, b, c, d, a, b, c, b, d, c);
		}
	}
	tileIndexCache.set(seg, index);
	return index;
}

export type TileChoice = {
	key: TileKey;
	distance: number;
	size: number;
	focus: boolean;
};

/**
 * Distance-driven quadtree like ../terrain.ts selectTiles, tuned for 512 px tiles: a tile
 * splits while `distance < lod × tileSize`, with a larger `lod` inside the photo's viewing
 * wedge so near-field terrain in view reaches z15–z17 and falls off with range, while the rest
 * of the circle stays coarse (it's only seen from the 3D orbit view).
 */
export function selectDemTiles(
	lat: number,
	lon: number,
	opts: {
		radiusM: number;
		maxZoom: number;
		minZoom: number;
		lod: number;
		lodOutside: number;
		wedge?: ViewWedge;
	},
): TileChoice[] {
	const { radiusM, maxZoom, minZoom, lod, lodOutside, wedge } = opts;
	const dLat = radiusM / M_PER_DEG_LAT;
	const dLon = radiusM / (M_PER_DEG_LAT * Math.cos(lat * DEG));
	const here = { lat, lon };
	const rel = (la: number, lo: number) =>
		wedge
			? ((bearingDeg(here, { lat: la, lon: lo }) - wedge.headingDeg + 540) %
					360) -
				180
			: 0;
	const inWedge = (
		b: ReturnType<typeof tileBounds>,
		d: number,
		size: number,
	) => {
		if (!wedge || d < size) return true;
		const hw = wedge.halfAngleDeg;
		const a = [
			rel(b.north, b.west),
			rel(b.north, b.east),
			rel(b.south, b.west),
			rel(b.south, b.east),
		];
		if (a.some((v) => Math.abs(v) <= hw)) return true;
		const lo = Math.min(...a);
		const hi = Math.max(...a);
		return lo < -hw && hi > hw && hi - lo < 180; // wedge passes between the corners
	};
	const out: TileChoice[] = [];
	const visit = (t: TileKey) => {
		const b = tileBounds(t);
		const nearest = {
			lat: Math.min(Math.max(lat, b.south), b.north),
			lon: Math.min(Math.max(lon, b.west), b.east),
		};
		const d = distanceM(here, nearest);
		if (d > radiusM) return;
		const size = distanceM(
			{ lat: b.south, lon: b.west },
			{ lat: b.south, lon: b.east },
		);
		const focus = inWedge(b, d, size);
		if (t.z < maxZoom && d < (focus ? lod : lodOutside) * size) {
			for (const [dx, dy] of [
				[0, 0],
				[1, 0],
				[0, 1],
				[1, 1],
			])
				visit({ z: t.z + 1, x: t.x * 2 + dx, y: t.y * 2 + dy });
		} else out.push({ key: t, distance: d, size, focus });
	};
	const x0 = Math.floor(lonToTileX(lon - dLon, minZoom));
	const x1 = Math.floor(lonToTileX(lon + dLon, minZoom));
	const y0 = Math.floor(latToTileY(lat + dLat, minZoom));
	const y1 = Math.floor(latToTileY(lat - dLat, minZoom));
	for (let x = x0; x <= x1; x++)
		for (let y = y0; y <= y1; y++) visit({ z: minZoom, x, y });
	return out.sort((a, b) => a.distance - b.distance);
}

/**
 * Mesh resolution: leaves of the quadtree all sit at roughly the same distance/size ratio, so
 * a fixed segment count gives a roughly constant angular vertex spacing (~4 mrad in the wedge
 * at lod 2). Only the tiles around the camera, which are much nearer than their size, get
 * the full 256 segments (every 2nd pixel of a 512 px tile).
 */
export function segmentsFor(t: TileChoice) {
	if (!t.focus) return t.distance < t.size * 0.5 ? 128 : 64;
	return t.distance < t.size ? 256 : 128;
}

// ---------- draped imagery ----------

// URL lists come from the imagery provider abstraction (src/lib/licences/imagery.ts); its
// "default" provider is byte-identical to the URLs this file used to build inline.
function imageryUrls(
	src: ImagerySource,
	z: number,
	x: number,
	y: number,
): string[] {
	return imageryTileUrls(
		src,
		z,
		x,
		y,
		tileYToLat(y + 0.5, z),
		tileXToLon(x + 0.5, z),
	);
}

async function fetchBitmap(
	urls: string[],
	priority: number,
	signal?: AbortSignal,
) {
	for (const url of urls) {
		try {
			const res = await cachedFetch(url, { priority, signal });
			if (res.ok) return await createImageBitmap(await res.blob());
		} catch (e) {
			if ((e as Error).name === "AbortError") throw e;
		}
	}
	return null;
}

/** Mosaic imagery for every tile (up to 4× finer than the DEM tile's zoom near the camera). */
export async function loadImagery(
	tiles: TileMesh[],
	src: ImagerySource,
	onTile: (id: string, image: ImageBitmap) => void,
	signal?: AbortSignal,
) {
	await pool(tiles, 8, async (t) => {
		if (signal?.aborted) return;
		// Imagery tiles are 256 px, the DEM tile it drapes spans a whole z tile: add levels
		// (0–2, capped at z19) until an imagery pixel subtends ≲1.5 mrad from the camera.
		const b = tileBounds(t.key);
		const sizeM = distanceM(
			{ lat: b.south, lon: b.west },
			{ lat: b.south, lon: b.east },
		);
		const want = 0.0015 * Math.max(t.distance, sizeM / 2);
		let extra = 0;
		while (
			extra < 2 &&
			t.key.z + extra < 19 &&
			sizeM / (256 * 2 ** extra) > want
		)
			extra++;
		const f = 2 ** extra;
		const z = t.key.z + extra;
		const canvas = new OffscreenCanvas(256 * f, 256 * f);
		const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
		const jobs: Promise<void>[] = [];
		for (let dy = 0; dy < f; dy++)
			for (let dx = 0; dx < f; dx++)
				jobs.push(
					fetchBitmap(
						imageryUrls(src, z, t.key.x * f + dx, t.key.y * f + dy),
						// after the DEM at equal distance; out-of-view tiles last
						tilePriority((t.focus ? 1 : 4) * t.distance + 500, z),
						signal,
					)
						.then((img) => {
							if (!img) return;
							ctx.drawImage(img, dx * 256, dy * 256);
							img.close();
						})
						.catch(() => {}),
				);
		await Promise.all(jobs);
		if (signal?.aborted) return;
		onTile(t.id, canvas.transferToImageBitmap());
	});
}

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Terrain for a roll: a DEM quadtree refined around EVERY viewpoint, not one centre.
//
// TerrainStreamer (deck/terrain-stream.ts) refines around its frame origin only, so in a roll
// spread over kilometres the ground at each photographer stays a coarse mesh: the fly-in lands
// inside the hill and the near-field drape streaks. Here a tile splits while it is within
// `lod` × its size of any focus (the viewpoints) and is otherwise kept at the context LOD around
// the roll centre. The set is static (a roll doesn't move), loaded once with a concurrency cap;
// meshes come from the same buildMesh / loadDemTile as the deck backend.
import { tilePriority } from "#/lib/cache";
import { buildBatchGrid } from "#/lib/deck/batched-terrain-grid";
import { buildMesh, TerrainSet, type TileMesh } from "#/lib/deck/terrain-data";
import { terrainBuild } from "#/lib/deck/terrain-mode";
import { downsample2 } from "#/lib/deck/terrain-stream";
import {
	type DemRaster,
	latToTileY,
	loadDemTile,
	lonToTileX,
	type TileKey,
	tileBounds,
} from "#/lib/dem";
import {
	distanceM,
	type EnuFrame,
	type LatLon,
	M_PER_DEG_LAT,
} from "#/lib/geodesy";

export type RollTerrainOptions = {
	foci: LatLon[];
	/** Context radius around the frame origin (m). */
	radiusM: number;
	/** Split while nearer a focus than lod × tile size. */
	lod?: number;
	/** Split factor for the context (distance from the frame origin). */
	lodContext?: number;
	minZoom?: number;
	maxZoom?: number;
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
	signal?: AbortSignal;
};

type Choice = { key: TileKey; distance: number; size: number; seg: number };

function selectRollTiles(frame: EnuFrame, o: RollTerrainOptions): Choice[] {
	const { foci, radiusM } = o;
	const lod = o.lod ?? 1.5;
	const lodContext = o.lodContext ?? 0.8;
	const minZoom = o.minZoom ?? 8;
	const maxZoom = o.maxZoom ?? 16;
	const here = { lat: frame.lat, lon: frame.lon };
	const nearestIn = (b: ReturnType<typeof tileBounds>, p: LatLon) => ({
		lat: Math.min(Math.max(p.lat, b.south), b.north),
		lon: Math.min(Math.max(p.lon, b.west), b.east),
	});
	const out: Choice[] = [];
	const visit = (t: TileKey) => {
		const b = tileBounds(t);
		const dc = distanceM(here, nearestIn(b, here));
		if (dc > radiusM) return;
		const size = distanceM(
			{ lat: b.south, lon: b.west },
			{ lat: b.south, lon: b.east },
		);
		let df = Number.POSITIVE_INFINITY;
		for (const f of foci) df = Math.min(df, distanceM(f, nearestIn(b, f)));
		if (t.z < maxZoom && (df < lod * size || dc < lodContext * size)) {
			for (const [dx, dy] of [
				[0, 0],
				[1, 0],
				[0, 1],
				[1, 1],
			])
				visit({ z: t.z + 1, x: t.x * 2 + dx, y: t.y * 2 + dy });
			return;
		}
		// the imagery resolution and mesh density follow the nearest viewpoint
		const distance = Math.min(df, dc);
		out.push({ key: t, distance, size, seg: distance < size ? 128 : 96 });
	};
	const dLat = radiusM / M_PER_DEG_LAT;
	const dLon =
		radiusM / (M_PER_DEG_LAT * Math.cos((frame.lat * Math.PI) / 180));
	const x0 = Math.floor(lonToTileX(frame.lon - dLon, minZoom));
	const x1 = Math.floor(lonToTileX(frame.lon + dLon, minZoom));
	const y0 = Math.floor(latToTileY(frame.lat + dLat, minZoom));
	const y1 = Math.floor(latToTileY(frame.lat - dLat, minZoom));
	for (let x = x0; x <= x1; x++)
		for (let y = y0; y <= y1; y++) visit({ z: minZoom, x, y });
	return out.sort((a, b) => a.distance - b.distance);
}

/** Load every selected tile's mesh; resolves with the complete set (null if aborted). */
export async function loadRollTerrain(
	frame: EnuFrame,
	o: RollTerrainOptions,
): Promise<TerrainSet | null> {
	const want = selectRollTiles(frame, o);
	const meshes: TileMesh[] = [];
	let done = 0;
	let next = 0;
	const { grid } = terrainBuild();
	const worker = async () => {
		while (next < want.length && !o.signal?.aborted) {
			const w = want[next++];
			let dem: DemRaster | null = await loadDemTile(w.key, {
				minZoom: (o.minZoom ?? 8) - 2,
				priority: tilePriority(w.distance, w.key.z),
				signal: o.signal,
			}).catch(() => null);
			if (dem && !o.signal?.aborted) {
				while (dem.size > 2 * w.seg && dem.size > 256) dem = downsample2(dem);
				// the full mesh always (MultiDrapeLayer draws per tile); the batch grid too when
				// TerrainLayer draws the batched path (terrain-mode.ts), which reads only `grid`
				const mesh = buildMesh(frame, dem, w.seg, w.distance, true);
				if (grid) mesh.grid = buildBatchGrid(frame, dem.key, dem.heights);
				meshes.push(mesh);
			}
			o.onProgress?.(++done, want.length);
		}
	};
	await Promise.all(Array.from({ length: o.concurrency ?? 10 }, worker));
	if (o.signal?.aborted) return null;
	const set = new TerrainSet(
		frame,
		meshes.sort((a, b) => a.distance - b.distance),
	);
	const zooms: Record<number, number> = {};
	for (const t of meshes) zooms[t.key.z] = (zooms[t.key.z] ?? 0) + 1;
	set.stats = {
		tiles: meshes.length,
		zooms,
		fallbacks: meshes.filter((t) => t.sourceZ < t.key.z).length,
		standIns: 0,
		pending: 0,
		triangles: meshes.reduce((n, t) => n + t.indices.length / 3, 0),
		loadMs: -1,
		generation: 1,
	};
	return set;
}

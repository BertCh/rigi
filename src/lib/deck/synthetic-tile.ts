// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// A synthetic DEM tile for the layer checks and lab pages: one real tile of the Bernese Oberland
// (default z12, about 6.7 km square) whose heights come from an analytic function of the frame's
// ENU (x east, y north, metres), in the lite form the batched terrain draws (batched-terrain-grid.ts).
import {
	type DemRaster,
	latToTileY,
	lonToTileX,
	type TileKey,
	tileBounds,
} from "#/lib/dem";
import { EnuFrame } from "#/lib/geodesy";
import { buildBatchGrid, buildLiteMesh } from "./batched-terrain-grid";
import { buildMesh, type TileMesh } from "./terrain-data";

export type SyntheticTile = { frame: EnuFrame; tile: TileMesh };

export type SyntheticTileOptions = {
	/** Tile zoom (default 12). */
	z?: number;
	/** Height raster side (default 257, so 256 mesh segments). */
	size?: number;
	/**
	 * Where the frame origin sits: undefined = the tile centre; a number = that many metres south of
	 * the tile's south edge (the tile then spans y = southEdgeM .. southEdgeM + its height).
	 */
	southEdgeM?: number;
	/** The frame's ellipsoid height (ENU z = height - frameH, default 0). */
	frameH?: number;
	/** Mesh segments per side (default size - 1). */
	seg?: number;
	/** Also build the CPU mesh (buildMesh), as roll-terrain does for the multi-drape layer. */
	full?: boolean;
};

/** `height(x, y)`: metres above sea level at the frame's ENU (x, y). */
export function createSyntheticTile(
	height: (x: number, y: number) => number,
	opts: SyntheticTileOptions = {},
): SyntheticTile {
	const z = opts.z ?? 12;
	const size = opts.size ?? 257;
	const key: TileKey = {
		z,
		x: Math.floor(lonToTileX(8.0, z)),
		y: Math.floor(latToTileY(46.7, z)),
	};
	const b = tileBounds(key);
	const lon = (b.west + b.east) / 2;
	const lat =
		opts.southEdgeM === undefined
			? (b.north + b.south) / 2
			: b.south - opts.southEdgeM / 111_320;
	const frame = new EnuFrame(lat, lon, opts.frameH ?? 0);
	const sw = [0, 0, 0];
	const ne = [0, 0, 0];
	frame.fromGeo(b.south, b.west, 0, sw);
	frame.fromGeo(b.north, b.east, 0, ne);
	const heights = new Float32Array(size * size);
	for (let j = 0; j < size; j++)
		for (let i = 0; i < size; i++)
			heights[j * size + i] = height(
				sw[0] + ((ne[0] - sw[0]) * i) / (size - 1),
				ne[1] - ((ne[1] - sw[1]) * j) / (size - 1), // row 0 = north
			);
	const dem: DemRaster = { key, size, heights, source: key };
	const seg = opts.seg ?? size - 1;
	if (!opts.full)
		return { frame, tile: buildLiteMesh(frame, dem, seg, 0, true) };
	const tile = buildMesh(frame, dem, seg, 0, true);
	tile.grid = buildBatchGrid(frame, key, heights);
	return { frame, tile };
}

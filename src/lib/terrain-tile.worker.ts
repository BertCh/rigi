// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/// <reference lib="webworker" />
// Terrain tiles off the main thread (terrain.ts fetchTiles): decode + crop + mesh arrays + kept heights,
// the same buildTile the page would run (terrain-mesh.ts), so the tiles are the same bits.
import { blobHeights } from "./dem/image";
import { buildTile, type TileJob, type TileResult } from "./terrain-mesh";
import { serveWorker } from "./worker-pool";

serveWorker<TileJob, TileResult | null>(async (job) => {
	const t = await buildTile(job, (buf) => blobHeights(new Blob([buf])));
	if (!t) return { out: null };
	const transfer = new Set<ArrayBuffer>(
		[t.pos, t.uv, t.elev, t.nor, t.heights].map((a) => a.buffer as ArrayBuffer),
	);
	return { out: t, transfer: [...transfer] };
});

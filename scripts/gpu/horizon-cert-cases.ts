// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// DEM-derived cases for src/lib/gpu/horizon/certified.check.ts: the app's horizon (LITE_RINGS mosaics
// to 120 km, 0.05° step, k = 0.13, min distance 2 m) marched on the CPU (horizon-fast, the GPU march's
// twin) from each ground-truth photo's eye, written as the march output the certified stages read
// (tan(elevation) as f32, distance f32). Tiles come from Mapterhorn through the node disk cache
// (.cache/dem-mapterhorn; fetched when missing).
//
//   npx tsx scripts/gpu/horizon-cert-cases.ts [IMG_xxxx ...]
//
// Writes out/gpu/horizon-cert/real-cases.json (gitignored).
import fs from "node:fs";
import path from "node:path";
import { MAPTERHORN } from "../../src/lib/dem";
import { DEG, REFRACTION_K } from "../../src/lib/geodesy";
import { computeHorizonFast } from "../../src/lib/horizon-fast/march";
import {
	LITE_RINGS,
	loadMosaics,
	TileStore,
} from "../../src/lib/horizon-fast/mosaic";
import { demTileLoaderNode, ROOT } from "../lib/node-io";

const OUT = path.join(ROOT, "out/gpu/horizon-cert");
const gt = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data/ground-truth.json"), "utf8"),
) as Record<string, { lat?: number; lon?: number; eye?: number }>;
const ids = process.argv.slice(2).length
	? process.argv.slice(2)
	: Object.keys(gt);
const load = demTileLoaderNode(MAPTERHORN);
const store = new TileStore({
	tileSize: MAPTERHORN.tileSize,
	maxZoom: MAPTERHORN.maxZoom,
	load: async (k) => (await load(k)) ?? null,
});

const cases = [];
for (const id of ids) {
	const g = gt[id];
	if (g?.lat == null || g.lon == null || g.eye == null) {
		console.log(`skip ${id}: no lat/lon/eye`);
		continue;
	}
	const t0 = performance.now();
	const mosaics = await loadMosaics(g.lat, g.lon, store, {
		rings: LITE_RINGS,
		maxDistance: 120_000,
	});
	const prof = computeHorizonFast(
		mosaics,
		{ lat: g.lat, lon: g.lon, h: g.eye },
		{
			step: 0.05,
			k: REFRACTION_K,
			maxDistance: 120_000,
			minDistance: 2,
			noRidges: true,
		},
	);
	const n = prof.elevation.length;
	const td = new Float32Array(n * 2);
	let hits = 0;
	for (let i = 0; i < n; i++) {
		const e = prof.elevation[i];
		td[2 * i] = e <= -90 ? -3e38 : Math.tan(e * DEG);
		td[2 * i + 1] = prof.distance[i];
		if (e > -90) hits++;
	}
	cases.push({
		id,
		lat: g.lat,
		lon: g.lon,
		eyeH: g.eye,
		k: REFRACTION_K,
		step: 0.05,
		td: Buffer.from(td.buffer).toString("base64"),
	});
	console.log(
		`${id}: ${hits}/${n} azimuths hit terrain, ${((performance.now() - t0) / 1000).toFixed(1)} s`,
	);
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "real-cases.json"), JSON.stringify({ cases }));
console.log(
	`wrote ${cases.length} cases to ${path.relative(ROOT, OUT)}/real-cases.json`,
);

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Bakes the sample trip's panorama terrain: for every viewpoint the roll's panorama strip can show
 * (two or more photos), the ridgelines and peaks a live trace would give (viewpointTerrain.ts and
 * ridgelines.worker.ts: same rings, eye rule, distance and peaks, traced on the CPU), so the strip
 * shows them with one small fetch instead of a worker over ~100 MB of DEM.
 *
 *   npx tsx scripts/demo/bake-pano-terrain.ts
 *
 * Writes public/demo/pano/<n>.bin (terrainCodec.ts) and public/demo/pano/index.json, which maps
 * each viewpoint's terrainKey to its file. src/lib/demo looks keys up there; a key the bake does not
 * have (another eye, a changed manifest) is traced live as before.
 */
import fs from "node:fs";
import path from "node:path";
import { MAPTERHORN } from "../../src/lib/dem";
import { distanceM } from "../../src/lib/geodesy";
import {
	buildMosaic,
	LITE_RINGS,
	mosaicFor,
	mosaicHeight,
	mosaicTileKeys,
	resolveRings,
	ringWindow,
	TileStore,
} from "../../src/lib/horizon-fast/mosaic";
import {
	type RidgelinePeakInput,
	traceViewpoint,
} from "../../src/lib/roll/mosaic/ridgelines";
import {
	encodeTerrain,
	terrainKey,
} from "../../src/lib/roll/mosaic/terrainCodec";
import { demTileLoaderNode, ROOT } from "../lib/node-io";

/** As viewpointTerrain.ts and roll.ts (not importable in Node: Vite globs and virtual modules). */
const MAX_DISTANCE = 120_000;
const VIEWPOINT_RADIUS_M = 250;
const OUT = path.join(ROOT, "public", "demo", "pano");

type Meta = {
	id: string;
	takenAt: string;
	lat: number;
	lon: number;
	alt: number | null;
};

const manifest = JSON.parse(
	fs.readFileSync(path.join(ROOT, "public", "demo", "manifest.json"), "utf8"),
) as { photos: Meta[]; region: { peaks: RidgelinePeakInput[] } };

// roll.ts groupViewpoints: in capture order, each photo joins the first viewpoint within 250 m,
// then every viewpoint is re-centred on its members
const sorted = [...manifest.photos].sort((a, b) =>
	a.takenAt.localeCompare(b.takenAt),
);
const groups: { lat: number; lon: number; photos: Meta[] }[] = [];
for (const m of sorted) {
	let g = groups.find((v) => distanceM(v, m) < VIEWPOINT_RADIUS_M);
	if (!g) {
		g = { lat: m.lat, lon: m.lon, photos: [] };
		groups.push(g);
	}
	g.photos.push(m);
}
for (const g of groups) {
	g.lat = g.photos.reduce((s, m) => s + m.lat, 0) / g.photos.length;
	g.lon = g.photos.reduce((s, m) => s + m.lon, 0) / g.photos.length;
}

// viewpointTerrain.ts regionPeaks: named peaks with an elevation, one per name and place
const byName = new Map<string, RidgelinePeakInput>();
for (const p of manifest.region.peaks)
	if (p.name && Number.isFinite(p.ele))
		byName.set(`${p.name}@${p.lat.toFixed(3)}`, p);
const peaks = [...byName.values()];

const T = MAPTERHORN.tileSize;
const store = new TileStore({
	tileSize: T,
	maxZoom: MAPTERHORN.maxZoom,
	load: demTileLoaderNode(MAPTERHORN),
});

fs.mkdirSync(OUT, { recursive: true });
const index: Record<string, string> = {};
for (const [i, g] of groups.entries()) {
	if (g.photos.length < 2) continue;
	// viewpointEye: the centroid, at the median known GPS altitude (the demo has no ground truth)
	const alts = g.photos
		.map((p) => p.alt)
		.filter((a): a is number => a != null)
		.sort((a, b) => a - b);
	const r = {
		lat: g.lat,
		lon: g.lon,
		eyeAlt: alts.length ? alts[alts.length >> 1] : null,
	};
	const t0 = performance.now();
	const spans = await resolveRings(LITE_RINGS, r.lat, r.lon, MAX_DISTANCE);
	await store.ensure(mosaicTileKeys(r.lat, r.lon, spans, T));
	const mosaics = spans.map((s) =>
		buildMosaic(store, ringWindow(r.lat, r.lon, s, T, 0, 360), s, r.lat, false),
	);
	// ridgelines.worker.ts's eye rule
	const dem = mosaicHeight(mosaics[0], r.lon, r.lat);
	const h = Number.isNaN(dem)
		? (r.eyeAlt as number)
		: r.eyeAlt != null
			? Math.max(r.eyeAlt, dem + 1.6)
			: dem + 1.8;
	const terrain = traceViewpoint(
		(lat, lon, d) => mosaicHeight(mosaicFor(mosaics, d), lon, lat),
		{ lat: r.lat, lon: r.lon, h },
		peaks,
		{ dMax: spans.at(-1)?.maxDistance },
	);
	const file = `${i}.bin`;
	const bytes = encodeTerrain(terrain);
	fs.writeFileSync(path.join(OUT, file), bytes);
	index[terrainKey(r)] = file;
	console.log(
		`viewpoint ${i}: ${g.photos.length} photos, key ${terrainKey(r)}, ${terrain.start.length - 1} strokes, ${terrain.peaks.length} peaks, ${(bytes.length / 1024).toFixed(0)} kB, ${((performance.now() - t0) / 1000).toFixed(1)} s`,
	);
}
fs.writeFileSync(
	path.join(OUT, "index.json"),
	`${JSON.stringify(index, null, "\t")}\n`,
);

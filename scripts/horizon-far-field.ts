// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Far-field sensitivity of the DEM horizon, inside each ground-truth photo's frame (a diagnostic on
 * dev data; its numbers are never results):
 *   - range: how much of the in-frame skyline lies beyond the app's 120 km cap, and how far the
 *     skyline moves between the 120 km and 150 km caps;
 *   - refraction: how far the in-frame skyline moves for k = 0.07 and k = 0.20 against k = 0.13.
 *
 *   npx tsx scripts/horizon-far-field.ts [IMG_xxxx ...]
 *
 * Uses the Terrarium tiles of the baseline levels (cached under .cache/terrarium) and horizon-fast's
 * CPU march (the same model as computeHorizon and the GPU march). The frame is the long side's
 * field of view centred on the ground-truth yaw, so it over-counts for portrait shots.
 */
import fs from "node:fs";
import { TERRAIN_LEVELS } from "../src/lib/dem";
import { loadTerrain } from "../src/lib/geo/terrain";
import { REFRACTION_K } from "../src/lib/geodesy";
import { computeHorizonFastCompat } from "../src/lib/horizon-fast/march";
import { loadTerrariumTileNode } from "./lib/node-io";

const STEP = 0.1;
const APP_CAP = 120_000;
const FULL = 150_000;

interface Gt {
	lat?: number;
	lon?: number;
	eye?: number;
	yaw?: number | null;
	f?: number | null;
	width: number;
	height: number;
}

const gt: Record<string, Gt> = JSON.parse(
	fs.readFileSync("data/ground-truth.json", "utf8"),
);
const only = new Set(process.argv.slice(2));
const tiles = new Map<string, Float32Array>();

console.log(
	"photo      eye m  in-frame >120km  Δel 150 vs 120 (max)  Δel k=0.07 / 0.20 (max)",
);
for (const [id, g] of Object.entries(gt)) {
	if (only.size && !only.has(id)) continue;
	if (g.lat == null || g.lon == null || g.eye == null) continue;
	if (g.yaw == null || g.f == null) continue;
	const terrain = await loadTerrain(
		g.lat,
		g.lon,
		loadTerrariumTileNode,
		TERRAIN_LEVELS,
		tiles,
	);
	const run = (maxDistance: number, k: number) =>
		computeHorizonFastCompat(
			terrain,
			g.lat as number,
			g.lon as number,
			g.eye as number,
			{
				step: STEP,
				maxDistance,
				k,
				noRidges: true,
			},
		);
	const base = run(FULL, REFRACTION_K);
	const capped = run(APP_CAP, REFRACTION_K);
	const kLow = run(FULL, 0.07);
	const kHigh = run(FULL, 0.2);
	const hfov =
		(2 * Math.atan(Math.max(g.width, g.height) / 2 / g.f) * 180) / Math.PI;
	let n = 0;
	let beyond = 0;
	let dCap = 0;
	let dK = 0;
	for (let i = 0; i < base.elevation.length; i++) {
		const az = i * STEP;
		if (Math.abs(((az - g.yaw + 540) % 360) - 180) > hfov / 2) continue;
		n++;
		if (base.distance[i] > APP_CAP) beyond++;
		dCap = Math.max(dCap, base.elevation[i] - capped.elevation[i]);
		dK = Math.max(
			dK,
			Math.abs(kLow.elevation[i] - base.elevation[i]),
			Math.abs(kHigh.elevation[i] - base.elevation[i]),
		);
	}
	console.log(
		`${id.padEnd(10)} ${g.eye.toFixed(0).padStart(5)}  ${((100 * beyond) / Math.max(1, n)).toFixed(1).padStart(14)}%  ${dCap.toFixed(3).padStart(19)}°  ${dK.toFixed(3).padStart(22)}°`,
	);
}

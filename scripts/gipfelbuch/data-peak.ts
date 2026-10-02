// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Real data for /gipfelbuch/peak: the REAL viewPeaks ray march (src/lib/geo/peaks.ts) replayed on demo-10 for the
 * tallest terrain-hidden summit, plus honest visible/hidden/labelled counts for the photos the page shows.
 *
 *   npx tsx scripts/gipfelbuch/data-peak.ts   (needs public/demo/gipfelbuch/<id>.json from build-data.ts)
 *
 * Writes public/demo/gipfelbuch/peak/peak.json. build-data.ts stores only the 40 tallest hidden summits per photo,
 * so the counts here are recomputed over every named OSM peak (maxDistance 120 km as in build-data.ts).
 */
import fs from "node:fs";
import path from "node:path";
import type { GipfelbuchPhotoData } from "../../src/components/gipfelbuch/viz/real";
import { DEM_SOURCES } from "../../src/lib/dem";
import {
	cameraFromAngles,
	directionENU,
	project,
} from "../../src/lib/geo/camera";
import {
	apparentElevation,
	layoutPeakLabels,
	type Peak,
	viewPeaks,
} from "../../src/lib/geo/peaks";
import { loadTerrain } from "../../src/lib/geo/terrain";
import { destination } from "../../src/lib/geodesy";
import { demTileLoaderNode, ROOT } from "../lib/node-io";

const DEM = DEM_SOURCES.terrarium;
const loadTile = demTileLoaderNode(DEM);
const tiles = new Map<string, Float32Array>();
const OUT = path.join(ROOT, "public", "demo", "gipfelbuch", "peak");
fs.mkdirSync(OUT, { recursive: true });
const rd = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const manifest = rd(path.join(ROOT, "public/demo/manifest.json")) as {
	region: { peaks: Peak[] };
};
const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const TOL = 0.05;

const IDS = ["demo-10", "demo-09", "demo-01", "demo-02", "demo-03", "demo-06"];
const counts: Record<string, unknown> = {};
let profile: unknown = null;

for (const id of IDS) {
	const d: GipfelbuchPhotoData = rd(
		path.join(ROOT, "public/demo/gipfelbuch", `${id}.json`),
	);
	const { lat, lon, eye } = d.gps;
	const terrain = await loadTerrain(
		lat,
		lon,
		loadTile,
		DEM.levels,
		tiles,
		16,
		DEM.tileSize,
	);
	const named = manifest.region.peaks.filter((p) => p.name);
	const views = viewPeaks(named, terrain, lat, lon, eye, {
		maxDistance: 120_000,
	});
	const cam = cameraFromAngles({
		width: d.photo.width,
		height: d.photo.height,
		f: d.solved.f,
		yaw: d.solved.yaw,
		pitch: d.solved.pitch,
		roll: d.solved.roll,
	});
	const inFrame = views.filter((v) => {
		const q = project(cam, directionENU(v.azimuth, v.elevation));
		return (
			q && q[0] >= 0 && q[0] <= cam.width && q[1] >= 0 && q[1] <= cam.height
		);
	});
	const labelled = layoutPeakLabels(views, cam);
	counts[id] = {
		inFrame: inFrame.length,
		visible: inFrame.filter((v) => v.visible).length,
		hidden: inFrame.filter((v) => !v.visible).length,
		labelled: labelled.length,
	};

	if (id === "demo-10") {
		// the tallest hidden summit in frame, replayed sample by sample exactly as viewPeaks does
		// a tall hidden summit with a clearly visible cover (chosen by hand from the hidden list in demo-10.json)
		const v = inFrame.find(
			(x) => !x.visible && x.peak.name === "Grosses Wannenhorn",
		) as (typeof views)[number];
		const stopAt = v.distance - Math.max(150, v.distance * 0.02);
		const samples: [number, number, number][] = [];
		let blocker: [number, number, number] | null = null;
		let worst: [number, number, number] | null = null;
		for (let dd = 20; dd < stopAt; dd += Math.max(10, dd * 0.004)) {
			const p = destination(lat, lon, v.azimuth, dd);
			const h = terrain.sampleAt(p.lon, p.lat, dd);
			if (Number.isNaN(h)) continue;
			const a = apparentElevation(h, eye, dd);
			const s: [number, number, number] = [Math.round(dd), r1(h), r3(a)];
			if (!worst || a > worst[2]) worst = s;
			if (!blocker && a > v.elevation + TOL) blocker = s;
		}
		// thin profile for drawing (every ~150 m)
		for (let dd = 0; dd <= v.distance; dd += 150) {
			const p = destination(lat, lon, v.azimuth, dd);
			const h = terrain.sampleAt(p.lon, p.lat, dd);
			if (!Number.isNaN(h)) samples.push([dd, r1(h), 0]);
		}
		profile = {
			id,
			name: v.peak.name,
			azimuth: r1(v.azimuth),
			distance: Math.round(v.distance),
			height: Math.round(v.height),
			elevationDeg: r3(v.elevation),
			eye: r1(eye),
			toleranceDeg: TOL,
			firstBlocker: blocker,
			highestAngle: worst,
			terrain: samples.map(([a, b]) => [a, b]),
		};
	}
}
fs.writeFileSync(
	path.join(OUT, "peak.json"),
	JSON.stringify({
		script: "scripts/gipfelbuch/data-peak.ts",
		generated: new Date().toISOString().slice(0, 10),
		dem: "terrarium",
		counts,
		profile,
	}),
);
console.log(
	JSON.stringify(
		{ counts, profile: { ...(profile as object), terrain: "…" } },
		null,
		1,
	),
);

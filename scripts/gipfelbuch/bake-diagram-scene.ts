// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Bakes the scene that the Gipfelbuch's synthetic diagrams draw (pod D,
 * reports/gipfelbuch-explainers-2026-10-02/D-diagrams.md): one real demo photo's DEM horizon, summits,
 * terrain section and poses, small enough to import synchronously. A diagram that explains a mechanism
 * (a ray march, a pose solve, a tap lock) keeps its synthetic sensor, but its mountains are this photo's
 * real ones, so the figure, its spill and the page's photos show the same peaks.
 *
 *   npx tsx scripts/gipfelbuch/bake-diagram-scene.ts [demo-09]
 *
 * Reads public/demo/gipfelbuch/<id>.json (build-data.ts) and public/demo/gipfelbuch/tafel/<id>.json
 * (data-tafel.ts, the wide horizon); writes src/components/gipfelbuch/viz/diagram-scene.json. No DEM
 * access: it only subsamples bakes that exist. Run `npx biome check --write` on the JSON afterwards.
 */
import fs from "node:fs";
import path from "node:path";

const id = process.argv[2] ?? "demo-09";
const root = path.resolve(import.meta.dirname, "../..");
const photo = JSON.parse(
	fs.readFileSync(path.join(root, `public/demo/gipfelbuch/${id}.json`), "utf8"),
);
const tafel = JSON.parse(
	fs.readFileSync(
		path.join(root, `public/demo/gipfelbuch/tafel/${id}.json`),
		"utf8",
	),
);
if (!tafel.horizon) throw new Error(`${id}: tafel bake has no wide horizon`);

const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const pose = (p: Record<string, number>) => ({
	yaw: r(p.yaw, 2),
	pitch: r(p.pitch, 2),
	roll: r(p.roll, 2),
	f: r(p.f, 1),
	hfov: r(p.hfov, 2),
});

// labelled, visible summits: the names the app writes on this photo
const peaks = (
	photo.peaks as {
		name: string;
		ele: number;
		az: number;
		el: number;
		distance: number;
		visible: boolean;
		labelled: boolean;
	}[]
)
	.filter((p) => p.visible && p.labelled)
	.map((p) => ({
		name: p.name,
		ele: Math.round(p.ele),
		az: r(p.az, 2),
		el: r(p.el, 3),
		km: r(p.distance / 1000, 1),
	}))
	.sort((a, b) => a.az - b.az);

// the terrain section along the view axis, thinned to about 200 m steps
const section: [number, number][] = [];
let lastD = Number.NEGATIVE_INFINITY;
for (const [d, h] of photo.terrainProfile.points as [number, number][])
	if (d - lastD >= 190) {
		section.push([Math.round(d), Math.round(h)]);
		lastD = d;
	}

const scene = {
	id,
	generated: new Date().toISOString().slice(0, 10),
	script: "scripts/gipfelbuch/bake-diagram-scene.ts",
	photo: { width: photo.photo.width, height: photo.photo.height },
	eye: {
		lat: r(photo.gps.lat, 5),
		lon: r(photo.gps.lon, 5),
		m: Math.round(photo.gps.eye),
		ground: Math.round(photo.gps.ground),
	},
	prior: pose(photo.prior),
	solved: pose(photo.solved),
	/** The DEM horizon from the eye, pose-free (tafel bake, yaw ± 85°): elevation (deg) at az0 + i·step. */
	horizon: {
		az0: tafel.horizon.az0,
		step: tafel.horizon.step,
		el: (tafel.horizon.el as number[]).map((v) => r(v, 3)),
	},
	/** Distance (m) of the horizon point across the photo's view, every `step` deg from az0. */
	horizonDistance: {
		az0: r(photo.horizon.profile[0].az, 2),
		step: photo.horizon.step,
		d: (photo.horizon.profile as { d: number }[]).map((p) => Math.round(p.d)),
	},
	/** Ground height (m) along the solved view axis: [distance m, height m]. */
	section: { azimuth: r(photo.terrainProfile.azimuth, 2), points: section },
	peaks,
};
const out = path.join(root, "src/components/gipfelbuch/viz/diagram-scene.json");
fs.writeFileSync(out, `${JSON.stringify(scene)}\n`);
console.log(
	`${id}: ${scene.horizon.el.length} horizon samples, ${section.length} section points, ${peaks.length} peaks → ${path.relative(root, out)} (${fs.statSync(out).size} B)`,
);

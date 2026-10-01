// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Bakes the data behind the "how it works" scene (src/components/site/how/) from one demo photo:
 * the photo skyline, the DEM horizon around the view, the visible peaks, and a coarse heightfield
 * for the little world view. Everything is real output of src/lib/geo; nothing is hand-drawn.
 *
 *   npx tsx scripts/howitworks/bake.ts [demo-09]
 *
 * Writes public/demo/how/scene.json (~100 kB).
 */
import fs from "node:fs";
import path from "node:path";
import { DEM_SOURCES } from "../../src/lib/dem";
import { computeHorizon } from "../../src/lib/geo/horizon";
import { viewPeaks } from "../../src/lib/geo/peaks";
import { EYE_ABOVE_GROUND } from "../../src/lib/geo/pipeline";
import { detectSkyline } from "../../src/lib/geo/skyline";
import { loadTerrain } from "../../src/lib/geo/terrain";
import { destination } from "../../src/lib/geodesy";
import { demTileLoaderNode, loadRGBA, ROOT } from "../lib/node-io";

const ID = process.argv[2] ?? "demo-09";
const WORK = 800; // skyline detector working width
const OUT = path.join(ROOT, "public", "demo", "how", "scene.json");
const r1 = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

async function main() {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(ROOT, "public/demo/manifest.json"), "utf8"),
	);
	const meta = manifest.photos.find((p: { id: string }) => p.id === ID);
	const solved = manifest.poses[ID].pose;
	if (!meta || !solved) throw new Error(`${ID}: not in the demo manifest`);

	// 1. Photo skyline, as the app detects it.
	const img = await loadRGBA(path.join(ROOT, "public", meta.src), WORK);
	const sky = detectSkyline(img, { returnSky: false } as never);
	const rows: (number | null)[] = [];
	const weight: number[] = [];
	for (let x = 0; x < sky.width; x += 4) {
		const y = sky.rows[x];
		rows.push(Number.isFinite(y) ? r1(y / sky.height, 4) : null);
		weight.push(r1(sky.weight[x], 2));
	}

	// 2. DEM horizon from the eye (Mapterhorn, eye = max(GPS, ground + 1.6 m) as in the app).
	const DEM = DEM_SOURCES.mapterhorn;
	const terrain = await loadTerrain(
		meta.lat,
		meta.lon,
		demTileLoaderNode(DEM),
		DEM.levels,
		new Map(),
		16,
		DEM.tileSize,
	);
	const ground = terrain.ground(meta.lon, meta.lat);
	const eye = Math.max(meta.alt ?? 0, ground + EYE_ABOVE_GROUND);
	const step = 0.1;
	const horizon = computeHorizon(terrain, meta.lat, meta.lon, eye, { step });
	// Keep a window around the view, wide enough for the prior and a hand-dragged yaw.
	const aspect = meta.width / meta.height;
	const hfov =
		(2 * Math.atan(Math.tan((solved.vfov * Math.PI) / 360) * aspect) * 180) /
		Math.PI;
	// The scene sweeps yaw ±SWEEP around the compass, so cover that plus half the view each side.
	const SWEEP = 30;
	const lo = Math.min(meta.heading, solved.yaw) - SWEEP - hfov / 2 - 4;
	const hi = Math.max(meta.heading, solved.yaw) + SWEEP + hfov / 2 + 4;
	const az0 = Math.floor(lo / step) * step;
	const n = Math.round((hi - az0) / step);
	const hEl: number[] = [];
	const hDist: number[] = [];
	const N = horizon.elevation.length;
	for (let i = 0; i < n; i++) {
		const k = ((Math.round((az0 + i * step) / step) % N) + N) % N;
		hEl.push(r1(horizon.elevation[k], 3));
		hDist.push(Math.round(horizon.distance[k]));
	}

	// 3. Peaks visible from the eye, inside the window.
	const views = viewPeaks(
		manifest.region.peaks,
		terrain,
		meta.lat,
		meta.lon,
		eye,
	)
		.filter((v) => v.visible)
		.filter(
			(v) =>
				Math.abs(((v.azimuth - solved.yaw + 540) % 360) - 180) < hfov / 2 + 2,
		)
		.map((v) => ({
			name: v.peak.name,
			ele: v.peak.ele ?? Math.round(v.height),
			az: r1(v.azimuth, 3),
			el: r1(v.elevation, 3),
			dist: Math.round(v.distance),
			prominence: v.peak.prominence ?? null,
		}))
		.sort((a, b) => (b.prominence ?? 0) - (a.prominence ?? 0) || b.ele - a.ele);
	// A few well-separated labels: the names people know first, then by prominence and height.
	const FAMOUS = [
		"Eiger",
		"Mönch",
		"Jungfrau",
		"Schreckhorn",
		"Niesen",
		"Stockhorn",
	];
	const rank = (v: (typeof views)[number]) =>
		(FAMOUS.includes(v.name ?? "") ? 1e5 : 0) + (v.prominence ?? 0) * 2 + v.ele;
	const MIN_SEP = hfov / 17;
	const peaks: typeof views = [];
	for (const v of [...views].sort((a, b) => rank(b) - rank(a)))
		if (peaks.length < 8 && peaks.every((p) => Math.abs(p.az - v.az) > MIN_SEP))
			peaks.push(v);
	peaks.sort((a, b) => a.az - b.az);

	// 4. Heightfield for the world view, in a frame aligned with the solved view: u to the right,
	// v straight ahead (metres). Rows of constant v are drawn back to front as ridgelines.
	const U = 56_000;
	const V0 = -3_000;
	const V1 = 46_000;
	const NU = 140;
	const NV = 90;
	const yawR = (solved.yaw * Math.PI) / 180;
	const fwd = [Math.sin(yawR), Math.cos(yawR)];
	const right = [Math.cos(yawR), -Math.sin(yawR)];
	const heights: number[] = [];
	for (let j = 0; j < NV; j++)
		for (let i = 0; i < NU; i++) {
			const u = (i / (NU - 1) - 0.5) * U;
			const v = V0 + (j / (NV - 1)) * (V1 - V0);
			const x = u * right[0] + v * fwd[0];
			const y = u * right[1] + v * fwd[1];
			const d = Math.hypot(x, y);
			const p = destination(
				meta.lat,
				meta.lon,
				(Math.atan2(x, y) * 180) / Math.PI,
				d,
			);
			const h = terrain.sampleAt(p.lon, p.lat, Math.max(d, 1500));
			heights.push(Math.round(Number.isNaN(h) ? 0 : h));
		}

	const scene = {
		id: ID,
		photo: meta.src,
		place: manifest.name,
		width: meta.width,
		height: meta.height,
		lat: meta.lat,
		lon: meta.lon,
		eye: r1(eye),
		gpsAlt: meta.alt === undefined ? null : r1(meta.alt),
		hAccuracy: meta.hAccuracy === undefined ? null : r1(meta.hAccuracy),
		ground: r1(ground),
		prior: {
			yaw: r1(meta.heading, 3),
			pitch: r1(meta.pitch, 3),
			roll: r1(meta.roll, 3),
			vfov: r1(meta.vfov, 3),
		},
		solved: {
			yaw: r1(solved.yaw, 3),
			pitch: r1(solved.pitch, 3),
			roll: r1(solved.roll, 3),
			vfov: r1(solved.vfov, 3),
		},
		confidence: manifest.poses[ID].confidence,
		skyline: { step: 4 / sky.width, rows, weight },
		horizon: { az0: r1(az0, 3), step, elevation: hEl, distance: hDist },
		peaks,
		heightfield: {
			yaw: r1(solved.yaw, 3),
			u: U,
			v0: V0,
			v1: V1,
			nu: NU,
			nv: NV,
			heights,
		},
		dem: "swissALTI3D via Mapterhorn",
	};
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	fs.writeFileSync(OUT, JSON.stringify(scene));
	console.log(
		`${OUT}: ${(fs.statSync(OUT).size / 1024).toFixed(0)} kB · eye ${eye.toFixed(0)} m · ${peaks.length}/${views.length} peaks · Δyaw ${(solved.yaw - meta.heading).toFixed(2)}°`,
	);
	console.log(
		peaks
			.map(
				(v) => `${v.name} ${v.ele} ${(v.dist / 1000).toFixed(1)}km az${v.az}`,
			)
			.join("\n"),
	);
	const fin = hDist.filter((d) => d > 0);
	console.log(
		"horizon dist km min/med/max",
		Math.min(...fin) / 1000,
		fin.sort((a, b) => a - b)[fin.length >> 1] / 1000,
		Math.max(...fin) / 1000,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

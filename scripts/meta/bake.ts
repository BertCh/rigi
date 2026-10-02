// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Bakes the data behind the "under the hood" visuals (src/components/site/meta/) from the demo roll.
 * Everything is real output of src/lib/geo on Mapterhorn; nothing is hand-drawn.
 *
 *   npx tsx scripts/meta/bake.ts [hero=demo-09]
 *
 * Writes public/demo/meta/:
 *   roll.json        all 12 photos: full 360° DEM horizon, photo skyline, prior and solved pose,
 *                    accept verdict (from public/demo/gipfelbuch/index.json)
 *   hero.json        one photo in depth: ridge crests across the view, side sections along each
 *                    bearing, a per-pixel depth grid at the solved pose, and the map frame
 *   hero-map.jpg     hillshaded DEM, ±MAP_HALF_KM around the camera, north up
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { DEM_SOURCES } from "../../src/lib/dem";
import {
	azimuthElevation,
	cameraFromAngles,
	unproject,
} from "../../src/lib/geo/camera";
import { computeHorizon } from "../../src/lib/geo/horizon";
import { EYE_ABOVE_GROUND } from "../../src/lib/geo/pipeline";
import { detectSkyline } from "../../src/lib/geo/skyline";
import { loadTerrain, type TerrainSampler } from "../../src/lib/geo/terrain";
import {
	DEG,
	destination,
	EARTH_R,
	REFRACTION_K,
	wrap360,
} from "../../src/lib/geodesy";
import { demTileLoaderNode, loadRGBA, ROOT } from "../lib/node-io";

const HERO = process.argv[2] ?? "demo-09";
const WORK = 800; // skyline detector working width, as in the app
const COLS = 200; // skyline columns kept (every 4th working column)
const H_STEP = 0.25; // 360° horizon step kept in roll.json
const OUT = path.join(ROOT, "public", "demo", "meta");
const DEM = DEM_SOURCES.mapterhorn;
const loadTile = demTileLoaderNode(DEM);
const tiles = new Map<string, Float32Array>();
const R_EFF = EARTH_R / (1 - REFRACTION_K);
const MAP_HALF_KM = 45;
const MAP_PX = 720;

const r = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const fFromVfov = (h: number, vfov: number) =>
	h / 2 / Math.tan((vfov * DEG) / 2);

type ManifestPhoto = {
	id: string;
	src: string;
	width: number;
	height: number;
	lat: number;
	lon: number;
	alt: number;
	hAccuracy: number;
	heading: number;
	pitch: number;
	roll: number;
	vfov: number;
	takenAt: string;
};
type Angles = { yaw: number; pitch: number; roll: number; vfov: number };

const manifest = JSON.parse(
	fs.readFileSync(path.join(ROOT, "public/demo/manifest.json"), "utf8"),
);
const gipfelbuchIndex = JSON.parse(
	fs.readFileSync(path.join(ROOT, "public/demo/gipfelbuch/index.json"), "utf8"),
);
const verdict = (id: string) => {
	const a = gipfelbuchIndex.photos.find((p: { id: string }) => p.id === id);
	const full = JSON.parse(
		fs.readFileSync(
			path.join(ROOT, `public/demo/gipfelbuch/${id}.json`),
			"utf8",
		),
	);
	return {
		accepted: Boolean(a?.accepted),
		stage: a?.stage ?? null,
		confidence: a ? r(a.confidence, 3) : null,
		rejectReason: full.solved?.rejectReason ?? null,
		inlierFraction: full.solved?.inlierFraction ?? null,
		ambiguity: full.solved?.ambiguity ?? null,
	};
};

async function terrainFor(p: ManifestPhoto) {
	const terrain = await loadTerrain(
		p.lat,
		p.lon,
		loadTile,
		DEM.levels,
		tiles,
		16,
		DEM.tileSize,
	);
	const ground = terrain.ground(p.lon, p.lat);
	const eye = Math.max(p.alt ?? 0, ground + EYE_ABOVE_GROUND);
	return { terrain, ground, eye };
}

async function skylineOf(p: ManifestPhoto) {
	const img = await loadRGBA(
		path.join(ROOT, "public", p.src.replace(/^\//, "")),
		WORK,
	);
	const sky = detectSkyline(img);
	const step = sky.width / COLS;
	const rows: (number | null)[] = [];
	const weight: number[] = [];
	for (let k = 0; k < COLS; k++) {
		const x = Math.round(k * step + step / 2);
		const y = sky.rows[x];
		rows.push(Number.isFinite(y) ? r(y / sky.height, 4) : null);
		weight.push(r(sky.weight[x] ?? 0, 2));
	}
	return { rows, weight };
}

/** Terrain heights along a bearing, with the curvature+refraction drop already applied. */
function section(
	terrain: TerrainSampler,
	p: ManifestPhoto,
	az: number,
	reach: number,
) {
	const pts: [number, number][] = [];
	for (let d = 0; d <= reach; d += Math.max(50, d * 0.011)) {
		const q = destination(p.lat, p.lon, az, d);
		const h = terrain.sampleAt(q.lon, q.lat, Math.max(d, 30));
		if (Number.isNaN(h)) continue;
		pts.push([Math.round(d), Math.round(h - (d * d) / (2 * R_EFF))]);
	}
	return pts;
}

/** Marches one ray until it dips under the terrain; returns distance (m) or null for sky. */
function castRay(
	terrain: TerrainSampler,
	p: ManifestPhoto,
	eye: number,
	az: number,
	el: number,
) {
	const t = Math.tan(el * DEG);
	let prev = 0;
	for (let d = 15; d <= 150_000; d += Math.max(10, d * 0.004)) {
		const q = destination(p.lat, p.lon, az, d);
		const h = terrain.sampleAt(q.lon, q.lat, d);
		if (Number.isNaN(h)) continue;
		const rayH = eye + d * t - (d * d) / (2 * R_EFF);
		if (rayH <= h) return (prev + d) / 2;
		prev = d;
	}
	return null;
}

async function main() {
	fs.mkdirSync(OUT, { recursive: true });
	const photos: ManifestPhoto[] = manifest.photos;
	const roll = [];
	let heroOut: unknown = null;

	for (const p of photos) {
		const t0 = performance.now();
		const { terrain, ground, eye } = await terrainFor(p);
		const horizon = computeHorizon(terrain, p.lat, p.lon, eye, { step: 0.05 });
		const N = horizon.elevation.length;
		const pick = (az: number) => ((Math.round(az / horizon.step) % N) + N) % N;
		const elevation: number[] = [];
		const distance: number[] = [];
		for (let az = 0; az < 360 - 1e-9; az += H_STEP) {
			elevation.push(r(horizon.elevation[pick(az)], 3));
			distance.push(Math.round(horizon.distance[pick(az)]));
		}
		const sky = await skylineOf(p);
		const pose = manifest.poses[p.id].pose;
		const prior: Angles = {
			yaw: r(p.heading, 3),
			pitch: r(p.pitch, 3),
			roll: r(p.roll, 3),
			vfov: r(p.vfov, 3),
		};
		const solved: Angles = {
			yaw: r(wrap360(pose.yaw), 3),
			pitch: r(pose.pitch, 3),
			roll: r(pose.roll, 3),
			vfov: r(pose.vfov, 3),
		};
		const entry = {
			id: p.id,
			photo: p.src,
			thumb: `/demo/thumbs/${p.id}.jpg`,
			width: p.width,
			height: p.height,
			takenAt: p.takenAt,
			lat: p.lat,
			lon: p.lon,
			gpsAlt: r(p.alt),
			hAccuracy: r(p.hAccuracy),
			ground: r(ground),
			eye: r(eye),
			prior,
			solved,
			...verdict(p.id),
			skyline: sky,
			horizon: { step: H_STEP, elevation, distance },
		};
		roll.push(entry);

		if (p.id === HERO) heroOut = bakeHero(p, terrain, eye, horizon, entry);
		console.log(
			`${p.id}: eye ${eye.toFixed(0)} m (gps ${p.alt.toFixed(0)}) · Δyaw ${(solved.yaw - prior.yaw).toFixed(1)}° · ${((performance.now() - t0) / 1000).toFixed(1)} s`,
		);
	}

	fs.writeFileSync(
		path.join(OUT, "roll.json"),
		JSON.stringify({
			generated: new Date().toISOString().slice(0, 10),
			script: "scripts/meta/bake.ts",
			place: manifest.name,
			dem: "swissALTI3D via Mapterhorn",
			photos: roll,
		}),
	);
	if (heroOut) {
		const { json, map } = await (heroOut as Promise<{
			json: unknown;
			map: Buffer;
		}>);
		fs.writeFileSync(path.join(OUT, "hero.json"), JSON.stringify(json));
		fs.writeFileSync(path.join(OUT, "hero-map.jpg"), map);
	}
	for (const f of fs.readdirSync(OUT))
		console.log(
			`${f}: ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)} kB`,
		);
}

async function bakeHero(
	p: ManifestPhoto,
	terrain: TerrainSampler,
	eye: number,
	horizon: ReturnType<typeof computeHorizon>,
	entry: { solved: Angles },
) {
	const s = entry.solved;
	const W = 800;
	const H = Math.round((W * p.height) / p.width);
	const cam = cameraFromAngles({
		width: W,
		height: H,
		f: fFromVfov(H, s.vfov),
		yaw: s.yaw,
		pitch: s.pitch,
		roll: s.roll,
	});
	const hfov = (2 * Math.atan(W / 2 / cam.f)) / DEG;
	const N = horizon.elevation.length;
	const pick = (az: number) => ((Math.round(az / horizon.step) % N) + N) % N;

	// 1. Ridge crests across the view at 0.25°: every visible silhouette, nearest first, then the
	// skyline itself. Drawn as a layered panorama coloured by distance.
	const az0 = s.yaw - hfov / 2 - 2;
	const nAz = Math.round((hfov + 4) / 0.25);
	const ridges = Array.from({ length: nAz + 1 }, (_, k) => {
		const az = az0 + k * 0.25;
		const i = pick(az);
		return [
			...(horizon.ridges[i] ?? []).map((q) => [
				r(q.elevation, 3),
				Math.round(q.distance),
			]),
			[r(horizon.elevation[i], 3), Math.round(horizon.distance[i])],
		];
	});

	// 2. Side sections along bearings across the view, every 1°.
	const sections = [];
	for (let az = Math.ceil(az0); az <= az0 + hfov + 4; az += 1) {
		const i = pick(az);
		const reach = Math.min(140_000, Math.max(3_000, horizon.distance[i] * 1.2));
		sections.push({
			az: r(wrap360(az), 2),
			skyline: {
				el: r(horizon.elevation[i], 3),
				d: Math.round(horizon.distance[i]),
			},
			ridges: (horizon.ridges[i] ?? []).map((q) => ({
				el: r(q.elevation, 3),
				d: Math.round(q.distance),
			})),
			points: section(terrain, p, az, reach),
		});
	}

	// 3. Depth grid at the solved pose: distance (m) to the terrain for each cell, 0 = sky.
	const GW = 200;
	const GH = Math.round((GW * H) / W);
	const depth: number[] = [];
	for (let gy = 0; gy < GH; gy++)
		for (let gx = 0; gx < GW; gx++) {
			const x = ((gx + 0.5) / GW) * W;
			const y = ((gy + 0.5) / GH) * H;
			const [az, el] = azimuthElevation(unproject(cam, x, y));
			// Above the DEM skyline there is nothing to hit.
			if (el > horizon.elevation[pick(az)] + 0.02) {
				depth.push(0);
				continue;
			}
			const d = castRay(terrain, p, eye, az, el);
			depth.push(d === null ? 0 : Math.round(d));
		}

	// 4. Hillshaded map, north up, ±MAP_HALF_KM, for the ray's landing point.
	const north = destination(p.lat, p.lon, 0, MAP_HALF_KM * 1000);
	const east = destination(p.lat, p.lon, 90, MAP_HALF_KM * 1000);
	const dLat = north.lat - p.lat;
	const dLon = east.lon - p.lon;
	const hgt = new Float32Array(MAP_PX * MAP_PX);
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (let y = 0; y < MAP_PX; y++)
		for (let x = 0; x < MAP_PX; x++) {
			const lat = p.lat + dLat * (1 - (2 * (y + 0.5)) / MAP_PX);
			const lon = p.lon + dLon * ((2 * (x + 0.5)) / MAP_PX - 1);
			const v = terrain.sampleAt(lon, lat, 8_000);
			hgt[y * MAP_PX + x] = v;
			if (Number.isFinite(v)) {
				lo = Math.min(lo, v);
				hi = Math.max(hi, v);
			}
		}
	const cell = (2 * MAP_HALF_KM * 1000) / MAP_PX;
	const px = new Uint8ClampedArray(MAP_PX * MAP_PX * 4);
	const L = [-0.5, 0.5, Math.SQRT1_2];
	const g = (xx: number, yy: number) => {
		const v =
			hgt[
				Math.min(MAP_PX - 1, Math.max(0, yy)) * MAP_PX +
					Math.min(MAP_PX - 1, Math.max(0, xx))
			];
		return Number.isFinite(v) ? v : lo;
	};
	for (let y = 0; y < MAP_PX; y++)
		for (let x = 0; x < MAP_PX; x++) {
			const dx = (g(x + 1, y) - g(x - 1, y)) / (2 * cell);
			const dy = (g(x, y - 1) - g(x, y + 1)) / (2 * cell);
			const nz = 1 / Math.hypot(dx, dy, 1);
			const shade = Math.max(0, (-dx * L[0] - dy * L[1] + L[2]) * nz);
			const e = (g(x, y) - lo) / (hi - lo);
			const i = 4 * (y * MAP_PX + x);
			// dark relief on ink: elevation lifts the tone, shade carries the form
			const base = 26 + 120 * e;
			const k = 0.3 + 0.8 * shade;
			px[i] = Math.min(255, base * k);
			px[i + 1] = Math.min(255, base * k * 0.98);
			px[i + 2] = Math.min(255, base * k * 0.94);
			px[i + 3] = 255;
		}
	const canvas = createCanvas(MAP_PX, MAP_PX);
	canvas.getContext("2d").putImageData(new ImageData(px, MAP_PX, MAP_PX), 0, 0);
	const map = await canvas.encode("jpeg", 84);

	return {
		json: {
			id: p.id,
			photo: p.src,
			width: W,
			height: H,
			lat: p.lat,
			lon: p.lon,
			eye: r(eye),
			solved: s,
			hfov: r(hfov, 3),
			ridges: { az0: r(az0, 3), step: 0.25, crests: ridges },
			sections,
			depth: { w: GW, h: GH, metres: depth },
			map: {
				src: "/demo/meta/hero-map.jpg",
				halfKm: MAP_HALF_KM,
				px: MAP_PX,
				min: Math.round(lo),
				max: Math.round(hi),
			},
		},
		map,
	};
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Real data for the gipfelbuch explainer pages (/gipfelbuch/<id>): runs the CPU baseline pipeline on the bundled
 * Niederhorn demo photos and writes compact artefacts the pages load at runtime.
 *
 *   npx tsx scripts/gipfelbuch/build-data.ts [demo-01 ...]
 *
 * Writes public/demo/gipfelbuch/:
 *   <id>.json      prior + solved pose, detected skyline (rows, weight), DEM horizon across the view,
 *                  prior/solved skyline projections, ridges, peaks (projected at the solved pose),
 *                  a terrain profile along the view axis, DEM patch bounds, stage timings
 *   <id>-sky.jpg   per-pixel sky probability at half the working width (grey = P(sky))
 *   <id>-dem.jpg   hillshaded DEM patch (±DEM_HALF_KM) centred on the camera
 *   index.json     per-photo summary + the 12-photo ground-truth eval rows (out/eval*\/report.json)
 * Numbers in this output are measured, not illustrative: every page that quotes them cites this script.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { DEM_SOURCES } from "../../src/lib/dem";
import {
	type Camera,
	cameraFromAngles,
	directionENU,
	project,
} from "../../src/lib/geo/camera";
import { computeHorizon } from "../../src/lib/geo/horizon";
import {
	layoutPeakLabels,
	type Peak,
	viewPeaks,
} from "../../src/lib/geo/peaks";
import { EYE_ABOVE_GROUND } from "../../src/lib/geo/pipeline";
import { detectSkyline } from "../../src/lib/geo/skyline";
import { projectSkylineRows, solvePose } from "../../src/lib/geo/solve";
import { loadTerrain } from "../../src/lib/geo/terrain";
import { destination } from "../../src/lib/geodesy";
import { refinePose } from "../../src/lib/refine/index";
import { demTileLoaderNode, loadRGBA, ROOT } from "../lib/node-io";

const WORK = 800;
const DEM_HALF_KM = 20;
const DEM_PX = 480;
const OUT = path.join(ROOT, "public", "demo", "gipfelbuch");
const DEM = DEM_SOURCES.terrarium;
const loadTile = demTileLoaderNode(DEM);
const tiles = new Map<string, Float32Array>();

type ManifestPhoto = {
	id: string;
	src: string;
	thumb: string;
	width: number;
	height: number;
	lat: number;
	lon: number;
	alt: number;
	hAccuracy: number;
	heading: number;
	f35: number;
	vfov: number;
	pitch: number;
	roll: number;
	takenAt: string;
	holding: string;
};
const manifest = JSON.parse(
	fs.readFileSync(path.join(ROOT, "public", "demo", "manifest.json"), "utf8"),
) as {
	photos: ManifestPhoto[];
	poses: Record<
		string,
		{
			pose: { yaw: number; pitch: number; roll: number; vfov: number };
			source: string;
			confidence: number;
		}
	>;
	region: { peaks: Peak[] };
};

const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v: number) =>
	Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
const r3 = (v: number) =>
	Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
const angleDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;
const fFromVfov = (h: number, vfov: number) =>
	h / 2 / Math.tan((vfov * Math.PI) / 360);
const camJson = (c: Camera) => ({
	yaw: r2(((c.yaw % 360) + 360) % 360),
	pitch: r2(c.pitch),
	roll: r2(c.roll),
	f: r1(c.f),
	hfov: r2((2 * Math.atan(c.width / 2 / c.f) * 180) / Math.PI),
	vfov: r2((2 * Math.atan(c.height / 2 / c.f) * 180) / Math.PI),
});
const arr = (a: ArrayLike<number>, round = r1) =>
	Array.from(a, (v) => round(v));

function residualStats(
	obs: Float32Array,
	w: Float32Array,
	model: Float32Array,
) {
	const d: number[] = [];
	for (let x = 0; x < obs.length; x++)
		if (Number.isFinite(obs[x]) && Number.isFinite(model[x]) && w[x] > 0.05)
			d.push(Math.abs(obs[x] - model[x]));
	d.sort((a, b) => a - b);
	return {
		n: d.length,
		median: r2(d[d.length >> 1] ?? Number.NaN),
		p90: r2(d[Math.floor(d.length * 0.9)] ?? Number.NaN),
		within5: r3(d.filter((v) => v <= 5).length / Math.max(1, d.length)),
	};
}

async function build(p: ManifestPhoto) {
	const t: Record<string, number> = {};
	let t0 = performance.now();
	const img = await loadRGBA(
		path.join(ROOT, "public", p.src.replace(/^\//, "")),
		WORK,
	);
	const H = img.height;
	const prior = cameraFromAngles({
		width: WORK,
		height: H,
		f: fFromVfov(H, p.vfov),
		yaw: p.heading,
		pitch: p.pitch,
		roll: p.roll,
	});

	t0 = performance.now();
	const terrain = await loadTerrain(
		p.lat,
		p.lon,
		loadTile,
		DEM.levels,
		tiles,
		16,
		DEM.tileSize,
	);
	t.terrain = performance.now() - t0;
	const ground = terrain.ground(p.lon, p.lat);
	const eye = Math.max(p.alt, ground + EYE_ABOVE_GROUND);

	t0 = performance.now();
	const horizon = computeHorizon(terrain, p.lat, p.lon, eye);
	t.horizon = performance.now() - t0;

	detectSkyline(img);
	t0 = performance.now();
	const sky = detectSkyline(img);
	t.skyline = performance.now() - t0;

	t0 = performance.now();
	let solved = solvePose(prior, horizon, sky);
	let stage = "solve";
	if (!solved.accepted) {
		const r = refinePose({
			camera: prior,
			horizon,
			skyline: sky,
			gpsAccuracy: p.hAccuracy,
		});
		if (r.confidence.accept) {
			stage = "refine";
			solved = {
				...solved,
				camera: r.camera,
				confidence: r.confidence.score,
				accepted: true,
				rejectReason: undefined,
			};
		}
	}
	t.solve = performance.now() - t0;
	const cam = solved.camera;

	const priorRows = projectSkylineRows(prior, horizon, WORK);
	const solvedRows = projectSkylineRows(cam, horizon, WORK);

	// DEM horizon over the view (±hfov/2 + 15°), 0.5° steps, up to 4 ridge crests each.
	const hfov = (2 * Math.atan(WORK / 2 / cam.f) * 180) / Math.PI;
	const span = hfov / 2 + 15;
	const az0 = cam.yaw - span;
	const nAz = Math.round((2 * span) / 0.5);
	const n = horizon.elevation.length;
	const profile = Array.from({ length: nAz + 1 }, (_, k) => {
		const az = (((az0 + k * 0.5) % 360) + 360) % 360;
		const i = Math.round(az / horizon.step) % n;
		const ridges = (horizon.ridges[i] ?? [])
			.slice(0, 4)
			.map((r) => [r2(r.elevation), Math.round(r.distance)]);
		return {
			az: r2(az),
			el: r3(horizon.elevation[i]),
			d: Math.round(horizon.distance[i]),
			ridges,
		};
	});

	// Peaks visible within the view at the solved pose (also with the prior for "before").
	const near = manifest.region.peaks.filter((pk) => pk.name);
	const views = viewPeaks(near, terrain, p.lat, p.lon, eye, {
		maxDistance: 120_000,
	});
	// the names the baseline label layout would actually show at the solved pose
	const labelled = new Set(layoutPeakLabels(views, cam).map((l) => l.peak));
	const peaks = views
		.map((v) => {
			const at = (c: Camera) => {
				const q = project(c, directionENU(v.azimuth, v.elevation));
				return q &&
					q[0] >= -20 &&
					q[0] <= WORK + 20 &&
					q[1] >= -20 &&
					q[1] <= H + 20
					? [r1(q[0]), r1(q[1])]
					: null;
			};
			return {
				name: v.peak.name,
				ele: v.peak.ele ?? null,
				dem: Math.round(v.height),
				az: r2(v.azimuth),
				el: r3(v.elevation),
				distance: Math.round(v.distance),
				visible: v.visible,
				labelled: labelled.has(v.peak),
				solved: at(cam),
				prior: at(prior),
			};
		})
		.filter((v) => v.solved || v.prior)
		.sort((a, b) => b.dem - a.dem);
	// all visible peaks in frame, plus the 40 highest terrain-hidden ones in frame (for "why is X not
	// labelled"); peaks only in frame at the prior pose are dropped
	const shown = peaks.filter((v) => v.visible && v.solved);
	const hidden = peaks.filter((v) => !v.visible && v.solved).slice(0, 40);

	// Terrain profile along the solved view axis, out to the horizon distance there.
	const axisI = Math.round((((cam.yaw % 360) + 360) % 360) / horizon.step) % n;
	const reach = Math.min(
		120_000,
		Math.max(2_000, horizon.distance[axisI] * 1.15),
	);
	const terrainProfile: [number, number][] = [];
	for (let d = 0; d <= reach; d += Math.max(25, d * 0.01)) {
		const q = destination(p.lat, p.lon, cam.yaw, d);
		terrainProfile.push([
			Math.round(d),
			r1(terrain.sampleAt(q.lon, q.lat, d)) ?? 0,
		]);
	}

	// Hillshaded DEM patch centred on the camera.
	const north = destination(p.lat, p.lon, 0, DEM_HALF_KM * 1000);
	const east = destination(p.lat, p.lon, 90, DEM_HALF_KM * 1000);
	const dLat = north.lat - p.lat;
	const dLon = east.lon - p.lon;
	const hgt = new Float32Array(DEM_PX * DEM_PX);
	let lo = Infinity;
	let hi = -Infinity;
	for (let y = 0; y < DEM_PX; y++)
		for (let x = 0; x < DEM_PX; x++) {
			const lat = p.lat + dLat * (1 - (2 * (y + 0.5)) / DEM_PX);
			const lon = p.lon + dLon * ((2 * (x + 0.5)) / DEM_PX - 1);
			const v = terrain.sampleAt(lon, lat, 5_000);
			hgt[y * DEM_PX + x] = v;
			if (Number.isFinite(v)) {
				lo = Math.min(lo, v);
				hi = Math.max(hi, v);
			}
		}
	const cell = (2 * DEM_HALF_KM * 1000) / DEM_PX;
	const px = new Uint8ClampedArray(DEM_PX * DEM_PX * 4);
	const L = [-0.5, 0.5, Math.SQRT1_2]; // NW light
	for (let y = 0; y < DEM_PX; y++)
		for (let x = 0; x < DEM_PX; x++) {
			const g = (xx: number, yy: number) =>
				hgt[
					Math.min(DEM_PX - 1, Math.max(0, yy)) * DEM_PX +
						Math.min(DEM_PX - 1, Math.max(0, xx))
				];
			const dx = (g(x + 1, y) - g(x - 1, y)) / (2 * cell);
			const dy = (g(x, y - 1) - g(x, y + 1)) / (2 * cell);
			const nz = 1 / Math.hypot(dx, dy, 1);
			const shade = Math.max(0, (-dx * L[0] - dy * L[1] + L[2]) * nz);
			const e = (g(x, y) - lo) / (hi - lo);
			const i = 4 * (y * DEM_PX + x);
			// warm-paper relief: elevation tint × shade; water-flat (lakes) stays dark
			const base = 40 + 150 * e;
			const s = 0.35 + 0.75 * shade;
			px[i] = Math.min(255, base * s * 1.05);
			px[i + 1] = Math.min(255, base * s * 0.98);
			px[i + 2] = Math.min(255, base * s * 0.88);
			px[i + 3] = 255;
		}
	const demCanvas = createCanvas(DEM_PX, DEM_PX);
	demCanvas
		.getContext("2d")
		.putImageData(new ImageData(px, DEM_PX, DEM_PX), 0, 0);
	fs.writeFileSync(
		path.join(OUT, `${p.id}-dem.jpg`),
		await demCanvas.encode("jpeg", 85),
	);

	// Sky probability image (grey) at the working width.
	if (sky.sky) {
		const s = new Uint8ClampedArray(WORK * H * 4);
		for (let i = 0; i < WORK * H; i++) {
			s[4 * i] = s[4 * i + 1] = s[4 * i + 2] = sky.sky[i];
			s[4 * i + 3] = 255;
		}
		const c = createCanvas(WORK, H);
		c.getContext("2d").putImageData(new ImageData(s, WORK, H), 0, 0);
		const half = createCanvas(WORK / 2, H / 2);
		half.getContext("2d").drawImage(c, 0, 0, WORK / 2, H / 2);
		fs.writeFileSync(
			path.join(OUT, `${p.id}-sky.jpg`),
			await half.encode("jpeg", 82),
		);
	}

	const app = manifest.poses[p.id];
	return {
		id: p.id,
		generated: new Date().toISOString().slice(0, 10),
		script: "scripts/gipfelbuch/build-data.ts",
		dem: DEM.name,
		photo: {
			src: p.src,
			thumb: p.thumb,
			width: WORK,
			height: H,
			fullWidth: p.width,
			fullHeight: p.height,
			takenAt: p.takenAt,
			holding: p.holding,
		},
		gps: {
			lat: p.lat,
			lon: p.lon,
			alt: r1(p.alt),
			hAccuracy: r1(p.hAccuracy),
			ground: r1(ground),
			eye: r1(eye),
		},
		sensor: {
			heading: r2(p.heading),
			pitch: r2(p.pitch),
			roll: r2(p.roll),
			f35: p.f35,
			vfov: r2(p.vfov),
		},
		prior: camJson(prior),
		solved: {
			...camJson(cam),
			stage,
			accepted: solved.accepted,
			confidence: r3(solved.confidence),
			rejectReason: solved.rejectReason ?? null,
			residualPx: r2(solved.residualPx),
			inlierFraction: r3(solved.inlierFraction),
			coverage: r3(solved.coverage),
			ambiguity: r3(solved.ambiguity),
			horizonRelief: r2(solved.horizonRelief),
			search: solved.search,
			delta: {
				yaw: r2(angleDiff(cam.yaw, prior.yaw)),
				pitch: r2(cam.pitch - prior.pitch),
				roll: r2(cam.roll - prior.roll),
				focal: r3(cam.f / prior.f),
			},
		},
		app: app
			? {
					yaw: r2(app.pose.yaw),
					pitch: r2(app.pose.pitch),
					roll: r2(app.pose.roll),
					vfov: r2(app.pose.vfov),
					source: app.source,
					confidence: r3(app.confidence),
				}
			: null,
		skyline: { rows: arr(sky.rows), weight: arr(sky.weight, r2) },
		priorRows: arr(priorRows),
		solvedRows: arr(solvedRows),
		residual: {
			prior: residualStats(sky.rows, sky.weight, priorRows),
			solved: residualStats(sky.rows, sky.weight, solvedRows),
		},
		horizon: { step: 0.5, profile },
		peaks: [...shown, ...hidden],
		terrainProfile: { azimuth: r2(cam.yaw), points: terrainProfile },
		demPatch: {
			src: `/demo/gipfelbuch/${p.id}-dem.jpg`,
			halfKm: DEM_HALF_KM,
			px: DEM_PX,
			min: Math.round(lo),
			max: Math.round(hi),
		},
		skyImage: sky.sky ? `/demo/gipfelbuch/${p.id}-sky.jpg` : null,
		ms: Object.fromEntries(
			Object.entries(t).map(([k, v]) => [k, Math.round(v)]),
		),
	};
}

const want = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const summary = [];
for (const p of manifest.photos) {
	if (want.length && !want.includes(p.id)) continue;
	const d = await build(p);
	fs.writeFileSync(path.join(OUT, `${p.id}.json`), JSON.stringify(d));
	const line = {
		id: d.id,
		thumb: d.photo.thumb,
		accepted: d.solved.accepted,
		stage: d.solved.stage,
		confidence: d.solved.confidence,
		delta: d.solved.delta,
		residual: d.residual,
		peaks: d.peaks.filter((x) => x.visible && x.solved).length,
		labelled: d.peaks.filter((x) => x.labelled).map((x) => x.name),
		ms: d.ms,
	};
	summary.push(line);
	console.log(
		d.id,
		d.solved.stage,
		d.solved.accepted,
		`conf ${d.solved.confidence}`,
		`Δyaw ${d.solved.delta.yaw}°`,
		`median ${d.residual.prior.median}→${d.residual.solved.median}px`,
		d.ms,
	);
}

// Ground-truth eval rows (12 hand-registered photos), copied as-is from the latest eval runs.
const evalRows = (dir: string) => {
	const f = path.join(ROOT, "out", dir, "report.json");
	return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};
if (!want.length)
	fs.writeFileSync(
		path.join(OUT, "index.json"),
		JSON.stringify({
			generated: new Date().toISOString().slice(0, 10),
			script: "scripts/gipfelbuch/build-data.ts",
			place: "Niederhorn above Lake Thun · 7 September 2026",
			photos: summary,
			groundTruthEval: {
				solve: evalRows("eval"),
				cascade: evalRows("eval-classic-cascade"),
			},
		}),
	);

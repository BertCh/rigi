// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Shared helpers for the annotation / ground-truth scripts: scene loading
 * (EXIF prior, DEM, horizon, OSM peaks), control-point resolution and
 * overlay drawing.
 */
import fs from "node:fs";
import path from "node:path";
import type { SKRSContext2D } from "@napi-rs/canvas";
import { TERRAIN_LEVELS, type TerrainLevel } from "../src/lib/dem";
import {
	type Camera,
	cameraFromAngles,
	cameraFromMeta,
	directionENU,
	project,
} from "../src/lib/geo/camera";
import type { ControlPoint } from "../src/lib/geo/control-points";
import { computeHorizon, type HorizonProfile } from "../src/lib/geo/horizon";
import {
	apparentElevation,
	type PeakView,
	viewPeaks,
} from "../src/lib/geo/peaks";
import { type ExifPhotoMeta, readPhotoMeta } from "../src/lib/geo/photo-meta";
import { EYE_ABOVE_GROUND } from "../src/lib/geo/pipeline";
import { loadTerrain, type TerrainSampler } from "../src/lib/geo/terrain";
import { imagePixelSize, loadTerrariumTileNode, ROOT } from "./lib/node-io";
import { fetchPeaks } from "./lib/overpass";

export const CP_FILE = path.join(ROOT, "data", "control-points.json");
export const GT_FILE = path.join(ROOT, "data", "ground-truth.json");

export type EyeMode = "max" | "ground" | "gps";

export interface Scene {
	eyeMode: EyeMode;
	name: string;
	heic: string;
	meta: ExifPhotoMeta;
	prior: Camera;
	terrain: TerrainSampler;
	ground: number;
	eye: number;
	horizon: HorizonProfile;
	views: PeakView[];
}

/**
 * Finer than TERRAIN_LEVELS: summits 5–40 km away are badly smoothed at
 * z11 (~50 m px), which matters for ground truth.
 */
export const GT_TERRAIN_LEVELS: TerrainLevel[] = [
	{ z: 13, maxDistance: 12_000 },
	{ z: 12, maxDistance: 45_000 },
	{ z: 10, maxDistance: 150_000 },
];

const tileCache = new Map<string, Float32Array>();

export async function loadScene(
	name: string,
	heic: string,
	levels: TerrainLevel[] = GT_TERRAIN_LEVELS,
	/** "max" = max(gps, ground+1.6) (pipeline default), "ground", "gps". */
	eyeMode: EyeMode = "max",
): Promise<Scene> {
	const meta = await readPhotoMeta(fs.readFileSync(heic), imagePixelSize(heic));
	if (meta.lat === undefined || meta.lon === undefined)
		throw new Error(`${name}: no GPS`);
	const prior = cameraFromMeta(meta);
	const terrain = await loadTerrain(
		meta.lat,
		meta.lon,
		loadTerrariumTileNode,
		levels,
		tileCache,
	);
	const ground = terrain.sample(meta.lon, meta.lat, TERRAIN_LEVELS[0].z);
	const eye =
		eyeMode === "ground"
			? ground + EYE_ABOVE_GROUND
			: eyeMode === "gps" && meta.altitude !== undefined
				? meta.altitude
				: Math.max(meta.altitude ?? ground, ground + EYE_ABOVE_GROUND);
	const horizon = computeHorizon(terrain, meta.lat, meta.lon, eye);
	const peaks = await fetchPeaks(meta.lat, meta.lon, 80_000);
	const views = viewPeaks(peaks, terrain, meta.lat, meta.lon, eye);
	return {
		eyeMode,
		name,
		heic,
		meta,
		prior,
		terrain,
		ground,
		eye,
		horizon,
		views,
	};
}

/** Skyline elevation (deg) and distance at azimuth, linearly interpolated. */
export function skylineAt(h: HorizonProfile, az: number) {
	const n = h.elevation.length;
	const f = ((((az % 360) + 360) % 360) / h.step) % n;
	const i = Math.floor(f);
	const t = f - i;
	const j = (i + 1) % n;
	return {
		elevation: h.elevation[i] * (1 - t) + h.elevation[j] * t,
		distance: h.distance[t < 0.5 ? i : j],
	};
}

/** A control point as stored in data/control-points.json. */
export interface StoredPoint {
	/** Pixel coords at `basis` px image width. */
	x: number;
	y: number;
	/** OSM peak name or "node/<id>". */
	peak?: string;
	/** Explicit azimuth (deg); elevation from `el` or the skyline profile. */
	az?: number;
	el?: number;
	/** Lat/lon of a terrain feature; height from `h` or the DEM. */
	lat?: number;
	lon?: number;
	h?: number;
	/** Known elevation `el`; azimuth from the pixel under the camera. */
	level?: boolean;
	label?: string;
}

export interface StoredEntry {
	basis: number;
	/** Eye height rule; default "max" (= max(gps, ground+1.6)). */
	eye?: EyeMode;
	/** Externally refined pose (e.g. sky-mask fit); points then only verify. */
	pose?: { yaw: number; pitch: number; roll: number; f?: number };
	source?: string;
	/** Fixed focal length (full-res px) replacing the EXIF value. */
	f?: number;
	solveFocal?: boolean;
	quality?: "good" | "approx" | "none";
	notes?: string;
	points: StoredPoint[];
}

export function readJson<T>(file: string, fallback: T): T {
	return fs.existsSync(file)
		? (JSON.parse(fs.readFileSync(file, "utf8")) as T)
		: fallback;
}

export function resolvePoint(
	scene: Scene,
	cam: Camera,
	sp: StoredPoint,
	basis: number,
): ControlPoint {
	const s = cam.width / basis;
	const base = { x: sp.x * s, y: sp.y * s };
	if (sp.peak) {
		const matches = scene.views.filter(
			(v) => v.peak.id === sp.peak || v.peak.name === sp.peak,
		);
		if (matches.length === 0) throw new Error(`Unknown peak ${sp.peak}`);
		const v = matches.sort((a, b) => a.distance - b.distance)[0];
		return {
			...base,
			azimuth: v.azimuth,
			elevation: v.elevation,
			label: sp.label ?? sp.peak,
		};
	}
	if (sp.lat !== undefined && sp.lon !== undefined) {
		const [one] = viewPeaks(
			[{ id: "pt", lat: sp.lat, lon: sp.lon, ele: sp.h }],
			scene.terrain,
			scene.meta.lat as number,
			scene.meta.lon as number,
			scene.eye,
		);
		return {
			...base,
			azimuth: one.azimuth,
			elevation: sp.h
				? apparentElevation(sp.h, scene.eye, one.distance)
				: one.elevation,
			label: sp.label,
		};
	}
	if (sp.az === undefined) throw new Error("Point needs peak, lat/lon or az");
	return {
		...base,
		azimuth: sp.az,
		elevation: sp.el ?? skylineAt(scene.horizon, sp.az).elevation,
		label: sp.label ?? `sky@${sp.az}`,
	};
}

export const cameraWith = (
	cam: Camera,
	p: Partial<{ yaw: number; pitch: number; roll: number; f: number }>,
) =>
	cameraFromAngles({
		width: cam.width,
		height: cam.height,
		yaw: p.yaw ?? cam.yaw,
		pitch: p.pitch ?? cam.pitch,
		roll: p.roll ?? cam.roll,
		f: p.f ?? cam.f,
	});

/** Colour by distance: near = warm, far = cool. */
export function distanceColor(d: number, alpha = 1) {
	const t = Math.min(1, Math.log10(Math.max(d, 500) / 500) / Math.log10(200));
	return `hsla(${20 + t * 200}, 95%, 55%, ${alpha})`;
}

/** Maps full-resolution display pixels to canvas pixels. */
export interface View2D {
	s: number;
	ox: number;
	oy: number;
	w: number;
	h: number;
}
const toCanvas = (v: View2D, p: [number, number]): [number, number] => [
	p[0] * v.s - v.ox,
	p[1] * v.s - v.oy,
];

export function drawSkyline(
	ctx: SKRSContext2D,
	cam: Camera,
	horizon: HorizonProfile,
	v: View2D,
	opts: { ridges?: boolean; width?: number } = {},
) {
	if (opts.ridges ?? true)
		for (let i = 0; i < horizon.ridges.length; i++) {
			const az = i * horizon.step;
			for (const r of horizon.ridges[i]) {
				const p = project(cam, directionENU(az, r.elevation));
				if (!p) continue;
				const [x, y] = toCanvas(v, p);
				if (x < 0 || y < 0 || x > v.w || y > v.h) continue;
				ctx.fillStyle = distanceColor(r.distance, 0.8);
				ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
			}
		}
	ctx.lineWidth = opts.width ?? 1.5;
	ctx.strokeStyle = "rgba(255,40,200,0.85)";
	ctx.beginPath();
	let pen = false;
	for (let i = 0; i < horizon.elevation.length; i++) {
		const p = project(
			cam,
			directionENU(i * horizon.step, horizon.elevation[i]),
		);
		const inView =
			p && p[0] > -50 && p[0] < cam.width + 50 && p[1] > -cam.height;
		if (!p || !inView) {
			pen = false;
			continue;
		}
		const [x, y] = toCanvas(v, p);
		if (pen) ctx.lineTo(x, y);
		else ctx.moveTo(x, y);
		pen = true;
	}
	ctx.stroke();
}

export function drawCrosshair(
	ctx: SKRSContext2D,
	x: number,
	y: number,
	r: number,
	color: string,
) {
	ctx.strokeStyle = color;
	ctx.lineWidth = 1.5;
	ctx.beginPath();
	ctx.moveTo(x - r, y);
	ctx.lineTo(x - r / 3, y);
	ctx.moveTo(x + r / 3, y);
	ctx.lineTo(x + r, y);
	ctx.moveTo(x, y - r);
	ctx.lineTo(x, y - r / 3);
	ctx.moveTo(x, y + r / 3);
	ctx.lineTo(x, y + r);
	ctx.stroke();
}

export function drawLabel(
	ctx: SKRSContext2D,
	text: string,
	x: number,
	y: number,
	color = "white",
	size = 14,
) {
	ctx.font = `bold ${size}px sans-serif`;
	const w = ctx.measureText(text).width;
	ctx.fillStyle = "rgba(0,0,0,0.55)";
	ctx.fillRect(x - 2, y - size, w + 4, size + 4);
	ctx.fillStyle = color;
	ctx.fillText(text, x, y);
}

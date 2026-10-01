// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Verification overlay: photo + DEM skyline at a pose + top OSM peak labels + a text header.
 *
 *   npx tsx tools/bench/harness/overlay.ts --photo p.jpg --lat 46.6 --lon 7.8 [--alt 1936]
 *       --pose yaw,pitch,roll,vfov [--gt yaw,pitch,roll,vfov] [--prior yaw,pitch,roll,vfov]
 *       [--method fused] [--title IMG_x] [--conf "HIGH 0.9"] [--region region.json] [--peaks 8]
 *       --out overlay.jpg
 *
 * Skyline: 0f's computeHorizon (curvature + refraction k=0.13) on the **Mapterhorn** DEM (lib/geo.ts),
 * from the eye the method used (--eye-h absolute m, optional --eye-lat/--eye-lon when the method moved
 * the camera), else the app's eye rule (GPS alt ≥ DEM + 1.6 m, else DEM + 1.8 m); projected with
 * projectSkylineRows. Peaks: the app's region JSON when
 * given, else Overpass (natural=peak within 80 km, cached in out/cache/overpass, 2 s between
 * queries), occlusion-tested with viewPeaks and laid out with layoutPeakLabels (import-only).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { type Pose, poseToCamera } from "../../../src/lib/camera";
import {
	layoutPeakLabels,
	type Peak,
	type PeakView,
	viewPeaks,
} from "../../../src/lib/geo/peaks";
import { projectSkylineRows } from "../../../src/lib/geo/solve";
import { appEye, peaksAt, sceneAt } from "./lib/geo";

export interface OverlayOptions {
	photoFile: string;
	lat: number;
	lon: number;
	alt?: number | null;
	/** Absolute eye height (m) the method used; default: the app's eye rule on Mapterhorn. */
	eyeH?: number | null;
	/** Eye position when the method moved the camera (pose6); default lat/lon. */
	eyeLat?: number | null;
	eyeLon?: number | null;
	eyeSource?: string;
	/** Eye rule when eyeH is not given: "app" (default: GPS ≥ DEM + 1.6, else DEM + 1.8) or "0f" (cascade: max(GPS, DEM + 1.6)). */
	eyeRule?: "app" | "0f";
	pose: Pose;
	gt?: Pose | null;
	prior?: Pose | null;
	title?: string;
	method?: string;
	condition?: string;
	confidence?: string;
	extra?: string;
	regionFile?: string | null;
	maxPeaks?: number;
	width?: number;
	out: string;
}

const peakViewCache = new Map<string, PeakView[]>();

async function peakViews(
	o: OverlayOptions,
	scene: Awaited<ReturnType<typeof sceneAt>>,
) {
	const lat = o.eyeLat ?? o.lat;
	const lon = o.eyeLon ?? o.lon;
	const key = `${lat},${lon},${scene.eye},${o.regionFile ?? ""}`;
	let v = peakViewCache.get(key);
	if (v) return v;
	let peaks: Peak[] = [];
	if (o.regionFile && fs.existsSync(o.regionFile)) {
		const r = JSON.parse(fs.readFileSync(o.regionFile, "utf8"));
		peaks = (r.peaks ?? []).map(
			(
				p: {
					name: string;
					lat: number;
					lon: number;
					ele: number | null;
					prominence: number | null;
				},
				i: number,
			) => ({
				id: `region/${i}`,
				name: p.name,
				lat: p.lat,
				lon: p.lon,
				ele: p.ele ?? undefined,
				prominence: p.prominence ?? undefined,
			}),
		);
	} else {
		try {
			peaks = await peaksAt(o.lat, o.lon);
		} catch (e) {
			console.error(`[overlay] peaks unavailable: ${e}`);
		}
	}
	v = viewPeaks(
		peaks.filter((p) => p.name),
		scene.terrain,
		lat,
		lon,
		scene.eye,
		{ maxDistance: 120_000 },
	);
	peakViewCache.set(key, v);
	return v;
}

function polyline(ctx: SKRSContext2D, rows: Float32Array, H: number) {
	ctx.beginPath();
	let pen = false;
	for (let x = 0; x < rows.length; x++) {
		const y = rows[x];
		if (!Number.isFinite(y) || y < -H || y > 2 * H) {
			pen = false;
			continue;
		}
		if (pen) ctx.lineTo(x + 0.5, y);
		else ctx.moveTo(x + 0.5, y);
		pen = true;
	}
	ctx.stroke();
}

function textBox(
	ctx: SKRSContext2D,
	text: string,
	x: number,
	y: number,
	size: number,
	fg = "#fff",
	bg = "rgba(0,0,0,0.62)",
) {
	ctx.font = `600 ${size}px sans-serif`;
	const w = ctx.measureText(text).width;
	const pad = size * 0.3;
	ctx.fillStyle = bg;
	ctx.fillRect(x - pad, y - size - pad * 0.6, w + 2 * pad, size + pad * 1.6);
	ctx.fillStyle = fg;
	ctx.fillText(text, x, y);
	return w + 2 * pad;
}

export async function renderOverlay(o: OverlayOptions) {
	const img = await loadImage(o.photoFile);
	const W = Math.min(o.width ?? 1600, img.width);
	const H = Math.round((img.height * W) / img.width);
	const canvas = createCanvas(W, H);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(img, 0, 0, W, H);
	const scene = await sceneAt(o.eyeLat ?? o.lat, o.eyeLon ?? o.lon, o.alt, {
		eyeH: o.eyeH,
		eyeRule: o.eyeRule === "0f" ? undefined : appEye,
		eyeSource: o.eyeSource,
	});
	const s = W / 1600;
	ctx.lineJoin = "round";
	// prior (magenta dotted), GT (white dashed), pose (yellow on black)
	if (o.prior) {
		ctx.strokeStyle = "rgba(255,60,210,0.85)";
		ctx.lineWidth = 2 * s;
		ctx.setLineDash([4 * s, 8 * s]);
		polyline(
			ctx,
			projectSkylineRows(poseToCamera(o.prior, W, H), scene.horizon, W),
			H,
		);
	}
	if (o.gt) {
		ctx.strokeStyle = "rgba(255,255,255,0.95)";
		ctx.lineWidth = 2.5 * s;
		ctx.setLineDash([14 * s, 9 * s]);
		polyline(
			ctx,
			projectSkylineRows(poseToCamera(o.gt, W, H), scene.horizon, W),
			H,
		);
	}
	ctx.setLineDash([]);
	const cam = poseToCamera(o.pose, W, H);
	const rows = projectSkylineRows(cam, scene.horizon, W);
	ctx.strokeStyle = "rgba(0,0,0,0.75)";
	ctx.lineWidth = 5.5 * s;
	polyline(ctx, rows, H);
	ctx.strokeStyle = "#ffd60a";
	ctx.lineWidth = 2.4 * s;
	polyline(ctx, rows, H);

	// peaks
	const header = Math.round(74 * s);
	const views = await peakViews(o, scene);
	const labels = layoutPeakLabels(views, cam, {
		maxLabels: o.maxPeaks ?? 8,
		minSpacingPx: W * 0.07,
	});
	const size = Math.round(21 * s);
	const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
	const pad = size * 0.3;
	for (const l of labels) {
		const ele = l.peak.ele ? ` ${Math.round(l.peak.ele)} m` : "";
		const km = `${(l.distance / 1000).toFixed(l.distance < 10000 ? 1 : 0)} km`;
		const t = `${l.peak.name}${ele} · ${km}`;
		ctx.font = `600 ${size}px sans-serif`;
		const tw = ctx.measureText(t).width;
		const tx = Math.min(W - tw - 8 * s, Math.max(8 * s, l.x - tw / 2));
		const minY = header + size + 12 * s;
		// stack upwards from just above the peak until the box is free; then downwards from the top
		const cands: number[] = [];
		for (let k = 0; k < 8; k++) cands.push(l.y - 34 * s - k * (size + 12 * s));
		for (let k = 0; k < 8; k++) cands.push(minY + k * (size + 12 * s));
		let ly = cands[0];
		for (const c of cands) {
			const y = Math.max(minY, c);
			const box = {
				x0: tx - pad - 4 * s,
				x1: tx + tw + pad + 4 * s,
				y0: y - size - pad,
				y1: y + pad,
			};
			if (
				placed.every(
					(b) =>
						b.x1 < box.x0 || b.x0 > box.x1 || b.y1 < box.y0 || b.y0 > box.y1,
				)
			) {
				ly = y;
				placed.push(box);
				break;
			}
		}
		ctx.strokeStyle = "rgba(255,255,255,0.9)";
		ctx.lineWidth = 1.5 * s;
		ctx.beginPath();
		ctx.moveTo(l.x, l.y - 5 * s);
		ctx.lineTo(l.x, ly + (ly < l.y ? 6 * s : -size - 6 * s));
		ctx.stroke();
		ctx.fillStyle = "#ffd60a";
		ctx.strokeStyle = "#000";
		ctx.beginPath();
		ctx.arc(l.x, l.y, 4.5 * s, 0, 2 * Math.PI);
		ctx.fill();
		ctx.stroke();
		textBox(ctx, t, tx, ly, size);
	}

	// header
	ctx.fillStyle = "rgba(0,0,0,0.72)";
	ctx.fillRect(0, 0, W, header);
	ctx.fillStyle = "#fff";
	ctx.font = `700 ${Math.round(26 * s)}px sans-serif`;
	const p = o.pose;
	ctx.fillText(
		`${o.title ?? path.parse(o.photoFile).name} · ${o.method ?? "pose"}${o.condition ? ` · ${o.condition}` : ""}${o.confidence ? ` · ${o.confidence}` : ""}`,
		12 * s,
		31 * s,
	);
	ctx.font = `500 ${Math.round(21 * s)}px sans-serif`;
	ctx.fillText(
		`yaw ${p.yaw.toFixed(2)}°  pitch ${p.pitch.toFixed(2)}°  roll ${p.roll.toFixed(2)}°  vfov ${p.vfov.toFixed(1)}°  ·  ${(o.eyeLat ?? o.lat).toFixed(5)}, ${(o.eyeLon ?? o.lon).toFixed(5)}  eye ${scene.eye.toFixed(0)} m${o.extra ? `  ·  ${o.extra}` : ""}`,
		12 * s,
		62 * s,
	);
	// legend
	const lg = `yellow: DEM skyline at this pose${o.gt ? " · white dashed: ground truth" : ""}${o.prior ? " · magenta dotted: prior" : ""} · labels: OSM peaks (occlusion-tested)`;
	textBox(
		ctx,
		lg,
		10 * s,
		H - 12 * s,
		Math.round(16 * s),
		"#ddd",
		"rgba(0,0,0,0.55)",
	);
	fs.mkdirSync(path.dirname(o.out), { recursive: true });
	fs.writeFileSync(o.out, await canvas.encode("jpeg", 82));
	return {
		out: o.out,
		labels: labels.map((l) => l.peak.name),
		eye: scene.eye,
		ground: scene.ground,
		dem: scene.dem,
	};
}

function parsePose(v?: string): Pose | null {
	if (!v) return null;
	const [yaw, pitch, roll, vfov] = v.split(",").map(Number);
	return { yaw, pitch, roll, vfov };
}

async function cli() {
	const a: Record<string, string> = {};
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++)
		if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
	if (!a.photo || !a.lat || !a.lon || !a.pose || !a.out) {
		console.error(
			"usage: overlay.ts --photo p.jpg --lat L --lon L [--alt m] --pose yaw,pitch,roll,vfov [--gt ...] [--prior ...] [--method m] [--title t] [--conf c] [--region r.json] [--peaks 8] [--eye-h m] [--eye-lat L --eye-lon L] --out o.jpg",
		);
		process.exit(2);
	}
	const r = await renderOverlay({
		photoFile: a.photo,
		lat: +a.lat,
		lon: +a.lon,
		alt: a.alt ? +a.alt : null,
		pose: parsePose(a.pose) as Pose,
		gt: parsePose(a.gt),
		prior: parsePose(a.prior),
		method: a.method,
		title: a.title,
		confidence: a.conf,
		regionFile: a.region,
		eyeH: a["eye-h"] ? +a["eye-h"] : null,
		eyeLat: a["eye-lat"] ? +a["eye-lat"] : null,
		eyeLon: a["eye-lon"] ? +a["eye-lon"] : null,
		maxPeaks: a.peaks ? +a.peaks : 8,
		out: a.out,
	});
	console.log(JSON.stringify(r));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	cli().catch((e) => {
		console.error(e);
		process.exit(1);
	});

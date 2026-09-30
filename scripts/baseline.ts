/**
 * Baseline georeferencing pass over img/*.HEIC:
 *   EXIF + Apple gravity → prior camera → Terrarium DEM horizon → overlay.
 *
 *   npx tsx scripts/baseline.ts [IMG_7033 ...]
 *
 * Writes out/baseline/<name>.jpg (overlay), out/baseline/<name>.json and
 * out/baseline/summary.json. Tiles are cached in .cache/terrarium.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { TERRAIN_LEVELS } from "../src/lib/dem";
import {
	type Camera,
	cameraFromMeta,
	directionENU,
	project,
} from "../src/lib/geo/camera";
import { computeHorizon, type HorizonProfile } from "../src/lib/geo/horizon";
import { readPhotoMeta } from "../src/lib/geo/photo-meta";
import { EYE_ABOVE_GROUND } from "../src/lib/geo/pipeline";
import { loadTerrain } from "../src/lib/geo/terrain";
import {
	heicToJpeg,
	imagePixelSize,
	listPhotos,
	loadTerrariumTileNode,
	ROOT,
} from "./lib/node-io";

const OUT = path.join(ROOT, "out", "baseline");
const tileCache = new Map<string, Float32Array>();

/** Colour by distance: near = warm, far = cool. */
function distanceColor(d: number) {
	const t = Math.min(1, Math.log10(Math.max(d, 500) / 500) / Math.log10(200));
	const hue = 20 + t * 200;
	return `hsl(${hue} 95% 55%)`;
}

async function drawOverlay(
	jpg: string,
	cam: Camera,
	horizon: HorizonProfile,
	label: string,
	outFile: string,
) {
	const img = await loadImage(jpg);
	const s = img.width / cam.width;
	const canvas = createCanvas(img.width, img.height);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(img, 0, 0);

	// Visible ridge crests (inner silhouettes).
	for (let i = 0; i < horizon.ridges.length; i++) {
		const az = i * horizon.step;
		for (const r of horizon.ridges[i]) {
			const p = project(cam, directionENU(az, r.elevation));
			if (!p) continue;
			ctx.fillStyle = distanceColor(r.distance);
			ctx.fillRect(p[0] * s - 1, p[1] * s - 1, 2, 2);
		}
	}

	// Skyline.
	ctx.lineWidth = 3;
	ctx.strokeStyle = "rgba(255,40,200,0.9)";
	ctx.beginPath();
	let pen = false;
	for (let i = 0; i < horizon.elevation.length; i++) {
		const p = project(
			cam,
			directionENU(i * horizon.step, horizon.elevation[i]),
		);
		const inView =
			p && p[0] > -50 && p[0] < cam.width + 50 && p[1] > -cam.height;
		if (!inView) {
			pen = false;
			continue;
		}
		if (pen) ctx.lineTo(p[0] * s, p[1] * s);
		else ctx.moveTo(p[0] * s, p[1] * s);
		pen = true;
	}
	ctx.stroke();

	// Geometric horizon (elevation 0) for reference.
	ctx.setLineDash([10, 8]);
	ctx.lineWidth = 1.5;
	ctx.strokeStyle = "rgba(255,255,255,0.7)";
	ctx.beginPath();
	pen = false;
	for (let az = 0; az < 360; az += 0.5) {
		const p = project(cam, directionENU(az, 0));
		if (!p || p[0] < -50 || p[0] > cam.width + 50) {
			pen = false;
			continue;
		}
		if (pen) ctx.lineTo(p[0] * s, p[1] * s);
		else ctx.moveTo(p[0] * s, p[1] * s);
		pen = true;
	}
	ctx.stroke();
	ctx.setLineDash([]);

	ctx.font = "bold 22px sans-serif";
	ctx.fillStyle = "rgba(0,0,0,0.6)";
	ctx.fillRect(0, 0, img.width, 34);
	ctx.fillStyle = "white";
	ctx.fillText(label, 10, 24);
	fs.writeFileSync(outFile, await canvas.encode("jpeg", 85));
}

async function main() {
	const files = listPhotos(process.argv.slice(2));
	fs.mkdirSync(OUT, { recursive: true });
	const summary = [];

	for (const { name, heic } of files) {
		const meta = await readPhotoMeta(
			fs.readFileSync(heic),
			imagePixelSize(heic),
		);
		if (meta.lat === undefined || meta.lon === undefined) {
			console.log(`${name}: no GPS, skipping`);
			continue;
		}
		const cam = cameraFromMeta(meta);
		const terrain = await loadTerrain(
			meta.lat,
			meta.lon,
			loadTerrariumTileNode,
			TERRAIN_LEVELS,
			tileCache,
		);
		const ground = terrain.sample(meta.lon, meta.lat, TERRAIN_LEVELS[0].z);
		const eye = Math.max(meta.altitude ?? ground, ground + EYE_ABOVE_GROUND);
		const t0 = performance.now();
		const horizon = computeHorizon(terrain, meta.lat, meta.lon, eye);
		const ms = performance.now() - t0;

		const fovH = (2 * Math.atan(cam.width / 2 / cam.f) * 180) / Math.PI;
		const row = {
			name,
			lat: meta.lat,
			lon: meta.lon,
			gpsAltitude: meta.altitude,
			demGround: +ground.toFixed(1),
			eye: +eye.toFixed(1),
			gpsError: meta.gpsError,
			focal35: meta.focal35,
			fPx: +cam.f.toFixed(1),
			fovH: +fovH.toFixed(1),
			orientation: meta.orientation,
			yaw: +cam.yaw.toFixed(2),
			pitch: +cam.pitch.toFixed(2),
			roll: +cam.roll.toFixed(2),
			horizonMs: Math.round(ms),
		};
		summary.push(row);
		console.log(
			`${name}  yaw ${row.yaw}°  pitch ${row.pitch}°  roll ${row.roll}°  f35 ${row.focal35} (hfov ${row.fovH}°)  alt gps ${meta.altitude?.toFixed(0)} / dem ${ground.toFixed(0)}  ±${meta.gpsError?.toFixed(0)}m  horizon ${row.horizonMs}ms`,
		);

		fs.writeFileSync(
			path.join(OUT, `${name}.json`),
			JSON.stringify({ meta, camera: cam, eye }, null, 1),
		);
		await drawOverlay(
			heicToJpeg(heic),
			cam,
			horizon,
			`${name}  prior: yaw ${row.yaw}° pitch ${row.pitch}° roll ${row.roll}° hfov ${row.fovH}°`,
			path.join(OUT, `${name}.jpg`),
		);
	}
	fs.writeFileSync(
		path.join(OUT, "summary.json"),
		JSON.stringify(summary, null, 1),
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

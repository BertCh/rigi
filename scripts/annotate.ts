// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Ground-truth annotation helper.
 *
 *   npx tsx scripts/annotate.ts IMG_7053 [options]
 *
 * Renders photo + predicted skyline/ridges + visible OSM peaks + a pixel
 * ruler (coordinates at 1600 px width) into out/gt/<name>.jpg. The camera
 * is solved from data/control-points.json when that has points for the
 * photo, else the EXIF prior.
 *
 *   --prior              ignore control points
 *   --cam y,p,r[,f]      explicit camera (deg, f in full-res px)
 *   --clean              photo + ruler only
 *   --crop x,y,w,h       crop (1600-px coords) → out/gt/<name>_crop.jpg
 *   --zoom z             crop magnification (default: 1400 px output)
 *   --probe x,y          print az/el under a pixel + nearby peaks
 *   --write              store the solved pose in data/ground-truth.json
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
	azimuthElevation,
	type Camera,
	directionENU,
	project,
	unproject,
} from "../src/lib/geo/camera";
import {
	type ControlPoint,
	type LevelPoint,
	solveFromControlPoints,
} from "../src/lib/geo/control-points";
import { apparentElevation, layoutPeakLabels } from "../src/lib/geo/peaks";
import { destination } from "../src/lib/geodesy";
import {
	CP_FILE,
	cameraWith,
	drawCrosshair,
	drawLabel,
	drawSkyline,
	type EyeMode,
	GT_FILE,
	loadScene,
	readJson,
	resolvePoint,
	type StoredEntry,
	skylineAt,
	type View2D,
} from "./annotate-lib";
import { heicToJpeg, listPhotos, ROOT } from "./lib/node-io";

const OUT = path.join(ROOT, "out", "gt");
const BASIS = 1600;

function arg(name: string) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);
const nums = (s: string) => s.split(",").map(Number);
const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

async function main() {
	const name = process.argv[2];
	const [photo] = listPhotos([name]);
	if (!photo) throw new Error(`No photo ${name}`);
	const entry = readJson<Record<string, StoredEntry>>(CP_FILE, {})[photo.name];
	const scene = await loadScene(
		photo.name,
		photo.heic,
		undefined,
		(arg("--eye") as EyeMode | undefined) ?? entry?.eye ?? "max",
	);

	let cam: Camera = scene.prior;
	let points: ControlPoint[] = [];
	let levels: LevelPoint[] = [];
	let solve: ReturnType<typeof solveFromControlPoints> | undefined;
	if (entry?.points.length && !flag("--prior")) {
		const k0 = scene.prior.width / entry.basis;
		points = entry.points
			.filter((p) => !p.level)
			.map((p) => resolvePoint(scene, scene.prior, p, entry.basis));
		levels = entry.points
			.filter((p) => p.level)
			.map((p) => ({
				x: p.x * k0,
				y: p.y * k0,
				elevation: p.el as number,
				label: p.label,
			}));
		const init = entry.f
			? cameraWith(scene.prior, { f: entry.f })
			: scene.prior;
		solve = solveFromControlPoints(init, points, {
			solveFocal: entry.solveFocal ?? false,
			levels,
		});
		cam = solve.camera;
		if (entry.pose) {
			cam = cameraWith(scene.prior, entry.pose);
			const r = points.map((p) => {
				const q = project(cam, directionENU(p.azimuth, p.elevation));
				return q ? Math.hypot(q[0] - p.x, q[1] - p.y) : 1e5;
			});
			solve = {
				camera: cam,
				residualsPx: r,
				rmsPx: Math.sqrt(
					r.reduce((a, v) => a + v * v, 0) / Math.max(1, r.length),
				),
				solvedFocal: false,
			};
			console.log("using stored pose (points are verification only)");
		}
	}
	const camArg = arg("--cam");
	if (camArg) {
		const [yaw, pitch, roll, f] = nums(camArg);
		cam = cameraWith(scene.prior, { yaw, pitch, roll, f });
	}
	const k = cam.width / BASIS; // full-res px per basis px

	console.log(
		`${photo.name} eye ${scene.eye.toFixed(0)} (gps ${scene.meta.altitude?.toFixed(0)}, dem ${scene.ground.toFixed(0)})  ${cam.width}x${cam.height}`,
	);
	const pr = scene.prior;
	console.log(
		`prior  yaw ${pr.yaw.toFixed(2)} pitch ${pr.pitch.toFixed(2)} roll ${pr.roll.toFixed(2)} f ${pr.f.toFixed(0)}`,
	);
	console.log(
		`camera yaw ${cam.yaw.toFixed(2)} pitch ${cam.pitch.toFixed(2)} roll ${cam.roll.toFixed(2)} f ${cam.f.toFixed(0)}  (Δ ${angDiff(cam.yaw, pr.yaw).toFixed(2)}, ${(cam.pitch - pr.pitch).toFixed(2)}, ${(cam.roll - pr.roll).toFixed(2)})`,
	);
	if (solve) {
		console.log(
			`solve  ${points.length} pts  rms ${(solve.rmsPx / k).toFixed(2)} px@${BASIS}  focal=${solve.solvedFocal}`,
		);
		points.forEach((p, i) => {
			const q = project(cam, directionENU(p.azimuth, p.elevation));
			console.log(
				`   ${(p.label ?? "").padEnd(22)} az ${p.azimuth.toFixed(3)} el ${p.elevation.toFixed(3)}  meas ${(p.x / k).toFixed(1)},${(p.y / k).toFixed(1)}  pred ${q ? `${(q[0] / k).toFixed(1)},${(q[1] / k).toFixed(1)}` : "-"}  res ${((solve?.residualsPx[i] ?? 0) / k).toFixed(2)}`,
			);
		});
		levels.forEach((l, i) => {
			const [az, el] = azimuthElevation(unproject(cam, l.x, l.y));
			console.log(
				`   ${(l.label ?? "level").padEnd(22)} az ${az.toFixed(3)} el ${l.elevation.toFixed(3)} (pixel el ${el.toFixed(3)})  meas ${(l.x / k).toFixed(1)},${(l.y / k).toFixed(1)}  res ${((solve?.residualsPx[points.length + i] ?? 0) / k).toFixed(2)}`,
			);
		});
	}

	// In-frame visible peaks.
	const inFrame = scene.views
		.map((v) => ({ v, p: project(cam, directionENU(v.azimuth, v.elevation)) }))
		.filter(
			({ p }) =>
				p && p[0] >= 0 && p[0] <= cam.width && p[1] >= -cam.height * 0.1,
		)
		.sort((a, b) => (a.p as number[])[0] - (b.p as number[])[0]);
	if (flag("--list"))
		for (const { v, p } of inFrame) {
			if (!v.visible || !v.peak.name) continue;
			const sky = skylineAt(scene.horizon, v.azimuth);
			console.log(
				`   peak ${v.peak.name.padEnd(26)} ${((p as number[])[0] / k).toFixed(0).padStart(5)},${((p as number[])[1] / k).toFixed(0).padStart(5)}  az ${v.azimuth.toFixed(2)} el ${v.elevation.toFixed(2)} (sky ${sky.elevation.toFixed(2)})  ${(v.distance / 1000).toFixed(1)} km  ${v.height.toFixed(0)} m${v.peak.wikidata ? " W" : ""}`,
			);
		}

	const find = arg("--find");
	if (find)
		for (const v of scene.views)
			if (v.peak.name?.toLowerCase().includes(find.toLowerCase())) {
				const q = project(cam, directionENU(v.azimuth, v.elevation));
				console.log(
					`find ${v.visible ? "vis" : "hid"} ${v.peak.name} ${v.peak.id} az ${v.azimuth.toFixed(3)} el ${v.elevation.toFixed(3)} ${(v.distance / 1000).toFixed(1)} km ${v.height.toFixed(0)} m (osm ${v.peak.ele ?? "-"})  px ${q ? `${(q[0] / k).toFixed(0)},${(q[1] / k).toFixed(0)}` : "-"}`,
				);
			}

	const probe = arg("--probe");
	if (probe) {
		const [px, py] = nums(probe);
		const [az, el] = azimuthElevation(unproject(cam, px * k, py * k));
		const sky = skylineAt(scene.horizon, az);
		console.log(
			`probe ${px},${py}: az ${az.toFixed(3)} el ${el.toFixed(3)}  skyline el ${sky.elevation.toFixed(3)} at ${(sky.distance / 1000).toFixed(1)} km`,
		);
		const lake = Number(arg("--lake") ?? Number.NaN);
		if (!Number.isNaN(lake)) {
			// Distance to the first terrain above lake level along this azimuth.
			for (let d = 30; d < 30_000; d += 10) {
				const q = destination(
					scene.meta.lat as number,
					scene.meta.lon as number,
					az,
					d,
				);
				if (scene.terrain.sampleAt(q.lon, q.lat, d) > lake + 1.5) {
					const el = apparentElevation(lake, scene.eye, d);
					console.log(
						`   shore at ${d} m → waterline el ${el.toFixed(3)} (eye ${scene.eye.toFixed(1)})`,
					);
					break;
				}
			}
		}
		for (const v of scene.views)
			if (v.peak.name && Math.abs(angDiff(v.azimuth, az)) < 1.5)
				console.log(
					`   ${v.visible ? "vis" : "hid"} ${v.peak.name} az ${v.azimuth.toFixed(3)} el ${v.elevation.toFixed(3)} ${(v.distance / 1000).toFixed(1)} km ${v.height.toFixed(0)} m`,
				);
	}

	// Render.
	fs.mkdirSync(OUT, { recursive: true });
	const img = await loadImage(heicToJpeg(photo.heic, 4032));
	const crop = arg("--crop");
	let view: View2D;
	let src: [number, number, number, number];
	let gridStep: number;
	let labelStep: number;
	if (crop) {
		const [x, y, w, h] = nums(crop);
		const zoom = Number(arg("--zoom") ?? 1400 / w);
		view = {
			s: zoom / k,
			ox: x * zoom,
			oy: y * zoom,
			w: w * zoom,
			h: h * zoom,
		};
		src = [x * k, y * k, w * k, h * k];
		gridStep = w <= 200 ? 5 : w <= 500 ? 10 : 25;
		labelStep = gridStep * 5;
	} else {
		view = {
			s: BASIS / cam.width,
			ox: 0,
			oy: 0,
			w: BASIS,
			h: (cam.height * BASIS) / cam.width,
		};
		src = [0, 0, cam.width, cam.height];
		gridStep = 50;
		labelStep = 100;
	}
	const canvas = createCanvas(Math.round(view.w), Math.round(view.h));
	const ctx = canvas.getContext("2d");
	const is = img.width / cam.width;
	ctx.drawImage(
		img,
		src[0] * is,
		src[1] * is,
		src[2] * is,
		src[3] * is,
		0,
		0,
		view.w,
		view.h,
	);
	if (flag("--enhance")) {
		// Contrast stretch (1–99 % luminance) to pull out hazy skylines.
		const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
		const d = id.data;
		const hist = new Array(256).fill(0);
		for (let i = 0; i < d.length; i += 4)
			hist[Math.round(0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2])]++;
		const total = d.length / 4;
		let acc = 0;
		let lo = 0;
		let hi = 255;
		for (let v = 0; v < 256; v++) {
			acc += hist[v];
			if (acc < total * 0.01) lo = v;
			if (acc < total * 0.99) hi = v;
		}
		const sc = 255 / Math.max(1, hi - lo);
		for (let i = 0; i < d.length; i += 4)
			for (let c = 0; c < 3; c++)
				d[i + c] = Math.max(0, Math.min(255, (d[i + c] - lo) * sc));
		ctx.putImageData(id, 0, 0);
	}
	const bs = view.s * k; // canvas px per basis px
	const bx = (x: number) => x * bs - view.ox;
	const by = (y: number) => y * bs - view.oy;

	// Ruler grid in basis coords.
	const x0 = Math.ceil(view.ox / bs / gridStep) * gridStep;
	const y0 = Math.ceil(view.oy / bs / gridStep) * gridStep;
	ctx.lineWidth = 1;
	for (let x = x0; bx(x) <= view.w; x += gridStep) {
		ctx.strokeStyle =
			x % labelStep === 0 ? "rgba(255,255,0,0.35)" : "rgba(255,255,255,0.12)";
		ctx.beginPath();
		ctx.moveTo(bx(x), 0);
		ctx.lineTo(bx(x), view.h);
		ctx.stroke();
		if (x % labelStep === 0)
			drawLabel(ctx, `${x}`, bx(x) + 2, view.h - 4, "yellow", 12);
	}
	for (let y = y0; by(y) <= view.h; y += gridStep) {
		ctx.strokeStyle =
			y % labelStep === 0 ? "rgba(255,255,0,0.35)" : "rgba(255,255,255,0.12)";
		ctx.beginPath();
		ctx.moveTo(0, by(y));
		ctx.lineTo(view.w, by(y));
		ctx.stroke();
		if (y % labelStep === 0) drawLabel(ctx, `${y}`, 2, by(y) - 2, "yellow", 12);
	}

	if (!flag("--clean")) {
		drawSkyline(ctx, cam, scene.horizon, view, { width: crop ? 1 : 1.5 });
		const shown = flag("--nolabels")
			? []
			: crop
				? inFrame.filter((c) => c.v.visible && c.v.peak.name)
				: layoutPeakLabels(
						scene.views.filter((v) => v.peak.name),
						cam,
						{ maxLabels: 30, minSpacingPx: cam.width * 0.02 },
					).map((l) => ({ v: l, p: [l.x, l.y] as [number, number] }));
		for (const { v, p } of shown) {
			if (!p) continue;
			const x = p[0] * view.s - view.ox;
			const y = p[1] * view.s - view.oy;
			if (x < 0 || y < 0 || x > view.w || y > view.h) continue;
			drawCrosshair(ctx, x, y, 8, "yellow");
			ctx.save();
			ctx.translate(x, y - 10);
			ctx.rotate(-Math.PI / 3);
			drawLabel(
				ctx,
				`${v.peak.name} ${(v.distance / 1000).toFixed(0)}km`,
				0,
				0,
				"yellow",
				12,
			);
			ctx.restore();
		}
		for (const pt of points) {
			const x = pt.x * view.s - view.ox;
			const y = pt.y * view.s - view.oy;
			const q = project(cam, directionENU(pt.azimuth, pt.elevation));
			ctx.strokeStyle = "lime";
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.arc(x, y, 5, 0, 2 * Math.PI);
			ctx.stroke();
			if (q) {
				ctx.strokeStyle = "red";
				ctx.beginPath();
				ctx.moveTo(x, y);
				ctx.lineTo(q[0] * view.s - view.ox, q[1] * view.s - view.oy);
				ctx.stroke();
			}
			drawLabel(ctx, pt.label ?? "", x + 6, y + 18, "lime", 12);
		}
	}
	const tag = crop ? "_crop" : flag("--clean") ? "_clean" : "";
	const outFile = path.join(OUT, `${photo.name}${tag}.jpg`);
	fs.writeFileSync(outFile, await canvas.encode("jpeg", 90));
	console.log(`wrote ${path.relative(ROOT, outFile)}`);

	if (flag("--write") && entry) {
		const gt = readJson<Record<string, unknown>>(GT_FILE, {});
		gt[photo.name] = {
			width: cam.width,
			height: cam.height,
			yaw: +cam.yaw.toFixed(3),
			pitch: +cam.pitch.toFixed(3),
			roll: +cam.roll.toFixed(3),
			f: +cam.f.toFixed(1),
			points: points.length + levels.length,
			rmsPx: solve ? +solve.rmsPx.toFixed(2) : null,
			rmsPx1600: solve ? +(solve.rmsPx / k).toFixed(2) : null,
			quality: entry.quality ?? "approx",
			eye: +scene.eye.toFixed(1),
			eyeRule: scene.eyeMode,
			eyeSource:
				Math.abs(scene.eye - (scene.ground + 1.6)) < 0.01 ? "dem+1.6" : "gps",
			demGround: +scene.ground.toFixed(1),
			gpsAltitude: scene.meta.altitude ? +scene.meta.altitude.toFixed(1) : null,
			lat: scene.meta.lat,
			lon: scene.meta.lon,
			prior: {
				yaw: +pr.yaw.toFixed(3),
				pitch: +pr.pitch.toFixed(3),
				roll: +pr.roll.toFixed(3),
				f: +pr.f.toFixed(1),
			},
			delta: {
				yaw: +angDiff(cam.yaw, pr.yaw).toFixed(3),
				pitch: +(cam.pitch - pr.pitch).toFixed(3),
				roll: +(cam.roll - pr.roll).toFixed(3),
			},
			notes: entry.notes ?? "",
		};
		const sorted = Object.fromEntries(
			Object.entries(gt).sort(([a], [b]) => a.localeCompare(b)),
		);
		fs.mkdirSync(path.dirname(GT_FILE), { recursive: true });
		fs.writeFileSync(GT_FILE, `${JSON.stringify(sorted, null, "\t")}\n`);
		console.log(`updated ${path.relative(ROOT, GT_FILE)}`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

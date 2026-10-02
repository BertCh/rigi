// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Bakes the Tafel's spill: the terrain that continues one demo photo past its frame, as white
 * strokes on transparency (coverage in alpha; the page tints them --gb-contour on --gb-paper-deep).
 * Contract: src/components/gipfelbuch/tafel/README.md (`TafelBake`).
 *
 *   npx tsx scripts/gipfelbuch/data-tafel.ts [--horizon-only] [demo-01 demo-02 ...]
 *
 * The ridgelines are traceViewpoint from the photo's eye (as scripts/demo/bake-surround.ts), projected
 * with the prototype pinhole projector (now tafel/project.ts, roll sign -1) at
 * the photo's solved camera (app camera when the solve was rejected), so the strokes leave the photo
 * exactly where `solvedRows` does. The seam check projects `horizon.profile` against `solvedRows`.
 * Writes public/demo/gipfelbuch/tafel/<id>.webp and <id>.json. Run `npx biome check --write` on the
 * JSON afterwards. DEM tiles come from the .cache/dem-mapterhorn disk cache (fetched on a miss); the
 * `horizon` row uses build-data.ts's terrarium DEM. `--horizon-only` rewrites only that row of the JSON
 * and leaves the strokes and everything else as they are.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { DEM_SOURCES, MAPTERHORN } from "../../src/lib/dem";
import { computeHorizon } from "../../src/lib/geo/horizon";
import { loadTerrain } from "../../src/lib/geo/terrain";
import {
	DEFAULT_RINGS,
	loadMosaics,
	mosaicFor,
	mosaicHeight,
	TileStore,
} from "../../src/lib/horizon-fast/mosaic";
import {
	type RidgelinePeakInput,
	traceViewpoint,
} from "../../src/lib/roll/mosaic/ridgelines";
import { demTileLoaderNode, ROOT } from "../lib/node-io";

const MAX_DISTANCE = 120_000;
const BUCKETS = 8;
const WORK_W = 800;
/** Spill past each edge in photo widths (x) and photo heights (y). */
const SPILL = { left: 0.5, right: 0.5, top: 0.1, bottom: 0.15 };
const CSS_W = 1000; // the photo's typical on-page width
const SCALE = 1.5;
const GROUND_COVERAGE = 0.06;
const GROUND_FADE = 0.15; // of the canvas height, from the bottom
const RULER = 22; // css px kept clear for the compass ruler
const MAX_PEAKS = 10;
const MIN_PEAK_DISTANCE = 1500;
const MIN_CONTRAST = 3;
const WEBP_QUALITY = 80;
/** Azimuth step of the bake's wide horizon (deg). */
const HORIZON_STEP = 0.25;
/** build-data.ts's DEM, so the wide horizon matches priorRows / solvedRows. */
const HORIZON_DEM = DEM_SOURCES.terrarium;
const OUT = path.join(ROOT, "public", "demo", "gipfelbuch", "tafel");
const RAD = Math.PI / 180;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

type Camera = { yaw: number; pitch: number; roll: number; f: number };
type Rows = (number | null)[];
type PhotoJson = {
	photo: { width: number; height: number };
	gps: { lat: number; lon: number; eye: number };
	prior: Camera;
	solved: Camera & { accepted: boolean };
	app: { yaw: number; pitch: number; roll: number; vfov: number } | null;
	skyline: { rows: Rows; weight: number[] };
	solvedRows: Rows;
	horizon: { profile: { az: number; el: number }[] };
};
type Manifest = {
	region: { peaks: RidgelinePeakInput[] };
};

/** The prototype projector, plus its inverse; returns null behind the image plane. */
function makeProjector(cam: Camera, w: number, h: number) {
	const cx = w / 2;
	const cy = h / 2;
	const p = cam.pitch * RAD;
	const r = -cam.roll * RAD;
	const cr = Math.cos(r);
	const sr = Math.sin(r);
	const cp = Math.cos(p);
	const sp = Math.sin(p);
	const project = (az: number, el: number): [number, number] | null => {
		const daz = (((((az - cam.yaw + 540) % 360) + 360) % 360) - 180) * RAD;
		const e = el * RAD;
		const x = Math.cos(e) * Math.sin(daz);
		const z = Math.cos(e) * Math.cos(daz);
		const y = Math.sin(e);
		const z2 = z * cp + y * sp;
		const y2 = y * cp - z * sp;
		if (z2 < 0.2) return null; // far off-axis blows up under a pinhole
		const u = (cam.f * x) / z2;
		const v = (-cam.f * y2) / z2;
		return [cx + u * cr - v * sr, cy + u * sr + v * cr];
	};
	/** Azimuth (deg, 0..360) of the ray through working pixel (px, py). */
	const azimuthAt = (px: number, py: number) => {
		const du = px - cx;
		const dv = py - cy;
		const u = du * cr + dv * sr;
		const v = -du * sr + dv * cr;
		const y2 = -v;
		const z2 = cam.f;
		const z = z2 * cp - y2 * sp;
		const daz = Math.atan2(u, z) / RAD;
		return (((cam.yaw + daz) % 360) + 360) % 360;
	};
	return { project, azimuthAt };
}

const linear = (c: number) => {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (rgb: number[]) =>
	0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
const contrast = (a: number[], b: number[]) => {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const hex = (s: string) =>
	[1, 3, 5].map((i) => Number.parseInt(s.slice(i, i + 2), 16));
const mixSrgb = (a: number[], b: number[], pa: number) =>
	a.map((v, i) => v * pa + b[i] * (1 - pa));

/** --gb-paper-deep from swiss/theme.css: paper 91% + #baaf96 9%, paper = #f7f7f5 96% + #ffdb8b 4%. */
function readPaperDeep() {
	const css = fs.readFileSync(
		path.join(ROOT, "src/components/gipfelbuch/swiss/theme.css"),
		"utf8",
	);
	const paper =
		/--gb-paper:\s*color-mix\(\s*in srgb,\s*(#\w+)\s+(\d+)%,\s*(#\w+)/.exec(
			css,
		);
	const deep =
		/--gb-paper-deep:\s*color-mix\(\s*in srgb,\s*var\(--gb-paper\)\s+(\d+)%,\s*(#\w+)/.exec(
			css,
		);
	const contour = /--gb-contour:\s*(#\w+)/.exec(css);
	if (!paper || !deep || !contour)
		throw new Error("theme.css tokens not found");
	const paperRgb = mixSrgb(
		hex(paper[1]),
		hex(paper[3]),
		Number(paper[2]) / 100,
	);
	return {
		deep: mixSrgb(paperRgb, hex(deep[2]), Number(deep[1]) / 100),
		contour: hex(contour[1]),
	};
}

/** Smallest 8-bit alpha whose stroke (contour over paper-deep) reaches MIN_CONTRAST on paper-deep. */
function alphaFloor() {
	const { deep, contour } = readPaperDeep();
	for (let a = 1; a <= 255; a++) {
		const c = contrast(mixSrgb(contour, deep, a / 255), deep);
		if (c >= MIN_CONTRAST) return { coverage: a / 255, contrast: c };
	}
	throw new Error("contour never reaches 3:1 on paper-deep");
}

const CARDINAL: Record<number, string> = {
	0: "N",
	45: "NE",
	90: "E",
	135: "SE",
	180: "S",
	225: "SW",
	270: "W",
	315: "NW",
};

const manifest = JSON.parse(
	fs.readFileSync(path.join(ROOT, "public", "demo", "manifest.json"), "utf8"),
) as Manifest;

const measureCanvas = createCanvas(10, 10).getContext("2d");
const textWidth = (text: string, px: number) => {
	measureCanvas.font = `${px}px sans-serif`;
	return measureCanvas.measureText(text).width;
};

const quantile = (sorted: number[], q: number) =>
	sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

async function bake(id: string, floor: { coverage: number; contrast: number }) {
	const d = JSON.parse(
		fs.readFileSync(
			path.join(ROOT, "public", "demo", "gipfelbuch", `${id}.json`),
			"utf8",
		),
	) as PhotoJson;
	const w = WORK_W;
	const h = d.photo.height;
	const aspect = w / h;

	// camera: solved when accepted, else the app's (vfov -> f), else the sensor prior
	let camera: Camera;
	let source: "solved" | "app";
	if (d.solved.accepted) {
		const { yaw, pitch, roll, f } = d.solved;
		camera = { yaw, pitch, roll, f };
		source = "solved";
	} else if (d.app) {
		const { yaw, pitch, roll, vfov } = d.app;
		camera = { yaw, pitch, roll, f: h / 2 / Math.tan((vfov * RAD) / 2) };
		source = "app";
	} else {
		const { yaw, pitch, roll, f } = d.prior;
		camera = { yaw, pitch, roll, f };
		source = "app";
	}
	const { project, azimuthAt } = makeProjector(camera, w, h);

	// seam: the DEM horizon profile against solvedRows, in working px
	const seam: number[] = [];
	for (const q of d.horizon.profile) {
		const p = project(q.az, q.el);
		if (!p || p[0] < 0.5 || p[0] > w - 1.5) continue;
		const c = Math.floor(p[0] - 0.5);
		const a = d.solvedRows[c];
		const b = d.solvedRows[c + 1];
		if (a == null || b == null) continue;
		const row = a + (b - a) * (p[0] - 0.5 - c);
		seam.push(Math.abs(p[1] - row));
	}
	seam.sort((a, b) => a - b);
	const seamMedian = quantile(seam, 0.5);
	const seamP90 = quantile(seam, 0.9);

	// the terrain from the eye over the half circle the camera faces
	const store = new TileStore({
		tileSize: MAPTERHORN.tileSize,
		maxZoom: MAPTERHORN.maxZoom,
		load: demTileLoaderNode(MAPTERHORN),
	});
	const mosaics = await loadMosaics(d.gps.lat, d.gps.lon, store, {
		rings: DEFAULT_RINGS,
		maxDistance: MAX_DISTANCE,
		az0: camera.yaw - 100,
		az1: camera.yaw + 100,
	});
	const heightAt = (lat: number, lon: number, dist: number) =>
		mosaicHeight(mosaicFor(mosaics, dist), lon, lat);
	const t = traceViewpoint(
		heightAt,
		{ lat: d.gps.lat, lon: d.gps.lon, h: d.gps.eye },
		manifest.region.peaks,
		{ dMax: MAX_DISTANCE },
	);

	// canvas: photo width css 1000 at scale 1.5; k = canvas px per working px
	const pw = Math.round(CSS_W * SCALE);
	const ph = Math.round(pw / aspect);
	const W = Math.round(pw * (1 + SPILL.left + SPILL.right));
	const H = Math.round(ph * (1 + SPILL.top + SPILL.bottom));
	const ox = SPILL.left * pw;
	const oy = SPILL.top * ph;
	const k = pw / w;
	const toCanvas = (az: number, el: number) => {
		const p = project(az, el);
		return p ? ([ox + p[0] * k, oy + p[1] * k] as [number, number]) : null;
	};

	const c = createCanvas(W, H);
	const g = c.getContext("2d");
	g.lineJoin = "round";
	g.lineCap = "round";

	// ground fill below the skyline, on its own layer so its bottom fades out
	const layer = createCanvas(W, H);
	const lg = layer.getContext("2d");
	const ground = new Path2D();
	const cols = t.skyline.length;
	let first: [number, number] | null = null;
	let last: [number, number] | null = null;
	for (let az = camera.yaw - 85; az <= camera.yaw + 85; az += t.step) {
		const col = ((Math.round(az / t.step) % cols) + cols) % cols;
		const e = t.skyline[col];
		const p = toCanvas(az, e > -90 ? e : -60);
		if (!p) continue;
		if (last) ground.lineTo(p[0], p[1]);
		else {
			ground.moveTo(p[0], p[1]);
			first = p;
		}
		last = p;
	}
	if (first && last) {
		ground.lineTo(last[0], H * 2);
		ground.lineTo(first[0], H * 2);
		ground.closePath();
		lg.fillStyle = `rgba(255,255,255,${GROUND_COVERAGE})`;
		lg.fill(ground);
	}
	const fade = lg.createLinearGradient(0, H * (1 - GROUND_FADE), 0, H);
	fade.addColorStop(0, "rgba(0,0,0,1)");
	fade.addColorStop(1, "rgba(0,0,0,0)");
	lg.globalCompositeOperation = "destination-in";
	lg.fillStyle = fade;
	lg.fillRect(0, 0, W, H);
	g.drawImage(layer, 0, 0);

	// ridgelines by class and depth bucket, far to near: coverage and width fall with depth
	const paths = [0, 1].map(() =>
		Array.from({ length: BUCKETS }, () => new Path2D()),
	);
	for (let i = 0; i < t.slab.length; i++) {
		const b = Math.min(
			BUCKETS - 1,
			Math.floor((t.slab[i] / Math.max(1, t.slabs - 1)) * BUCKETS),
		);
		const stroke = paths[t.ridge[i]][b];
		let pen = false;
		for (let j = t.start[i]; j < t.start[i + 1]; j++) {
			const az = t.pts[j * 2];
			const off = ((((az - camera.yaw) % 360) + 540) % 360) - 180;
			const p = Math.abs(off) < 85 ? toCanvas(az, t.pts[j * 2 + 1]) : null;
			if (!p) {
				pen = false;
				continue;
			}
			if (pen) stroke.lineTo(p[0], p[1]);
			else stroke.moveTo(p[0], p[1]);
			pen = true;
		}
	}
	const floorCov = floor.coverage;
	for (let b = BUCKETS - 1; b >= 0; b--) {
		const depth = b / (BUCKETS - 1);
		// slope contours: faint but never below the floor; ridges: from 1 down to the floor
		g.strokeStyle = `rgba(255,255,255,${floorCov + (1 - floorCov) * 0.35 * (1 - depth)})`;
		g.lineWidth = 1.2 * SCALE;
		g.stroke(paths[0][b]);
		g.strokeStyle = `rgba(255,255,255,${floorCov + (1 - floorCov) * (1 - depth)})`;
		g.lineWidth = (2.2 - 1.0 * depth) * SCALE;
		g.stroke(paths[1][b]);
	}
	// the photo covers its own rectangle: leave it empty
	g.clearRect(Math.floor(ox) + 1, Math.floor(oy) + 1, pw - 2, ph - 2);

	// ticks: where each azimuth crosses the ruler row just inside the canvas top
	const rulerY = (RULER * SCALE - oy) / k; // working row of the ruler line
	const ticks: TafelTick[] = [];
	let prev: number | null = null;
	for (let x = 0; x <= W; x++) {
		const az = azimuthAt((x - ox) / k, rulerY);
		if (prev != null && az - prev > 0 && az - prev < 10) {
			for (let a = Math.ceil(prev); a <= az; a++) {
				if (a % 5 !== 0) continue;
				const deg = a % 360;
				const card = CARDINAL[deg];
				ticks.push({
					az: deg,
					x: r4(x / W),
					...(deg % 15 === 0 ? { label: card ?? `${deg}°` } : {}),
					...(card ? { cardinal: true } : {}),
				});
			}
		}
		prev = az;
	}

	// peaks outside the frame, greedy by elevation, label boxes (13 px name over 11 px detail) not overlapping
	const frame = {
		x0: ox / SCALE,
		y0: oy / SCALE,
		x1: (ox + pw) / SCALE,
		y1: (oy + ph) / SCALE,
	};
	const cssW = W / SCALE;
	const cssH = H / SCALE;
	const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
	const labels: TafelPeak[] = [];
	const candidates = [...t.peaks]
		.filter((p) => p.d > MIN_PEAK_DISTANCE && p.name)
		.sort((a, b) => b.ele - a.ele);
	for (const p of candidates) {
		if (labels.length >= MAX_PEAKS) break;
		const q = toCanvas(p.az, p.el);
		if (!q) continue;
		const km =
			p.d < 10_000 ? Math.round(p.d / 100) / 10 : Math.round(p.d / 1000);
		const detail = `${p.ele} m · ${p.d < 10_000 ? km.toFixed(1) : km} km`;
		const tw = Math.max(textWidth(p.name, 13), textWidth(detail, 11)) + 8;
		const x = q[0] / SCALE;
		const y = q[1] / SCALE;
		const box = { x0: x - tw / 2, y0: y - 44, x1: x + tw / 2, y1: y };
		if (box.x0 < 0 || box.x1 > cssW || box.y0 < RULER + 6 || y > cssH - 4)
			continue;
		const hits = (o: typeof box) =>
			box.x0 < o.x1 && o.x0 < box.x1 && box.y0 < o.y1 && o.y0 < box.y1;
		if (
			hits(frame) ||
			(x > frame.x0 - 0 && x < frame.x1 && y > frame.y0 && y < frame.y1)
		)
			continue;
		if (boxes.some(hits)) continue;
		boxes.push(box);
		labels.push({
			name: p.name,
			ele: p.ele,
			km,
			az: r4(p.az),
			x: r4(q[0] / W),
			y: r4(q[1] / H),
		});
	}

	// band: 10-90th pct of the confident skyline rows, padded 16% above, 28% below, min 240 rows
	const rows = d.skyline.rows
		.filter((_, i) => d.skyline.weight[i] > 0)
		.filter((v): v is number => v != null)
		.sort((a, b) => a - b);
	let top = quantile(rows, 0.1) - h * 0.16;
	let bottom = quantile(rows, 0.9) + h * 0.28;
	if (bottom - top < 240) {
		const m = (top + bottom) / 2;
		top = m - 120;
		bottom = m + 120;
	}
	top = Math.max(0, top);
	bottom = Math.min(h, bottom);

	fs.mkdirSync(OUT, { recursive: true });
	const img = path.join(OUT, `${id}.webp`);
	fs.writeFileSync(img, await c.encode("webp", WEBP_QUALITY));
	const bakeJson: TafelBake = {
		id,
		generated: new Date().toISOString().slice(0, 10),
		script: "scripts/gipfelbuch/data-tafel.ts",
		src: `/demo/gipfelbuch/tafel/${id}.webp`,
		width: W,
		height: H,
		photo: { x: r4(ox / W), y: r4(oy / H), w: r4(pw / W), h: r4(ph / H) },
		camera: {
			yaw: r4(camera.yaw),
			pitch: r4(camera.pitch),
			roll: r4(camera.roll),
			f: r4(camera.f),
			source,
		},
		band: [Math.round(top * 10) / 10, Math.round(bottom * 10) / 10],
		ticks,
		peaks: labels,
		horizon: await wideHorizon(d.gps, camera.yaw),
		minContrast: Math.round(floor.contrast * 100) / 100,
	};
	fs.writeFileSync(
		path.join(OUT, `${id}.json`),
		`${JSON.stringify(bakeJson)}\n`,
	);
	const kb = fs.statSync(img).size / 1024;
	console.log(
		`${id}: ${source}${d.solved.accepted ? "" : " (solve rejected)"}, seam median ${seamMedian.toFixed(2)} p90 ${seamP90.toFixed(2)} px (${seam.length} pts)${source === "solved" && seamMedian >= 0.5 ? " SEAM FAIL" : ""}, minContrast ${bakeJson.minContrast}, coverage floor ${floorCov.toFixed(3)}, ${W}x${H}, ${labels.length} peaks, ${kb.toFixed(0)} kB`,
	);
}

/**
 * The DEM horizon (elevation angle, deg) from yaw - 85° to yaw + 85° in HORIZON_STEP steps, traced as
 * build-data.ts traces `horizon.profile` (computeHorizon on the terrarium DEM from gps.eye), so it meets
 * priorRows and solvedRows at the frame's edge, but wider: the spill draws the skyline, the guess and
 * the solve past the frame at any pose. Pose-free.
 */
async function wideHorizon(
	gps: { lat: number; lon: number; eye: number },
	yaw: number,
): Promise<{ az0: number; step: number; el: number[] }> {
	const terrain = await loadTerrain(
		gps.lat,
		gps.lon,
		demTileLoaderNode(HORIZON_DEM),
		HORIZON_DEM.levels,
		new Map<string, Float32Array>(),
		16,
		HORIZON_DEM.tileSize,
	);
	const h = computeHorizon(terrain, gps.lat, gps.lon, gps.eye, {
		step: HORIZON_STEP,
	});
	const n = h.elevation.length;
	const az0 = Math.floor((yaw - 85) / HORIZON_STEP) * HORIZON_STEP;
	const el: number[] = [];
	for (let az = az0; az <= yaw + 85; az += HORIZON_STEP)
		el.push(
			Math.round(
				h.elevation[((Math.round(az / HORIZON_STEP) % n) + n) % n] * 1000,
			) / 1000,
		);
	return { az0: r4(((az0 % 360) + 360) % 360), step: HORIZON_STEP, el };
}

type TafelTick = { az: number; x: number; label?: string; cardinal?: boolean };
type TafelPeak = {
	name: string;
	ele: number;
	km: number;
	az: number;
	x: number;
	y: number;
};
interface TafelBake {
	id: string;
	generated: string;
	script: "scripts/gipfelbuch/data-tafel.ts";
	src: string;
	width: number;
	height: number;
	photo: { x: number; y: number; w: number; h: number };
	camera: Camera & { source: "solved" | "app" };
	band: [number, number];
	ticks: TafelTick[];
	peaks: TafelPeak[];
	horizon: { az0: number; step: number; el: number[] };
	minContrast: number;
}

/** `--horizon-only`: re-trace the wide horizon into an existing bake JSON, keeping every other field. */
async function bakeHorizon(id: string) {
	const d = JSON.parse(
		fs.readFileSync(
			path.join(ROOT, "public", "demo", "gipfelbuch", `${id}.json`),
			"utf8",
		),
	) as PhotoJson;
	const file = path.join(OUT, `${id}.json`);
	const old = JSON.parse(fs.readFileSync(file, "utf8")) as TafelBake;
	const horizon = await wideHorizon(d.gps, old.camera.yaw);
	const { minContrast, ...rest } = old;
	fs.writeFileSync(
		file,
		`${JSON.stringify({ ...rest, horizon, minContrast })}\n`,
	);
	console.log(`${id}: horizon ${horizon.el.length} az from ${horizon.az0}°`);
}

const horizonOnly = process.argv.includes("--horizon-only");
const floorCoverage = horizonOnly ? null : alphaFloor();
const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const all = Array.from(
	{ length: 12 },
	(_, i) => `demo-${String(i + 1).padStart(2, "0")}`,
);
for (const id of ids.length ? ids : all)
	if (floorCoverage) await bake(id, floorCoverage);
	else await bakeHorizon(id);

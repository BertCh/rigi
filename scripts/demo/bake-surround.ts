// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Bakes the terrain that continues the landing page's top two photos past their frames, in the roll
 * panorama's look (src/lib/roll/mosaic/terrainLayer.ts: depth-faded paper ridgelines, a faint ground
 * fill, peak names on leaders, a compass ruler). The ridgelines are the panorama's own trace
 * (traceViewpoint, from the photo's eye) projected through the photo's solved camera, extended past
 * the frame, so every line leaves the photo exactly where its ridge does.
 *
 *   npx tsx scripts/demo/bake-surround.ts [demo-09 demo-01 how]
 *
 * Writes public/demo/surround/<id>.webp (the strokes on transparency, with the photo's own rectangle left empty) and
 * src/components/site/surround/<id>.json (frame geometry, peak labels, ruler ticks; imported by the
 * landing page, so it ships in the bundle and lays out with no fetch). Run `npx biome check --write`
 * on the JSON afterwards. Tiles come from the .cache/dem-mapterhorn disk cache (fetched on a miss).
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { type Pose, projectPoint, unprojectDir } from "../../src/lib/camera";
import { MAPTERHORN } from "../../src/lib/dem";
import {
	DEFAULT_RINGS,
	loadMosaics,
	mosaicFor,
	mosaicHeight,
	TileStore,
} from "../../src/lib/horizon-fast/mosaic";
import { dirOf } from "../../src/lib/roll/mosaic/panorama";
import {
	type RidgelinePeakInput,
	traceViewpoint,
} from "../../src/lib/roll/mosaic/ridgelines";
import { demTileLoaderNode, ROOT } from "../lib/node-io";

/** How far the terrain runs past each edge, in photo widths (x) and heights (y). Asymmetric for the
 * hero, whose headline sits on the left. `css` is the photo's typical on-page width, which sets the
 * stroke weights and the label spacing; the bake is drawn at `scale` × that. */
type Layout = {
	left: number;
	right: number;
	top: number;
	bottom: number;
	css: number;
	scale: number;
	/** Peak names only this far past the frame (photo widths), so a laptop-width window shows them whole. */
	labelReach: number;
	/** Demo photo id, when the bake's name is not one. */
	photo?: string;
	/** A frame that is not a manifest photo: its eye, camera and aspect. */
	camera?: {
		lat: number;
		lon: number;
		alt: number | null;
		pose: Pose;
		aspect: number;
	};
	/** The frame shows the photo's top `crop` of its height (the how-it-works band); default 1. */
	crop?: number;
	/** Draw the compass ruler along the top; default true. */
	ruler?: boolean;
};
const LAYOUTS: Record<string, Layout> = {
	"demo-09": {
		left: 0.08,
		right: 0.75,
		top: 0.08,
		bottom: 0.1,
		css: 640,
		scale: 2,
		labelReach: 0.3,
	},
	"demo-01": {
		left: 0.5,
		right: 0.5,
		top: 0.05,
		bottom: 0.12,
		css: 1080,
		scale: 1.5,
		labelReach: 0.16,
	},
	// the how-it-works scene's viewport: the top half of demo-09, across the column
	how: {
		photo: "demo-09",
		crop: 0.5,
		left: 0.6,
		right: 0.6,
		top: 0,
		bottom: 0,
		css: 1080,
		scale: 1.5,
		labelReach: 0.16,
		ruler: false,
	},
};

const MAX_DISTANCE = 120_000; // as the panorama strip (viewpointTerrain.ts)
const BUCKETS = 8;
const PAPER = "236,230,218";
const RULER = 22; // CSS px, the strip's ruler height
const LABEL_FONT = 6.3; // CSS px per character at 10.5 px, for spacing names
const OUT_IMG = path.join(ROOT, "public", "demo", "surround");
const OUT_JSON = path.join(ROOT, "src", "components", "site", "surround");
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

type Manifest = {
	photos: {
		id: string;
		src: string;
		width: number;
		height: number;
		lat: number;
		lon: number;
		alt: number | null;
	}[];
	poses: Record<string, { pose: Pose }>;
	region: { peaks: RidgelinePeakInput[] };
};

async function bake(manifest: Manifest, id: string) {
	const L = LAYOUTS[id];
	const photoId = L?.photo ?? id;
	const photo = manifest.photos.find((p) => p.id === photoId);
	const meta = L?.camera ?? photo;
	const pose = L?.camera?.pose ?? manifest.poses[photoId]?.pose;
	if (!meta || !pose || !L) throw new Error(`${id}: no photo, pose or layout`);
	const aspect = L.camera?.aspect ?? (photo ? photo.width / photo.height : 1);

	// the DEM around the eye, over the half circle the camera faces
	const store = new TileStore({
		tileSize: MAPTERHORN.tileSize,
		maxZoom: MAPTERHORN.maxZoom,
		load: demTileLoaderNode(MAPTERHORN),
	});
	const mosaics = await loadMosaics(meta.lat, meta.lon, store, {
		rings: DEFAULT_RINGS,
		maxDistance: MAX_DISTANCE,
		az0: pose.yaw - 100,
		az1: pose.yaw + 100,
	});
	const heightAt = (lat: number, lon: number, d: number) =>
		mosaicHeight(mosaicFor(mosaics, d), lon, lat);
	// the eye rule of the ridgelines worker: GPS altitude unless underground
	const dem = heightAt(meta.lat, meta.lon, 0);
	const h = Math.max(meta.alt ?? Number.NEGATIVE_INFINITY, dem + 1.6);
	const t = traceViewpoint(
		heightAt,
		{ lat: meta.lat, lon: meta.lon, h },
		manifest.region.peaks,
		{ dMax: MAX_DISTANCE },
	);

	// canvas: the photo's image plane, extended; photo pixels = image px per normalised unit
	const pw = Math.round(L.css * L.scale);
	const ph = Math.round(pw / aspect);
	const W = Math.round(pw * (1 + L.left + L.right));
	const crop = L.crop ?? 1;
	const ruler = L.ruler ?? true;
	const fh = Math.round(ph * crop); // the frame on the page: the photo, or its top band
	const H = Math.round(ph * (crop + L.top + L.bottom));
	const ox = L.left * pw;
	const oy = L.top * ph;
	const s = L.scale;
	const proj = (az: number, el: number) => {
		const q = projectPoint(pose, aspect, [0, 0, 0], dirOf(az, el));
		// rays far off-axis blow up under a pinhole; the canvas never reaches past ~70° from the axis
		if (!q || q.depth < 0.3) return null;
		return [ox + q.u * pw, oy + q.v * ph] as const;
	};

	const c = createCanvas(W, H);
	const g = c.getContext("2d");
	g.lineJoin = "round";
	g.lineCap = "round";

	// ground under the skyline
	const ground = new Path2D();
	let started = false;
	const cols = t.skyline.length;
	for (let i = 0; i <= cols * 0.6; i++) {
		const az = pose.yaw - cols * 0.3 * t.step + i * t.step;
		const k = ((Math.round(az / t.step) % cols) + cols) % cols;
		const e = t.skyline[k];
		const p = proj(az, e > -90 ? e : -60);
		if (!p) continue;
		if (started) ground.lineTo(p[0], p[1]);
		else ground.moveTo(p[0], p[1]);
		started = true;
	}
	ground.lineTo(W * 2, H * 2);
	ground.lineTo(-W, H * 2);
	ground.closePath();
	g.fillStyle = `rgba(${PAPER},0.035)`;
	g.fill(ground);

	// ridgelines, by class and depth bucket, far to near
	const paths = [0, 1].map(() =>
		Array.from({ length: BUCKETS }, () => new Path2D()),
	);
	for (let i = 0; i < t.slab.length; i++) {
		const b = Math.min(
			BUCKETS - 1,
			Math.floor((t.slab[i] / Math.max(1, t.slabs - 1)) * BUCKETS),
		);
		const path = paths[t.ridge[i]][b];
		let pen = false;
		for (let k = t.start[i]; k < t.start[i + 1]; k++) {
			const az = t.pts[k * 2];
			const off = ((((az - pose.yaw) % 360) + 540) % 360) - 180;
			const p = Math.abs(off) < 85 ? proj(az, t.pts[k * 2 + 1]) : null;
			if (!p) {
				pen = false;
				continue;
			}
			if (pen) path.lineTo(p[0], p[1]);
			else path.moveTo(p[0], p[1]);
			pen = true;
		}
	}
	for (let b = BUCKETS - 1; b >= 0; b--) {
		const d = b / (BUCKETS - 1);
		g.strokeStyle = `rgba(${PAPER},${0.32 - 0.16 * d})`;
		g.lineWidth = 0.7 * s;
		g.stroke(paths[0][b]);
		g.strokeStyle = `rgba(${PAPER},${0.85 - 0.5 * d})`;
		g.lineWidth = (1.3 - 0.6 * d) * s;
		g.stroke(paths[1][b]);
	}
	// the photo covers its own rectangle: leave it empty (transparent)
	g.clearRect(Math.floor(ox) + 1, Math.floor(oy) + 1, pw - 2, fh - 2);

	// compass ruler along the top: where each azimuth crosses the canvas's top row
	const ticks: { x: number; label?: string }[] = [];
	if (ruler) {
		const topV = -L.top + RULER / (ph / s);
		let prev: number | null = null;
		for (let x = 0; x <= W; x += 1) {
			const u = (x - ox) / pw;
			const d = unprojectDir(pose, aspect, u, topV);
			const az = ((Math.atan2(d[0], d[1]) * 180) / Math.PI + 360) % 360;
			if (prev != null) {
				for (let a = Math.ceil(prev); a <= az && az - prev < 10; a++)
					if (a % 5 === 0) {
						const deg = a % 360;
						const card = CARDINAL[deg];
						ticks.push({
							x: r4(x / W),
							...(deg % 15 === 0 ? { label: card ?? `${deg}°` } : {}),
						});
					}
			}
			prev = az;
		}
	}

	// peak names past the frame, each just above its summit on a short leader; the strip's greedy
	// placement by prominence, at the page's width
	const peaks = [...t.peaks].sort(
		(a, b) => (b.prominence ?? 0) - (a.prominence ?? 0) || b.ele - a.ele,
	);
	const placed: { x0: number; x1: number }[] = [];
	const labels: {
		name: string;
		ele: number;
		km: number;
		x: number;
		y: number;
	}[] = [];
	for (const p of peaks) {
		if (labels.length >= 14) break;
		const q = proj(p.az, p.el);
		if (!q) continue;
		const [x, y] = q;
		if (y < ((ruler ? RULER : 0) + 48) * s || y > H - 4) continue;
		const xc = x / s;
		const tw = Math.max(p.name.length * LABEL_FONT, 84) + 12;
		// the whole name past the frame on its own side, and within reach of it
		const reach = (L.labelReach * pw) / s;
		const fx0 = ox / s;
		const fx1 = (ox + pw) / s;
		const fits =
			(xc > fx0 - reach && xc + tw < fx0 - 6) ||
			(xc > fx1 + 4 && xc + tw < fx1 + reach);
		if (!fits) continue;
		if (placed.some((r) => xc < r.x1 + 6 && r.x0 < xc + tw)) continue;
		placed.push({ x0: xc, x1: xc + tw });
		labels.push({
			name: p.name,
			ele: p.ele,
			km: Math.round(p.d / 100) / 10,
			x: r4(x / W),
			y: r4(y / H),
		});
	}

	fs.mkdirSync(OUT_IMG, { recursive: true });
	fs.mkdirSync(OUT_JSON, { recursive: true });
	const img = path.join(OUT_IMG, `${id}.webp`);
	fs.writeFileSync(img, await c.encode("webp", 82));
	const json = {
		id,
		src: `/demo/surround/${id}.webp`,
		width: W,
		height: H,
		/** The photo's rectangle, as fractions of the canvas. */
		photo: {
			x: r4(ox / W),
			y: r4(oy / H),
			w: r4(pw / W),
			h: r4(fh / H),
		},
		/** The ruler's height as a fraction of the canvas. */
		ruler: ruler ? r4((RULER * s) / H) : 0,
		ticks,
		peaks: labels,
	};
	fs.writeFileSync(
		path.join(OUT_JSON, `${id}.json`),
		`${JSON.stringify(json)}\n`,
	);
	console.log(
		`${id}: ${W}×${H}, eye ${h.toFixed(0)} m, ${t.start.length - 1} strokes, ${labels.length} labels, ${(fs.statSync(img).size / 1024).toFixed(0)} kB`,
	);
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
const ids = process.argv.slice(2);
for (const id of ids.length ? ids : Object.keys(LAYOUTS))
	await bake(manifest, id);

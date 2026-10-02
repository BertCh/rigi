// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Map-sheet data for the /gipfelbuch Swiss reskin (SheetMap, ContourField).
 *
 *   npx tsx scripts/gipfelbuch/data-sheet.ts
 *
 * Sheet box (WGS84): lon 7.715..7.875, lat 46.665..46.740 (about 12.2 x 8.3 km: Niederhorn, the north-east arm of
 * Thunersee, Beatenberg, Interlaken edge). Writes public/demo/gipfelbuch/sheet/:
 *   sheet.json   contours (20 m, index every 100 m), lake polygon, peaks, places, viewpoints, LV95 frame corners
 *   relief.jpg   greyscale Swiss-style relief drawn from the DEM (sheet-relief.ts), sun.jpg / shade.jpg tone masks
 *   rock.json    rock hachures and scree as merged integer paths (sheet-rock.ts)
 * Offline CPU bake (node build script, the GPU-first rule does not apply). Seeded and deterministic: two bakes give
 * byte-identical output apart from the `generated` date.
 * Coordinates: Web Mercator (EPSG:3857) scaled to a 2400-unit-wide SVG space (y down, integer units); the relief
 * raster covers exactly the same extent. Mapterhorn z13 DEM tiles are fetched through the shared .cache.
 * Peaks and places come from the Thunersee terroir pack (swissNAMES3D), nothing is typed in.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { contours } from "d3-contour";
import { DEM_SOURCES } from "../../src/lib/dem";
import { demTileLoaderNode, ROOT } from "../lib/node-io";
import {
	addContourRing,
	CONTOUR_KEYS,
	type ContourKey,
} from "./sheet-contours";
import { analyseTerrain, bakeRelief } from "./sheet-relief";
import { buildRockLayers, buildRockMask } from "./sheet-rock";

const OUT = path.join(ROOT, "public", "demo", "gipfelbuch", "sheet");
fs.mkdirSync(OUT, { recursive: true });
const rd = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

const BBOX = { west: 7.715, east: 7.875, south: 46.665, north: 46.74 };
const W = 2400; // sheet units
const INTERVAL = 20;
const INDEX_EVERY = 100;
const LAKE_LEVEL = 559; // Thunersee surface is 557.8 m; DEM <= 559 m inside the box is lake
const SIMPLIFY = 1.3; // Douglas-Peucker tolerance in sheet units

const R = 6378137;
const mercX = (lon: number) => (R * lon * Math.PI) / 180;
const mercY = (lat: number) =>
	R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const X0 = mercX(BBOX.west);
const X1 = mercX(BBOX.east);
const Y0 = mercY(BBOX.south);
const Y1 = mercY(BBOX.north);
const SCALE = W / (X1 - X0);
const H = Math.round((Y1 - Y0) * SCALE);
const toSheet = (lon: number, lat: number): [number, number] => [
	Math.round((mercX(lon) - X0) * SCALE),
	Math.round((Y1 - mercY(lat)) * SCALE),
];

/** swisstopo's approximate WGS84 -> LV95 formulas (about 1 m). */
function toLv95(lon: number, lat: number) {
	const p = (lat * 3600 - 169028.66) / 10000;
	const l = (lon * 3600 - 26782.5) / 10000;
	const E =
		2600072.37 +
		211455.93 * l -
		10938.51 * l * p -
		0.36 * l * p * p -
		44.54 * l * l * l;
	const N =
		1200147.07 +
		308807.95 * p +
		3745.25 * l * l +
		76.63 * p * p -
		194.56 * l * l * p +
		119.79 * p * p * p;
	return [Math.round(E), Math.round(N)];
}

// ---------- 1. DEM mosaic (Mapterhorn z13, 512 px tiles) ----------
const M = DEM_SOURCES.mapterhorn;
const ZD = 13;
const nTiles = 2 ** ZD;
const tx = (x: number) => ((x + Math.PI * R) / (2 * Math.PI * R)) * nTiles;
const ty = (y: number) => ((Math.PI * R - y) / (2 * Math.PI * R)) * nTiles;

async function buildDem() {
	const load = demTileLoaderNode(M);
	const x0 = Math.floor(tx(X0));
	const x1 = Math.floor(tx(X1));
	const y0 = Math.floor(ty(Y1));
	const y1 = Math.floor(ty(Y0));
	const S = M.tileSize;
	const mw = (x1 - x0 + 1) * S;
	const mh = (y1 - y0 + 1) * S;
	const mosaic = new Float32Array(mw * mh);
	for (let y = y0; y <= y1; y++)
		for (let x = x0; x <= x1; x++) {
			const t = await load({ z: ZD, x, y });
			if (!t) throw new Error(`Mapterhorn tile ${ZD}/${x}/${y} missing`);
			for (let j = 0; j < S; j++)
				mosaic.set(
					t.subarray(j * S, (j + 1) * S),
					((y - y0) * S + j) * mw + (x - x0) * S,
				);
		}
	// Output grid: about 10 m (merc) cells, 2 sheet units each
	const GW = 1200;
	const GH = Math.round((GW * (Y1 - Y0)) / (X1 - X0));
	const grid = new Float64Array(GW * GH);
	for (let j = 0; j < GH; j++)
		for (let i = 0; i < GW; i++) {
			const X = X0 + ((i + 0.5) / GW) * (X1 - X0);
			const Y = Y1 - ((j + 0.5) / GH) * (Y1 - Y0);
			const fx = (tx(X) - x0) * S - 0.5;
			const fy = (ty(Y) - y0) * S - 0.5;
			const ix = Math.max(0, Math.min(mw - 2, Math.floor(fx)));
			const iy = Math.max(0, Math.min(mh - 2, Math.floor(fy)));
			const ax = fx - ix;
			const ay = fy - iy;
			const a = mosaic[iy * mw + ix];
			const b = mosaic[iy * mw + ix + 1];
			const c = mosaic[(iy + 1) * mw + ix];
			const d = mosaic[(iy + 1) * mw + ix + 1];
			grid[j * GW + i] =
				a * (1 - ax) * (1 - ay) +
				b * ax * (1 - ay) +
				c * (1 - ax) * ay +
				d * ax * ay;
		}
	return { grid, GW, GH };
}

// ---------- 2. geometry helpers ----------
type Pt = [number, number];
function simplify(pts: Pt[], tol: number): Pt[] {
	if (pts.length < 3) return pts;
	const keep = new Uint8Array(pts.length);
	keep[0] = keep[pts.length - 1] = 1;
	const stack: [number, number][] = [[0, pts.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop() as [number, number];
		let dmax = 0;
		let idx = -1;
		const [ax, ay] = pts[a];
		const [bx, by] = pts[b];
		const len = Math.hypot(bx - ax, by - ay) || 1e-9;
		for (let i = a + 1; i < b; i++) {
			const d =
				Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) /
				len;
			if (d > dmax) {
				dmax = d;
				idx = i;
			}
		}
		if (dmax > tol && idx > 0) {
			keep[idx] = 1;
			stack.push([a, idx], [idx, b]);
		}
	}
	return pts.filter((_, i) => keep[i]);
}
/** Douglas-Peucker for a closed ring (first point equals last): split at the point farthest from the start. */
function simplifyRing(ring: Pt[], tol: number): Pt[] {
	let far = 1;
	let dmax = 0;
	for (let i = 1; i < ring.length - 1; i++) {
		const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
		if (d > dmax) {
			dmax = d;
			far = i;
		}
	}
	return [
		...simplify(ring.slice(0, far + 1), tol),
		...simplify(ring.slice(far), tol).slice(1),
	];
}
/** Integer relative path: M x y l dx dy ... (smaller than absolute coordinates). */
function pathOf(pts: Pt[], close = false) {
	let d = `M${pts[0][0]} ${pts[0][1]}l`;
	let px = pts[0][0];
	let py = pts[0][1];
	const parts: string[] = [];
	for (let i = 1; i < pts.length; i++) {
		parts.push(`${pts[i][0] - px} ${pts[i][1] - py}`);
		px = pts[i][0];
		py = pts[i][1];
	}
	d += parts.join(" ").replace(/ -/g, "-");
	return close ? `${d}z` : d;
}
const ringLength = (r: Pt[]) => {
	let s = 0;
	for (let i = 1; i < r.length; i++)
		s += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
	return s;
};
const ringArea = (r: Pt[]) => {
	let s = 0;
	for (let i = 0; i < r.length; i++) {
		const [x0, y0] = r[i];
		const [x1, y1] = r[(i + 1) % r.length];
		s += x0 * y1 - x1 * y0;
	}
	return Math.abs(s) / 2;
};
/** Straightest stretch of about `arc` sheet units along a ring, away from the frame, oriented left to right. */
function labelStretch(ring: Pt[], arc: number): Pt[] | undefined {
	const margin = 90;
	let best: { score: number; pts: Pt[] } | undefined;
	for (let i = 0; i < ring.length; i++) {
		const pts: Pt[] = [ring[i]];
		let s = 0;
		for (let k = 1; k < ring.length && s < arc; k++) {
			const a = ring[(i + k - 1) % ring.length];
			const b = ring[(i + k) % ring.length];
			s += Math.hypot(b[0] - a[0], b[1] - a[1]);
			pts.push(b);
		}
		if (s < arc) continue;
		if (
			pts.some(
				([x, y]) =>
					x < margin || x > W - margin || y < margin || y > H - margin,
			)
		)
			continue;
		const first = pts[0];
		const last = pts[pts.length - 1];
		const score = Math.hypot(last[0] - first[0], last[1] - first[1]) / s;
		// prefer nearly horizontal stretches so the lettering stays readable
		const flat =
			Math.abs(last[0] - first[0]) /
			(Math.hypot(last[0] - first[0], last[1] - first[1]) || 1);
		const total = score * 0.7 + flat * 0.3;
		if (!best || total > best.score) best = { score: total, pts };
	}
	if (!best) return undefined;
	const pts =
		best.pts[0][0] <= best.pts[best.pts.length - 1][0]
			? best.pts
			: [...best.pts].reverse();
	return simplify(pts, 0.8);
}

// ---------- 3. relief rasters (own Swiss-style bake, see sheet-relief.ts) ----------
/** Greyscale JPEG from one 8-bit channel, resampled to outW wide. */
function writeGrey(
	file: string,
	data: Uint8ClampedArray,
	w: number,
	h: number,
	outW: number,
	quality: number,
) {
	const px = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = data[i];
		px[i * 4 + 3] = 255;
	}
	const small = createCanvas(w, h);
	small.getContext("2d").putImageData(new ImageData(px, w, h), 0, 0);
	const outH = Math.round((outW * h) / w);
	const c = createCanvas(outW, outH);
	const ctx = c.getContext("2d");
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(small, 0, 0, outW, outH);
	const buf = c.toBuffer("image/jpeg", quality);
	fs.writeFileSync(path.join(OUT, file), buf);
	return { bytes: buf.length, width: outW, height: outH };
}

// ---------- 4. main ----------
async function main() {
	const dem = await buildDem();
	const { grid, GW, GH } = dem;
	const cellSheet = W / GW;
	const sheetPt = (p: number[]): Pt => [p[0] * cellSheet, p[1] * cellSheet];

	// terrain analysis shared by relief, contours, rock and scree
	const groundCell = (X1 - X0) / GW / 1.458; // ground metres per cell at 46.7 deg N
	const terrain = analyseTerrain({
		grid,
		w: GW,
		h: GH,
		cellMetres: groundCell,
		lakeLevel: LAKE_LEVEL,
	});
	const mask = buildRockMask(terrain, GW, GH, groundCell);
	const at = (a: ArrayLike<number>, x: number, y: number) =>
		a[
			Math.min(GH - 1, Math.max(0, Math.round(y / cellSheet))) * GW +
				Math.min(GW - 1, Math.max(0, Math.round(x / cellSheet)))
		];
	const sampler = {
		// downhill direction (east, south) against the direction to the NW light
		litness: (x: number, y: number) =>
			-Math.SQRT1_2 * (at(terrain.downX, x, y) + at(terrain.downY, x, y)),
		slopeDeg: (x: number, y: number) => at(terrain.slopeDeg, x, y),
		isRock: (x: number, y: number) => at(mask.rock, x, y) === 1,
	};

	// contours: Tanaka runs by aspect, coloured by surface
	const thresholds: number[] = [];
	for (let t = 580; t <= 2100; t += INTERVAL) thresholds.push(t);
	const gen = contours().size([GW, GH]).smooth(true).thresholds(thresholds);
	const multi = gen(Array.from(grid));
	const runs = Object.fromEntries(CONTOUR_KEYS.map((k) => [k, ""])) as Record<
		ContourKey,
		string
	>;
	const labels: { ele: number; d: string }[] = [];
	let totalPts = 0;
	for (const mp of multi) {
		const ele = mp.value;
		const isIndex = ele % INDEX_EVERY === 0;
		const rings: Pt[][] = [];
		for (const poly of mp.coordinates)
			for (const ring of poly) {
				const pts = simplifyRing(
					ring
						.map(sheetPt)
						.map(([x, y]) => [Math.round(x), Math.round(y)] as Pt),
					SIMPLIFY,
				);
				// drop duplicates created by rounding
				const dedup = pts.filter(
					(p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1],
				);
				if (dedup.length >= 3 && ringLength(dedup) > 14) rings.push(dedup);
			}
		if (!rings.length) continue;
		for (const r of rings) addContourRing(r, isIndex, sampler, runs);
		totalPts += rings.reduce((a, r) => a + r.length, 0);
		if (isIndex && ele % 200 === 0) {
			const longest = [...rings].sort(
				(a, b) => ringLength(b) - ringLength(a),
			)[0];
			const st = labelStretch(longest, 230);
			if (st) labels.push({ ele, d: pathOf(st) });
		}
	}

	// rock hachures and scree (rock.json, quarter-unit integers)
	const rockLayers = buildRockLayers(
		mask,
		terrain,
		GW,
		GH,
		W,
		H,
		cellSheet,
		(x, y) => x < 6 || y < 6 || x > W - 6 || y > H - 6,
	);

	// lake polygon: h <= LAKE_LEVEL, largest ring only
	const lakeGen = contours()
		.size([GW, GH])
		.smooth(true)
		.thresholds([-LAKE_LEVEL]);
	const lakeMp = lakeGen(Array.from(grid, (v) => -v))[0];
	const lakeRings: Pt[][] = [];
	for (const poly of lakeMp.coordinates)
		for (const ring of poly) {
			const pts = simplifyRing(
				ring
					.map(sheetPt)
					.map(
						([x, y]) => [Math.round(x * 2) / 2, Math.round(y * 2) / 2] as Pt,
					),
				0.7,
			);
			lakeRings.push(pts);
		}
	const lakeBig = lakeRings.filter((r) => ringArea(r) > 12000);
	const lakeD = lakeBig
		.map((r) => `M${r.map((p) => p.join(" ")).join("L")}z`)
		.join("");
	const lakeCentroid = (() => {
		const r = lakeBig.sort((a, b) => ringArea(b) - ringArea(a))[0];
		const x = r.reduce((a, p) => a + p[0], 0) / r.length;
		const y = r.reduce((a, p) => a + p[1], 0) / r.length;
		return [Math.round(x), Math.round(y)];
	})();

	// peaks and places from the terroir pack (swissNAMES3D)
	type Name = {
		name: string;
		cls: string;
		lat: number;
		lon: number;
		ele?: number;
		src: string;
	};
	const pack = rd(
		path.join(ROOT, "public", "terroir", "thunersee", "pack.json"),
	) as { names: Name[] };
	const inBox = (n: Name, inset = 0.004) =>
		n.lon > BBOX.west + inset &&
		n.lon < BBOX.east - inset &&
		n.lat > BBOX.south + inset &&
		n.lat < BBOX.north - inset;
	const peakPool = pack.names
		.filter((n) => /^peak/.test(n.cls) && n.ele && inBox(n))
		.sort((a, b) => (b.ele as number) - (a.ele as number));
	const peaks: Name[] = [];
	for (const n of [
		...peakPool.filter((p) => p.name === "Niederhorn"),
		...peakPool,
	])
		if (peaks.length < 13 && !peaks.includes(n)) {
			const [x, y] = toSheet(n.lon, n.lat);
			if (
				peaks.every(
					(p) =>
						Math.hypot(
							toSheet(p.lon, p.lat)[0] - x,
							toSheet(p.lon, p.lat)[1] - y,
						) > 190,
				)
			)
				peaks.push(n);
		}
	const places = pack.names
		.filter((n) => ["town", "village"].includes(n.cls) && inBox(n, 0.002))
		.filter((n) =>
			[
				"Interlaken",
				"Unterseen",
				"Beatenberg",
				"Sigriswil",
				"Merligen",
				"Därligen",
				"Leissigen",
				"Habkern",
				"Bönigen b. Interlaken",
				"Ringgenberg BE",
				"Wilderswil",
				"Matten b. Interlaken",
			].includes(n.name),
		)
		.map((n) => {
			const [x, y] = toSheet(n.lon, n.lat);
			return {
				name: n.name.replace(/ b\. Interlaken| BE/, ""),
				x,
				y,
				ele: n.ele ?? null,
				cls: n.cls,
			};
		});

	// viewpoints: demo camera positions with solved yaw (manifest compass heading when the solve was rejected)
	const manifest = rd(path.join(ROOT, "public", "demo", "manifest.json"));
	const viewpoints = (
		manifest.photos as {
			id: string;
			lat: number;
			lon: number;
			heading: number;
		}[]
	).map((p) => {
		const d = rd(
			path.join(ROOT, "public", "demo", "gipfelbuch", `${p.id}.json`),
		);
		const [x, y] = toSheet(p.lon, p.lat);
		return {
			id: p.id,
			x,
			y,
			lat: Number(p.lat.toFixed(5)),
			lon: Number(p.lon.toFixed(5)),
			yaw: Math.round((d.solved.accepted ? d.solved.yaw : p.heading) * 10) / 10,
			hfov: Math.round(d.solved.hfov * 10) / 10,
			solved: !!d.solved.accepted,
		};
	});

	const rel = bakeRelief({
		grid,
		w: GW,
		h: GH,
		cellMetres: groundCell,
		lakeLevel: LAKE_LEVEL,
	});
	const reliefImg = writeGrey("relief.jpg", rel.tone, GW, GH, 1400, 72);
	const sunImg = writeGrey("sun.jpg", rel.sun, GW, GH, 700, 70);
	const shadeImg = writeGrey("shade.jpg", rel.shade, GW, GH, 700, 70);
	const reliefSource =
		"own Swiss-style relief from the Mapterhorn z13 DEM (generalised, NW light bent locally, aerial perspective, sky illumination)";

	const corner = (lon: number, lat: number) => toLv95(lon, lat);
	const sheet = {
		generated: new Date().toISOString().slice(0, 10),
		script: "scripts/gipfelbuch/data-sheet.ts",
		name: "Niederhorn · Thunersee",
		crs: "EPSG:3857 Web Mercator, scaled to a y-down integer space (width W units)",
		width: W,
		height: H,
		bbox: BBOX,
		lv95: {
			sw: corner(BBOX.west, BBOX.south),
			ne: corner(BBOX.east, BBOX.north),
			nw: corner(BBOX.west, BBOX.north),
			se: corner(BBOX.east, BBOX.south),
		},
		metresPerUnit: Number(((X1 - X0) / W / 1.4608).toFixed(3)), // ground metres at 46.7 deg N
		interval: INTERVAL,
		indexInterval: INDEX_EVERY,
		relief: {
			src: "/demo/gipfelbuch/sheet/relief.jpg",
			sun: "/demo/gipfelbuch/sheet/sun.jpg",
			shade: "/demo/gipfelbuch/sheet/shade.jpg",
			source: reliefSource,
			width: reliefImg.width,
			height: reliefImg.height,
		},
		rock: "/demo/gipfelbuch/sheet/rock.json",
		contours: { runs, labels },
		lake: { name: "Thunersee", level: 557.8, d: lakeD, label: lakeCentroid },
		peaks: peaks.map((n) => {
			const [x, y] = toSheet(n.lon, n.lat);
			return { name: n.name, ele: n.ele, x, y };
		}),
		places,
		viewpoints,
		sources: [
			"Mapterhorn DEM z13 (contours, lake)",
			reliefSource,
			"swissNAMES3D via public/terroir/thunersee/pack.json (peaks, places)",
		],
		credit: "DEM Mapterhorn · names swisstopo swissNAMES3D",
	};
	fs.writeFileSync(path.join(OUT, "sheet.json"), JSON.stringify(sheet));
	fs.writeFileSync(
		path.join(OUT, "rock.json"),
		JSON.stringify({
			note: "integer paths in quarter sheet units; render inside scale(0.25)",
			quantum: 4,
			hachures: rockLayers.hachures,
			scree: rockLayers.scree,
		}),
	);
	const sz = fs
		.readdirSync(OUT)
		.map((f) => [f, fs.statSync(path.join(OUT, f)).size] as const);
	console.log(
		`sheet ${W}x${H} units, grid ${GW}x${GH}, contour pts ${totalPts}, labels ${labels.length}, peaks ${peaks.length}, hachures ${rockLayers.counts.hachures}, dots ${rockLayers.counts.dots}`,
	);
	console.log(reliefSource, `masks ${sunImg.width}px, ${shadeImg.width}px`);
	console.log(sz.map(([f, s]) => `${f} ${(s / 1024).toFixed(1)}K`).join("\n"));
}
main();

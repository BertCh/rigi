// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Real DEM facts for the gipfelbuch pages terrain-snapping, dem-source and dem-anchoring.
 *
 *   npx tsx scripts/gipfelbuch/data-terrain.ts
 *
 * Runs the REAL modules (src/lib/dem sources + tile math, geo/terrain TerrainSampler, geo/camera) on Terrarium (AWS)
 * and Mapterhorn tiles around the demo camera (Niederhorn, demo-01), disk-cached in .cache/. Writes
 * public/demo/gipfelbuch/terrain/:
 *   terrain.json            numbers (tile grid, RGB of a real pixel, transect, seam patch, per-photo eye, peak snaps,
 *                           DEM range grid, spike curves)
 *   hs-terrarium.jpg / hs-mapterhorn.jpg   same 1.2 km box, hillshaded from each source
 *   snap-<n>.jpg            hillshade around a peak whose OSM node is moved by the snap rule
 * Output < 400 KB. Every number is measured here, none is typed in.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, ImageData, loadImage } from "@napi-rs/canvas";
import {
	DEM_SOURCES,
	type DemSource,
	decodeTerrarium,
	lonLatToTile,
	tileBounds,
	tilesAround,
	tileXToLon,
	tileYToLat,
} from "../../src/lib/dem";
import { cameraFromAngles, unproject } from "../../src/lib/geo/camera";
import { TerrainSampler } from "../../src/lib/geo/terrain";
import { destination, distanceBearing } from "../../src/lib/geodesy";
import { CACHE, demTileLoaderNode, ROOT } from "../lib/node-io";

const OUT = path.join(ROOT, "public", "demo", "gipfelbuch", "terrain");
fs.mkdirSync(OUT, { recursive: true });
const GIPFELBUCH = path.join(ROOT, "public", "demo", "gipfelbuch");
const rd = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const manifest = rd(path.join(ROOT, "public", "demo", "manifest.json"));
const demo01 = rd(path.join(GIPFELBUCH, "demo-01.json"));
const { lat: LAT, lon: LON } = demo01.gps as { lat: number; lon: number };

const r0 = (v: number) => (Number.isFinite(v) ? Math.round(v) : null);
const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v: number) =>
	Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

const T = DEM_SOURCES.terrarium;
const M = DEM_SOURCES.mapterhorn;
const store: Record<string, Map<string, Float32Array>> = {
	terrarium: new Map(),
	mapterhorn: new Map(),
};
const loaders = {
	terrarium: demTileLoaderNode(T),
	mapterhorn: demTileLoaderNode(M),
};
const samplers = {
	terrarium: new TerrainSampler(T.levels, store.terrarium, T.tileSize),
	mapterhorn: new TerrainSampler(M.levels, store.mapterhorn, M.tileSize),
};
async function need(src: DemSource, z: number, lat: number, lon: number) {
	const t = lonLatToTile(lon, lat, z);
	const key = { z, x: Math.floor(t.x), y: Math.floor(t.y) };
	const id = `${z}/${key.x}/${key.y}`;
	const st = store[src.name];
	if (st.has(id)) return true;
	const h = await loaders[src.name as "terrarium"](key);
	if (h) st.set(id, h);
	return !!h;
}
/** Make sure every tile within `radius` of a point exists at zoom z. */
async function needAround(
	src: DemSource,
	z: number,
	lat: number,
	lon: number,
	radius: number,
) {
	for (const k of tilesAround(lat, lon, radius, z)) {
		const id = `${k.z}/${k.x}/${k.y}`;
		if (store[src.name].has(id)) continue;
		const h = await loaders[src.name as "terrarium"](k);
		if (h) store[src.name].set(id, h);
	}
}
const M_LAT = 111_320;
const enu = (dx: number, dy: number) => ({
	lat: LAT + dy / M_LAT,
	lon: LON + dx / (M_LAT * Math.cos((LAT * Math.PI) / 180)),
});

function hillshade(
	h: Float32Array,
	n: number,
	cell: number,
	exag = 2,
	file: string,
) {
	const out = new Uint8ClampedArray(n * n * 4);
	const az = (315 * Math.PI) / 180;
	const zen = (45 * Math.PI) / 180;
	for (let y = 0; y < n; y++)
		for (let x = 0; x < n; x++) {
			const g = (xx: number, yy: number) =>
				h[
					Math.min(n - 1, Math.max(0, yy)) * n +
						Math.min(n - 1, Math.max(0, xx))
				];
			const dzdx = ((g(x + 1, y) - g(x - 1, y)) / (2 * cell)) * exag;
			const dzdy = ((g(x, y + 1) - g(x, y - 1)) / (2 * cell)) * exag;
			const slope = Math.atan(Math.hypot(dzdx, dzdy));
			const asp = Math.atan2(dzdy, -dzdx);
			const s =
				Math.cos(zen) * Math.cos(slope) +
				Math.sin(zen) * Math.sin(slope) * Math.cos(az - asp);
			const v = Math.max(0, Math.min(255, 25 + 215 * s));
			const o = (y * n + x) * 4;
			out[o] = out[o + 1] = out[o + 2] = v;
			out[o + 3] = 255;
		}
	const c = createCanvas(n, n);
	c.getContext("2d").putImageData(new ImageData(out, n, n), 0, 0);
	fs.writeFileSync(path.join(OUT, file), c.toBuffer("image/jpeg", 78));
}

const pct = (a: number[], p: number) => {
	const s = [...a].sort((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

async function main() {
	const out: Record<string, unknown> = {
		generated: new Date().toISOString().slice(0, 10),
		script: "scripts/gipfelbuch/data-terrain.ts",
		site: { lat: r5(LAT), lon: r5(LON), name: "Niederhorn (demo-01 camera)" },
	};

	// ---------- 1. tile grid: levels, tile counts, tile footprint ----------
	const mpp = (z: number, size: number) =>
		(40_075_016.686 * Math.cos((LAT * Math.PI) / 180)) / (size * 2 ** z);
	const gridFor = (src: DemSource) =>
		src.levels.map((l, i) => {
			const prev = i ? src.levels[i - 1].maxDistance : 0;
			const t = lonLatToTile(LON, LAT, l.z);
			const key = { z: l.z, x: Math.floor(t.x), y: Math.floor(t.y) };
			const b = tileBounds(key);
			const tileKm =
				((b.east - b.west) * M_LAT * Math.cos((LAT * Math.PI) / 180)) / 1000;
			return {
				z: l.z,
				from: prev,
				to: l.maxDistance,
				tiles: tilesAround(LAT, LON, l.maxDistance, l.z).length,
				cameraTile: `${key.z}/${key.x}/${key.y}`,
				tileKm: r2(tileKm),
				mPerPx: r2(mpp(l.z, src.tileSize)),
				tileSize: src.tileSize,
			};
		});
	out.levels = { terrarium: gridFor(T), mapterhorn: gridFor(M) };
	out.source = {
		terrarium: { tileSize: T.tileSize, maxZoom: T.maxZoom, format: "png" },
		mapterhorn: { tileSize: M.tileSize, maxZoom: M.maxZoom, format: "webp" },
	};

	// ---------- 2. RGB of a real pixel (Terrarium z13 + Mapterhorn z15 at the camera) ----------
	const rgbOf = async (src: DemSource, z: number) => {
		await need(src, z, LAT, LON);
		const t = lonLatToTile(LON, LAT, z);
		const key = { z, x: Math.floor(t.x), y: Math.floor(t.y) };
		const ext = src.name === "terrarium" ? "png" : "webp";
		const dir = src.name === "terrarium" ? "terrarium" : `dem-${src.name}`;
		const img = await loadImage(
			path.join(CACHE, dir, `${z}/${key.x}/${key.y}.${ext}`),
		);
		const c = createCanvas(img.width, img.height);
		const ctx = c.getContext("2d");
		ctx.drawImage(img, 0, 0);
		const px = Math.floor((t.x - key.x) * src.tileSize);
		const py = Math.floor((t.y - key.y) * src.tileSize);
		const d = ctx.getImageData(px, py, 1, 1).data;
		const h = decodeTerrarium(
			new Uint8ClampedArray([d[0], d[1], d[2], 255]),
		)[0];
		return {
			source: src.name,
			tile: `${z}/${key.x}/${key.y}`,
			px,
			py,
			rgb: [d[0], d[1], d[2]],
			height: r2(h),
		};
	};
	out.rgb = [await rgbOf(T, 13), await rgbOf(M, 15)];

	// ---------- 3. hillshade of the same box from each source ----------
	const HALF = 600;
	const N = 300;
	const cell = (2 * HALF) / N;
	await needAround(T, 15, LAT, LON, HALF * 1.5);
	await needAround(M, 16, LAT, LON, HALF * 1.5);
	await needAround(M, 17, LAT, LON, HALF * 1.5);
	const boxStats: Record<string, unknown> = {};
	const grids: Record<string, Float32Array> = {};
	for (const [name, src, z] of [
		["terrarium", T, 15],
		["mapterhorn", M, 17],
	] as const) {
		const h = new Float32Array(N * N);
		for (let y = 0; y < N; y++)
			for (let x = 0; x < N; x++) {
				const p = enu(-HALF + (x + 0.5) * cell, HALF - (y + 0.5) * cell);
				h[y * N + x] = samplers[name].sample(p.lon, p.lat, z);
			}
		grids[name] = h;
		hillshade(h, N, cell, 0.6, `hs-${name}.jpg`);
		const slopes: number[] = [];
		for (let y = 1; y < N - 1; y++)
			for (let x = 1; x < N - 1; x++) {
				const gx = (h[y * N + x + 1] - h[y * N + x - 1]) / (2 * cell);
				const gy = (h[(y + 1) * N + x] - h[(y - 1) * N + x]) / (2 * cell);
				slopes.push((Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI);
			}
		let mx = -Infinity;
		let mn = Infinity;
		for (const v of h) {
			mx = Math.max(mx, v);
			mn = Math.min(mn, v);
		}
		boxStats[name] = {
			z,
			nativeMPerPx: r2(mpp(z, src.tileSize)),
			max: r1(mx),
			min: r1(mn),
			slopeP50: r1(pct(slopes, 0.5)),
			slopeP90: r1(pct(slopes, 0.9)),
			slopeP99: r1(pct(slopes, 0.99)),
		};
	}
	let dsum = 0;
	let dmax = 0;
	for (let i = 0; i < N * N; i++) {
		const d = Math.abs(grids.terrarium[i] - grids.mapterhorn[i]);
		dsum += d;
		dmax = Math.max(dmax, d);
	}
	// profile along the row through the highest Mapterhorn pixel (east-west)
	let bi = 0;
	for (let i = 0; i < N * N; i++)
		if (grids.mapterhorn[i] > grids.mapterhorn[bi]) bi = i;
	const prow = Math.floor(bi / N);
	const profile = {
		row: prow,
		northM: r0(HALF - (prow + 0.5) * cell),
		terrarium: Array.from({ length: N }, (_, x) =>
			r1(grids.terrarium[prow * N + x]),
		),
		mapterhorn: Array.from({ length: N }, (_, x) =>
			r1(grids.mapterhorn[prow * N + x]),
		),
	};
	const osmSummit = manifest.region.peaks.find(
		(q: { name: string }) => q.name === "Niederhorn",
	);
	out.box = {
		osmSummit: { name: "Niederhorn", ele: osmSummit?.ele ?? null },
		profile,
		halfM: HALF,
		px: N,
		cellM: r2(cell),
		...boxStats,
		meanAbsDiff: r1(dsum / (N * N)),
		maxAbsDiff: r1(dmax),
	};

	// ---------- 4. transect from the camera across Lake Thun (bearing 150 deg), every source and zoom ----------
	const BEAR = 150;
	const LEN = 12_000;
	const STEP = 50;
	const zsM = [9, 10, 11, 12, 14, 15];
	const zsT = [10, 11, 13, 15];
	const dists = Array.from({ length: LEN / STEP + 1 }, (_, i) => i * STEP);
	const pts = dists.map((d) => destination(LAT, LON, BEAR, d));
	for (const p of pts) {
		for (const z of zsM) await need(M, z, p.lat, p.lon);
		for (const z of zsT) await need(T, z, p.lat, p.lon);
	}
	const ser = (name: "terrarium" | "mapterhorn", z: number) =>
		pts.map((p) => r1(samplers[name].sample(p.lon, p.lat, z)));
	const at = (name: "terrarium" | "mapterhorn") =>
		pts.map((p, i) => {
			const lv = samplers[name].levels;
			let k = lv.findIndex((l) => dists[i] <= l.maxDistance);
			if (k < 0) k = lv.length - 1;
			return r1(samplers[name].sampleAt(p.lon, p.lat, dists[i]));
		});
	out.transect = {
		bearing: BEAR,
		step: STEP,
		d: dists,
		mapterhorn: Object.fromEntries(zsM.map((z) => [z, ser("mapterhorn", z)])),
		terrarium: Object.fromEntries(zsT.map((z) => [z, ser("terrarium", z)])),
		mapterhornAt: at("mapterhorn"),
		terrariumAt: at("terrarium"),
	};

	// ---------- 5. seam patch: a real tile boundary near the camera, Mapterhorn z15 ----------
	{
		const z = 15;
		await need(M, z, LAT, LON);
		const t = lonLatToTile(LON, LAT, z);
		const seamX = Math.round(t.x); // tile column boundary nearest the camera
		const lonSeam = tileXToLon(seamX, z);
		// A point 0.35 px east of the seam, at the camera's latitude.
		const pxPerTile = M.tileSize;
		const gxSeam = seamX * pxPerTile; // first pixel of the tile east of the seam
		const ty = lonLatToTile(lonSeam, LAT, z).y;
		const gy = Math.floor(ty * pxPerTile - 0.5);
		await need(M, z, LAT, lonSeam - 1e-5);
		await need(M, z, LAT, lonSeam + 1e-5);
		const GW = 6;
		const GH = 5;
		const gx0 = gxSeam - 3;
		const gy0 = gy - 2;
		const heights: number[][] = [];
		const st = store.mapterhorn;
		const px = (gx: number, gyy: number) => {
			const tx = Math.floor(gx / pxPerTile);
			const tyy = Math.floor(gyy / pxPerTile);
			const tile = st.get(`${z}/${tx}/${tyy}`);
			return tile
				? tile[(gyy - tyy * pxPerTile) * pxPerTile + (gx - tx * pxPerTile)]
				: Number.NaN;
		};
		for (let j = 0; j < GH; j++)
			heights.push(
				Array.from(
					{ length: GW },
					(_, i) => r2(px(gx0 + i, gy0 + j)) as number,
				),
			);
		// probe point: between pixel centres (gxSeam-1) and gxSeam, 0.4 of the way across, at row gy + 0.3
		const fx = 0.4;
		const fy = 0.3;
		const probeX = (gxSeam - 1 + fx + 0.5) / pxPerTile;
		const probeY = (gy + fy + 0.5) / pxPerTile;
		const probeLon = tileXToLon(probeX, z);
		const probeLat = tileYToLat(probeY, z);
		out.seam = {
			z,
			tileA: `${z}/${seamX - 1}/${Math.floor(ty)}`,
			tileB: `${z}/${seamX}/${Math.floor(ty)}`,
			seamAtCol: 3,
			gridW: GW,
			gridH: GH,
			heights,
			fx,
			fy,
			sampled: r2(samplers.mapterhorn.sample(probeLon, probeLat, z)),
			mPerPx: r2(mpp(z, pxPerTile)),
		};
	}

	// ---------- 6. coverage: finest Mapterhorn zoom at a few places (HTTP status of each zoom) ----------
	const places: [string, number, number][] = [
		["Niederhorn (CH)", 46.7102, 7.7733],
		["Chamonix (FR)", 45.83, 6.86],
		["Cervino (IT)", 45.976, 7.658],
		["Dolomites (IT)", 46.41, 11.84],
		["Norway", 61.63, 8.31],
		["Utah (US)", 40.65, -111.58],
	];
	const cov: unknown[] = [];
	for (const [name, la, lo] of places) {
		let finest = 0;
		for (const z of [9, 11, 12, 13, 14, 15, 16, 17]) {
			const t = lonLatToTile(lo, la, z);
			const res = await fetch(
				M.url({ z, x: Math.floor(t.x), y: Math.floor(t.y) }),
			);
			if (res.ok) finest = z;
		}
		cov.push({ name, finest });
	}
	out.coverage = cov;

	// ---------- 7. eye rule per demo photo: GPS altitude vs DEM ground (both sources) ----------
	const eyes: unknown[] = [];
	for (const p of manifest.photos as {
		id: string;
		lat: number;
		lon: number;
		alt: number;
		hAccuracy: number;
	}[]) {
		await need(M, 15, p.lat, p.lon);
		await need(T, 13, p.lat, p.lon);
		const gM = samplers.mapterhorn.ground(p.lon, p.lat);
		const gT = samplers.terrarium.ground(p.lon, p.lat);
		const pj = rd(path.join(GIPFELBUCH, `${p.id}.json`));
		eyes.push({
			id: p.id,
			alt: r1(p.alt),
			hAcc: r1(p.hAccuracy),
			groundTerrarium: r1(gT),
			groundMapterhorn: r1(gM),
			eye: pj.gps.eye,
			lift: r1(pj.gps.eye - p.alt),
		});
	}
	out.eyes = eyes;
	// Lake Thun surface in the DEM (middle of the transect)
	{
		const lakeD = dists.filter((_, i) => {
			const h = (
				out.transect as { mapterhorn: Record<number, (number | null)[]> }
			).mapterhorn[15][i];
			return h != null && h < 570;
		});
		const li = lakeD.map((d) => d / STEP);
		const tr = out.transect as {
			mapterhorn: Record<number, (number | null)[]>;
			terrarium: Record<number, (number | null)[]>;
		};
		const vals = (a: (number | null)[]) => li.map((i) => a[i] as number);
		out.lake = {
			fromM: lakeD[0],
			toM: lakeD[lakeD.length - 1],
			mapterhornMin: Math.min(...vals(tr.mapterhorn[15])),
			mapterhornMax: Math.max(...vals(tr.mapterhorn[15])),
			terrariumMin: Math.min(...vals(tr.terrarium[15])),
			terrariumMax: Math.max(...vals(tr.terrarium[15])),
		};
	}

	// ---------- 8. peak snap (the engine rule: localMax radius min(250, 60 + 0.004 d), 9x9 grid) ----------
	const peaks = manifest.region.peaks as {
		name: string;
		lat: number;
		lon: number;
		ele?: number | null;
	}[];
	const cand = peaks
		.map((p) => ({ p, ...distanceBearing(LAT, LON, p.lat, p.lon) }))
		.filter((c) => c.distance >= 150 && c.distance <= 110_000 && c.p.name);
	// Load the tiles each sampler needs for the peaks inside the Mapterhorn level bands (<=40 km, a few hundred tiles).
	const near = cand.filter((c) => c.distance <= 40_000);
	for (const c of near) {
		const lv =
			M.levels.find((l) => c.distance <= l.maxDistance) ??
			M.levels[M.levels.length - 1];
		for (const dz of [0, 0]) {
			await need(M, lv.z + dz, c.p.lat, c.p.lon);
		}
		const lt =
			T.levels.find((l) => c.distance <= l.maxDistance) ??
			T.levels[T.levels.length - 1];
		await need(T, lt.z, c.p.lat, c.p.lon);
	}
	const localMax = (
		s: TerrainSampler,
		lat: number,
		lon: number,
		dist: number,
		R: number,
	) => {
		let best = { lat, lon, h: s.sampleAt(lon, lat, dist) };
		const dLat = R / M_LAT;
		const dLon = R / (M_LAT * Math.cos((lat * Math.PI) / 180));
		for (let i = -4; i <= 4; i++)
			for (let j = -4; j <= 4; j++) {
				const la = lat + (i / 4) * dLat;
				const lo = lon + (j / 4) * dLon;
				const h = s.sampleAt(lo, la, dist);
				if (Number.isFinite(h) && !(h <= best.h))
					best = { lat: la, lon: lo, h };
			}
		return best;
	};
	const rows = near.map((c) => {
		const R = Math.min(250, 60 + c.distance * 0.004);
		const at0 = (s: TerrainSampler) => s.sampleAt(c.p.lon, c.p.lat, c.distance);
		const sm = localMax(samplers.mapterhorn, c.p.lat, c.p.lon, c.distance, R);
		const st = localMax(samplers.terrarium, c.p.lat, c.p.lon, c.distance, R);
		const moved = (q: { lat: number; lon: number }) =>
			distanceBearing(c.p.lat, c.p.lon, q.lat, q.lon).distance;
		return {
			name: c.p.name,
			ele: c.p.ele ?? null,
			dist: Math.round(c.distance),
			radius: Math.round(R),
			osmMapterhorn: r1(at0(samplers.mapterhorn)),
			snapMapterhorn: r1(sm.h),
			moveMapterhorn: Math.round(moved(sm)),
			osmTerrarium: r1(at0(samplers.terrarium)),
			snapTerrarium: r1(st.h),
			moveTerrarium: Math.round(moved(st)),
			lat: r5(c.p.lat),
			lon: r5(c.p.lon),
			slat: r5(sm.lat),
			slon: r5(sm.lon),
		};
	});
	const withEle = rows.filter((r) => r.ele != null && r.snapMapterhorn != null);
	out.peakRule = {
		n: rows.length,
		nWithEle: withEle.length,
		radiusAt: [
			[150, r0(Math.min(250, 60 + 150 * 0.004))],
			[10_000, r0(Math.min(250, 60 + 10_000 * 0.004))],
			[40_000, r0(Math.min(250, 60 + 40_000 * 0.004))],
			[110_000, r0(Math.min(250, 60 + 110_000 * 0.004))],
		],
		// OSM `ele` vs the snapped DEM summit height (Mapterhorn / Terrarium)
		medianAbsEleMinusSnapMapterhorn: r1(
			pct(
				withEle.map((r) =>
					Math.abs((r.ele as number) - (r.snapMapterhorn as number)),
				),
				0.5,
			),
		),
		medianAbsEleMinusSnapTerrarium: r1(
			pct(
				withEle.map((r) =>
					Math.abs((r.ele as number) - (r.snapTerrarium as number)),
				),
				0.5,
			),
		),
		medianAbsEleMinusOsmNodeMapterhorn: r1(
			pct(
				withEle.map((r) =>
					Math.abs((r.ele as number) - (r.osmMapterhorn as number)),
				),
				0.5,
			),
		),
		medianMoveMapterhorn: pct(
			rows.map((r) => r.moveMapterhorn as number),
			0.5,
		),
		p90MoveMapterhorn: pct(
			rows.map((r) => r.moveMapterhorn as number),
			0.9,
		),
		// a spread of examples: biggest snaps within 6 km (visible in a close-up) and a few notable ones
		rows: rows
			.filter((r) => r.dist <= 12_000)
			.sort(
				(a, b) => (b.moveMapterhorn as number) - (a.moveMapterhorn as number),
			)
			.slice(0, 18),
	};
	// close-up hillshade of the best nearby example
	{
		const ex = (out.peakRule as { rows: typeof rows }).rows.find(
			(r) => r.dist >= 800 && r.dist <= 8000 && r.moveMapterhorn >= 25,
		);
		if (ex) {
			const half = 220;
			const n = 220;
			const cs = (2 * half) / n;
			await needAround(M, 16, ex.lat, ex.lon, half * 1.5);
			const h = new Float32Array(n * n);
			const dLat = (v: number) => v / M_LAT;
			const dLon = (v: number) =>
				v / (M_LAT * Math.cos((ex.lat * Math.PI) / 180));
			for (let y = 0; y < n; y++)
				for (let x = 0; x < n; x++)
					h[y * n + x] = samplers.mapterhorn.sample(
						ex.lon + dLon(-half + (x + 0.5) * cs),
						ex.lat + dLat(half - (y + 0.5) * cs),
						16,
					);
			hillshade(h, n, cs, 1, "snap-0.jpg");
			const toPx = (la: number, lo: number) => [
				r1(((lo - ex.lon) / dLon(1) + half) / cs),
				r1((half - (la - ex.lat) / dLat(1)) / cs),
			];
			// the 9x9 search grid, in px, plus DEM heights at those samples
			const R = ex.radius;
			const grid: number[][] = [];
			for (let i = -4; i <= 4; i++)
				for (let j = -4; j <= 4; j++) {
					const la = ex.lat + (i / 4) * dLat(R);
					const lo = ex.lon + (j / 4) * dLon(R);
					const hh = samplers.mapterhorn.sample(lo, la, 16);
					grid.push([...(toPx(la, lo) as number[]), r1(hh) as number]);
				}
			out.snapExample = {
				name: ex.name,
				ele: ex.ele,
				dist: ex.dist,
				radius: R,
				halfM: half,
				px: n,
				osmPx: toPx(ex.lat, ex.lon),
				snapPx: toPx(ex.slat, ex.slon),
				osmH: r1(samplers.mapterhorn.sample(ex.lon, ex.lat, 16)),
				snapH: ex.snapMapterhorn,
				move: ex.moveMapterhorn,
				grid,
			};
		}
	}

	// ---------- 9. DEM ray range for demo-01 at its solved pose (the ruler Step Inside calibrates against) ----------
	{
		const d = demo01;
		const W = d.photo.width as number;
		const H = d.photo.height as number;
		const cam = cameraFromAngles({
			width: W,
			height: H,
			f: d.solved.f,
			yaw: d.solved.yaw,
			pitch: d.solved.pitch,
			roll: d.solved.roll,
		});
		await needAround(T, 13, LAT, LON, 4_000);
		await needAround(T, 11, LAT, LON, 40_000);
		await needAround(T, 10, LAT, LON, 150_000);
		const S = samplers.terrarium;
		const eye = d.gps.eye as number;
		const EARTH = 6_371_000;
		const range = (dir: number[]) => {
			let prevT = 0;
			let prevG = eye - (S.sampleAt(LON, LAT, 0) as number);
			let tt = 4;
			while (tt < 30_000) {
				const dx = dir[0] * tt;
				const dy = dir[1] * tt;
				const p = enu(dx, dy);
				const hz = Math.hypot(dx, dy);
				const gnd = S.sampleAt(p.lon, p.lat, hz);
				const ray = eye + dir[2] * tt - (hz * hz) / (2 * EARTH);
				const g = ray - gnd;
				if (!Number.isNaN(g) && g <= 0) {
					const f = prevG / (prevG - g);
					return prevT + f * (tt - prevT);
				}
				prevT = tt;
				if (!Number.isNaN(g)) prevG = g;
				tt += Math.max(4, tt * 0.01);
			}
			return Number.NaN;
		};
		const CS = 20;
		const cols = Math.floor(W / CS);
		const rowsN = Math.floor(H / CS);
		const grid: (number | null)[][] = [];
		for (let j = 0; j < rowsN; j++) {
			const row: (number | null)[] = [];
			for (let i = 0; i < cols; i++)
				row.push(r0(range(unproject(cam, (i + 0.5) * CS, (j + 0.5) * CS))));
			grid.push(row);
		}
		out.range = {
			id: "demo-01",
			dem: "terrarium",
			cell: CS,
			cols,
			rows: rowsN,
			grid,
		};
	}

	// ---------- 10. measured depth-vs-DEM fits from the P0 spike (tools/nearfield/spike/place.json, 30 dev photos) ----------
	{
		const place = rd(
			path.join(ROOT, "tools", "nearfield", "spike", "place.json"),
		) as Record<
			string,
			{
				n: number;
				curve?: { x: number[]; y: number[] };
				curveQ?: {
					quality: number;
					residualLogAll: number;
					inlierFrac: number;
				};
				resid500?: { curve: number | null; scale3000: number | null };
			}
		>;
		const fits = Object.entries(place)
			.filter(([, v]) => v.curve && v.curveQ)
			.map(([id, v]) => ({
				id,
				x: (v.curve as { x: number[] }).x.map(r2),
				y: (v.curve as { y: number[] }).y.map(r2),
				quality: r2(v.curveQ?.quality as number),
				resid: r2(v.curveQ?.residualLogAll as number),
				inlier: r2(v.curveQ?.inlierFrac as number),
			}));
		const med = (a: number[]) => pct(a, 0.5);
		const rc = Object.values(place)
			.map((v) => v.resid500?.curve)
			.filter((v): v is number => typeof v === "number");
		const rs = Object.values(place)
			.map((v) => v.resid500?.scale3000)
			.filter((v): v is number => typeof v === "number");
		out.spike = {
			source: "tools/nearfield/spike/place.json",
			nPhotos: Object.keys(place).length,
			nFitted: fits.length,
			medianResidCurve: r2(med(rc)),
			medianResidScale: r2(med(rs)),
			nResid: rc.length,
			passQ15: fits.filter((f) => (f.quality as number) >= 0.15).length,
			passQ35: fits.filter((f) => (f.quality as number) >= 0.35).length,
			fits,
		};
	}

	fs.writeFileSync(path.join(OUT, "terrain.json"), JSON.stringify(out));
	const sz = fs
		.readdirSync(OUT)
		.map((f) => [f, fs.statSync(path.join(OUT, f)).size] as const);
	console.log(sz.map(([f, s]) => `${f} ${(s / 1024).toFixed(1)}K`).join("\n"));
	console.log(
		"total",
		(sz.reduce((a, [, s]) => a + s, 0) / 1024).toFixed(0),
		"KB",
	);
}
main();

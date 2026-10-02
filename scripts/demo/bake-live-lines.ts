// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Bakes the line art the live landing views draw on their sides, projected every frame through the
 * live camera (src/components/site/LiveLines.tsx; container and decoding in lineArt.ts):
 *
 *   public/demo/surround/step-lines.bin    05 · Step inside: the ridgelines traced from IMG_7086's eye
 *     (the panorama strip's trace, traceViewpoint), cropped to the azimuths the swaying canvas and its
 *     side spill can show, with the peaks seen from there.
 *   public/demo/surround/live3d-lines.bin  04 · 3D: Mapterhorn contours around the demo viewpoint as 3D
 *     polylines (40 m, every 200 m heavier; only the 200 m ones past NEAR_R), in short strokes so each
 *     can fade with its own distance from the orbiting camera.
 *
 *   npx tsx scripts/demo/bake-live-lines.ts
 *
 * Tiles come from the .cache/dem-mapterhorn disk cache (fetched on a miss).
 */
import fs from "node:fs";
import path from "node:path";
import { contours } from "d3-contour";
import { encodeBlob } from "../../src/components/site/lineArt";
import { MAPTERHORN } from "../../src/lib/dem";
import { EnuFrame } from "../../src/lib/geodesy";
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

const OUT = path.join(ROOT, "public", "demo", "surround");
const manifest = JSON.parse(
	fs.readFileSync(path.join(ROOT, "public", "demo", "manifest.json"), "utf8"),
) as { region: { peaks: RidgelinePeakInput[] } };
const step = JSON.parse(
	fs.readFileSync(
		path.join(ROOT, "public", "demo", "step", "scene.json"),
		"utf8",
	),
) as {
	photo: { lat: number; lon: number; alt: number };
	pose: { yaw: number; pitch: number; roll: number; vfov: number };
	eye: { z: number };
};
const load = demTileLoaderNode(MAPTERHORN);
const write = (name: string, buf: Uint8Array) => {
	fs.mkdirSync(OUT, { recursive: true });
	fs.writeFileSync(path.join(OUT, name), buf);
	console.log(`${name}: ${(buf.byteLength / 1024).toFixed(0)} kB`);
};

// ─── 05 · Step inside: ridgelines from the photo's eye ───────────────────────

/** The sway (StepInsideDemo SWAY_YAW) plus the widest view: a 16:9 canvas at the photo's vfov with half
 * a frame width of spill each side, so ±atan(2 tan(hfov/2)) about the view direction, and a margin. */
const SWAY = 22;
{
	const { lat, lon, alt } = step.photo;
	const pose = step.pose;
	const store = new TileStore({
		tileSize: MAPTERHORN.tileSize,
		maxZoom: MAPTERHORN.maxZoom,
		load,
	});
	const mosaics = await loadMosaics(lat, lon, store, {
		rings: DEFAULT_RINGS,
		maxDistance: 120_000,
	});
	const heightAt = (la: number, lo: number, d: number) =>
		mosaicHeight(mosaicFor(mosaics, d), lo, la);
	const h = Math.max(alt, heightAt(lat, lon, 0) + 1.6);
	const t = traceViewpoint(heightAt, { lat, lon, h }, manifest.region.peaks, {
		dMax: 120_000,
	});
	const tanV = Math.tan((pose.vfov * Math.PI) / 360);
	const half = (Math.atan(2 * tanV * (16 / 9)) * 180) / Math.PI + SWAY + 8;
	const off = (az: number) => ((((az - pose.yaw) % 360) + 540) % 360) - 180;
	const az: number[] = [];
	const el: number[] = [];
	const start = [0];
	const slab: number[] = [];
	const ridge: number[] = [];
	for (let i = 0; i < t.slab.length; i++) {
		// split each stroke into the runs inside the window
		let run: number[] = [];
		const flush = () => {
			if (run.length >= 4) {
				for (let k = 0; k < run.length; k += 2) {
					// azimuths unwrapped about the view direction, so 0/360 never splits a stroke
					az.push(Math.round((pose.yaw + off(run[k])) * 100));
					el.push(Math.round(run[k + 1] * 100));
				}
				start.push(az.length);
				slab.push(t.slab[i]);
				ridge.push(t.ridge[i]);
			}
			run = [];
		};
		for (let k = t.start[i]; k < t.start[i + 1]; k++) {
			const a = t.pts[k * 2];
			if (Math.abs(off(a)) <= half) run.push(a, t.pts[k * 2 + 1]);
			else flush();
		}
		flush();
	}
	const peaks = [...t.peaks]
		.filter((p) => Math.abs(off(p.az)) <= half)
		.sort((a, b) => (b.prominence ?? 0) - (a.prominence ?? 0) || b.ele - a.ele)
		.slice(0, 40)
		.map((p) => ({
			name: p.name,
			ele: p.ele,
			az: Math.round((pose.yaw + off(p.az)) * 100) / 100,
			el: Math.round(p.el * 1000) / 1000,
			d: p.d,
		}));
	write(
		"step-lines.bin",
		encodeBlob(
			{
				kind: "ridges",
				eye: { lat, lon, h },
				// the step camera's ENU eye (public/demo/step/scene.json): the rest view
				restEyeZ: step.eye.z,
				pose,
				slabs: t.slabs,
				dMin: t.dMin,
				dMax: t.dMax,
				peaks,
			},
			{
				az: new Uint16Array(az),
				el: new Int16Array(el),
				start: new Uint32Array(start),
				slab: new Uint8Array(slab),
				ridge: new Uint8Array(ridge),
			},
		),
	);
	console.log(
		`  ${slab.length} strokes, ${az.length} points, ±${half.toFixed(0)}° about yaw ${pose.yaw}`,
	);
}

// ─── 04 · 3D: contours around the demo viewpoint ─────────────────────────────

/** The demo viewpoint (the landing roll's centre of attention); the engine shifts its frame onto it. */
const ORIGIN = { lat: 46.71039, lon: 7.7736 };
/** Radius covered (m): the overview orbit (3.2 km out, ~43° down) sees ground to ~9 km at the top edge. */
const R = 11_000;
/** Inside this every 40 m contour; outside only every 200 m (they are faint and dense out there). */
const NEAR_R = 5_000;
const STEP_M = 40;
const INDEX_M = 200;
/** Douglas–Peucker tolerance (m) and stroke length (points). */
const TOL = 7;
const CHUNK = 40;
const Z = 11; // Mapterhorn 512 px tiles: ~26 m cells here
{
	const T = MAPTERHORN.tileSize;
	const n = T * 2 ** Z;
	const merc = (lat: number, lon: number) => {
		const s = Math.sin((lat * Math.PI) / 180);
		return {
			x: ((lon + 180) / 360) * n,
			y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
		};
	};
	const unmerc = (x: number, y: number) => ({
		lon: (x / n) * 360 - 180,
		lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
	});
	const c = merc(ORIGIN.lat, ORIGIN.lon);
	const mPerPx = (40_075_016.7 * Math.cos((ORIGIN.lat * Math.PI) / 180)) / n;
	const half = Math.ceil(R / mPerPx) + 2;
	const x0 = Math.floor(c.x - half);
	const y0 = Math.floor(c.y - half);
	const G = half * 2;
	const tiles = new Map<string, Float32Array | undefined>();
	for (let ty = Math.floor(y0 / T); ty <= Math.floor((y0 + G) / T); ty++)
		for (let tx = Math.floor(x0 / T); tx <= Math.floor((x0 + G) / T); tx++)
			tiles.set(`${tx}/${ty}`, await load({ z: Z, x: tx, y: ty }));
	const grid = new Float64Array(G * G);
	for (let j = 0; j < G; j++)
		for (let i = 0; i < G; i++) {
			const gx = x0 + i + 0.5;
			const gy = y0 + j + 0.5;
			const tx = Math.floor(gx / T);
			const ty = Math.floor(gy / T);
			const h = tiles.get(`${tx}/${ty}`);
			grid[j * G + i] = h
				? h[
						Math.min(T - 1, Math.floor(gy - ty * T)) * T +
							Math.min(T - 1, Math.floor(gx - tx * T))
					]
				: 0;
		}
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const v of grid) {
		lo = Math.min(lo, v);
		hi = Math.max(hi, v);
	}
	const thresholds: number[] = [];
	for (let v = Math.ceil(lo / STEP_M) * STEP_M; v <= hi; v += STEP_M)
		thresholds.push(v);
	const frame = new EnuFrame(ORIGIN.lat, ORIGIN.lon, 0);
	const out = [0, 0, 0];
	const xy: number[] = [];
	const start = [0];
	const level: number[] = [];
	const index: number[] = [];
	const push = (line: number[], lv: number) => {
		const keep = simplify(line, TOL);
		if (keep.length < 2) return;
		for (let s = 0; s < keep.length - 1; s += CHUNK - 1) {
			const part = keep.slice(s, s + CHUNK);
			if (part.length < 2) break;
			for (const k of part) xy.push(line[k * 2], line[k * 2 + 1]);
			start.push(xy.length / 2);
			level.push(lv);
			index.push(lv % INDEX_M === 0 ? 1 : 0);
		}
	};
	for (const mp of contours().size([G, G]).thresholds(thresholds)(
		Array.from(grid),
	)) {
		const lv = mp.value;
		const isIndex = lv % INDEX_M === 0;
		for (const poly of mp.coordinates)
			for (const ring of poly) {
				let line: number[] = [];
				for (const [gx, gy] of ring) {
					const g = unmerc(x0 + gx, y0 + gy);
					frame.fromGeo(g.lat, g.lon, lv, out);
					const r = Math.hypot(out[0], out[1]);
					if (r > R || (!isIndex && r > NEAR_R)) {
						if (line.length >= 4) push(line, lv);
						line = [];
						continue;
					}
					line.push(Math.round(out[0]), Math.round(out[1]));
				}
				if (line.length >= 4) push(line, lv);
			}
	}
	write(
		"live3d-lines.bin",
		encodeBlob(
			{
				kind: "contours",
				origin: ORIGIN,
				step: STEP_M,
				index: INDEX_M,
				// aerial perspective: full strength to 2.5 km from the camera, gone by 14 km
				fade: [2500, 14_000],
			},
			{
				xy: new Int16Array(xy),
				start: new Uint32Array(start),
				level: new Int16Array(level),
				index: new Uint8Array(index),
			},
		),
	);
	console.log(
		`  ${level.length} strokes, ${xy.length / 2} points, ${thresholds.length} levels ${thresholds[0]}–${thresholds.at(-1)} m, grid ${G}² at ${mPerPx.toFixed(0)} m`,
	);
}

/** Douglas–Peucker over (x, y) pairs; the kept point indices. */
function simplify(p: number[], tol: number): number[] {
	const n = p.length / 2;
	if (n < 3) return Array.from({ length: n }, (_, i) => i);
	const keep = new Uint8Array(n);
	keep[0] = keep[n - 1] = 1;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [i, j] = stack.pop() as [number, number];
		const dx = p[j * 2] - p[i * 2];
		const dy = p[j * 2 + 1] - p[i * 2 + 1];
		const len = Math.hypot(dx, dy);
		let best = -1;
		let bi = -1;
		for (let k = i + 1; k < j; k++) {
			const ex = p[k * 2] - p[i * 2];
			const ey = p[k * 2 + 1] - p[i * 2 + 1];
			const d = len ? Math.abs(dy * ex - dx * ey) / len : Math.hypot(ex, ey);
			if (d > best) {
				best = d;
				bi = k;
			}
		}
		if (best > tol) {
			keep[bi] = 1;
			stack.push([i, bi], [bi, j]);
		}
	}
	const out: number[] = [];
	for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
	return out;
}

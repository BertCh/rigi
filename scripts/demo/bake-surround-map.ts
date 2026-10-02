// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Bakes the terrain around the landing page's topo board ("03 · Map") as a plan: Mapterhorn contours
 * in the panorama's ink (paper lines, index contours heavier; shipped as a grey coverage mask) at the board's own
 * scale and centre (z14 web-mercator pixels about the photos' centroid, src/components/site/TopoBoard.tsx),
 * so the map's ground carries on past its edges. The board covers the middle; the page moves the
 * layer with the board's pan.
 *
 *   npx tsx scripts/demo/bake-surround-map.ts
 *
 * Writes public/demo/surround/map.webp and src/components/site/surround/map.json (then run
 * `npx biome check --write` on the JSON). Tiles come from the .cache/dem-mapterhorn disk cache.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { contours } from "d3-contour";
import { MAPTERHORN } from "../../src/lib/dem";
import { demTileLoaderNode, ROOT } from "../lib/node-io";

/** The board's zoom: 1 CSS px = 1 z14 pixel of 256-px tiles (TopoBoard's Z and TILE). */
const Z = 14;
/** Layer size (CSS px), centred on the board: covers a 1088 × 640 board on a wide window. */
const CSS_W = 2400;
const CSS_H = 1000;
/** The board's usual size, for keeping peak names off it. */
const BOARD = { w: 1088, h: 640 };
/** The part every board covers (md and up), left empty to save bytes. */
const HOLE = { w: 760, h: 440 };
const SCALE = 1.25;
const STEP_M = 20;
const INDEX_M = 100;
/** Stroke alphas are drawn in white; the page tints them paper. */
const PAPER = "255,255,255";
const LABEL_FONT = 6.3;

type Manifest = {
	photos: { lat: number; lon: number }[];
	region: {
		peaks: {
			name: string;
			lat: number;
			lon: number;
			ele: number;
			prominence?: number | null;
		}[];
	};
};

const worldPx = (lat: number, lon: number, z: number, tile: number) => {
	const n = tile * 2 ** z;
	const s = Math.sin((lat * Math.PI) / 180);
	return {
		x: ((lon + 180) / 360) * n,
		y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
	};
};
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

const manifest = JSON.parse(
	fs.readFileSync(path.join(ROOT, "public", "demo", "manifest.json"), "utf8"),
) as Manifest;
const ps = manifest.photos;
const lat = ps.reduce((s, p) => s + p.lat, 0) / ps.length;
const lon = ps.reduce((s, p) => s + p.lon, 0) / ps.length;
const c = worldPx(lat, lon, Z, 256);
const x0 = c.x - CSS_W / 2;
const y0 = c.y - CSS_H / 2;

// heights on the board's pixel grid: z14 @ 256 px = Mapterhorn z13 @ 512 px, one sample per pixel
const T = MAPTERHORN.tileSize;
const tz = Z - Math.log2(T / 256);
const load = demTileLoaderNode(MAPTERHORN);
const tiles = new Map<string, Float32Array | undefined>();
for (let ty = Math.floor(y0 / T); ty <= Math.floor((y0 + CSS_H) / T); ty++)
	for (let tx = Math.floor(x0 / T); tx <= Math.floor((x0 + CSS_W) / T); tx++)
		tiles.set(`${tx}/${ty}`, await load({ z: tz, x: tx, y: ty }));
const grid = new Float64Array(CSS_W * CSS_H);
for (let j = 0; j < CSS_H; j++)
	for (let i = 0; i < CSS_W; i++) {
		const gx = x0 + i;
		const gy = y0 + j;
		const tx = Math.floor(gx / T);
		const ty = Math.floor(gy / T);
		const h = tiles.get(`${tx}/${ty}`);
		const px = Math.min(T - 1, Math.floor(gx - tx * T));
		const py = Math.min(T - 1, Math.floor(gy - ty * T));
		grid[j * CSS_W + i] = h ? h[py * T + px] : 0;
	}
// a light box blur (two passes, radius 2): DEM noise otherwise turns every contour into a sawtooth,
// which reads as dirt at this scale and costs bytes
for (let pass = 0; pass < 2; pass++) {
	const tmp = new Float64Array(grid.length);
	const R = 2;
	for (let j = 0; j < CSS_H; j++)
		for (let i = 0; i < CSS_W; i++) {
			let sum = 0;
			let n = 0;
			for (let k = -R; k <= R; k++) {
				const ii = i + k;
				if (ii >= 0 && ii < CSS_W) {
					sum += grid[j * CSS_W + ii];
					n++;
				}
			}
			tmp[j * CSS_W + i] = sum / n;
		}
	for (let j = 0; j < CSS_H; j++)
		for (let i = 0; i < CSS_W; i++) {
			let sum = 0;
			let n = 0;
			for (let k = -R; k <= R; k++) {
				const jj = j + k;
				if (jj >= 0 && jj < CSS_H) {
					sum += tmp[jj * CSS_W + i];
					n++;
				}
			}
			grid[j * CSS_W + i] = sum / n;
		}
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

const W = Math.round(CSS_W * SCALE);
const H = Math.round(CSS_H * SCALE);
const cv = createCanvas(W, H);
const g = cv.getContext("2d");
g.lineJoin = "round";
g.lineCap = "round";
g.scale(SCALE, SCALE);
const gen = contours().size([CSS_W, CSS_H]).smooth(true).thresholds(thresholds);
const minor = new Path2D();
const major = new Path2D();
for (const m of gen(Array.from(grid))) {
	const path = m.value % INDEX_M === 0 ? major : minor;
	for (const poly of m.coordinates)
		for (const ring of poly) {
			// d3 closes rings along the grid's border: skip those edge runs
			let pen = false;
			for (const [x, y] of ring) {
				const edge =
					x <= 0.5 || y <= 0.5 || x >= CSS_W - 0.5 || y >= CSS_H - 0.5;
				if (edge) {
					pen = false;
					continue;
				}
				if (pen) path.lineTo(x, y);
				else path.moveTo(x, y);
				pen = true;
			}
		}
}
g.strokeStyle = `rgba(${PAPER},0.16)`;
g.lineWidth = 0.6;
g.stroke(minor);
g.strokeStyle = `rgba(${PAPER},0.42)`;
g.lineWidth = 1.1;
g.stroke(major);
// the board hides the middle: leave it empty (narrower than the usual board, so a smaller window's
// board still has terrain right up to its edges)
g.clearRect((CSS_W - HOLE.w) / 2, (CSS_H - HOLE.h) / 2, HOLE.w, HOLE.h);

// peak names off the board, best first, never overlapping
const peaks = [...manifest.region.peaks].sort(
	(a, b) => (b.prominence ?? 0) - (a.prominence ?? 0) || b.ele - a.ele,
);
const placed: { x0: number; x1: number; y: number }[] = [];
const labels: {
	name: string;
	ele: number;
	km: number;
	x: number;
	y: number;
}[] = [];
for (const p of peaks) {
	if (labels.length >= 12) break;
	const w = worldPx(p.lat, p.lon, Z, 256);
	const x = w.x - x0;
	const y = w.y - y0;
	if (x < 8 || y < 48 || x > CSS_W - 8 || y > CSS_H - 8) continue;
	const tw = Math.max(p.name.length * LABEL_FONT, 84) + 12;
	const bx0 = (CSS_W - BOARD.w) / 2;
	const by0 = (CSS_H - BOARD.h) / 2;
	const onBoard =
		x + tw > bx0 - 8 &&
		x < bx0 + BOARD.w + 8 &&
		y > by0 - 8 &&
		y - 44 < by0 + BOARD.h + 8;
	// names sit 44 px above their summits: none above the board's top (the section heading is there)
	if (onBoard || y - 44 < by0 || x + tw > CSS_W - 8) continue;
	if (
		placed.some((q) => x < q.x1 + 6 && q.x0 < x + tw && Math.abs(q.y - y) < 48)
	)
		continue;
	placed.push({ x0: x, x1: x + tw, y });
	const d =
		Math.hypot((w.x - c.x) * 1, (w.y - c.y) * 1) *
		((156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** Z);
	labels.push({
		name: p.name,
		ele: Math.round(p.ele),
		km: Math.round(d / 100) / 10,
		x: r4(x / CSS_W),
		y: r4(y / CSS_H),
	});
}

const img = path.join(ROOT, "public", "demo", "surround", "map.webp");
fs.mkdirSync(path.dirname(img), { recursive: true });
// one ink, so ship coverage only: a grey WebP the page uses as a luminance mask over a paper fill
// (~¼ the bytes of the same strokes as RGBA)
const px = g.getImageData(0, 0, W, H);
for (let k = 0; k < px.data.length; k += 4) {
	const a = px.data[k + 3];
	px.data[k] = px.data[k + 1] = px.data[k + 2] = a;
	px.data[k + 3] = 255;
}
const grey = createCanvas(W, H);
grey.getContext("2d").putImageData(px, 0, 0);
fs.writeFileSync(img, await grey.encode("webp", 75));
fs.writeFileSync(
	path.join(ROOT, "src", "components", "site", "surround", "map.json"),
	`${JSON.stringify({
		id: "map",
		src: "/demo/surround/map.webp",
		width: W,
		height: H,
		// centred on the board at a fixed CSS size; the board covers the middle
		fixed: { w: CSS_W, h: CSS_H },
		/** `src` is coverage (grey = alpha) for a paper fill, not a colour image. */
		mask: true,
		photo: {
			x: r4((CSS_W - BOARD.w) / 2 / CSS_W),
			y: r4((CSS_H - BOARD.h) / 2 / CSS_H),
			w: r4(BOARD.w / CSS_W),
			h: r4(BOARD.h / CSS_H),
		},
		ruler: 0,
		ticks: [],
		peaks: labels,
	})}\n`,
);
console.log(
	`map: ${W}×${H}, ${thresholds.length} levels (${lo.toFixed(0)}–${hi.toFixed(0)} m), ${labels.length} labels, ${(fs.statSync(img).size / 1024).toFixed(0)} kB`,
);

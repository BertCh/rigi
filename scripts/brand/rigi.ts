// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Brand data for Rigi, precomputed from the Mapterhorn DEM and OSM peaks.
 *
 *   npx tsx scripts/brand/rigi.ts [--preview]
 *
 * Writes public/brand/rigi-panorama.json: the view south from Rigi Kulm as
 * depth-layered ridgelines. Each distance slab contributes the parts of its
 * top edge that no nearer slab hides, so slopes read as range contours and
 * true ridges (terrain drops away behind) are flagged for a heavier stroke.
 * Also writes src/brand/rigi-mark.json (summit contours, imported by the logo) and
 * public/favicon.svg. --preview renders PNGs to BRAND_OUT for review.
 */
import fs from "node:fs";
import path from "node:path";
import { contours } from "d3-contour";
import { BRAND, brandAlpha } from "../../src/brand/khipu";
import {
	latToTileY,
	lonToTileX,
	MAPTERHORN,
	type TileKey,
	tileId,
} from "../../src/lib/dem";
import { simplifyPointIndices } from "../../src/lib/geo/simplify";
import { fileHeights } from "../lib/node-io";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT = process.env.BRAND_OUT ?? path.join(ROOT, ".cache", "brand");
const TILES = path.join(OUT, "tiles");
const PUBLIC = path.join(ROOT, "public", "brand");

const DEG = Math.PI / 180;
const R = 6_371_000;
const K_REFRACTION = 0.13;

/** Rigi Kulm trig point (swisstopo 1797.5 m); eye 2 m above ground. */
const KULM = { lat: 47.05668, lon: 8.48525, ele: 1797.5 };
const VIEW = {
	az0: 118, // Glarus Alps …
	az1: 258, // … to Pilatus
	colStep: 0.05, // degrees per column
	dMin: 250,
	dMax: 160_000,
	slabs: 72,
	elMin: -6.5, // crop: nearer slopes below this are dropped
	elMax: 3.4,
};

// ─── DEM ─────────────────────────────────────────────────────────────────────

const tileCache = new Map<string, Float32Array | null>();
const pending = new Map<string, Promise<Float32Array | null>>();

async function tile(k: TileKey) {
	const id = tileId(k);
	const cached = tileCache.get(id);
	if (cached) return cached;
	if (!pending.has(id))
		pending.set(
			id,
			(async () => {
				const file = path.join(TILES, `${id}.webp`);
				if (!fs.existsSync(file)) {
					const res = await fetch(MAPTERHORN.url(k));
					if (!res.ok) return null;
					fs.mkdirSync(path.dirname(file), { recursive: true });
					fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
				}
				const h = await fileHeights(file, 512);
				tileCache.set(id, h);
				return h;
			})(),
		);
	const inflight = pending.get(id);
	// invariant: set just above when missing
	if (!inflight) throw new Error(`tile ${id} not pending`);
	return inflight;
}

/** Synchronous bilinear sample; tiles must be preloaded with `preload`. */
function height(lat: number, lon: number, z: number) {
	const fx = lonToTileX(lon, z);
	const fy = latToTileY(lat, z);
	const tx = Math.floor(fx);
	const ty = Math.floor(fy);
	const h = tileCache.get(tileId({ z, x: tx, y: ty }));
	if (!h) return Number.NaN;
	const px = Math.min(510.999, Math.max(0, (fx - tx) * 512 - 0.5));
	const py = Math.min(510.999, Math.max(0, (fy - ty) * 512 - 0.5));
	const x0 = Math.floor(px);
	const y0 = Math.floor(py);
	const ax = px - x0;
	const ay = py - y0;
	const i = y0 * 512 + x0;
	return (
		(h[i] * (1 - ax) + h[i + 1] * ax) * (1 - ay) +
		(h[i + 512] * (1 - ax) + h[i + 513] * ax) * ay
	);
}

/** Zoom used at distance d: finer near the summit, coarser for the far Alps. */
const zoomAt = (d: number) =>
	d < 6_000 ? 13 : d < 25_000 ? 12 : d < 70_000 ? 11 : 10;

function destination(lat: number, lon: number, az: number, d: number) {
	const φ1 = lat * DEG;
	const λ1 = lon * DEG;
	const θ = az * DEG;
	const δ = d / R;
	const φ2 = Math.asin(
		Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
	);
	const λ2 =
		λ1 +
		Math.atan2(
			Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
			Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
		);
	return [φ2 / DEG, λ2 / DEG] as const;
}

function* rayDistances() {
	for (let d = VIEW.dMin; d < VIEW.dMax; d += Math.max(12, d * 0.0025)) yield d;
}

async function preload() {
	const need = new Set<string>();
	const keys: TileKey[] = [];
	for (let az = VIEW.az0 - 1; az <= VIEW.az1 + 1; az += 0.25)
		for (const d of rayDistances()) {
			const [lat, lon] = destination(KULM.lat, KULM.lon, az, d);
			const z = zoomAt(d);
			const k = {
				z,
				x: Math.floor(lonToTileX(lon, z)),
				y: Math.floor(latToTileY(lat, z)),
			};
			const id = tileId(k);
			if (!need.has(id)) {
				need.add(id);
				keys.push(k);
			}
		}
	console.log(`panorama: ${keys.length} tiles`);
	for (let i = 0; i < keys.length; i += 8)
		await Promise.all(keys.slice(i, i + 8).map(tile));
}

// ─── Panorama ────────────────────────────────────────────────────────────────

const slabEdge = (i: number) =>
	VIEW.dMin * (VIEW.dMax / VIEW.dMin) ** (i / VIEW.slabs);

function elevationAngle(h: number, d: number, eye: number) {
	const drop = ((d * d) / (2 * R)) * (1 - K_REFRACTION);
	return Math.atan2(h - drop - eye, d) / DEG;
}

function trace() {
	const eye = height(KULM.lat, KULM.lon, 13) + 2;
	const cols = Math.round((VIEW.az1 - VIEW.az0) / VIEW.colStep) + 1;
	const top = Array.from({ length: VIEW.slabs }, () =>
		new Float32Array(cols).fill(Number.NEGATIVE_INFINITY),
	);
	const edges = Array.from({ length: VIEW.slabs + 1 }, (_, i) => slabEdge(i));
	for (let c = 0; c < cols; c++) {
		const az = VIEW.az0 + c * VIEW.colStep;
		let s = 0;
		for (const d of rayDistances()) {
			while (d >= edges[s + 1]) s++;
			const [lat, lon] = destination(KULM.lat, KULM.lon, az, d);
			const h = height(lat, lon, zoomAt(d));
			if (Number.isNaN(h)) continue;
			const a = elevationAngle(h, d, eye);
			if (a > top[s][c]) top[s][c] = a;
		}
	}
	return { eye, cols, top };
}

type Pt = [number, number];
type Stroke = { s: number; ridge: boolean; pts: Pt[] };

/** Visible, classified runs of each slab's top edge (az, el in degrees). */
function strokes(top: Float32Array[], cols: number) {
	const out: Stroke[] = [];
	const nearer = new Float32Array(cols).fill(Number.NEGATIVE_INFINITY);
	const EPS = 0.004; // degrees: a slab edge must clear everything nearer by this much
	for (let s = 0; s < top.length; s++) {
		const t = top[s];
		let run: Stroke | null = null;
		for (let c = 0; c < cols; c++) {
			const a = t[c];
			const visible = a > nearer[c] + EPS && a > VIEW.elMin;
			// Ridge: the next few slabs sit lower here, so the ground falls away behind this edge.
			let behind = Number.NEGATIVE_INFINITY;
			for (let j = s + 1; j < Math.min(top.length, s + 4); j++)
				behind = Math.max(behind, top[j][c]);
			const ridge = behind < a - 0.01;
			if (!visible || (run && run.ridge !== ridge)) {
				if (run && visible) run.pts.push([VIEW.az0 + c * VIEW.colStep, a]); // join the class change
				if (run && run.pts.length > 1) out.push(run);
				run = null;
			}
			if (visible) {
				run ??= { s, ridge, pts: [] };
				run.pts.push([VIEW.az0 + c * VIEW.colStep, a]);
			}
		}
		if (run && run.pts.length > 1) out.push(run);
		for (let c = 0; c < cols; c++) nearer[c] = Math.max(nearer[c], t[c]);
	}
	return { strokes: out, skyline: nearer };
}

/** Douglas–Peucker in (az, el) degrees. */
function simplify(pts: Pt[], tol: number): Pt[] {
	const keep = new Set(simplifyPointIndices(pts, tol));
	return pts.filter((_, i) => keep.has(i));
}

// ─── Peaks ───────────────────────────────────────────────────────────────────

type Peak = { name: string; ele: number; lat: number; lon: number };

async function osmPeaks(): Promise<Peak[]> {
	const file = path.join(OUT, "peaks.json");
	if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
	const q = `[out:json][timeout:60];node["natural"="peak"]["name"]["ele"](45.9,7.4,47.1,9.5);out;`;
	const mirrors = [
		"https://overpass-api.de/api/interpreter",
		"https://overpass.kumi.systems/api/interpreter",
		"https://overpass.private.coffee/api/interpreter",
	];
	let res: Response | undefined;
	for (const url of [...mirrors, ...mirrors]) {
		res = await fetch(url, {
			method: "POST",
			body: new URLSearchParams({ data: q }),
			headers: { "User-Agent": "rigi-brand/1.0" },
		}).catch(() => undefined);
		if (res?.ok) break;
		console.warn(`overpass ${url}: ${res?.status ?? "network error"}`);
	}
	if (!res?.ok) throw new Error("overpass: all mirrors failed");
	const json = (await res.json()) as {
		elements: { lat: number; lon: number; tags: Record<string, string> }[];
	};
	const peaks = json.elements
		.map((e) => ({
			name: e.tags["name:de"] ?? e.tags.name,
			ele: Number.parseFloat(e.tags.ele),
			lat: e.lat,
			lon: e.lon,
		}))
		.filter((p) => Number.isFinite(p.ele));
	fs.mkdirSync(OUT, { recursive: true });
	fs.writeFileSync(file, JSON.stringify(peaks));
	return peaks;
}

function bearing(lat1: number, lon1: number, lat2: number, lon2: number) {
	const φ1 = lat1 * DEG;
	const φ2 = lat2 * DEG;
	const Δλ = (lon2 - lon1) * DEG;
	const y = Math.sin(Δλ) * Math.cos(φ2);
	const x =
		Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
	return (((Math.atan2(y, x) / DEG) % 360) + 360) % 360;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
	const a =
		Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 +
		Math.cos(lat1 * DEG) *
			Math.cos(lat2 * DEG) *
			Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

/** Pilatus' highest summit is Tomlishorn; label the massif. */
const DISPLAY: Record<string, string> = { Tomlishorn: "Pilatus" };

const LANDMARKS = [
	"Tomlishorn",
	"Titlis",
	"Jungfrau",
	"Eiger",
	"Mönch",
	"Finsteraarhorn",
	"Tödi",
	"Urirotstock",
	"Uri-Rotstock",
	"Schreckhorn",
	"Wetterhorn",
	"Dammastock",
	"Bristen",
	"Glärnisch",
	"Sustenhorn",
	"Stanserhorn",
	"Brienzer Rothorn",
	"Oberalpstock",
];

/** Peaks on the skyline or clear of nearer terrain, greedily spaced by rank. */
function visiblePeaks(peaks: Peak[], top: Float32Array[], eye: number) {
	const cand = [];
	for (const p of peaks) {
		const d = haversine(KULM.lat, KULM.lon, p.lat, p.lon);
		const az = bearing(KULM.lat, KULM.lon, p.lat, p.lon);
		if (d < 3_000 || d > VIEW.dMax || az < VIEW.az0 + 1 || az > VIEW.az1 - 1)
			continue;
		const c = Math.round((az - VIEW.az0) / VIEW.colStep);
		// DEM summit near the OSM node (nodes are often a few pixels off the true top).
		let h = Number.NEGATIVE_INFINITY;
		const z = zoomAt(d);
		for (let dy = -60; dy <= 60; dy += 20)
			for (let dx = -60; dx <= 60; dx += 20) {
				const [la, lo] = destination(p.lat, p.lon, 0, dy);
				const [la2, lo2] = destination(la, lo, 90, dx);
				h = Math.max(h, height(la2, lo2, z));
			}
		const el = elevationAngle(Math.max(h, p.ele), d, eye);
		let nearer = Number.NEGATIVE_INFINITY;
		for (let s = 0; s < top.length && slabEdge(s + 1) < d * 0.97; s++)
			for (let dc = -1; dc <= 1; dc++)
				nearer = Math.max(nearer, top[s][c + dc] ?? nearer);
		if (el < nearer + 0.02 || el < VIEW.elMin) continue;
		cand.push({
			name: DISPLAY[p.name] ?? p.name,
			ele: Math.round(p.ele),
			az: +az.toFixed(3),
			el: +el.toFixed(3),
			d: Math.round(d),
		});
	}
	// Rank: the landmarks of the Rigi panorama first, then by height.
	const rank = (p: { name: string; ele: number }) => {
		const i = LANDMARKS.findIndex((n) => (DISPLAY[n] ?? n) === p.name);
		return i >= 0 ? -10_000 + i : -p.ele;
	};
	cand.sort((a, b) => rank(a) - rank(b));
	const picked: typeof cand = [];
	for (const p of cand) {
		if (picked.length >= 16) break;
		if (picked.some((q) => Math.abs(q.az - p.az) < 3.4)) continue;
		if (/\d|Vorgipfel|Pt\.|Punkt/.test(p.name)) continue;
		picked.push(p);
	}
	return picked.map((p, rank) => ({ ...p, rank })).sort((a, b) => a.az - b.az);
}

// ─── Mark: summit contours ───────────────────────────────────────────────────

async function mark() {
	const z = 14;
	const half = 1_250; // metres around Kulm
	const [n] = destination(KULM.lat, KULM.lon, 0, half);
	const [s] = destination(KULM.lat, KULM.lon, 180, half);
	const [, e] = destination(KULM.lat, KULM.lon, 90, half);
	const [, w] = destination(KULM.lat, KULM.lon, 270, half);
	const keys: TileKey[] = [];
	for (
		let x = Math.floor(lonToTileX(w, z));
		x <= Math.floor(lonToTileX(e, z));
		x++
	)
		for (
			let y = Math.floor(latToTileY(n, z));
			y <= Math.floor(latToTileY(s, z));
			y++
		)
			keys.push({ z, x, y });
	await Promise.all(keys.map(tile));
	const N = 160;
	const grid = new Float64Array(N * N);
	for (let j = 0; j < N; j++)
		for (let i = 0; i < N; i++) {
			const lat = n + ((s - n) * j) / (N - 1);
			const lon = w + ((e - w) * i) / (N - 1);
			grid[j * N + i] = height(lat, lon, z);
		}
	blur(grid, N, 2.5);
	const levels = [];
	for (let h = 1_550; h <= 1_780; h += 38) levels.push(h);
	const rings = contours().size([N, N]).smooth(true).thresholds(levels)(
		Array.from(grid),
	);
	const inside = (ring: Pt[]) =>
		ring.every(([x, y]) => x > 1 && y > 1 && x < N - 1 && y < N - 1);
	const out = {
		size: N,
		levels,
		paths: rings.map((r) => ({
			level: r.value,
			d: r.coordinates
				.flatMap((poly) => poly.map((ring) => simplify(ring as Pt[], 0.35)))
				.filter((ring) => ring.length > 4 && inside(ring))
				.map(
					(ring) =>
						`M${ring.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}Z`,
				)
				.join(""),
		})),
	};
	return { ...out, box: markBox(out) };
}

/** Separable Gaussian blur in place: the mark wants the landform, not every gully. */
function blur(g: Float64Array, n: number, sigma: number) {
	const r = Math.ceil(sigma * 3);
	const k = Array.from({ length: 2 * r + 1 }, (_, i) =>
		Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)),
	);
	const tmp = new Float64Array(g.length);
	for (const [a, b, horizontal] of [
		[g, tmp, true],
		[tmp, g, false],
	] as const)
		for (let j = 0; j < n; j++)
			for (let i = 0; i < n; i++) {
				let sum = 0;
				let w = 0;
				for (let o = -r; o <= r; o++) {
					const x = horizontal ? i + o : i;
					const y = horizontal ? j : j + o;
					if (x < 0 || y < 0 || x >= n || y >= n) continue;
					sum += a[y * n + x] * k[o + r];
					w += k[o + r];
				}
				b[j * n + i] = sum / w;
			}
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	fs.mkdirSync(PUBLIC, { recursive: true });
	await preload();
	console.time("trace");
	const { eye, cols, top } = trace();
	console.timeEnd("trace");
	const { strokes: runs, skyline } = strokes(top, cols);
	const peaks = visiblePeaks(await osmPeaks(), top, eye);
	const layers = runs
		.map((r) => ({ ...r, pts: simplify(r.pts, 0.012) }))
		.filter(
			(r) =>
				r.pts.length > 1 &&
				Math.abs((r.pts.at(-1) as [number, number])[0] - r.pts[0][0]) > 0.15,
		);
	const q = (v: number) => Math.round(v * 1000); // millidegrees
	const panorama = {
		source: "Mapterhorn DEM (swissALTI3D / Copernicus), OSM peaks",
		viewpoint: {
			name: "Rigi Kulm",
			lat: KULM.lat,
			lon: KULM.lon,
			ele: KULM.ele,
			eye: Math.round(eye),
		},
		view: {
			az0: VIEW.az0,
			az1: VIEW.az1,
			elMin: VIEW.elMin,
			elMax: VIEW.elMax,
		},
		slabs: Array.from({ length: VIEW.slabs + 1 }, (_, i) =>
			Math.round(slabEdge(i)),
		),
		unit: "millidegrees; each stroke is [slab, ridge?1:0, x0, y0, dx, dy, …]",
		strokes: layers.map((r) => {
			const flat = [r.s, r.ridge ? 1 : 0, q(r.pts[0][0]), q(r.pts[0][1])];
			for (let i = 1; i < r.pts.length; i++)
				flat.push(
					q(r.pts[i][0]) - q(r.pts[i - 1][0]),
					q(r.pts[i][1]) - q(r.pts[i - 1][1]),
				);
			return flat;
		}),
		skyline: simplify(
			Array.from(skyline, (a, c) => [VIEW.az0 + c * VIEW.colStep, a] as Pt),
			0.01,
		).map(([x, y]) => [q(x), q(y)]),
		peaks,
	};
	const json = JSON.stringify(panorama);
	fs.writeFileSync(path.join(PUBLIC, "rigi-panorama.json"), json);
	console.log(
		`panorama: ${layers.length} strokes, ${layers.reduce((n, r) => n + r.pts.length, 0)} pts, ${(json.length / 1024).toFixed(0)} KB, ${peaks.length} peaks`,
	);
	console.log(
		peaks
			.map(
				(p) =>
					`${p.name} ${p.ele} @${p.az.toFixed(1)}° ${(p.d / 1000).toFixed(0)} km`,
			)
			.join("\n"),
	);

	const m = await mark();
	fs.mkdirSync(path.join(ROOT, "src", "brand"), { recursive: true });
	fs.writeFileSync(
		path.join(ROOT, "src", "brand", "rigi-mark.json"),
		JSON.stringify(m),
	);
	fs.writeFileSync(
		path.join(ROOT, "public", "favicon.svg"),
		markSvg(m, { stroke: BRAND.paper, bg: BRAND.ink }),
	);
	console.log(`mark: ${m.paths.length} levels`);

	if (process.argv.includes("--preview")) await preview(panorama, m);
}

/** Square box around the drawn rings (grid units), for a mark that fills its frame. */
function markBox(m: { paths: { d: string }[] }) {
	const nums = m.paths.flatMap(
		(p) => p.d.match(/-?[\d.]+/g)?.map(Number) ?? [],
	);
	const xs = nums.filter((_, i) => i % 2 === 0);
	const ys = nums.filter((_, i) => i % 2 === 1);
	const [x0, x1, y0, y1] = [
		Math.min(...xs),
		Math.max(...xs),
		Math.min(...ys),
		Math.max(...ys),
	];
	const side = Math.max(x1 - x0, y1 - y0) * 1.16;
	return [(x0 + x1 - side) / 2, (y0 + y1 - side) / 2, side].map(
		(v) => +v.toFixed(1),
	);
}

function markSvg(
	m: Awaited<ReturnType<typeof mark>>,
	c: { stroke: string; bg?: string },
) {
	const [x, y, side] = markBox(m);
	const sw = side / 64;
	const body = m.paths
		.map(
			(p, i) =>
				`<path d="${p.d}" fill="none" stroke="${c.stroke}" stroke-linejoin="round" stroke-width="${(i === m.paths.length - 1 ? 2.2 : 1.2) * sw}" stroke-opacity="${(0.5 + (0.5 * i) / (m.paths.length - 1)).toFixed(2)}"/>`,
		)
		.join("");
	const bg = c.bg
		? `<rect x="${x}" y="${y}" width="${side}" height="${side}" rx="${side * 0.22}" fill="${c.bg}"/>`
		: "";
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${side} ${side}">${bg}${body}</svg>`;
}

async function preview(
	p: {
		strokes: number[][];
		view:
			| typeof VIEW
			| { az0: number; az1: number; elMin: number; elMax: number };
		peaks: { name: string; az: number; el: number; ele: number }[];
	},
	m: Awaited<ReturnType<typeof mark>>,
) {
	const { createCanvas } = await import("@napi-rs/canvas");
	const W = 2800;
	const sx = W / (p.view.az1 - p.view.az0);
	const H = Math.round((p.view.elMax - p.view.elMin) * sx * 2.2);
	const c = createCanvas(W, H);
	const g = c.getContext("2d");
	g.fillStyle = BRAND.paper;
	g.fillRect(0, 0, W, H);
	const X = (az: number) => (az - p.view.az0) * sx;
	const Y = (el: number) => (p.view.elMax - el) * sx * 2.2;
	for (const st of p.strokes) {
		const [s, ridge] = st;
		let x = st[2] / 1000;
		let y = st[3] / 1000;
		const t = s / VIEW.slabs;
		g.strokeStyle = brandAlpha("ink", (ridge ? 0.95 : 0.5) * (1 - 0.75 * t));
		g.lineWidth = ridge ? 2.2 - t : 1;
		g.beginPath();
		g.moveTo(X(x), Y(y));
		for (let i = 4; i < st.length; i += 2) {
			x += st[i] / 1000;
			y += st[i + 1] / 1000;
			g.lineTo(X(x), Y(y));
		}
		g.stroke();
	}
	g.fillStyle = BRAND.ink;
	g.font = "20px sans-serif";
	for (const pk of p.peaks) {
		g.fillRect(X(pk.az), Y(pk.el) - 40, 1, 30);
		g.fillText(`${pk.name} ${pk.ele}`, X(pk.az) + 4, Y(pk.el) - 30);
	}
	fs.writeFileSync(path.join(OUT, "panorama.png"), c.toBuffer("image/png"));
	fs.writeFileSync(
		path.join(OUT, "mark.svg"),
		markSvg(m, { stroke: BRAND.ink, bg: BRAND.paper }),
	);
	console.log(`preview → ${OUT}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

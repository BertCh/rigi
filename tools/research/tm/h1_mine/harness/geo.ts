// H1 copy of tools/bench/harness/lib/geo.ts: imports made absolute, CACHE redirected (see line ~37). Otherwise unchanged.
/**
 * Node geo helpers for the harness (import-only use of 0f's src/lib/geo + scripts/lib).
 *
 * DEM: **Mapterhorn** (https://tiles.mapterhorn.com/{z}/{x}/{y}.webp, Terrarium-encoded, 512 px), the
 * DEM the app and the fused service render. Terrarium/AWS is never used. Zoom per distance band,
 * ring-limited (a coarse level only loads tiles its band can sample): z16 ≤ 0.8 km, z15 ≤ 2 km,
 * z14 ≤ 6.6 km, z13 ≤ 13 km, z12 ≤ 26 km, z11 ≤ 53 km, z10 ≤ 150 km (the app's LOD rule, lod 2 × tile
 * size, from z14 out, plus two finer near bands). A 404 falls back to the parent tile (upsampled
 * quadrant). Disk cache: out/cache/mapterhorn (gitignored), LRU-trimmed to ~1 GB.
 */
import fs from "node:fs";
import path from "node:path";
import { fileHeights } from "../../../../../scripts/lib/node-io";
import { eyeHeight } from "../../../../../scripts/lib/pipeline-node";
import {
	lonLatToTile,
	MAPTERHORN,
	type TerrainLevel,
	type TileKey,
	tileId,
} from "../../../../../src/lib/dem";
import {
	computeHorizon,
	type HorizonProfile,
} from "../../../../../src/lib/geo/horizon";
import {
	overpassPeaksQuery,
	type Peak,
	parseOverpassPeaks,
} from "../../../../../src/lib/geo/peaks";
import { TerrainSampler } from "../../../../../src/lib/geo/terrain";
import { distanceBearing, EARTH_R } from "../../../../../src/lib/geodesy";
import { OVERPASS, overpass } from "../../../../../src/lib/overpass";

export const ROOT = path.resolve(import.meta.dirname, "../../../..");
export const HARNESS = path.resolve(import.meta.dirname, "..");
// H1 copy: caches go under tools/research/tm/h1_mine/harness/cache (never into tools/bench/**)
export const CACHE =
	process.env.H1_OVERLAY_CACHE ?? path.join(import.meta.dirname, "cache");
const TILE_DIR =
	process.env.BENCH_MAPTERHORN_DIR ?? path.join(CACHE, "mapterhorn");
const TILE_CAP_BYTES = Number(process.env.BENCH_MAPTERHORN_CAP ?? 4e8);
export const DEM_SOURCE = "mapterhorn";
const TS = 512;
export const LEVELS: TerrainLevel[] = [
	{ z: 16, maxDistance: 800 },
	{ z: 15, maxDistance: 2_000 },
	{ z: 14, maxDistance: 6_600 },
	{ z: 13, maxDistance: 13_000 },
	{ z: 12, maxDistance: 26_000 },
	{ z: 11, maxDistance: 53_000 },
	{ z: 10, maxDistance: 150_000 },
];
/** HARNESS_HORIZON_CACHE=disk also keeps horizons on disk (≈1.7 MB each); default memory only. */
const HORIZON_DISK = process.env.HARNESS_HORIZON_CACHE === "disk";
const horizonMem = new Map<string, HorizonProfile>();
const DEG = Math.PI / 180;

/** Raw tile from disk / network; null on 404 (remembered with a .404 marker). */
async function fetchTile(k: TileKey): Promise<Float32Array | null> {
	const file = path.join(TILE_DIR, `${tileId(k)}.webp`);
	const miss = `${file}.404`;
	if (fs.existsSync(file)) {
		const now = new Date();
		fs.utimesSync(file, now, now);
		return fileHeights(file, TS);
	}
	if (fs.existsSync(miss)) return null;
	let err = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await fetch(MAPTERHORN.url(k), {
				headers: { "User-Agent": UA },
			});
			if (res.status === 404) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(miss, "");
				return null;
			}
			if (res.ok) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
				return fileHeights(file, TS);
			}
			err = `${res.status}`;
		} catch (e) {
			err = String(e);
		}
		await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
	}
	throw new Error(`Mapterhorn ${tileId(k)}: ${err}`);
}

/** Tile, or its parent's upsampled quadrant when the tile is missing (404), recursively. */
async function getTile(k: TileKey, depth = 0): Promise<Float32Array | null> {
	const t = await fetchTile(k);
	if (t || k.z <= 5 || depth > 6) return t;
	const parent = await getTile(
		{ z: k.z - 1, x: k.x >> 1, y: k.y >> 1 },
		depth + 1,
	);
	if (!parent) return null;
	const ox = (k.x & 1) * (TS / 2);
	const oy = (k.y & 1) * (TS / 2);
	const out = new Float32Array(TS * TS);
	for (let y = 0; y < TS; y++) {
		const py = Math.min(TS - 1.001, oy + (y + 0.5) / 2 - 0.5);
		const y0 = Math.max(0, Math.floor(py));
		const fy = py - y0;
		for (let x = 0; x < TS; x++) {
			const px = Math.min(TS - 1.001, ox + (x + 0.5) / 2 - 0.5);
			const x0 = Math.max(0, Math.floor(px));
			const fx = px - x0;
			const a = parent[y0 * TS + x0];
			const b = parent[y0 * TS + x0 + 1];
			const c = parent[(y0 + 1) * TS + x0];
			const d = parent[(y0 + 1) * TS + x0 + 1];
			out[y * TS + x] =
				(a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
		}
	}
	return out;
}

/** Min / max ground distance (m) from (lat, lon) to a tile's rectangle (equirectangular). */
function tileDistance(lat: number, lon: number, k: TileKey) {
	const n = 2 ** k.z;
	const lonOf = (x: number) => (x / n) * 360 - 180;
	const latOf = (y: number) =>
		Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / DEG;
	const w = lonOf(k.x);
	const e = lonOf(k.x + 1);
	const north = latOf(k.y);
	const south = latOf(k.y + 1);
	const mx = Math.cos(lat * DEG) * DEG * EARTH_R;
	const my = DEG * EARTH_R;
	const dx = lon < w ? (w - lon) * mx : lon > e ? (lon - e) * mx : 0;
	const dy =
		lat < south ? (south - lat) * my : lat > north ? (lat - north) * my : 0;
	const far = Math.max(Math.abs(w - lon), Math.abs(e - lon)) * mx;
	const farY = Math.max(Math.abs(north - lat), Math.abs(south - lat)) * my;
	return { min: Math.hypot(dx, dy), max: Math.hypot(far, farY) };
}

const tileCache = new Map<string, Float32Array>();

/** Mapterhorn sampler around (lat, lon): each level loads only tiles its distance band can touch. */
export async function mapterhornAt(
	lat: number,
	lon: number,
): Promise<TerrainSampler> {
	if (tileCache.size > 700) tileCache.clear(); // ≈1 MB per decoded tile
	const keys: TileKey[] = [];
	let inner = 0;
	for (const lv of LEVELS) {
		const n = 2 ** lv.z;
		const span =
			(lv.maxDistance / (EARTH_R * Math.cos(lat * DEG) * DEG)) * (n / 360);
		const c = lonLatToTile(lon, lat, lv.z);
		const margin = ((2 * 40075016) / n / TS) * Math.cos(lat * DEG); // 2 px of this level
		for (
			let x = Math.floor(c.x - span - 1);
			x <= Math.floor(c.x + span + 1);
			x++
		)
			for (
				let y = Math.floor(c.y - span - 1);
				y <= Math.floor(c.y + span + 1);
				y++
			) {
				const k = { z: lv.z, x, y };
				const d = tileDistance(lat, lon, k);
				if (d.min <= lv.maxDistance && d.max >= inner - margin) keys.push(k);
			}
		inner = lv.maxDistance;
	}
	const todo = keys.filter((k) => !tileCache.has(tileId(k)));
	for (let i = 0; i < todo.length; i += 16)
		await Promise.all(
			todo.slice(i, i + 16).map(async (k) => {
				const t = await getTile(k);
				if (t) tileCache.set(tileId(k), t);
			}),
		);
	trimCache();
	return new TerrainSampler(LEVELS, tileCache, TS);
}

let lastTrim = 0;
function trimCache() {
	if (Date.now() - lastTrim < 60_000) return;
	lastTrim = Date.now();
	const files: { f: string; size: number; t: number }[] = [];
	const walk = (d: string) => {
		if (!fs.existsSync(d)) return;
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const f = path.join(d, e.name);
			if (e.isDirectory()) walk(f);
			else if (e.name.endsWith(".webp")) {
				const st = fs.statSync(f);
				files.push({ f, size: st.size, t: st.mtimeMs });
			}
		}
	};
	walk(TILE_DIR);
	let total = files.reduce((s, x) => s + x.size, 0);
	if (total <= TILE_CAP_BYTES) return;
	files.sort((a, b) => a.t - b.t);
	for (const x of files) {
		if (total <= TILE_CAP_BYTES * 0.8) break;
		fs.rmSync(x.f, { force: true });
		total -= x.size;
	}
}

/** The app's eye rule (src/lib/engine.ts): GPS alt ≥ DEM + 1.6 m, else DEM + 1.8 m without GPS alt. */
export function appEye(ground: number, altitude?: number | null) {
	return altitude != null ? Math.max(altitude, ground + 1.6) : ground + 1.8;
}

export interface Scene {
	terrain: TerrainSampler;
	ground: number;
	eye: number;
	eyeSource: string;
	horizon: HorizonProfile;
	horizonMs: number;
	dem: string;
}

/**
 * Terrain + eye + 360° horizon on Mapterhorn at (lat, lon). The eye is `eyeH` (absolute m, e.g. the
 * height a method actually used) when given, else `eyeRule(ground, altitude)` (default: 0f's
 * eyeHeight rule, max(GPS, ground + 1.6), which is what the cascade applies to its DEM).
 */
export async function sceneAt(
	lat: number,
	lon: number,
	altitude?: number | null,
	opts: {
		eyeH?: number | null;
		eyeRule?: (ground: number, alt?: number | null) => number;
		eyeSource?: string;
	} = {},
): Promise<Scene> {
	const terrain = await mapterhornAt(lat, lon);
	let ground = Number.NaN;
	for (const lv of LEVELS) {
		ground = terrain.sample(lon, lat, lv.z);
		if (Number.isFinite(ground)) break;
	}
	const rule =
		opts.eyeRule ??
		((g: number, a?: number | null) => eyeHeight(a ?? undefined, g));
	const eye =
		opts.eyeH != null && Number.isFinite(opts.eyeH)
			? opts.eyeH
			: rule(ground, altitude);
	const eyeSource =
		opts.eyeH != null
			? (opts.eyeSource ?? "given")
			: opts.eyeRule
				? "rule"
				: "0f-eyeHeight(mapterhorn)";
	const key = `${lat.toFixed(6)}_${lon.toFixed(6)}_${eye.toFixed(2)}_mapterhorn`;
	const file = path.join(CACHE, "horizon", `${key}.json`);
	const t0 = performance.now();
	let horizon = horizonMem.get(key);
	if (!horizon && HORIZON_DISK && fs.existsSync(file)) {
		const j = JSON.parse(fs.readFileSync(file, "utf8"));
		horizon = {
			step: j.step,
			elevation: Float32Array.from(j.elevation),
			distance: Float32Array.from(j.distance),
			ridges: j.ridges,
		};
	}
	if (!horizon) {
		horizon = computeHorizon(terrain, lat, lon, eye);
		if (HORIZON_DISK) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				JSON.stringify({
					step: horizon.step,
					elevation: Array.from(horizon.elevation),
					distance: Array.from(horizon.distance),
					ridges: horizon.ridges,
				}),
			);
		}
	}
	if (horizonMem.size >= 6)
		horizonMem.delete(horizonMem.keys().next().value as string);
	horizonMem.set(key, horizon);
	return {
		terrain,
		ground,
		eye,
		eyeSource,
		horizon,
		horizonMs: performance.now() - t0,
		dem: DEM_SOURCE,
	};
}

const UA =
	"summit-lens-bench/0.1 (mountain photo georeferencing research; local benchmark harness)";
let lastOverpass = 0;

/** OSM peaks within radiusM, cached per ~1 km cell; polite (UA, ≥ 2 s between queries, back-off). */
const bboxes: { s: number; w: number; n: number; e: number; peaks: Peak[] }[] =
	[];

/**
 * One Overpass query for all named peaks in a bbox (cached), so a set spread over a whole country
 * costs one polite request instead of one per photo. peaksAt() then answers from it.
 */
export async function prefetchPeaksBBox(
	s: number,
	w: number,
	n: number,
	e: number,
) {
	const key = `bbox_${s.toFixed(2)}_${w.toFixed(2)}_${n.toFixed(2)}_${e.toFixed(2)}`;
	const file = path.join(CACHE, "overpass", `${key}.json`);
	if (!fs.existsSync(file)) {
		const q = `[out:json][timeout:300];(node["natural"="peak"]["name"](${s},${w},${n},${e});node["natural"="volcano"]["name"](${s},${w},${n},${e}););out body;`;
		const txt = await overpassText(q);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, txt);
	}
	bboxes.push({
		s,
		w,
		n,
		e,
		peaks: parseOverpassPeaks(JSON.parse(fs.readFileSync(file, "utf8"))),
	});
	return bboxes[bboxes.length - 1].peaks.length;
}

/** Polite Overpass: ≥ 2 s between queries, two instances alternating, backing off 8 s × attempt. */
async function overpassText(q: string): Promise<string> {
	const wait = lastOverpass + 2000 - Date.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	lastOverpass = Date.now();
	const json = await overpass(q, {
		endpoints: [OVERPASS.main, OVERPASS.coffee, OVERPASS.main, OVERPASS.coffee],
		userAgent: UA,
		backoffMs: 8000,
	});
	return JSON.stringify(json);
}

export async function peaksAt(
	lat: number,
	lon: number,
	radiusM = 80_000,
): Promise<Peak[]> {
	const dLat = radiusM / 111_320;
	const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
	const box = bboxes.find(
		(b) =>
			lat - dLat >= b.s &&
			lat + dLat <= b.n &&
			lon - dLon >= b.w &&
			lon + dLon <= b.e,
	);
	if (box)
		return box.peaks.filter(
			(p) => distanceBearing(lat, lon, p.lat, p.lon).distance <= radiusM,
		);
	const key = `${lat.toFixed(2)},${lon.toFixed(2)},${Math.round(radiusM / 1000)}km`;
	const file = path.join(CACHE, "overpass", `${key}.json`);
	// the repo's own caches (read-only) first
	const shared = path.join(ROOT, ".cache", "overpass", `${key}.json`);
	if (fs.existsSync(shared))
		return parseOverpassPeaks(JSON.parse(fs.readFileSync(shared, "utf8")));
	if (!fs.existsSync(file)) {
		const q = overpassPeaksQuery(+lat.toFixed(2), +lon.toFixed(2), radiusM);
		const txt = await overpassText(q);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, txt);
	}
	return parseOverpassPeaks(JSON.parse(fs.readFileSync(file, "utf8")));
}

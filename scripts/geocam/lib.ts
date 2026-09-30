/**
 * GEO evaluation library (Agent B; plan §3). CPU-only, node. Shared by every scripts/geocam/ga*.ts. The API
 * below is STABLE (additive changes only):
 *
 *   // re-exported from scripts/concord/lib.ts (scene frame: ENU at the GT fix, z = alt − GT eye alt −
 *   // d²/2R_eff; the GT camera has eye [0,0,0]; px @1600 = long side 1600)
 *   loadGT, loadSplit, loadScene, gtCam, appSolve, enuOf, scorePins, skylineRms, loadPins, median,
 *   quantile, basis1600, R_EFF, type Scene, type GroundTruth, type EvalPin
 *
 *   GT_DEV, GT_HOLDOUT                  frozen split (tools/concord/pins/PROTOCOL.txt)
 *   assertDevGT(photo)                  throws on holdout / unknown photos. NO override.
 *   devGTPhotos(only?)                  the dev GT photos (optionally filtered), each asserted
 *   terrainFor(scene, dem="mh")         Mapterhorn (z17 ≤ 300 m, then MAPTERHORN levels) or Terrarium sampler
 *   heightFnOf(scene, terrain)          scene-frame DEM z(e, n, d) (curvature + refraction folded in)
 *   FastSampler                         TerrainSampler.sampleAt with a one-tile memo (horizon marches)
 *   sectorHorizon(scene, fast, eye, a0, a1)   computeHorizon-identical sector march at a scene-frame eye
 *   horizonProvider(scene, terrain, yaw, halfFovDeg, {dem})  memoised + disk-cached HorizonsAtEyes
 *   halfDiagFovDeg(cam)                 half the diagonal FOV (deg)
 *   skySamples(photo)                   detectSkyline samples on the 1600 px photo (every 2nd col, w ≥ 0.3)
 *   photoMeta(photo)                    photos.json + EXIF: lat, lon, alt, hAcc, heading, pitch, roll, lens, f35
 *   lakesFor(scene, terrain)            OSM lakes (cached out/concord/pins/osm/*_water.json) with DEM levels
 *   rematchCues(photo)                  WP-G re-match point cues (out/concord/rematch/cues), [] if absent
 *   photoSetup(photo, {start, dem})     everything a MAP problem needs for one GT dev photo (PhotoSetup)
 *   wildDevIds(), assertWildDev(pid), wildDev(pid)   C0 cache (tools/research/tm/cache), 50 dev ids only,
 *                                       read-only: {pid, dir, meta, photoJpg}
 *   writeJson(file, obj)                mkdir -p + JSON write
 *
 * Horizons: disk cache out/geocam/ga1/hzcache (elevation + distance per 0.05° bin; the key format of
 * the removed scripts/concord/solve-eval.ts, whose own cache lacks distances and is therefore not read).
 */
import fs from "node:fs";
import path from "node:path";
import exifr from "exifr";
import type { CameraX, Vec3 } from "../../src/lib/concord/core";
import {
	buildGeomBuffer,
	extractCues,
	type Lake,
	lakeLevel,
	lakesFromOverpass,
	type PhotoEdges,
	photoEdgesFromRGBA,
} from "../../src/lib/concord/cues";
import {
	type EyePrior,
	eyePriorFromExif,
} from "../../src/lib/concord/priors/altitude";
import {
	focalPrior,
	lensModelFromCamera,
} from "../../src/lib/concord/priors/focal-table";
import {
	groundFromHeightAt,
	offsetLatLon,
} from "../../src/lib/concord/priors/ground";
import type { JointCue } from "../../src/lib/geocam/map";
import { lonLatToTile, MAPTERHORN, type TerrainLevel } from "../../src/lib/dem";
import { detectSkyline } from "../../src/lib/geo/skyline";
import { loadTerrain, type TerrainSampler } from "../../src/lib/geo/terrain";
import {
	destination,
	distanceBearing as distBear,
} from "../../src/lib/geodesy";
import type {
	EyeHorizon,
	HorizonsAtEyes,
	SkylineSample,
} from "../../src/lib/pose6dof/eye";
import {
	appSolve,
	gtCam,
	loadGT,
	loadScene,
	loadSplit,
	R_EFF,
	type Scene,
} from "../concord/lib";
import {
	demTileLoaderNode,
	heicToJpeg,
	IMG_DIR,
	loadRGBA,
	ROOT,
} from "../lib/node-io";

export {
	appSolve,
	basis1600,
	type EvalPin,
	enuOf,
	type GroundTruth,
	gtCam,
	loadGT,
	loadPins,
	loadScene,
	loadSplit,
	median,
	quantile,
	R_EFF,
	type Scene,
	scorePins,
	skylineRms,
} from "../concord/lib";

const DEG = Math.PI / 180;
export const GEO_OUT = path.join(ROOT, "out", "geocam");
const HZ_CACHE = path.join(GEO_OUT, "ga1", "hzcache");

// ---------------------------------------------------------------- split

export const GT_DEV = [
	"IMG_5495",
	"IMG_6971",
	"IMG_7018",
	"IMG_7033",
	"IMG_7053",
	"IMG_7059",
	"IMG_7063",
	"IMG_7068",
	"IMG_7131",
	"IMG_7155",
] as const;
export const GT_HOLDOUT = [
	"IMG_6019",
	"IMG_6958",
	"IMG_7086",
	"IMG_7130",
] as const;

/** Refuses holdout (and anything not dev in PROTOCOL.txt). There is no override in GEO. */
export function assertDevGT(photo: string): void {
	const name = photo.startsWith("IMG_") ? photo : `IMG_${photo}`;
	if ((GT_HOLDOUT as readonly string[]).includes(name))
		throw new Error(`${name} is a HOLDOUT photo: GEO evals are dev-only`);
	const split = loadSplit();
	if (split[name] !== "dev" || !(GT_DEV as readonly string[]).includes(name))
		throw new Error(`${name} is not a DEV GT photo`);
}

/** Dev GT photos (all, or the `only` subset), each asserted. */
export function devGTPhotos(only: string[] = []): string[] {
	const list = only.length
		? only.map((p) => (p.startsWith("IMG_") ? p : `IMG_${p}`))
		: [...GT_DEV];
	for (const p of list) assertDevGT(p);
	return list;
}

// ---------------------------------------------------------------- DEM + horizons (copied from solve-eval.ts)

export type Dem = "mh" | "terrarium";
const mhTiles = new Map<string, Float32Array>();
const loadMH = demTileLoaderNode(MAPTERHORN);
const terrMemo = new Map<string, Promise<TerrainSampler>>();

export function terrainFor(s: Scene, dem: Dem = "mh"): Promise<TerrainSampler> {
	if (dem === "terrarium") return Promise.resolve(s.terrain);
	let t = terrMemo.get(s.photo);
	if (!t) {
		const levels: TerrainLevel[] = [
			{ z: 17, maxDistance: 300 },
			...MAPTERHORN.levels,
		];
		t = loadTerrain(
			s.lat,
			s.lon,
			loadMH,
			levels,
			mhTiles,
			8,
			MAPTERHORN.tileSize,
		);
		terrMemo.set(s.photo, t);
	}
	return t;
}

/** Scene-frame z of the DEM at (e, n) (d = distance for the level choice). */
export const heightFnOf =
	(s: Scene, t: TerrainSampler) => (e: number, n: number, d: number) => {
		const dO = Math.hypot(e, n);
		const p =
			dO > 0
				? destination(s.lat, s.lon, Math.atan2(e, n) / DEG, dO)
				: { lat: s.lat, lon: s.lon };
		return t.sampleAt(p.lon, p.lat, d) - s.eyeAlt - (dO * dO) / (2 * R_EFF);
	};

export const HZ_STEP = 0.05;

/** TerrainSampler.sampleAt with a one-tile memo per zoom; identical arithmetic and level fallback. */
export class FastSampler {
	private readonly n: number;
	private readonly memo: Map<
		number,
		{ tx: number; ty: number; tile: Float32Array | undefined }
	> = new Map();
	constructor(private readonly t: TerrainSampler) {
		this.n = t.tileSize;
	}
	private tiles() {
		return (this.t as unknown as { tiles: Map<string, Float32Array> }).tiles;
	}
	private pixel(z: number, gx: number, gy: number) {
		const n = this.n;
		const tx = Math.floor(gx / n);
		const ty = Math.floor(gy / n);
		let m = this.memo.get(z);
		if (!m) {
			m = { tx: Number.NaN, ty: Number.NaN, tile: undefined };
			this.memo.set(z, m);
		}
		if (m.tx !== tx || m.ty !== ty) {
			m.tx = tx;
			m.ty = ty;
			m.tile = this.tiles().get(`${z}/${tx}/${ty}`);
		}
		if (!m.tile) return Number.NaN;
		return m.tile[(gy - ty * n) * n + (gx - tx * n)];
	}
	sample(lon: number, lat: number, z: number) {
		const t = lonLatToTile(lon, lat, z);
		const px = t.x * this.n - 0.5;
		const py = t.y * this.n - 0.5;
		const x0 = Math.floor(px);
		const y0 = Math.floor(py);
		const fx = px - x0;
		const fy = py - y0;
		const h00 = this.pixel(z, x0, y0);
		const h10 = this.pixel(z, x0 + 1, y0);
		const h01 = this.pixel(z, x0, y0 + 1);
		const h11 = this.pixel(z, x0 + 1, y0 + 1);
		return (
			(h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy
		);
	}
	sampleAt(lon: number, lat: number, distance: number) {
		const L = this.t.levels;
		let i = L.findIndex((l) => distance <= l.maxDistance);
		if (i < 0) i = L.length - 1;
		for (; i < L.length; i++) {
			const h = this.sample(lon, lat, L[i].z);
			if (!Number.isNaN(h)) return h;
		}
		return Number.NaN;
	}
}

type RayTable = {
	a0: number;
	nAz: number;
	ds: Float64Array;
	lat: Float64Array;
	lon: Float64Array;
};
const rayMemo = new Map<string, RayTable>();
function rayTable(s: Scene, a0: number, a1: number): RayTable {
	const key = `${s.photo}_${a0}_${a1}`;
	let r = rayMemo.get(key);
	if (!r) {
		rayMemo.clear();
		const dl: number[] = [];
		for (let d = 20; d <= 150_000; d += Math.max(10, d * 0.004)) dl.push(d);
		const k0 = Math.ceil(a0 / HZ_STEP);
		const nAz = Math.floor(a1 / HZ_STEP) - k0 + 1;
		const lat = new Float64Array(nAz * dl.length);
		const lon = new Float64Array(nAz * dl.length);
		for (let k = 0; k < nAz; k++)
			for (let j = 0; j < dl.length; j++) {
				const p = destination(s.lat, s.lon, (k0 + k) * HZ_STEP, dl[j]);
				lat[k * dl.length + j] = p.lat;
				lon[k * dl.length + j] = p.lon;
			}
		r = { a0: k0, nAz, ds: Float64Array.from(dl), lat, lon };
		rayMemo.set(key, r);
	}
	return r;
}

/**
 * Sector horizon at a scene-frame eye: the geo/horizon.ts computeHorizon ray march (20 m → 150 km,
 * step max(10, 0.004·d), curvature + refraction), azimuths [a0, a1]; elsewhere −90 (no data).
 */
export function sectorHorizon(
	s: Scene,
	fs_: FastSampler,
	eye: Vec3,
	a0: number,
	a1: number,
): EyeHorizon {
	const n = Math.round(360 / HZ_STEP);
	const elevation = new Float32Array(n).fill(-90);
	const distance = new Float32Array(n);
	const R = rayTable(s, a0, a1);
	const p0 = offsetLatLon(s.lat, s.lon, eye[0], eye[1]);
	const dLat = p0.lat - s.lat;
	const dLon = p0.lon - s.lon;
	const eyeAlt = s.eyeAlt + eye[2];
	const nd = R.ds.length;
	for (let k = 0; k < R.nAz; k++) {
		const i = (((R.a0 + k) % n) + n) % n;
		let best = -90;
		let bestD = 0;
		for (let j = 0; j < nd; j++) {
			const d = R.ds[j];
			const h = fs_.sampleAt(
				R.lon[k * nd + j] + dLon,
				R.lat[k * nd + j] + dLat,
				d,
			);
			if (Number.isNaN(h)) continue;
			const a = Math.atan2(h - eyeAlt - (d * d) / (2 * R_EFF), d) / DEG;
			if (a > best) {
				best = a;
				bestD = d;
			}
		}
		elevation[i] = best;
		distance[i] = bestD;
	}
	return { step: HZ_STEP, elevation, distance };
}

export const hzStats = { computed: 0, ms: 0 };

/**
 * Memo (0.25 m quantum, LRU of `max`) over a HorizonsAtEyes. Unlike concord/solve cachedHorizons, a batch never
 * evicts an eye it is about to return (that version can drop a cached hit while inserting the misses of the same
 * batch and return undefined).
 */
export function memoHorizons(
	h: HorizonsAtEyes,
	quantumM = 0.25,
	max = 256,
): HorizonsAtEyes {
	const memo = new Map<string, EyeHorizon>();
	const key = (e: number[]) => e.map((x) => Math.round(x / quantumM)).join(",");
	return async (eyes) => {
		const miss = eyes.filter((e) => !memo.has(key(e)));
		const uniq = [...new Map(miss.map((e) => [key(e), e])).values()];
		const got = new Map<string, EyeHorizon>();
		if (uniq.length) {
			const hs = await h(uniq);
			uniq.forEach((e, i) => {
				got.set(key(e), hs[i]);
			});
		}
		const out = eyes.map(
			(e) => got.get(key(e)) ?? (memo.get(key(e)) as EyeHorizon),
		);
		for (const [k, v] of got) {
			memo.delete(k);
			memo.set(k, v);
			while (memo.size > max) memo.delete(memo.keys().next().value as string);
		}
		return out;
	};
}

/** Half the diagonal field of view (deg) of a camera (pinhole at fScale). */
export const halfDiagFovDeg = (cam: CameraX) =>
	Math.atan(
		(Math.hypot(cam.aspect, 1) * Math.tan((cam.pose.vfov * DEG) / 2)) /
			cam.intr.fScale,
	) / DEG;

/**
 * Memoised (0.25 m quantum) + disk-cached horizons for a sector around `yaw` (± halfFov + 20°, 5°
 * aligned: the same keys as solve-eval.ts). Distances are kept in memory but not on disk (a cache
 * hit returns elevation + distance when the file has them).
 */
export function horizonProvider(
	s: Scene,
	t: TerrainSampler,
	yaw: number,
	halfFov: number,
	o: { dem?: Dem } = {},
): HorizonsAtEyes {
	const dem = o.dem ?? "mh";
	const fast = new FastSampler(t);
	const c = Math.round(yaw / 5) * 5;
	const half = Math.ceil((halfFov + 20) / 5) * 5;
	const a0 = c - half;
	const a1 = c + half;
	fs.mkdirSync(HZ_CACHE, { recursive: true });
	return memoHorizons(async (eyes: Vec3[]) =>
		eyes.map((e) => {
			const key = `${s.photo}_${dem}_${a0}_${a1}_${e.map((x) => x.toFixed(2)).join("_")}`;
			const nAll = Math.round(360 / HZ_STEP);
			for (const dir of [HZ_CACHE]) {
				const file = path.join(dir, `${key}.json`);
				if (!fs.existsSync(file)) continue;
				const j = JSON.parse(fs.readFileSync(file, "utf8"));
				const el = new Float32Array(nAll).fill(-90);
				const di = new Float32Array(nAll);
				const k0 = j.k0 as number;
				(j.el as number[]).forEach((v, k) => {
					el[(k0 + k) % nAll] = v;
				});
				(j.d as number[] | undefined)?.forEach((v, k) => {
					di[(k0 + k) % nAll] = v;
				});
				return j.d
					? { step: HZ_STEP, elevation: el, distance: di }
					: { step: HZ_STEP, elevation: el };
			}
			const t0 = Date.now();
			const h = sectorHorizon(s, fast, e, a0, a1);
			hzStats.ms += Date.now() - t0;
			hzStats.computed++;
			const k0 = ((Math.ceil(a0 / HZ_STEP) % nAll) + nAll) % nAll;
			const cnt = Math.floor(a1 / HZ_STEP) - Math.ceil(a0 / HZ_STEP) + 1;
			const el: number[] = [];
			const d: number[] = [];
			for (let k = 0; k < cnt; k++) {
				el.push(+h.elevation[(k0 + k) % nAll].toFixed(5));
				d.push(Math.round((h.distance as Float32Array)[(k0 + k) % nAll]));
			}
			fs.writeFileSync(
				path.join(HZ_CACHE, `${key}.json`),
				JSON.stringify({ k0, el, d }),
			);
			return h;
		}),
	);
}

// ---------------------------------------------------------------- photo inputs

const skyMemo = new Map<string, Promise<SkylineSample[]>>();
export function skySamples(photo: string): Promise<SkylineSample[]> {
	let p = skyMemo.get(photo);
	if (!p) {
		p = (async () => {
			const img = await loadRGBA(
				heicToJpeg(path.join(IMG_DIR, `${photo}.HEIC`), 1600),
			);
			const sky = detectSkyline(img);
			const out: SkylineSample[] = [];
			for (let x = 0; x < img.width; x += 2) {
				const y = sky.rows[x];
				if (!Number.isFinite(y) || sky.weight[x] < 0.3) continue;
				out.push({
					u: (x + 0.5) / img.width,
					v: y / img.height,
					w: sky.weight[x],
				});
			}
			return out;
		})();
		skyMemo.set(photo, p);
	}
	return p;
}

export type PhotoMeta = {
	lat: number;
	lon: number;
	alt: number | null;
	hAcc: number | null;
	/** photos.json heading (deg, reference unknown: photos.json drops headingRef), null = none. */
	heading: number | null;
	/** photos.json gravity-derived pitch / roll (deg), null = none. */
	pitch: number | null;
	roll: number | null;
	lensModel?: string;
	model?: string;
	f35?: number;
};
export async function photoMeta(photo: string): Promise<PhotoMeta> {
	const meta = (
		JSON.parse(
			fs.readFileSync(
				path.join(ROOT, "public", "photos", "photos.json"),
				"utf8",
			),
		) as {
			id: string;
			lat: number;
			lon: number;
			alt: number;
			hAccuracy: number;
			f35: number;
			heading?: number | null;
			pitch?: number | null;
			roll?: number | null;
		}[]
	).find((m) => m.id === photo);
	if (!meta) throw new Error(`${photo}: not in photos.json`);
	const e = await exifr.parse(path.join(IMG_DIR, `${photo}.HEIC`), {
		exif: true,
		tiff: true,
		gps: false,
		xmp: false,
		makerNote: false,
	});
	const num = (x: unknown) =>
		typeof x === "number" && Number.isFinite(x) ? x : null;
	return {
		lat: meta.lat,
		lon: meta.lon,
		alt: num(meta.alt),
		hAcc: num(meta.hAccuracy),
		heading: num(meta.heading),
		pitch: num(meta.pitch),
		roll: num(meta.roll),
		lensModel: e?.LensModel,
		model: e?.Model,
		f35: e?.FocalLengthIn35mmFormat ?? meta.f35,
	};
}

let osmMemo: unknown[] | undefined;
function osmWater(): unknown[] {
	if (!osmMemo) {
		const dir = path.join(ROOT, "out", "concord", "pins", "osm");
		const seen = new Set<string>();
		osmMemo = [];
		if (fs.existsSync(dir))
			for (const f of fs
				.readdirSync(dir)
				.filter((f) => f.endsWith("_water.json")))
				for (const e of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
					.elements) {
					const k = `${e.type}/${e.id}`;
					if (seen.has(k)) continue;
					seen.add(k);
					osmMemo.push(e);
				}
	}
	return osmMemo;
}

/** OSM lakes (≥ 5 ha, within 40 km) in the scene frame with a DEM-median level (absolute m). */
export function lakesFor(s: Scene, t: TerrainSampler): Lake[] {
	const toEN = (lat: number, lon: number): [number, number] => {
		const { distance: d, bearing } = distBear(s.lat, s.lon, lat, lon);
		return [d * Math.sin(bearing * DEG), d * Math.cos(bearing * DEG)];
	};
	const lakes = lakesFromOverpass(
		osmWater() as Parameters<typeof lakesFromOverpass>[0],
		toEN,
		{ minAreaM2: 50_000 },
	).filter((l) => l.polygon.some(([e, n]) => Math.hypot(e, n) < 40_000));
	for (const l of lakes) {
		const abs = (e: number, n: number) => {
			const dO = Math.hypot(e, n);
			const p = destination(s.lat, s.lon, Math.atan2(e, n) / DEG, dO);
			return t.sampleAt(p.lon, p.lat, dO);
		};
		l.levelM = lakeLevel(l, abs, {
			region: (e, n) => Math.hypot(e, n) < 30_000,
		}).levelM;
	}
	return lakes.filter((l) => Number.isFinite(l.levelM));
}

export function rematchCues(photo: string): JointCue[] {
	const f = path.join(
		ROOT,
		"out",
		"concord",
		"rematch",
		"cues",
		`${photo}.json`,
	);
	if (!fs.existsSync(f)) return [];
	const j = JSON.parse(fs.readFileSync(f, "utf8"));
	return (j.cues as JointCue[]).filter((c) => c.kind === "point");
}

// ---------------------------------------------------------------- per-photo setup

export type PhotoSetup = {
	photo: string;
	s: Scene;
	t: TerrainSampler;
	dem: Dem;
	/** Start camera (app solve or GT), scene frame. */
	start: CameraX;
	/** GT camera (eye [0,0,0]). NOT independent truth for the eye (GT eyes = fix + DEM/GPS rule). */
	gt: CameraX;
	appAccepted: boolean;
	appConfidence: number;
	meta: PhotoMeta;
	/** WP-B eye prior in the scene frame (eye0, σH, σV, isoBand…). */
	eyePrior: EyePrior;
	/** GPS fix in the scene frame (E, N) — the GT lat/lon is the fix, so [0, 0]. */
	fixEN: [number, number];
	/** Scene-frame DEM ground z at (e, n) (curvature folded in), for standing-height factors. */
	ground: (e: number, n: number) => number;
	/** Focal prior at the 1600 basis (long side 1600). */
	focal: { fPx: number; sigmaPx: number; fScale: number; lens?: string };
	horizonsAtEyes: HorizonsAtEyes;
	skyline: SkylineSample[];
	heightFn: (e: number, n: number, d: number) => number;
	lakes: Lake[];
	rematch: JointCue[];
	/** WP-C cues (edge/level/shore, CPU ray cast at 800 px) at a camera. Loads photo edges lazily. */
	cuesAt: (cam: CameraX) => Promise<JointCue[]>;
};

export async function photoSetup(
	photo: string,
	o: { start?: "app" | "gt"; dem?: Dem } = {},
): Promise<PhotoSetup> {
	assertDevGT(photo);
	const dem = o.dem ?? "mh";
	const s = await loadScene(photo);
	const t = await terrainFor(s, dem);
	const app = await appSolve(photo);
	const gt = gtCam(photo);
	const start = (o.start ?? "app") === "app" ? app.cam : gt;
	const meta = await photoMeta(photo);
	const g = loadGT()[photo];
	const groundAbs = groundFromHeightAt(meta.lat, meta.lon, (la, lo) =>
		t.sampleAt(lo, la, 0),
	);
	const pr = eyePriorFromExif(
		{ lat: meta.lat, lon: meta.lon, alt: meta.alt, hAcc: meta.hAcc },
		groundAbs,
	);
	if (Math.abs(meta.lat - s.lat) > 1e-9 || Math.abs(meta.lon - s.lon) > 1e-9)
		throw new Error(`${photo}: fix ≠ scene origin`);
	const z0 = s.eyeAlt;
	const eyePrior: EyePrior = {
		...pr,
		eye0: [pr.eye0[0], pr.eye0[1], pr.eye0[2] - z0],
		mapEye: pr.mapEye
			? [pr.mapEye[0], pr.mapEye[1], pr.mapEye[2] - z0]
			: undefined,
		isoBand: pr.isoBand
			? {
					...pr.isoBand,
					alt: pr.isoBand.alt - z0,
					ground: (dE: number, dN: number) => groundAbs(dE, dN) - z0,
				}
			: undefined,
	};
	const ground = (e: number, n: number) =>
		groundAbs(e, n) - z0 - (e * e + n * n) / (2 * R_EFF);
	const lens = meta.lensModel ?? lensModelFromCamera(meta.model, meta.f35);
	const fp = focalPrior(lens, meta.f35 ?? 26, {
		width: g.width,
		height: g.height,
	});
	const k = 1600 / Math.max(g.width, g.height);
	const horizonsAtEyes = horizonProvider(
		s,
		t,
		start.pose.yaw,
		halfDiagFovDeg(start),
		{ dem },
	);
	const skyline = await skySamples(photo);
	const heightFn = heightFnOf(s, t);
	const lakes = lakesFor(s, t);
	const rematch = rematchCues(photo);
	let edges: PhotoEdges | undefined;
	const cuesAt = async (cam: CameraX): Promise<JointCue[]> => {
		if (!edges) {
			const jpg = heicToJpeg(path.join(IMG_DIR, `${photo}.HEIC`), 1600);
			const ew = cam.aspect >= 1 ? 1600 : Math.round(1600 * cam.aspect);
			const rgba = await loadRGBA(jpg, ew);
			edges = photoEdgesFromRGBA(rgba.data, rgba.width, rgba.height);
		}
		const gw = cam.aspect >= 1 ? 800 : Math.round(800 * cam.aspect);
		const gh = Math.round(gw / cam.aspect);
		const geom = buildGeomBuffer(cam, gw, gh, heightFn, {
			frame: { alt0: s.eyeAlt, rEff: R_EFF },
		});
		return extractCues({ geom, cam, edges, lakes }).cues as JointCue[];
	};
	return {
		photo,
		s,
		t,
		dem,
		start,
		gt,
		appAccepted: app.accepted,
		appConfidence: app.confidence,
		meta,
		eyePrior,
		fixEN: [0, 0],
		ground,
		focal: {
			fPx: fp.fPx * k,
			sigmaPx: fp.sigmaPx * k,
			fScale: fp.fScale,
			lens,
		},
		horizonsAtEyes,
		skyline,
		heightFn,
		lakes,
		rematch,
		cuesAt,
	};
}

// ---------------------------------------------------------------- wild dev (C0 cache, read-only)

const TM_CACHE = path.join(ROOT, "tools", "research", "tm", "cache");
let wildIds: string[] | undefined;
/** The 50 wild dev ids (tools/bench/split.json "dev"; same as tm_common.dev_ids). */
export function wildDevIds(): string[] {
	wildIds ??= (
		JSON.parse(
			fs.readFileSync(path.join(ROOT, "tools", "bench", "split.json"), "utf8"),
		).dev as string[]
	)
		.slice()
		.sort();
	return wildIds;
}
export function assertWildDev(pid: string): void {
	if (!wildDevIds().includes(pid))
		throw new Error(`${pid} is not a wild dev id`);
}

export type WildDev = {
	pid: string;
	dir: string;
	/** C0 meta.json (tools/research/tm/cache/FORMAT.md). */
	meta: Record<string, unknown> & {
		lat: number;
		lon: number;
		eye: [number, number, number];
		aspect: number;
		W: number;
		H: number;
		vfov0: number;
		headingDeg: number | null;
		correct_refs: {
			label: string;
			pose: { yaw: number; pitch: number; roll: number; vfov: number };
			eyeH: number | null;
			renderEye: [number, number, number];
		}[];
	};
	photoJpg: string;
};
/** A wild dev photo from the C0 cache (null when its DONE marker is missing). */
export function wildDev(pid: string): WildDev | null {
	assertWildDev(pid);
	const dir = path.join(TM_CACHE, pid);
	if (!fs.existsSync(path.join(dir, "DONE"))) return null;
	return {
		pid,
		dir,
		meta: JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")),
		photoJpg: path.join(dir, "photo.jpg"),
	};
}

// ---------------------------------------------------------------- io

export function writeJson(file: string, obj: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(obj, null, 1));
}

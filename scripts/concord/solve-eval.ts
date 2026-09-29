/**
 * WP-D evaluation: joint whole-frame solve + gate on the DEV photos (CPU only).
 *
 *   npx tsx scripts/concord/solve-eval.ts [--start app,gt] [--modes cues,pins,cuespins]
 *       [--dem mh|terrarium] [--rounds 2] [--no-rematch] [--tag x] [--opts '{json JointOpts}'] [IMG_xxxx ...]
 *
 * Per photo (DEV split of tools/concord/pins/PROTOCOL.txt only; holdout photos are refused):
 *   geometry   DEM = Mapterhorn (z17 ≤ 300 m, then the app's MAPTERHORN levels) by default, in the eval
 *              lib's scene frame (ENU at the GT fix, z = alt − GT eye alt − d²/2R_eff). Horizons: a sector
 *              ray march identical to geo/horizon.ts computeHorizon (0.05° step), cached on disk.
 *   skyline    detectSkyline on the 1600 px photo (every 2nd column, weight ≥ 0.3), as the eval lib.
 *   priors     WP-B eyePriorFromExif (frozen defaults) on the same DEM, converted to the scene frame;
 *              WP-B focalPrior (LENS_TABLE) from the EXIF LensModel / 35 mm focal.
 *   cues       WP-C extractCues at the current camera (CPU ray cast GeomBuffer, photo edges, OSM lakes),
 *              plus the WP-G render → re-match inliers (out/concord/rematch/cues, fixed) when present.
 *   start      "app": the app's automatic skyline solve (eval lib appSolve, its eye rule);
 *              "gt": the ground-truth pose (pin-fitted: in-sample for the pins, reference only).
 * Modes:
 *   cues       concordRefine (2 extraction rounds, gate = 2-fold cue cross-check). The pins are never
 *              seen: every pin is out-of-sample. This is the product configuration.
 *   pins       LOO over the photo's dev pins: skyline + priors + (pins \ i) as cues, score pin i.
 *              Gate = sanity rules only (no holdout evidence exists inside a LOO fold): labelled so.
 *   cuespins   LOO: final-round cues of mode "cues" + (pins \ i); gate = cue cross-check.
 * Scores: dev pins via scripts/concord/lib.ts scorePins, banded by the pin's distance from the GT eye.
 * The gated camera for a LOW-confidence start is the start (concordRefine refuses); the raw solve is
 * still reported (diagnostic) for every photo.
 * Outputs: out/concord/solve/eval-<tag>.json, cand/<start>-cues/<photo>.json (eval.ts --candidate).
 */
import fs from "node:fs";
import path from "node:path";
import exifr from "exifr";
import {
	type CameraX,
	DISTANCE_BANDS,
	IDENTITY_INTRINSICS,
	type Vec3,
} from "../../src/lib/concord/core";
import {
	buildGeomBuffer,
	extractCues,
	type Lake,
	lakeLevel,
	lakesFromOverpass,
	photoEdgesFromRGBA,
} from "../../src/lib/concord/cues";
import { isLowConfidence } from "../../src/lib/concord/field/fit";
import { eyePriorFromExif } from "../../src/lib/concord/priors/altitude";
import {
	focalPrior,
	lensModelFromCamera,
} from "../../src/lib/concord/priors/focal-table";
import {
	groundFromHeightAt,
	offsetLatLon,
} from "../../src/lib/concord/priors/ground";
import {
	cachedHorizons,
	type ConcordRefineOut,
	concordRefine,
	cueCrossCheck,
	gate,
	type JointCue,
	type JointInput,
	type JointOpts,
	type JointResult,
	solveJoint,
} from "../../src/lib/concord/solve";
import { lonLatToTile, MAPTERHORN, type TerrainLevel } from "../../src/lib/dem";
import { detectSkyline } from "../../src/lib/geo/skyline";
import { loadTerrain, type TerrainSampler } from "../../src/lib/geo/terrain";
import { destination } from "../../src/lib/geodesy";
import type { EyeHorizon, SkylineSample } from "../../src/lib/pose6dof/eye";
import {
	demTileLoaderNode,
	heicToJpeg,
	IMG_DIR,
	loadRGBA,
	ROOT,
} from "../lib/node-io";
import {
	appSolve,
	bandTable,
	baselineCam,
	type EvalPin,
	type EvalResidual,
	enuOf,
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
} from "./lib";

const DEG = Math.PI / 180;
const OUT = path.join(ROOT, "out", "concord", "solve");
const HZ_CACHE = path.join(OUT, "cache");

// ---------------------------------------------------------------- args

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
	const i = args.indexOf(k);
	if (i < 0) return d;
	const v = args[i + 1];
	args.splice(i, 2);
	return v;
};
const flag = (k: string) => {
	const i = args.indexOf(k);
	if (i < 0) return false;
	args.splice(i, 1);
	return true;
};
const starts = opt("--start", "app").split(",") as ("app" | "gt")[];
const modes = opt("--modes", "cues,pins,cuespins").split(",");
const dem = opt("--dem", "mh") as "mh" | "terrarium";
const nRounds = Number(opt("--rounds", "2"));
const tag = opt("--tag", `${starts.join("+")}-${dem}`);
const jointOpts: JointOpts = JSON.parse(opt("--opts", "{}"));
const noRematch = flag("--no-rematch");
const split = loadSplit();
let photos = args.filter((a) => a.startsWith("IMG_"));
if (!photos.length)
	photos = Object.keys(split)
		.filter((p) => split[p] === "dev")
		.sort();
for (const p of photos)
	if (split[p] !== "dev")
		throw new Error(`${p} is not a DEV photo; WP-D tunes/reports on DEV only`);
fs.mkdirSync(HZ_CACHE, { recursive: true });

// ---------------------------------------------------------------- DEM + horizons

const mhTiles = new Map<string, Float32Array>();
const loadMH = demTileLoaderNode(MAPTERHORN);
const terrMemo = new Map<string, Promise<TerrainSampler>>();
function terrainFor(s: Scene): Promise<TerrainSampler> {
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
const heightFnOf =
	(s: Scene, t: TerrainSampler) => (e: number, n: number, d: number) => {
		const dO = Math.hypot(e, n);
		const p =
			dO > 0
				? destination(s.lat, s.lon, Math.atan2(e, n) / DEG, dO)
				: { lat: s.lat, lon: s.lon };
		return t.sampleAt(p.lon, p.lat, d) - s.eyeAlt - (dO * dO) / (2 * R_EFF);
	};

const HZ_STEP = 0.05;

/**
 * TerrainSampler.sampleAt re-implemented with a one-tile memo per zoom (the class builds a string key
 * per bilinear corner, which dominates a horizon march). Identical arithmetic and level fallback.
 */
class FastSampler {
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
/** Great-circle sample points (lat, lon) from the scene origin for every sector azimuth × distance. */
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
 * step max(10, 0.004·d), curvature + refraction), restricted to azimuths [a0, a1]; elsewhere −90 (no
 * data). The eye's horizontal offset (≤ ~100 m) translates the origin's great-circle samples in
 * lat/lon (error ≈ offset·d/R ≤ 1 m at 150 km).
 */
function sectorHorizon(
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

let hzComputed = 0;
let hzMs = 0;
function horizonProvider(
	s: Scene,
	t: TerrainSampler,
	yaw: number,
	halfFov: number,
) {
	const fast = new FastSampler(t);
	const c = Math.round(yaw / 5) * 5;
	const half = Math.ceil((halfFov + 20) / 5) * 5;
	const a0 = c - half;
	const a1 = c + half;
	return cachedHorizons(async (eyes: Vec3[]) =>
		eyes.map((e) => {
			const key = `${s.photo}_${dem}_${a0}_${a1}_${e.map((x) => x.toFixed(2)).join("_")}`;
			const file = path.join(HZ_CACHE, `${key}.json`);
			if (fs.existsSync(file)) {
				const j = JSON.parse(fs.readFileSync(file, "utf8"));
				const el = new Float32Array(Math.round(360 / HZ_STEP)).fill(-90);
				const k0 = j.k0 as number;
				(j.el as number[]).forEach((v, k) => {
					el[(k0 + k) % el.length] = v;
				});
				return { step: HZ_STEP, elevation: el };
			}
			const t0 = Date.now();
			const h = sectorHorizon(s, fast, e, a0, a1);
			hzMs += Date.now() - t0;
			hzComputed++;
			const n = h.elevation.length;
			const k0 = ((Math.ceil(a0 / HZ_STEP) % n) + n) % n;
			const cnt = Math.floor(a1 / HZ_STEP) - Math.ceil(a0 / HZ_STEP) + 1;
			const el: number[] = [];
			for (let k = 0; k < cnt; k++)
				el.push(+h.elevation[(k0 + k) % n].toFixed(5));
			fs.writeFileSync(file, JSON.stringify({ k0, el }));
			return h;
		}),
	);
}

// ---------------------------------------------------------------- photo inputs

const skyMemo = new Map<string, Promise<SkylineSample[]>>();
function skySamples(photo: string) {
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

type PhotoMeta = {
	lat: number;
	lon: number;
	alt: number | null;
	hAcc: number | null;
	lensModel?: string;
	model?: string;
	f35?: number;
};
async function photoMeta(photo: string): Promise<PhotoMeta> {
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
		}[]
	).find((m) => m.id === photo);
	const e = await exifr.parse(path.join(IMG_DIR, `${photo}.HEIC`), {
		exif: true,
		tiff: true,
		gps: false,
		xmp: false,
		makerNote: false,
	});
	if (!meta) throw new Error(`${photo}: not in photos.json`);
	return {
		lat: meta.lat,
		lon: meta.lon,
		alt: Number.isFinite(meta.alt) ? meta.alt : null,
		hAcc: Number.isFinite(meta.hAccuracy) ? meta.hAccuracy : null,
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

function lakesFor(s: Scene, t: TerrainSampler): Lake[] {
	const toEN = (lat: number, lon: number): [number, number] => {
		const v = enuOf(s, lat, lon, 0);
		return [v[0], v[1]];
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

function rematchCues(photo: string): JointCue[] {
	if (noRematch) return [];
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

const pinCue = (p: EvalPin, aspect: number): JointCue =>
	p.level
		? {
				kind: "level",
				u: p.x / 1600,
				v: (p.y * aspect) / 1600,
				el: 0,
				world: p.enu,
				depthM: p.distM,
				sigmaPx: p.sigmaPx ?? 2,
				source: "pin",
			}
		: {
				kind: "point",
				u: p.x / 1600,
				v: (p.y * aspect) / 1600,
				world: p.enu,
				depthM: p.distM,
				sigmaPx: p.sigmaPx ?? 2,
				source: "pin",
			};

type Setup = {
	s: Scene;
	t: TerrainSampler;
	base: CameraX;
	confidence: { accepted: boolean; confidence: number };
	inpBase: Omit<JointInput, "cues">;
	cuesAt: (cam: CameraX) => Promise<JointCue[]>;
	pins: EvalPin[];
	meta: PhotoMeta;
	priorNote: string;
};

async function setup(photo: string, start: "app" | "gt"): Promise<Setup> {
	const s = await loadScene(photo);
	const t = await terrainFor(s);
	const base = await baselineCam(photo, start);
	const conf =
		start === "app"
			? await appSolve(photo).then((a) => ({
					accepted: a.accepted,
					confidence: a.confidence,
				}))
			: { accepted: true, confidence: 1 };
	const meta = await photoMeta(photo);
	const g = loadGT()[photo];
	// eye prior on the same DEM (absolute), then into the scene frame
	const groundAbs = groundFromHeightAt(meta.lat, meta.lon, (la, lo) =>
		t.sampleAt(lo, la, 0),
	);
	const pr = eyePriorFromExif(
		{ lat: meta.lat, lon: meta.lon, alt: meta.alt, hAcc: meta.hAcc },
		groundAbs,
	);
	// photos.json lat/lon == GT lat/lon (checked): the fix is the scene origin
	if (Math.abs(meta.lat - s.lat) > 1e-9 || Math.abs(meta.lon - s.lon) > 1e-9)
		throw new Error(`${photo}: fix ≠ scene origin`);
	const z0 = s.eyeAlt;
	const eyePrior = {
		...pr,
		eye0: [pr.eye0[0], pr.eye0[1], pr.eye0[2] - z0] as Vec3,
		mapEye: pr.mapEye
			? ([pr.mapEye[0], pr.mapEye[1], pr.mapEye[2] - z0] as Vec3)
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
	const halfFov =
		Math.atan(
			Math.hypot(base.aspect, 1) * Math.tan((base.pose.vfov * DEG) / 2),
		) / DEG;
	const horizonsAtEyes = horizonProvider(s, t, base.pose.yaw, halfFov);
	const skyline = await skySamples(photo);
	const heightFn = heightFnOf(s, t);
	const jpg = path.join(ROOT, ".cache", "jpg", "1600", `${photo}.jpg`);
	if (!fs.existsSync(jpg))
		heicToJpeg(path.join(IMG_DIR, `${photo}.HEIC`), 1600);
	const ew = base.aspect >= 1 ? 1600 : Math.round(1600 * base.aspect);
	const rgba = await loadRGBA(jpg, ew);
	const edges = photoEdgesFromRGBA(rgba.data, rgba.width, rgba.height);
	const lakes = lakesFor(s, t);
	const rm = rematchCues(photo);
	const cuesAt = async (cam: CameraX) => {
		const gw = cam.aspect >= 1 ? 800 : Math.round(800 * cam.aspect);
		const gh = Math.round(gw / cam.aspect);
		const geom = buildGeomBuffer(cam, gw, gh, heightFn, {
			frame: { alt0: s.eyeAlt, rEff: R_EFF },
		});
		const r = extractCues({ geom, cam, edges, lakes });
		return [...(r.cues as JointCue[]), ...rm];
	};
	return {
		s,
		t,
		base,
		confidence: conf,
		inpBase: {
			cam0: base,
			eyePrior,
			ground,
			skyline,
			horizonsAtEyes,
			focal: {
				fPx: fp.fPx,
				sigmaPx: fp.sigmaPx,
				basisLongPx: Math.max(g.width, g.height),
			},
			free: { eye: true, fScale: true, k1: false },
			frame: { alt0: s.eyeAlt, rEff: R_EFF },
		},
		cuesAt,
		pins: await loadPins({ photos: [photo], split: "dev" }),
		meta,
		priorNote: `${pr.source} σH ${pr.sigmaH.toFixed(0)} σV ${pr.sigmaV.toFixed(0)} (${pr.reason}); focal ${lens ?? "default"} ×${fp.fScale.toFixed(4)} σ ${(100 * fp.entry.sigma).toFixed(1)}%; lakes ${lakes.length}; rematch ${rm.length}`,
	};
}

// ---------------------------------------------------------------- scoring helpers

/** scorePins with bands by the pin's distance from the GT eye (same bands for every camera). */
const score = (cam: CameraX, pins: EvalPin[]): EvalResidual[] =>
	scorePins(cam, pins).map((r, k) => ({ ...r, band: bandOfPin(pins[k]) }));
const bandOfPin = (p: EvalPin) => {
	const m = p.distM;
	return m < 500
		? "<0.5km"
		: m < 2000
			? "0.5-2km"
			: m < 5000
				? "2-5km"
				: m < 15000
					? "5-15km"
					: ">15km";
};
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const pad = (s: string | number, n: number) => String(s).padStart(n);
const camJson = (c: CameraX) => ({
	pose: c.pose,
	eye: c.eye.map((x) => +x.toFixed(3)),
	aspect: c.aspect,
	intr: c.intr,
});
const summary = (r: JointResult | null) =>
	r && {
		accepted: r.accepted,
		reasons: r.reasons,
		freed: r.freed,
		eyeShift: r.eyeShift.map((x) => +x.toFixed(2)),
		eyeShiftSigmaH: +r.eyeShiftSigmaH.toFixed(2),
		fScale: +r.cam.intr.fScale.toFixed(5),
		focalZ: +r.focalZ.toFixed(2),
		edgeBiasPx: +r.edgeBiasPx.toFixed(2),
		sky: [+r.skylineRmsBefore.toFixed(2), +r.skylineRmsAfter.toFixed(2)],
		skyInl: [
			+r.skylineInlierBefore.toFixed(3),
			+r.skylineInlierAfter.toFixed(3),
		],
		cue: [+r.cueRmsBefore.toFixed(2), +r.cueRmsAfter.toFixed(2)],
		sigma: Object.fromEntries(
			Object.entries(r.sigma).map(([k, v]) => [k, +v.toPrecision(3)]),
		),
		counts: r.counts,
		spread: r.spread,
		outer: r.outer,
		iterations: r.iterations,
		ms: r.ms,
	};

// ---------------------------------------------------------------- horizon self-check

if (flag("--verify-horizon")) {
	// sectorHorizon vs geo/horizon.ts computeHorizon (the app's march) at two eyes, in-sector azimuths
	const { computeHorizon } = await import("../../src/lib/geo/horizon");
	for (const photo of photos.slice(0, 2)) {
		const s = await loadScene(photo);
		const t = await terrainFor(s);
		const fast = new FastSampler(t);
		const yaw = loadGT()[photo].yaw as number;
		const a0 = Math.round(yaw / 5) * 5 - 60;
		const a1 = a0 + 120;
		for (const eye of [
			[0, 0, 0],
			[20, -15, 3],
		] as Vec3[]) {
			let t0 = Date.now();
			const h = sectorHorizon(s, fast, eye, a0, a1);
			const msFast = Date.now() - t0;
			const p = offsetLatLon(s.lat, s.lon, eye[0], eye[1]);
			t0 = Date.now();
			const ref = computeHorizon(t, p.lat, p.lon, s.eyeAlt + eye[2]);
			const msRef = Date.now() - t0;
			let mx = 0;
			const diffs: number[] = [];
			for (
				let k = Math.ceil(a0 / HZ_STEP);
				k <= Math.floor(a1 / HZ_STEP);
				k++
			) {
				const i = ((k % 7200) + 7200) % 7200;
				const d = Math.abs(h.elevation[i] - ref.elevation[i]);
				diffs.push(d);
				mx = Math.max(mx, d);
			}
			console.log(
				`${photo} eye [${eye.join(",")}]: |Δel| max ${mx.toExponential(2)}°, median ${median(diffs).toExponential(2)}°; sector ${msFast} ms vs computeHorizon (360°) ${msRef} ms`,
			);
		}
	}
	process.exit(0);
}

// ---------------------------------------------------------------- main

type Rec = { base: EvalResidual[]; raw: EvalResidual[]; gated: EvalResidual[] };
const results: Record<string, Record<string, Rec>> = {};
const perPhoto: Record<string, unknown>[] = [];
const add = (key: string, photo: string, rec: Rec) => {
	results[key] ??= {};
	results[key][photo] = rec;
};

for (const start of starts) {
	for (const photo of photos) {
		const T0 = Date.now();
		const S = await setup(photo, start);
		const low = isLowConfidence(S.confidence);
		const row: Record<string, unknown> = {
			photo,
			start,
			confidence: S.confidence,
			low,
			prior: S.priorNote,
			nPins: S.pins.length,
		};
		console.log(
			`\n=== ${photo} [${start}] conf ${S.confidence.confidence.toFixed(2)}${S.confidence.accepted ? "" : " (not accepted)"}${low ? " LOW" : ""}; pins ${S.pins.length}; ${S.priorNote}`,
		);
		const baseRes = score(S.base, S.pins);
		const baseSky = await skylineRms(photo, S.base);
		row.baseline = {
			cam: camJson(S.base),
			pinsMed: median(baseRes.map((r) => r.px)),
			skyTerrarium: baseSky.rmsInl,
		};

		// ---- mode cues (product configuration: pins never seen)
		let lastCues: JointCue[] = [];
		if (modes.includes("cues") || modes.includes("cuespins")) {
			const out: ConcordRefineOut = await concordRefine({
				cam: S.base,
				// diagnostics: run the solve even at LOW confidence; the LOW rule is applied below
				confidence: { accepted: true, confidence: 1 },
				eyePrior: S.inpBase.eyePrior,
				ground: S.inpBase.ground,
				skyline: S.inpBase.skyline,
				horizonsAtEyes: S.inpBase.horizonsAtEyes,
				focal: S.inpBase.focal,
				cuesAt: S.cuesAt,
				free: S.inpBase.free,
				frame: S.inpBase.frame,
				rounds: nRounds,
				opts: jointOpts,
			});
			lastCues = out.cues;
			const rawCam = out.result?.cam ?? S.base;
			const gatedCam = !low && out.accepted ? out.cam : S.base;
			const rec: Rec = {
				base: baseRes,
				raw: score(rawCam, S.pins),
				gated: score(gatedCam, S.pins),
			};
			add(`${start}/cues`, photo, rec);
			const rawSky = await skylineRms(photo, rawCam);
			fs.mkdirSync(path.join(OUT, "cand", `${start}-cues`), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(OUT, "cand", `${start}-cues`, `${photo}.json`),
				JSON.stringify({
					cam: camJson(gatedCam),
					raw: camJson(rawCam),
					accepted: out.accepted && !low,
				}),
			);
			row.cues = {
				...summary(out.result),
				acceptedFinal: out.accepted && !low,
				crossCheck: out.crossCheck,
				rounds: out.rounds.map((r) => ({
					nCues: r.nCues,
					cueRmsAfter: +r.cueRmsAfter.toFixed(2),
				})),
				cueKinds: Object.fromEntries(
					[...new Set(out.cues.map((c) => `${c.kind}:${c.source}`))].map(
						(k) => [
							k,
							out.cues.filter((c) => `${c.kind}:${c.source}` === k).length,
						],
					),
				),
				skyTerrarium: [baseSky.rmsInl, rawSky.rmsInl],
				pinsMed: [
					median(rec.base.map((r) => r.px)),
					median(rec.raw.map((r) => r.px)),
					median(rec.gated.map((r) => r.px)),
				],
				ms: out.ms,
			};
			const r = out.result;
			console.log(
				`  cues: ${out.cues.length} (${Object.entries(
					(row.cues as { cueKinds: Record<string, number> }).cueKinds,
				)
					.map(([k, v]) => `${k} ${v}`)
					.join(
						", ",
					)}); ${out.accepted && !low ? "ACCEPTED" : "rejected"}${low ? " (LOW)" : ""}`,
			);
			if (r)
				console.log(
					`    freed ${JSON.stringify(r.freed)} shift [${r.eyeShift.map((x) => fmt(x, 1)).join(", ")}] m (${fmt(r.eyeShiftSigmaH, 1)}σH) fScale ${fmt(r.cam.intr.fScale, 4)} (z ${fmt(r.focalZ, 1)}) edgeBias ${fmt(r.edgeBiasPx)} | sky ${fmt(r.skylineRmsBefore)}→${fmt(r.skylineRmsAfter)} (terrarium ${fmt(baseSky.rmsInl)}→${fmt(rawSky.rmsInl)}) cue ${fmt(r.cueRmsBefore)}→${fmt(r.cueRmsAfter)} | pins med ${fmt(median(rec.base.map((x) => x.px)))} → raw ${fmt(median(rec.raw.map((x) => x.px)))} → gated ${fmt(median(rec.gated.map((x) => x.px)))} | ${out.ms} ms`,
				);
			console.log(`    ${out.reasons.join("; ")}`);
		}

		// ---- LOO modes
		for (const m of ["pins", "cuespins"] as const) {
			if (!modes.includes(m) || S.pins.length < 2) continue;
			const rec: Rec = { base: baseRes, raw: [], gated: [] };
			const folds: unknown[] = [];
			for (let i = 0; i < S.pins.length; i++) {
				const train = S.pins
					.filter((_, j) => j !== i)
					.map((p) => pinCue(p, S.base.aspect));
				const inp: JointInput = {
					...S.inpBase,
					cues: m === "pins" ? train : [...lastCues, ...train],
				};
				const r = await solveJoint(inp, jointOpts);
				let g: JointResult;
				if (m === "pins") {
					// no holdout evidence exists inside the fold: sanity rules only (labelled)
					g = gate(r, undefined, {
						crossCheck: {
							pass: true,
							folds: [],
							reason: "pins mode: sanity rules only",
						},
					});
				} else {
					const cc = await cueCrossCheck(inp, jointOpts);
					g = gate(r, undefined, { crossCheck: cc });
				}
				const gatedCam = !low && g.accepted ? g.cam : S.base;
				rec.raw.push(score(r.cam, [S.pins[i]])[0]);
				rec.gated.push(score(gatedCam, [S.pins[i]])[0]);
				folds.push({
					pin: S.pins[i].id,
					band: bandOfPin(S.pins[i]),
					base: +baseRes[i].px.toFixed(2),
					raw: +rec.raw[i].px.toFixed(2),
					gated: +rec.gated[i].px.toFixed(2),
					accepted: g.accepted && !low,
					freed: r.freed,
					shift: r.eyeShift.map((x) => +x.toFixed(1)),
					fScale: +r.cam.intr.fScale.toFixed(4),
					sky: [+r.skylineRmsBefore.toFixed(2), +r.skylineRmsAfter.toFixed(2)],
					why: g.reasons.filter((x) => x.startsWith("REJECT")),
				});
			}
			add(`${start}/${m}`, photo, rec);
			row[m] = folds;
			console.log(
				`  ${m} LOO: pins med ${fmt(median(rec.base.map((x) => x.px)))} → raw ${fmt(median(rec.raw.map((x) => x.px)))} → gated ${fmt(median(rec.gated.map((x) => x.px)))}; accepted ${folds.filter((f) => (f as { accepted: boolean }).accepted).length}/${folds.length}`,
			);
		}
		row.ms = Date.now() - T0;
		perPhoto.push(row);
		console.log(
			`  (${row.ms} ms; horizons computed ${hzComputed}, ${(hzMs / 1000).toFixed(1)} s total)`,
		);
	}
}

// ---------------------------------------------------------------- report

const tables: Record<string, unknown> = {};
const criteria: Record<string, unknown> = {};
console.log(
	`\n\nDEV pins (px @1600), median / p90 (n); bands by pin distance from the GT eye. DEM ${dem}.`,
);
console.log(
	`${"run".padEnd(24)}${DISTANCE_BANDS.map((b) => pad(b, 18)).join("")}${pad("all", 18)}`,
);
for (const [key, byPhoto] of Object.entries(results)) {
	const all = (k: keyof Rec) => Object.values(byPhoto).flatMap((r) => r[k]);
	const t: Record<string, ReturnType<typeof bandTable>> = {};
	for (const k of ["base", "raw", "gated"] as const) {
		const bt = bandTable(all(k));
		t[k] = bt;
		console.log(
			`${`${key} ${k}`.padEnd(24)}${DISTANCE_BANDS.map((b) => pad(`${fmt(bt.byBand[b].medPx)}/${fmt(bt.byBand[b].p90Px, 1)} (${bt.byBand[b].n})`, 18)).join("")}${pad(`${fmt(bt.all.medPx)}/${fmt(bt.all.p90Px, 1)} (${bt.all.n})`, 18)}`,
		);
	}
	tables[key] = t;
	// per-photo p90 regressions
	const reg = (k: "raw" | "gated") =>
		Object.entries(byPhoto)
			.map(([p, r]) => ({
				p,
				d:
					quantile(
						r[k].map((x) => x.px),
						0.9,
					) -
					quantile(
						r.base.map((x) => x.px),
						0.9,
					),
			}))
			.filter((x) => x.d > 1);
	const drop = (k: "raw" | "gated", b: string) => {
		const b0 = t.base.byBand[b as keyof typeof t.base.byBand].medPx;
		const b1 = t[k].byBand[b as keyof typeof t.base.byBand].medPx;
		return (b0 - b1) / b0;
	};
	criteria[key] = Object.fromEntries(
		(["raw", "gated"] as const).map((k) => [
			k,
			{
				"0.5-2km drop": drop(k, "0.5-2km"),
				"<0.5km drop": drop(k, "<0.5km"),
				"all drop": (t.base.all.medPx - t[k].all.medPx) / t.base.all.medPx,
				p90Regressions: reg(k).map((x) => `${x.p} +${x.d.toFixed(1)}`),
			},
		]),
	);
	for (const k of ["raw", "gated"] as const) {
		const c = (criteria[key] as Record<string, Record<string, unknown>>)[k];
		console.log(
			`   ${k}: 0.5-2km drop ${fmt(100 * (c["0.5-2km drop"] as number), 0)}% (need ≥30), <0.5km drop ${fmt(100 * (c["<0.5km drop"] as number), 0)}% (need ≥20), all ${fmt(100 * (c["all drop"] as number), 0)}%, photo p90 regressions > 1 px: ${(c.p90Regressions as string[]).join(", ") || "none"}`,
		);
	}
}
fs.mkdirSync(OUT, { recursive: true });
const outFile = path.join(OUT, `eval-${tag}.json`);
fs.writeFileSync(
	outFile,
	JSON.stringify(
		{ args: process.argv.slice(2), dem, jointOpts, perPhoto, tables, criteria },
		null,
		1,
	),
);
console.log(
	`\nwrote ${outFile}; horizons computed ${hzComputed} (${(hzMs / 1000).toFixed(1)} s)`,
);
void IDENTITY_INTRINSICS;

/**
 * Concordance evaluation library (WP-A). CPU-only, node. Other concord packages import this:
 *
 *   import { baselineCam, loadPins, scorePins, bandTable, looScore } from "<repo>/scripts/concord/lib";
 *
 * Scene frame (every photo): local ENU at the GT lat/lon, z = altitude − GT eye altitude, with the
 * app's curvature + refraction drop d²/(2·R_eff) folded into z (as computeHorizon/apparentElevation).
 * The GT camera therefore has eye = [0,0,0]; a candidate that moves the eye sets
 * cam.eye = [dE, dN, dU] (metres) in this frame.
 *
 * Pixel units: the 1600 basis (long side = 1600 px), as in data/control-points.json.
 * Split: per PHOTO, frozen in tools/concord/pins/PROTOCOL.txt ("SPLIT <photo> dev|holdout" lines).
 */
import fs from "node:fs";
import path from "node:path";
import { cameraToPose, type Pose, vfovFromFocal } from "../../src/lib/camera";
import {
	type BandStat,
	type CameraX,
	type ConcordReport,
	DISTANCE_BANDS,
	type DistanceBand,
	distanceBand,
	IDENTITY_INTRINSICS,
	type InteriorPin,
	invertField,
	type PinResidual,
	projectX,
	RADIUS_BANDS,
	type RadiusBand,
	type ResidualField,
	radiusBand,
	sampleField,
	unprojectDirX,
	type Vec3,
} from "../../src/lib/concord/core";
import {
	MAPTERHORN,
	TERRARIUM_AWS,
	type TerrainLevel,
} from "../../src/lib/dem";
import { computeHorizon, type HorizonProfile } from "../../src/lib/geo/horizon";
import { levenbergMarquardt } from "../../src/lib/geo/lm";
import { parseOverpassPeaks, viewPeaks } from "../../src/lib/geo/peaks";
import { detectSkyline } from "../../src/lib/geo/skyline";
import { horizonAt, solvePose } from "../../src/lib/geo/solve";
import { loadTerrain, type TerrainSampler } from "../../src/lib/geo/terrain";
import {
	destination,
	distanceBearing,
	EARTH_R,
	REFRACTION_K,
} from "../../src/lib/geodesy";
import {
	demTileLoaderNode,
	heicToJpeg,
	IMG_DIR,
	loadRGBA,
	ROOT,
} from "../lib/node-io";

const DEG = Math.PI / 180;
export const R_EFF = EARTH_R / (1 - REFRACTION_K);
export const PINS_DIR = path.join(ROOT, "tools", "concord", "pins");
export const PROTOCOL_FILE = path.join(PINS_DIR, "PROTOCOL.txt");
export const INTERIOR_PINS_FILE = path.join(PINS_DIR, "interior-pins.json");
export const GT_FILE = path.join(ROOT, "data", "ground-truth.json");
export const CP_FILE = path.join(ROOT, "data", "control-points.json");
export const EVAL_OUT = path.join(ROOT, "out", "concord", "eval");
const CACHE_DIR = path.join(EVAL_OUT, "cache");

// ---------------------------------------------------------------- ground truth & split

export type GroundTruth = {
	width: number;
	height: number;
	yaw: number | null;
	pitch: number | null;
	roll: number | null;
	f: number | null;
	quality: "good" | "approx" | "none";
	eye: number;
	eyeSource: string;
	demGround: number;
	gpsAltitude?: number;
	lat: number;
	lon: number;
	notes?: string;
};

let gtMemo: Record<string, GroundTruth> | undefined;
export function loadGT(): Record<string, GroundTruth> {
	gtMemo ??= JSON.parse(fs.readFileSync(GT_FILE, "utf8"));
	return gtMemo as Record<string, GroundTruth>;
}

/** Photos with a stored GT pose (the 14 evaluation photos). */
export const gtPhotos = () =>
	Object.keys(loadGT())
		.filter((n) => loadGT()[n].yaw !== null)
		.sort();

export type Split = "dev" | "holdout";
/** The frozen per-photo split, parsed from PROTOCOL.txt. */
export function loadSplit(): Record<string, Split> {
	const out: Record<string, Split> = {};
	for (const line of fs.readFileSync(PROTOCOL_FILE, "utf8").split("\n")) {
		const m = line.match(/^SPLIT\s+(\S+)\s+(dev|holdout)\b/);
		if (m) out[m[1]] = m[2] as Split;
	}
	return out;
}

// ---------------------------------------------------------------- scene

export type Scene = {
	photo: string;
	g: GroundTruth;
	lat: number;
	lon: number;
	/** GT eye altitude (m): origin of the scene frame. */
	eyeAlt: number;
	width: number;
	height: number;
	aspect: number;
	terrain: TerrainSampler;
	/** Horizon (Terrarium, computeHorizon) from the GT eye. */
	horizon: HorizonProfile;
	/** Terrarium ground at the GT lat/lon (current cache). */
	groundTerrarium: number;
	/** Mapterhorn ground at the GT lat/lon (finest zoom available, z17→z12), null if unavailable. */
	groundMapterhorn: { h: number; z: number } | null;
};

const terrariumTiles = new Map<string, Float32Array>();
const loadTerrariumTile = demTileLoaderNode(TERRARIUM_AWS);
const loadMapterhornTile = demTileLoaderNode(MAPTERHORN);
const mapterhornTiles = new Map<string, Float32Array>();
const MH_ZOOMS = [17, 16, 15, 14, 13, 12];

/** Mapterhorn height at a point, finest zoom that has data (tiles cached in .cache/dem-mapterhorn). */
export async function mapterhornHeight(
	lat: number,
	lon: number,
): Promise<{ h: number; z: number } | null> {
	if (process.env.CONCORD_OFFLINE === "1") return null;
	try {
		const levels: TerrainLevel[] = MH_ZOOMS.map((z) => ({
			z,
			maxDistance: 20,
		}));
		const t = await loadTerrain(
			lat,
			lon,
			loadMapterhornTile,
			levels,
			mapterhornTiles,
			6,
			MAPTERHORN.tileSize,
		);
		for (const z of MH_ZOOMS) {
			const h = t.sample(lon, lat, z);
			if (Number.isFinite(h)) return { h, z };
		}
	} catch (e) {
		console.error(`mapterhorn ${lat},${lon}: ${(e as Error).message}`);
	}
	return null;
}

function cachedHorizon(
	key: string,
	make: () => HorizonProfile,
): HorizonProfile {
	const file = path.join(CACHE_DIR, `horizon_${key}.json`);
	if (fs.existsSync(file)) {
		const j = JSON.parse(fs.readFileSync(file, "utf8"));
		return {
			step: j.step,
			elevation: Float32Array.from(j.elevation),
			distance: Float32Array.from(j.distance),
			ridges: j.ridges,
		};
	}
	const h = make();
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({
			step: h.step,
			elevation: Array.from(h.elevation),
			distance: Array.from(h.distance),
			ridges: h.ridges,
		}),
	);
	return h;
}

const sceneMemo = new Map<string, Promise<Scene>>();
export function loadScene(photo: string): Promise<Scene> {
	let p = sceneMemo.get(photo);
	if (!p) {
		p = (async () => {
			const g = loadGT()[photo];
			if (!g || g.yaw === null) throw new Error(`${photo}: no GT pose`);
			const terrain = await loadTerrain(
				g.lat,
				g.lon,
				loadTerrariumTile,
				TERRARIUM_AWS.levels,
				terrariumTiles,
			);
			const horizon = cachedHorizon(`${photo}_${g.eye.toFixed(1)}`, () =>
				computeHorizon(terrain, g.lat, g.lon, g.eye),
			);
			return {
				photo,
				g,
				lat: g.lat,
				lon: g.lon,
				eyeAlt: g.eye,
				width: g.width,
				height: g.height,
				aspect: g.width / g.height,
				terrain,
				horizon,
				groundTerrarium: terrain.ground(g.lon, g.lat),
				groundMapterhorn: await mapterhornHeight(g.lat, g.lon),
			};
		})();
		sceneMemo.set(photo, p);
	}
	return p;
}

/** Scene-frame ENU of an absolute (lat, lon, altitude h). */
export function enuOf(s: Scene, lat: number, lon: number, h: number): Vec3 {
	const { distance: d, bearing: az } = distanceBearing(s.lat, s.lon, lat, lon);
	return [
		d * Math.sin(az * DEG),
		d * Math.cos(az * DEG),
		h - s.eyeAlt - (d * d) / (2 * R_EFF),
	];
}

/**
 * Pin coordinates → uv. Pin basis 1600 = image WIDTH 1600 px (the data/control-points.json and
 * engine.ts convention; portrait photos are 1600 × 2133).
 */
export const pinUV = (
	x: number,
	y: number,
	aspect: number,
): [number, number] => [x / 1600, (y * aspect) / 1600];

/** Residual pixel basis: long side = 1600 px (the audit's "px @1600"). */
export const basis1600 = (aspect: number) =>
	aspect >= 1 ? { W: 1600, H: 1600 / aspect } : { W: 1600 * aspect, H: 1600 };

// ---------------------------------------------------------------- cameras

/** GT pose (data/ground-truth.json yaw/pitch/roll/f) with the GT eye (scene origin, eye = [0,0,0]). */
export function gtCam(photo: string): CameraX {
	const g = loadGT()[photo];
	if (!g || g.yaw === null || g.f === null) throw new Error(`${photo}: no GT`);
	const pose: Pose = {
		yaw: g.yaw,
		pitch: g.pitch as number,
		roll: g.roll as number,
		vfov: vfovFromFocal(g.f, g.height),
	};
	return {
		pose,
		eye: [0, 0, 0],
		aspect: g.width / g.height,
		intr: { ...IDENTITY_INTRINSICS },
	};
}

export type AppSolve = {
	cam: CameraX;
	accepted: boolean;
	confidence: number;
	appEyeAlt: number;
};
const appMemo = new Map<string, Promise<AppSolve>>();
/**
 * The app's automatic baseline, reproduced exactly as scripts/eval.ts (SOLVER=solve, HORIZON=classic,
 * DEM=terrarium defaults): photoContext prior + eye rule max(GPS, DEM+1.6) → detectSkyline on the
 * 800 px working image → solvePose. The eye is expressed in the GT scene frame.
 */
export function appSolve(photo: string): Promise<AppSolve> {
	let p = appMemo.get(photo);
	if (!p) {
		p = (async () => {
			const { photoContext } = await import("../lib/pipeline-node");
			const heic = path.join(IMG_DIR, `${photo}.HEIC`);
			const ctx = await photoContext(photo, heic);
			const img = await loadRGBA(heicToJpeg(heic, 1600), 800);
			const res = solvePose(ctx.prior, ctx.horizon, detectSkyline(img));
			const s = await loadScene(photo);
			const e = enuOf(s, ctx.meta.lat as number, ctx.meta.lon as number, 0);
			const g = loadGT()[photo];
			if (res.camera.width !== g.width)
				console.error(
					`${photo}: app camera ${res.camera.width}×${res.camera.height} vs GT ${g.width}×${g.height}`,
				);
			return {
				cam: {
					pose: cameraToPose(res.camera),
					eye: [e[0], e[1], ctx.eye - s.eyeAlt],
					aspect: res.camera.width / res.camera.height,
					intr: { ...IDENTITY_INTRINSICS },
				},
				accepted: res.accepted,
				confidence: res.confidence,
				appEyeAlt: ctx.eye,
			};
		})();
		appMemo.set(photo, p);
	}
	return p;
}

/**
 * Baseline camera for a photo. mode "gt" (default): the GT pose + GT eye from ground-truth.json —
 * this is the pose the concordance audit measured. mode "app": the app's automatic skyline solve
 * (appSolve) with the app eye rule.
 */
export async function baselineCam(
	photo: string,
	mode: "gt" | "app" = "gt",
): Promise<CameraX> {
	return mode === "gt" ? gtCam(photo) : (await appSolve(photo)).cam;
}

// ---------------------------------------------------------------- pins

export type EvalPin = InteriorPin & {
	/** Scene-frame ENU (for level pins: the waterline point at lake level). */
	enu: Vec3;
	/** Horizontal distance from the GT eye (m). */
	distM: number;
	origin: "control-points" | "interior-pins";
	label: string;
};

type CpPoint = {
	x: number;
	y: number;
	peak?: string;
	az?: number;
	el?: number;
	level?: boolean;
	label?: string;
};

/** First terrain hit along (az, el) from the GT eye (audit ray march). */
function rayHit(s: Scene, az: number, el: number) {
	const t = Math.tan(el * DEG);
	const rel = (d: number) => {
		const p = destination(s.lat, s.lon, az, d);
		return (
			s.terrain.sampleAt(p.lon, p.lat, d) - s.eyeAlt - (d * d) / (2 * R_EFF)
		);
	};
	let prev = 0;
	for (let d = 15; d < 150000; d += Math.max(5, d * 0.004)) {
		const r = rel(d);
		if (Number.isNaN(r)) return null;
		if (r >= d * t) {
			let a = prev;
			let b = d;
			for (let k = 0; k < 16; k++) {
				const m = (a + b) / 2;
				if (rel(m) >= m * t) b = m;
				else a = m;
			}
			return { d: b, ...destination(s.lat, s.lon, az, b) };
		}
		prev = d;
	}
	return null;
}

const azEl = (d: ArrayLike<number>) => [
	(((Math.atan2(d[0], d[1]) / DEG) % 360) + 360) % 360,
	Math.asin(Math.max(-1, Math.min(1, d[2]))) / DEG,
];

/** Convert one photo's data/control-points.json entries to eval pins (peaks, DEM notches, waterlines). */
export async function controlPointPins(
	photo: string,
	split: Split,
): Promise<EvalPin[]> {
	const cp = JSON.parse(fs.readFileSync(CP_FILE, "utf8"))[photo];
	if (!cp?.points?.length) return [];
	const s = await loadScene(photo);
	const sc = 1600 / (cp.basis ?? 1600);
	const out: EvalPin[] = [];
	let views: ReturnType<typeof viewPeaks> | undefined;
	const peakViews = () => {
		if (!views) {
			const key = `${s.lat.toFixed(2)},${s.lon.toFixed(2)},80km`;
			const file = path.join(ROOT, ".cache", "overpass", `${key}.json`);
			const peaks = parseOverpassPeaks(
				JSON.parse(fs.readFileSync(file, "utf8")),
			);
			views = viewPeaks(peaks, s.terrain, s.lat, s.lon, s.eyeAlt);
		}
		return views;
	};
	for (const [i, sp] of (cp.points as CpPoint[]).entries()) {
		const x = sp.x * sc;
		const y = sp.y * sc;
		const common = {
			photo,
			id: `cp:${photo}:${i}`,
			x,
			y,
			basis: 1600 as const,
			split,
			origin: "control-points" as const,
			label: sp.label ?? sp.peak ?? "",
		};
		if (sp.level) {
			const [pu, pv] = pinUV(x, y, s.aspect);
			const dir = unprojectDirX(gtCam(photo), pu, pv);
			const [az] = azEl(dir);
			const hit = rayHit(s, az, sp.el as number);
			if (!hit) {
				console.error(`${common.id} (${common.label}): waterline ray miss`);
				continue;
			}
			const lakeM =
				s.eyeAlt +
				hit.d * Math.tan((sp.el as number) * DEG) +
				(hit.d * hit.d) / (2 * R_EFF);
			out.push({
				...common,
				lat: hit.lat,
				lon: hit.lon,
				level: { lakeM },
				kind: "waterline",
				source: "manual",
				note: `control-points level el=${sp.el}°`,
				enu: enuOf(s, hit.lat, hit.lon, lakeM),
				distM: hit.d,
			});
		} else if (sp.peak) {
			const m = peakViews()
				.filter((v) => v.peak.id === sp.peak || v.peak.name === sp.peak)
				.sort((a, b) => a.distance - b.distance)[0];
			if (!m) {
				console.error(`${common.id}: peak ${sp.peak} not found`);
				continue;
			}
			out.push({
				...common,
				lat: m.peak.lat,
				lon: m.peak.lon,
				h: m.height,
				kind: "summit",
				source: "osm",
				enu: enuOf(s, m.peak.lat, m.peak.lon, m.height),
				distM: m.distance,
			});
		} else if (sp.az !== undefined) {
			const hz = s.horizon;
			const k =
				Math.round((((sp.az % 360) + 360) % 360) / hz.step) %
				hz.elevation.length;
			const el = sp.el ?? hz.elevation[k];
			const d = hz.distance[k];
			const p = destination(s.lat, s.lon, sp.az, d);
			const h = s.eyeAlt + d * Math.tan(el * DEG) + (d * d) / (2 * R_EFF);
			out.push({
				...common,
				lat: p.lat,
				lon: p.lon,
				h,
				kind: "notch",
				source: "manual",
				note: `DEM skyline az=${sp.az}${sp.el === undefined ? " (el from DEM horizon)" : ` el=${sp.el}`}`,
				enu: enuOf(s, p.lat, p.lon, h),
				distM: d,
			});
		}
	}
	return out;
}

/** Interior pins clicked by the user (tools/concord/pins/interior-pins.json). */
export async function interiorPins(
	photo: string,
	split: Split,
): Promise<EvalPin[]> {
	if (!fs.existsSync(INTERIOR_PINS_FILE)) return [];
	const all = JSON.parse(fs.readFileSync(INTERIOR_PINS_FILE, "utf8"))
		.points as InteriorPin[];
	const mine = all.filter((p) => p.photo === photo);
	if (!mine.length) return [];
	const s = await loadScene(photo);
	const out: EvalPin[] = [];
	for (const p of mine) {
		if (p.split !== split)
			console.error(
				`${p.id}: split ${p.split} ≠ PROTOCOL ${split}; using PROTOCOL`,
			);
		let h: number;
		if (p.level) h = p.level.lakeM;
		else if (p.h !== undefined) h = p.h;
		else {
			const g =
				(await mapterhornHeight(p.lat, p.lon))?.h ??
				s.terrain.sampleAt(p.lon, p.lat, 0);
			h = g + (p.hAbove ?? 0);
		}
		const enu = enuOf(s, p.lat, p.lon, h);
		out.push({
			...p,
			split,
			enu,
			distM: Math.hypot(enu[0], enu[1]),
			origin: "interior-pins",
			label: p.note ?? p.id,
		});
	}
	return out;
}

export type PinSource = "control-points" | "interior-pins";
/**
 * All eval pins for the given photos (default: the 14 GT photos), filtered by split
 * ("dev" default — tuning; "holdout" only for a final, once-only report; "all" for audits).
 */
export async function loadPins(
	opts: {
		photos?: string[];
		split?: Split | "all";
		sources?: PinSource[];
	} = {},
): Promise<EvalPin[]> {
	const splits = loadSplit();
	const want = opts.split ?? "dev";
	const sources = opts.sources ?? ["control-points", "interior-pins"];
	const out: EvalPin[] = [];
	for (const photo of opts.photos ?? gtPhotos()) {
		const sp = splits[photo];
		if (!sp) throw new Error(`${photo}: not in PROTOCOL.txt split`);
		if (want !== "all" && sp !== want) continue;
		if (sources.includes("control-points"))
			out.push(...(await controlPointPins(photo, sp)));
		if (sources.includes("interior-pins"))
			out.push(...(await interiorPins(photo, sp)));
	}
	return out;
}

// ---------------------------------------------------------------- scoring

export type EvalResidual = PinResidual & {
	photo: string;
	level: boolean;
	behind: boolean;
	label: string;
};

const invMemo = new WeakMap<ResidualField, ResidualField>();

/**
 * Residuals (px @1600, predicted − observed) of `pins` under `cam`. Level pins are elevation-only:
 * dx = 0, dy = f·(el(observed pixel) − el(lake point)). With `field` (display W: render = photo + W),
 * the drawn position is r + W⁻¹(r) where r is the camera projection. Pins behind the camera get
 * px = 1e4 and behind = true.
 */
export function scorePins(
	cam: CameraX,
	pins: EvalPin[],
	field?: ResidualField,
): EvalResidual[] {
	const { W, H } = basis1600(cam.aspect);
	const fPx = (H / 2 / Math.tan((cam.pose.vfov * DEG) / 2)) * cam.intr.fScale;
	let inv: ResidualField | undefined;
	if (field) {
		inv = invMemo.get(field);
		if (!inv) {
			inv = invertField(field);
			invMemo.set(field, inv);
		}
	}
	return pins.map((p) => {
		const [u, v] = pinUV(p.x, p.y, cam.aspect);
		const rel: Vec3 = [
			p.enu[0] - cam.eye[0],
			p.enu[1] - cam.eye[1],
			p.enu[2] - cam.eye[2],
		];
		const distM = Math.hypot(rel[0], rel[1]);
		let dx = 0;
		let dy = 0;
		let behind = false;
		if (p.level) {
			let uu = u;
			let vv = v;
			if (inv) {
				// the photo pixel is shown at render r = p + W(p); evaluate its ray there
				const [wu, wv] = sampleField(field as ResidualField, u, v);
				uu += wu;
				vv += wv;
			}
			const [, elObs] = azEl(unprojectDirX(cam, uu, vv));
			const elT = Math.atan2(rel[2], distM) / DEG;
			dy = fPx * (elObs - elT) * DEG;
		} else {
			const q = projectX(cam, p.enu);
			if (!q) {
				behind = true;
				dx = 1e4;
				dy = 1e4;
			} else {
				let qu = q.u;
				let qv = q.v;
				if (inv) {
					const [iu, iv] = sampleField(inv, qu, qv);
					qu += iu;
					qv += iv;
				}
				dx = (qu - u) * W;
				dy = (qv - v) * H;
			}
		}
		return {
			id: p.id,
			photo: p.photo,
			label: p.label,
			dxPx: dx,
			dyPx: dy,
			px: Math.hypot(dx, dy),
			distM,
			band: distanceBand(distM),
			radius: radiusBand(u, v, cam.aspect),
			level: !!p.level,
			behind,
		};
	});
}

/** Median (mean of the middle two) of finite values; NaN if empty. */
export function median(a: number[]): number {
	const s = a.filter(Number.isFinite).sort((x, y) => x - y);
	if (!s.length) return Number.NaN;
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Nearest-rank quantile. */
export function quantile(a: number[], q: number): number {
	const s = a.filter(Number.isFinite).sort((x, y) => x - y);
	if (!s.length) return Number.NaN;
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}
const stat = (px: number[]): BandStat => ({
	n: px.length,
	medPx: median(px),
	p90Px: quantile(px, 0.9),
});

/** Per distance band and radius band stats of residuals. */
export function bandTable(res: PinResidual[]): {
	byBand: Record<DistanceBand, BandStat>;
	byRadius: Record<RadiusBand, BandStat>;
	all: BandStat;
} {
	const byBand = Object.fromEntries(
		DISTANCE_BANDS.map((b) => [
			b,
			stat(res.filter((r) => r.band === b).map((r) => r.px)),
		]),
	) as Record<DistanceBand, BandStat>;
	const byRadius = Object.fromEntries(
		RADIUS_BANDS.map((b) => [
			b,
			stat(res.filter((r) => r.radius === b).map((r) => r.px)),
		]),
	) as Record<RadiusBand, BandStat>;
	return { byBand, byRadius, all: stat(res.map((r) => r.px)) };
}

export function concordReport(
	photo: string,
	res: PinResidual[],
	skylineRmsPx?: number,
): ConcordReport {
	const { byBand, byRadius } = bandTable(res);
	return { photo, n: res.length, byBand, byRadius, skylineRmsPx };
}

/**
 * The audit's comparison bands: pins < 6.5 km and > 15 km. Level (waterline) pins have no stored
 * distance in the audit and are excluded from both, as there.
 */
export function auditBands(res: EvalResidual[]) {
	const pts = res.filter((r) => !r.level);
	return {
		"<6.5km": stat(pts.filter((r) => r.distM < 6500).map((r) => r.px)),
		">15km": stat(pts.filter((r) => r.distM > 15000).map((r) => r.px)),
		waterline: stat(res.filter((r) => r.level).map((r) => r.px)),
	};
}

// ---------------------------------------------------------------- skyline

const skyObsMemo = new Map<
	string,
	Promise<{ u: number; v: number; w: number }[]>
>();
function skylineObs(photo: string) {
	let p = skyObsMemo.get(photo);
	if (!p) {
		p = (async () => {
			const heic = path.join(IMG_DIR, `${photo}.HEIC`);
			const img = await loadRGBA(heicToJpeg(heic, 1600));
			const sky = detectSkyline(img);
			const obs: { u: number; v: number; w: number }[] = [];
			for (let x = 0; x < img.width; x += 2) {
				const y = sky.rows[x];
				if (!Number.isFinite(y) || sky.weight[x] < 0.3) continue;
				obs.push({
					u: (x + 0.5) / img.width,
					v: y / img.height,
					w: sky.weight[x],
				});
			}
			return obs;
		})();
		skyObsMemo.set(photo, p);
	}
	return p;
}

/**
 * Skyline residuals (px @1600, elevation-only) of detectSkyline vs the DEM horizon under `cam`.
 * The horizon is recomputed when the eye moves > 0.5 m. rmsInl = RMS over |r| < 30 px.
 */
export async function skylineRms(
	photo: string,
	cam: CameraX,
): Promise<{ rmsInl: number; medAbs: number; inlierFrac: number; n: number }> {
	const s = await loadScene(photo);
	let hz = s.horizon;
	if (Math.hypot(...cam.eye) > 0.5) {
		const d = Math.hypot(cam.eye[0], cam.eye[1]);
		const az = Math.atan2(cam.eye[0], cam.eye[1]) / DEG;
		const p =
			d > 0 ? destination(s.lat, s.lon, az, d) : { lat: s.lat, lon: s.lon };
		const alt = s.eyeAlt + cam.eye[2];
		hz = cachedHorizon(
			`${photo}_${p.lat.toFixed(6)}_${p.lon.toFixed(6)}_${alt.toFixed(1)}`,
			() => computeHorizon(s.terrain, p.lat, p.lon, alt),
		);
	}
	const { H } = basis1600(cam.aspect);
	const fPx = (H / 2 / Math.tan((cam.pose.vfov * DEG) / 2)) * cam.intr.fScale;
	const r = (await skylineObs(photo)).map((o) => {
		const [az, el] = azEl(unprojectDirX(cam, o.u, o.v));
		return (el - horizonAt(hz, az)) * DEG * fPx;
	});
	const inl = r.filter((x) => Math.abs(x) < 30);
	return {
		rmsInl: Math.sqrt(
			inl.reduce((a, x) => a + x * x, 0) / Math.max(1, inl.length),
		),
		medAbs: median(r.map(Math.abs)),
		inlierFrac: inl.length / Math.max(1, r.length),
		n: r.length,
	};
}

// ---------------------------------------------------------------- leave-one-out

/** A fit that must not see the held-out pin: returns the camera to score it with. */
export type FitWithout = (
	photo: string,
	train: EvalPin[],
	base: CameraX,
) => CameraX | Promise<CameraX>;

/** Leave-one-out over one photo's pins: fit on pins \ i, score pin i. */
export async function looScore(
	fit: FitWithout,
	pins: EvalPin[],
	base: CameraX,
	field?: (train: EvalPin[]) => ResidualField | undefined,
): Promise<EvalResidual[]> {
	const out: EvalResidual[] = [];
	for (let i = 0; i < pins.length; i++) {
		const train = pins.filter((_, j) => j !== i);
		const cam = await fit(pins[i].photo, train, base);
		out.push(scorePins(cam, [pins[i]], field?.(train))[0]);
	}
	return out;
}

/**
 * Built-in reference fits (sanity baselines for LOO, not WP-D): refit yaw/pitch/roll ("rot") or
 * yaw/pitch/roll/focal ("rotf") on the training pins, Cauchy loss, starting from `base`.
 * Needs ≥ 2 (rot) / ≥ 3 (rotf) training pins, else returns `base`.
 */
export function builtinFit(kind: "rot" | "rotf"): FitWithout {
	return (_photo, train, base) => {
		const nParam = kind === "rot" ? 3 : 4;
		if (train.length < nParam - 1) return base;
		const camOf = (q: number[]): CameraX => ({
			...base,
			pose: {
				yaw: q[0],
				pitch: q[1],
				roll: q[2],
				vfov: base.pose.vfov,
			},
			intr: { ...base.intr, fScale: kind === "rotf" ? q[3] : base.intr.fScale },
		});
		const fn = (q: number[]) =>
			scorePins(camOf(q), train).flatMap((r) =>
				r.level ? [r.dyPx] : [r.dxPx, r.dyPx],
			);
		const p0 = [base.pose.yaw, base.pose.pitch, base.pose.roll];
		if (kind === "rotf") p0.push(base.intr.fScale);
		const r = levenbergMarquardt(fn, p0, {
			steps: [1e-4, 1e-4, 1e-4, 1e-5].slice(0, nParam),
			maxIterations: 50,
			cauchy: 4,
		});
		return camOf(r.params);
	};
}

// ---------------------------------------------------------------- candidates

/** Candidate file written by another package: { cam: CameraX, field?: ResidualField(JSON arrays ok) }. */
export function readCandidate(file: string): {
	cam: CameraX;
	field?: ResidualField;
} {
	const j = JSON.parse(fs.readFileSync(file, "utf8"));
	const cam = j.cam as CameraX;
	cam.intr = { ...IDENTITY_INTRINSICS, ...(cam.intr ?? {}) };
	let field: ResidualField | undefined;
	if (j.field) {
		const f = j.field;
		field = {
			...f,
			du: Float32Array.from(f.du),
			dv: Float32Array.from(f.dv),
			sigmaPx: Float32Array.from(f.sigmaPx ?? new Array(f.w * f.h).fill(0)),
		};
	}
	return { cam, field };
}

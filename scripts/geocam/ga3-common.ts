/**
 * GA3 shared helpers (Agent D): rastered scene-frame DEM, photo loading (GT dev + wild dev), and the eye
 * scorer used by ga3-synth.ts and ga3-dev.ts. CPU-only, node, no renders, no live services.
 *
 * Scene frame (as scripts/concord/lib.ts): local ENU at the photo fix, z = altitude − eyeAlt with the
 * curvature + refraction drop r²/(2·R_eff) (k = 0.13) folded in; the reference camera has eye [0,0,0].
 *
 * Eye scorer (frozen in tools/research/geo/PROTOCOL.txt, GA3 section) for a candidate eye (E, N) with
 * U = ground(E, N) + (reference height above ground):
 *   1. layeredHorizon from the eye over the reference sector (+3°), step 0.05°, 20 m → 150 km;
 *   2. predictJunctions (near 200–3000 m, crossing ≥ 20°, in frame);
 *   3. rotation re-fit (yaw, pitch, roll; focal fixed at the reference): 3 robust Gauss–Newton steps on
 *      the junction contour samples + skyline samples (one per 0.5°), each re-measured on the photo edges
 *      (searchAlongNormal, ±12 px @1600), Cauchy c = 3 px;
 *   4. cost = mean over predicted junctions of min(e_near², τ²) + min(e_far², τ²), τ = 6 px (a contour
 *      with < 2 matched samples costs τ²); fewer than 3 predicted junctions ⇒ cost 2τ² (uninformative).
 *   Secondary (reported, not scored): the same with the reference rotation (no re-fit), pair and diff.
 */
import fs from "node:fs";
import path from "node:path";
import type { CameraX, Vec3 } from "../../src/lib/concord/core";
import { IDENTITY_INTRINSICS, projectX } from "../../src/lib/concord/core";
import {
	type PhotoEdges,
	photoEdgesFromRGBA,
	searchAlongNormal,
	thinEdgesMemo,
} from "../../src/lib/concord/cues";
import { MAPTERHORN, type TerrainLevel } from "../../src/lib/dem";
import { loadTerrain, type TerrainSampler } from "../../src/lib/geo/terrain";
import {
	type HeightFn,
	type Junction,
	type LayeredHorizon,
	layeredHorizon,
	measureJunctions,
	predictJunctions,
	sectorOf,
} from "../../src/lib/geocam/tjunc";
import { destination } from "../../src/lib/geodesy";
import { R_EFF } from "../concord/lib";
import {
	demTileLoaderNode,
	heicToJpeg,
	IMG_DIR,
	loadRGBA,
} from "../lib/node-io";
import { FastSampler, gtCam, loadScene, terrainFor, wildDev } from "./lib";

const DEG = Math.PI / 180;

// ---------------------------------------------------------------- rastered DEM

/** Grid rings: spacing (m), radius from the origin served (m), matching the Mapterhorn level choice. */
const RINGS: { sp: number; r: number }[] = [
	{ sp: 2, r: 300 },
	{ sp: 4, r: 1000 },
	{ sp: 8, r: 2500 },
	{ sp: 25, r: 6000 },
	{ sp: 50, r: 15_000 },
	{ sp: 100, r: 40_000 },
	{ sp: 200, r: 150_000 },
];
/** Extra extent of every ring beyond its radius (m): the eye may move this far from the origin. */
const RING_PAD = 450;

export type Raster = {
	h: HeightFn;
	ground: (e: number, n: number) => number;
	ms: number;
};

/**
 * The scene-frame DEM rastered onto nested ENU grids (bilinear), so a layered horizon march costs
 * ~20 ns per sample. Each ring samples the sampler at the level its radius selects (distance from the
 * origin), i.e. the same level the app's march would use from the origin.
 */
export function rasterHeight(
	lat: number,
	lon: number,
	eyeAlt: number,
	t: TerrainSampler,
): Raster {
	const t0 = Date.now();
	const fs_ = new FastSampler(t);
	const grids = RINGS.map((R) => {
		const half = Math.ceil((R.r + RING_PAD) / R.sp);
		const n = 2 * half + 1;
		const z = new Float32Array(n * n);
		for (let iy = 0; iy < n; iy++)
			for (let ix = 0; ix < n; ix++) {
				const e = (ix - half) * R.sp;
				const nn = (iy - half) * R.sp;
				const dO = Math.hypot(e, nn);
				const p =
					dO > 0
						? destination(lat, lon, Math.atan2(e, nn) / DEG, dO)
						: { lat, lon };
				const h = fs_.sampleAt(p.lon, p.lat, Math.min(dO, R.r));
				z[iy * n + ix] = h - eyeAlt - (dO * dO) / (2 * R_EFF);
			}
		return { ...R, half, n, z };
	});
	const h: HeightFn = (e, n) => {
		const r = Math.max(Math.abs(e), Math.abs(n));
		for (const g of grids) {
			if (r > g.r && g !== grids[grids.length - 1]) continue;
			const fx = e / g.sp + g.half;
			const fy = n / g.sp + g.half;
			const x0 = Math.floor(fx);
			const y0 = Math.floor(fy);
			if (x0 < 0 || y0 < 0 || x0 >= g.n - 1 || y0 >= g.n - 1) return Number.NaN;
			const ax = fx - x0;
			const ay = fy - y0;
			const k = y0 * g.n + x0;
			const z = g.z;
			return (
				(z[k] * (1 - ax) + z[k + 1] * ax) * (1 - ay) +
				(z[k + g.n] * (1 - ax) + z[k + g.n + 1] * ax) * ay
			);
		}
		return Number.NaN;
	};
	return { h, ground: (e, n) => h(e, n, 0), ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- photos

export type Ga3Photo = {
	id: string;
	kind: "gt" | "wild";
	lat: number;
	lon: number;
	eyeAlt: number;
	/** Reference camera (eye [0,0,0]): GT pose, or the first correct C0 ref. */
	cam: CameraX;
	raster: Raster;
	/** Photo edges at long side 1600 (lazy). */
	edges: () => Promise<PhotoEdges>;
};

const mhTiles = new Map<string, Float32Array>();
const loadMH = demTileLoaderNode(MAPTERHORN);
const MH_LEVELS: TerrainLevel[] = [
	{ z: 17, maxDistance: 300 },
	...MAPTERHORN.levels,
];

export async function loadGa3Photo(id: string): Promise<Ga3Photo | null> {
	if (id.startsWith("IMG_")) {
		const s = await loadScene(id);
		const t = await terrainFor(s, "mh");
		const cam = gtCam(id);
		let memo: PhotoEdges | undefined;
		return {
			id,
			kind: "gt",
			lat: s.lat,
			lon: s.lon,
			eyeAlt: s.eyeAlt,
			cam,
			raster: rasterHeight(s.lat, s.lon, s.eyeAlt, t),
			edges: async () => {
				if (!memo) {
					const jpg = heicToJpeg(path.join(IMG_DIR, `${id}.HEIC`), 1600);
					const ew = cam.aspect >= 1 ? 1600 : Math.round(1600 * cam.aspect);
					const rgba = await loadRGBA(jpg, ew);
					memo = photoEdgesFromRGBA(rgba.data, rgba.width, rgba.height);
				}
				return memo;
			},
		};
	}
	const w = wildDev(id);
	if (!w) return null;
	const ref = w.meta.correct_refs[0];
	if (!ref) return null;
	const eyeAlt = ref.renderEye[2];
	const t = await loadTerrain(
		w.meta.lat,
		w.meta.lon,
		loadMH,
		MH_LEVELS,
		mhTiles,
		8,
		MAPTERHORN.tileSize,
	);
	const cam: CameraX = {
		pose: {
			yaw: ref.pose.yaw,
			pitch: ref.pose.pitch,
			roll: ref.pose.roll,
			vfov: ref.pose.vfov,
		},
		eye: [0, 0, 0],
		aspect: w.meta.aspect,
		intr: { ...IDENTITY_INTRINSICS },
	};
	let memo: PhotoEdges | undefined;
	return {
		id,
		kind: "wild",
		lat: w.meta.lat,
		lon: w.meta.lon,
		eyeAlt,
		cam,
		raster: rasterHeight(w.meta.lat, w.meta.lon, eyeAlt, t),
		edges: async () => {
			if (!memo) {
				const ew = cam.aspect >= 1 ? 1600 : Math.round(1600 * cam.aspect);
				const rgba = await loadRGBA(w.photoJpg, ew);
				memo = photoEdgesFromRGBA(rgba.data, rgba.width, rgba.height);
			}
			return memo;
		},
	};
}

// ---------------------------------------------------------------- eye scorer

export const SCORER = {
	step: 0.05,
	sectorMarginDeg: 3,
	minNearD: 200,
	maxNearD: 3000,
	minAngleDeg: 20,
	searchPx: 12,
	cauchyPx: 3,
	tauPx: 6,
	skyEveryDeg: 0.5,
	gnIters: 3,
	minJunctions: 3,
	/** AMENDMENT A1 (PROTOCOL GA3): the march and the synthetic cast start at 100 m (DEM foreground cut). */
	minD: 100,
	/** AMENDMENT A2: eye height = mean DEM over a 5 × 5 grid at this spacing (m) + reference height. */
	groundBoxM: 10,
} as const;

/** AMENDMENT A2: DEM smoothed over a 40 m box (5 × 5 at 10 m), so the candidate eye height is continuous. */
export const smoothGround =
	(ph: Ga3Photo) =>
	(e: number, n: number): number => {
		let s = 0;
		const b = SCORER.groundBoxM;
		for (let i = -2; i <= 2; i++)
			for (let j = -2; j <= 2; j++) s += ph.raster.ground(e + b * i, n + b * j);
		return s / 25;
	};

type Sample = {
	w: Vec3;
	n: [number, number];
	jn: number;
	which: "near" | "far" | "sky";
};

export type EyeScore = {
	E: number;
	N: number;
	U: number;
	/** Primary: rotation re-fit, pair residuals. */
	cost: number;
	/** Secondary: reference rotation, pair / diff residuals. */
	costOraclePair: number;
	costOracleDiff: number;
	nJ: number;
	/** Junctions with both contours matched after the re-fit. */
	nMatched: number;
	dRotDeg: [number, number, number];
	ms: number;
};

const px1600 = (cam: CameraX): [number, number] =>
	cam.aspect >= 1 ? [1600, 1600 / cam.aspect] : [1600 * cam.aspect, 1600];

/** Skyline samples (one per skyEveryDeg) of a layered horizon, with image normals at cam. */
function skySamples(lh: LayeredHorizon, cam: CameraX): Sample[] {
	const out: Sample[] = [];
	const every = Math.max(1, Math.round(SCORER.skyEveryDeg / lh.step));
	const [W, H] = px1600(cam);
	for (let i = 2; i < lh.crests.length - 2; i += every) {
		const c = lh.crests[i].at(-1);
		const a = lh.crests[i - 2].at(-1);
		const b = lh.crests[i + 2].at(-1);
		if (!c || !a || !b || !c.sky || !a.sky || !b.sky) continue;
		if (Math.abs(Math.log(a.d / b.d)) > 0.3) continue;
		const p = projectX(cam, c.world);
		const pa = projectX(cam, a.world);
		const pb = projectX(cam, b.world);
		if (!p || !pa || !pb) continue;
		const x = p.u * W;
		const y = p.v * H;
		if (x < 16 || y < 16 || x > W - 16 || y > H - 16) continue;
		const tx = (pb.u - pa.u) * W;
		const ty = (pb.v - pa.v) * H;
		const tn = Math.hypot(tx, ty);
		if (tn < 1e-6) continue;
		let n: [number, number] = [-ty / tn, tx / tn];
		if (n[1] > 0) n = [-n[0], -n[1]]; // toward the sky (up in the image, roughly)
		out.push({ w: c.world, n, jn: -1, which: "sky" });
	}
	return out;
}

function junctionSamples(js: Junction[]): Sample[] {
	const out: Sample[] = [];
	js.forEach((j, k) => {
		for (const w of j.nearPts)
			out.push({ w, n: j.nNear, jn: k, which: "near" });
		for (const w of j.farPts) out.push({ w, n: j.nFar, jn: k, which: "far" });
	});
	return out;
}

const rotated = (cam: CameraX, d: [number, number, number]): CameraX => ({
	...cam,
	pose: {
		...cam.pose,
		yaw: cam.pose.yaw + d[0],
		pitch: cam.pose.pitch + d[1],
		roll: cam.pose.roll + d[2],
	},
});

/** Measure samples at cam: e = predicted − observed along n (px @1600), NaN if unmatched. */
function measureSamples(
	ss: Sample[],
	cam: CameraX,
	edges: PhotoEdges,
	tolRad: (s: Sample) => number,
): Float64Array {
	const te = thinEdgesMemo(edges, 0.8);
	const toE = Math.max(edges.w, edges.h) / 1600;
	const e = new Float64Array(ss.length).fill(Number.NaN);
	ss.forEach((s, k) => {
		const p = projectX(cam, s.w);
		if (!p) return;
		const m = searchAlongNormal(
			te,
			p.u * edges.w,
			p.v * edges.h,
			s.n[0],
			s.n[1],
			{
				search: SCORER.searchPx * toE,
				band: Math.max(1, 1.5 * toE),
				tolRad: tolRad(s),
				polarity: 0,
				sepPx: 2 * toE,
			},
		);
		if (m) e[k] = -m.t / toE;
	});
	return e;
}

/** ∂(projected position · n)/∂(yaw, pitch, roll) per sample (px @1600 per degree). */
function rotJacobian(ss: Sample[], cam: CameraX): Float64Array[] {
	const [W, H] = px1600(cam);
	const h = 1e-3;
	const P0 = ss.map((s) => projectX(cam, s.w));
	return [0, 1, 2].map((a) => {
		const d: [number, number, number] = [0, 0, 0];
		d[a] = h;
		const c = rotated(cam, d);
		return Float64Array.from(ss, (s, k) => {
			const p = projectX(c, s.w);
			const p0 = P0[k];
			if (!p || !p0) return 0;
			return ((p.u - p0.u) * W * s.n[0] + (p.v - p0.v) * H * s.n[1]) / h;
		});
	});
}

function junctionCost(
	js: Junction[],
	ss: Sample[],
	e: Float64Array,
): { cost: number; matched: number } {
	const tau2 = SCORER.tauPx ** 2;
	if (js.length < SCORER.minJunctions) return { cost: 2 * tau2, matched: 0 };
	const per = js.map(() => ({ near: [] as number[], far: [] as number[] }));
	ss.forEach((s, k) => {
		if (s.jn < 0 || !Number.isFinite(e[k])) return;
		(s.which === "near" ? per[s.jn].near : per[s.jn].far).push(e[k]);
	});
	const med = (a: number[]) => {
		const s = [...a].sort((x, y) => x - y);
		const m = s.length >> 1;
		return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
	};
	let tot = 0;
	let matched = 0;
	for (const p of per) {
		const cn = p.near.length >= 2 ? Math.min(med(p.near) ** 2, tau2) : tau2;
		const cf = p.far.length >= 2 ? Math.min(med(p.far) ** 2, tau2) : tau2;
		if (p.near.length >= 2 && p.far.length >= 2) matched++;
		tot += cn + cf;
	}
	return { cost: tot / js.length, matched };
}

export type Scorer = {
	score: (E: number, N: number) => EyeScore;
	/** Junctions predicted at the reference eye (for eligibility). */
	refJunctions: Junction[];
	sector: [number, number];
	hag: number;
};

export function makeScorer(ph: Ga3Photo, edges: PhotoEdges): Scorer {
	const cam0 = ph.cam;
	const sector = sectorOf(cam0, SCORER.sectorMarginDeg);
	const G = smoothGround(ph);
	const hag = 0 - G(0, 0); // reference eye height above the (smoothed) DEM
	const jo = {
		minNearD: SCORER.minNearD,
		maxNearD: SCORER.maxNearD,
		minAngleDeg: SCORER.minAngleDeg,
	};
	const lhOpts = { step: SCORER.step, minD: SCORER.minD };
	const refJunctions = predictJunctions(
		layeredHorizon(ph.raster.h, [0, 0, 0], sector, lhOpts),
		cam0,
		jo,
	);
	const tau2 = SCORER.tauPx ** 2;
	const score = (E: number, N: number): EyeScore => {
		const t0 = Date.now();
		const U = G(E, N) + hag;
		const eye: Vec3 = [E, N, U];
		const lh = layeredHorizon(ph.raster.h, eye, sector, lhOpts);
		const camE: CameraX = { ...cam0, eye };
		const js = predictJunctions(lh, camE, jo);
		// oracle rotation (secondary)
		const ob = measureJunctions(js, edges, camE, { searchPx: SCORER.searchPx });
		let cp = 0;
		let cd = 0;
		for (const o of ob) {
			cp +=
				Math.min(Number.isFinite(o.eNear) ? o.eNear ** 2 : tau2, tau2) +
				Math.min(Number.isFinite(o.eFar) ? o.eFar ** 2 : tau2, tau2);
			cd += Math.min(Number.isFinite(o.r) ? o.r ** 2 : tau2, tau2);
		}
		const okJ = js.length >= SCORER.minJunctions;
		// rotation re-fit (primary)
		const ss = [...junctionSamples(js), ...skySamples(lh, camE)];
		const tol = (s: Sample) =>
			s.jn >= 0 ? Math.min(20, js[s.jn].angleDeg / 2) * DEG : 20 * DEG;
		let d: [number, number, number] = [0, 0, 0];
		let e = measureSamples(ss, camE, edges, tol);
		for (let it = 0; it < SCORER.gnIters && ss.length >= 3; it++) {
			const c = rotated(camE, d);
			const J = rotJacobian(ss, c);
			const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
			const b = [0, 0, 0];
			let nOk = 0;
			for (let k = 0; k < ss.length; k++) {
				if (!Number.isFinite(e[k])) continue;
				const w = 1 / (1 + (e[k] / SCORER.cauchyPx) ** 2);
				nOk++;
				for (let a = 0; a < 3; a++) {
					b[a] += w * J[a][k] * e[k];
					for (let q = 0; q < 3; q++) A[3 * a + q] += w * J[a][k] * J[q][k];
				}
			}
			if (nOk < 4) break;
			for (let a = 0; a < 3; a++) A[4 * a] = A[4 * a] * 1.01 + 1e-3;
			const x = solve3(
				A,
				b.map((v) => -v),
			);
			if (!x) break;
			const s = Math.min(1, 0.5 / Math.max(1e-9, Math.hypot(x[0], x[1], x[2])));
			d = [d[0] + s * x[0], d[1] + s * x[1], d[2] + s * x[2]];
			e = measureSamples(ss, rotated(camE, d), edges, tol);
		}
		const jc = junctionCost(js, ss, e);
		return {
			E,
			N,
			U,
			cost: jc.cost,
			costOraclePair: okJ ? cp / js.length : 2 * tau2,
			costOracleDiff: okJ ? cd / js.length : tau2,
			nJ: js.length,
			nMatched: jc.matched,
			dRotDeg: d,
			ms: Date.now() - t0,
		};
	};
	return { score, refJunctions, sector, hag };
}

function solve3(A: number[], b: number[]): number[] | null {
	const [a, bb, c, d, e, f, g, h, i] = A;
	const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
	if (!(Math.abs(det) > 1e-12)) return null;
	const inv = [
		(e * i - f * h) / det,
		(c * h - bb * i) / det,
		(bb * f - c * e) / det,
		(f * g - d * i) / det,
		(a * i - c * g) / det,
		(c * d - a * f) / det,
		(d * h - e * g) / det,
		(bb * g - a * h) / det,
		(a * e - bb * d) / det,
	];
	return [0, 1, 2].map(
		(r) => inv[3 * r] * b[0] + inv[3 * r + 1] * b[1] + inv[3 * r + 2] * b[2],
	);
}

export function writeJsonFile(file: string, obj: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(obj, null, 1));
}

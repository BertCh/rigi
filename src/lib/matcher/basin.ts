// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Position-grid basin gap (port of tools/matcher/pose6.py basin_gap, fast mode, regime "manual"): the
// LOW trigger for uploads whose position is not an EXIF GPS fix. No new renders: only the stage-2 skyline
// cue, the lifted matches and the DEM.
//   - Delta horizon: at an eye the skyline is the app's own horizonDirs (binned on the solve's azimuth
//     grid) plus the change a DEM ray-march predicts between the start eye and that eye.
//   - Grid: 9 × 9 eyes, ±1000 m around the start eye, at AGL max(1.6 m, start AGL). Per node the coarse
//     rotation search (yaw ±15°, pitch ±3°) on the app skyline score, top 3 after a 1° NMS (GPU: one graph
//     per grid, ./basin-gpu.ts, only the winners read back; CPU twin rotSearchCpu).
//   - The 10 best nodes by coarse score get the rotation LM (eye fixed) and the comparable cost
//     N_EFF · selection cost + priors; gap = (c2 − c1) / |c1|, c2 = the best node ≥ 2 spacings from the best.

import type { Pose } from "#/lib/camera";
import {
	FOCAL_SIGMA as _FS,
	type Corr,
	GATES,
	huberSqrtW,
	matchResid,
	poseFromX,
	type SkylineCue,
	selectionCost,
	skyAssociate,
	skyResid,
	solveFusion,
	WINS,
	xFromPose,
} from "./fusion";
import { DEG, dang, focalPx, hfovFromVfov, poseToR, pyMod } from "./geometry";
import { leastSquares } from "./lm";

void _FS;

export const N_EFF = 60.0;
export const SIGMA_H = { exif: 30.0, manual: 400.0 };
export const GRID_R = 1000.0;
export const GRID_N = 9;
export const AGL_NOMINAL = 1.6;
export const AGL_SIGMA = 3.0;
export const AGL_MAX = 10.0;
export const AGL_FLOOR = 1.5;
export const NODE_LM = 10;
export const STEPS = [0.003, 0.003, 0.003, 3e-4, 0.5, 0.5, 0.3];
/** app.BASIN_GAP_MIN / rule GAP_MIN */
export const BASIN_GAP_MIN = 0.2;

export type Vec3 = [number, number, number];

/** The DEM the basin gap needs: terrain z (ENU, curvature-reduced) and horizon elevations on an azimuth grid. */
export type BasinDem = {
	ground(E: number, N: number): number;
	/** Elevation (deg) at az = az0 + k·step, k = 0 … ⌊(az1 − az0)/step + 0.5⌋, for each eye. */
	horizons(
		eyes: Vec3[],
		az0: number,
		az1: number,
		step: number,
	): Promise<Float64Array[]>;
};

/** np.arange(a, b, step) length. */
export const arangeLen = (a: number, b: number, step: number) =>
	Math.max(0, Math.ceil((b - a) / step));

/** numpy round (half to even). */
const roundHalfEven = (x: number) => {
	const r = Math.round(x);
	return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

export type BasinProblem = {
	W: number;
	H: number;
	sk: SkylineCue;
	corr: Corr | null;
	eye0: Vec3;
	pose0: Pose;
	f0: number;
	fsig: number;
	sigmaH: number;
	hfov: number;
	agl0: number;
	aglRef: number;
	cap: number;
	az0: number;
	az1: number;
	azstep: number;
	nAz: number;
	az: Float64Array;
	py0: Float64Array;
	baseEl: Float64Array;
	dem: BasinDem;
};

/** pose6.Problem (fast = true): the delta-horizon model around the start eye. */
export async function basinProblem(o: {
	W: number;
	H: number;
	sk: SkylineCue;
	corr: Corr | null;
	eye0: ArrayLike<number>;
	pose0: Pose;
	focalKnown: boolean;
	regime?: "manual" | "exif";
	dem: BasinDem;
}): Promise<BasinProblem> {
	const { W, H, sk, dem, pose0 } = o;
	const eye0: Vec3 = [o.eye0[0], o.eye0[1], o.eye0[2]];
	const hfov = hfovFromVfov(pose0.vfov, W / H);
	const g0 = dem.ground(eye0[0], eye0[1]);
	const agl0 = eye0[2] - g0;
	let half = hfov / 2 + Math.min(35.0, Math.max(6.0, 2.5 * hfov));
	half = Math.min(half, hfov / 2 + 17.0);
	const az0 = pose0.yaw - half;
	const az1 = pose0.yaw + half;
	const azstep = Math.min(0.05, Math.max(0.004, hfov / W)) * 2.0;
	const nAz = arangeLen(az0, az1 + azstep * 0.5, azstep);
	const az = Float64Array.from({ length: nAz }, (_, k) => az0 + k * azstep);
	const [py0] = await dem.horizons([eye0], az0, az1, azstep);
	const p: BasinProblem = {
		W,
		H,
		sk,
		corr: o.corr && o.corr.x2d.length ? o.corr : null,
		eye0,
		pose0: { ...pose0 },
		f0: focalPx(pose0.vfov, H),
		fsig: o.focalKnown ? 0.05 : 0.15,
		sigmaH: SIGMA_H[o.regime ?? "manual"],
		hfov,
		agl0,
		aglRef: Math.max(AGL_NOMINAL, agl0),
		cap: Math.max(AGL_MAX, agl0),
		az0,
		az1,
		azstep,
		nAz,
		az,
		py0,
		baseEl: py0,
		dem,
	};
	p.baseEl = appEl(p, sk.dirs, py0);
	return p;
}

/** Problem._app_el: the app's horizonDirs binned on the azimuth grid (max elevation per bin). */
export function appEl(
	p: Pick<BasinProblem, "az0" | "azstep" | "nAz">,
	dirs: Float64Array,
	py0: Float64Array,
) {
	const n = p.nAz;
	const out = new Float64Array(n).fill(Number.NEGATIVE_INFINITY);
	for (let i = 0; i < dirs.length / 3; i++) {
		const a = pyMod(
			Math.atan2(dirs[i * 3], dirs[i * 3 + 1]) / DEG - p.az0,
			360,
		);
		const el = Math.asin(Math.max(-1, Math.min(1, dirs[i * 3 + 2]))) / DEG;
		const k = roundHalfEven(a / p.azstep);
		if (k >= 0 && k < n && el > out[k]) out[k] = el;
	}
	const good: number[] = [];
	for (let k = 0; k < n; k++) if (Number.isFinite(out[k])) good.push(k);
	if (good.length < 10) return Float64Array.from(py0);
	// np.interp over the good bins
	let g = 0;
	for (let k = 0; k < n; k++) {
		if (Number.isFinite(out[k])) continue;
		while (g < good.length - 1 && good[g + 1] < k) g++;
		if (k < good[0]) out[k] = out[good[0]];
		else if (k > good[good.length - 1]) out[k] = out[good[good.length - 1]];
		else {
			const a = good[g];
			const b = good[g + 1];
			out[k] = out[a] + ((k - a) / (b - a)) * (out[b] - out[a]);
		}
	}
	const lo = good[0];
	const hi = good[good.length - 1];
	for (let k = 0; k < lo; k++) out[k] = py0[k];
	for (let k = hi + 1; k < n; k++) out[k] = py0[k];
	return out;
}

/** Problem.eye: terrain + clipped AGL. */
export const basinEye = (
	p: BasinProblem,
	E: number,
	N: number,
	a: number,
): Vec3 => [E, N, p.dem.ground(E, N) + Math.min(Math.max(a, AGL_FLOOR), p.cap)];

/** Problem.horizon(eye) dirs from a marched elevation profile (delta on the app's base elevations). */
export function deltaDirs(p: BasinProblem, py: Float64Array): Float64Array {
	const n = p.nAz;
	const d = new Float64Array(n * 3);
	for (let k = 0; k < n; k++) {
		const el = (p.baseEl[k] + (py[k] - p.py0[k])) * DEG;
		const a = p.az[k] * DEG;
		d[k * 3] = Math.sin(a) * Math.cos(el);
		d[k * 3 + 1] = Math.cos(a) * Math.cos(el);
		d[k * 3 + 2] = Math.sin(el);
	}
	return d;
}

export const skyWith = (p: BasinProblem, dirs: Float64Array): SkylineCue => ({
	...p.sk,
	dirs,
});

export type Sig = { sky: number; match: number };

/** pose6.sigmas at the start eye (the start horizon is the app's own, binned). */
export function sigmas(
	p: BasinProblem,
	x4: Float64Array,
	eye: Vec3,
	sk: SkylineCue,
): Sig {
	const sig: Sig = { sky: 2.0, match: 2.0 };
	const s = solveFusion(x4, p.W, p.H, p.f0, { sk, useMatch: false });
	if (s?.[1].sky) sig.sky = s[1].sky.sigma;
	if (p.corr && p.corr.x2d.length / 2 >= 6) {
		const m = solveFusion(x4, p.W, p.H, p.f0, {
			c: p.corr,
			eye,
			useSky: false,
		});
		if (m?.[1].match) sig.match = m[1].match.sigma;
	}
	return sig;
}

export function priorRes(p: BasinProblem, q: ArrayLike<number>): number[] {
	const a = Math.min(Math.max(q[6], AGL_FLOOR), p.cap);
	return [
		(q[3] - Math.log(p.f0)) / p.fsig,
		q[4] / p.sigmaH,
		q[5] / p.sigmaH,
		Math.max(0, a - p.aglRef) / AGL_SIGMA,
	];
}

/** pose6.total_cost at the node eye (sk = that eye's skyline cue). */
export function totalCost(
	p: BasinProblem,
	q: ArrayLike<number>,
	sig: Sig,
	eye: Vec3,
	sk: SkylineCue,
) {
	const sel = selectionCost(
		Array.from(q).slice(0, 4),
		sk,
		p.corr,
		eye,
		p.W,
		p.H,
		sig,
	);
	return N_EFF * sel + priorRes(p, q).reduce((s, v) => s + v * v, 0);
}

/** pose6.solve6(move = False): rotation + log f LM at a fixed eye. */
export function solveRotationAtEye(
	p: BasinProblem,
	q0: ArrayLike<number>,
	sig: Sig,
	eye: Vec3,
	sk: SkylineCue,
): Float64Array | null {
	const { W, H, corr: c } = p;
	const q = Float64Array.from(q0);
	for (let it = 0; it < WINS.length; it++) {
		type Part =
			| { name: "sky"; cu: Float64Array; tgt: Float64Array; w: Float64Array }
			| { name: "match"; idx: number[]; w: Float64Array };
		const parts: Part[] = [];
		const x4 = q.subarray(0, 4);
		const { cu, tgt } = skyAssociate(x4, sk, W, H, WINS[it]);
		if (cu.length >= 10) {
			const r = skyResid(x4, sk, W, H, cu, tgt);
			parts.push({
				name: "sky",
				cu,
				tgt,
				w: huberSqrtW(r.map((v) => v / sig.sky)),
			});
		}
		if (c) {
			const r = matchResid(x4, c, eye);
			const idx: number[] = [];
			for (let i = 0; i < r.length / 2; i++)
				if (Math.hypot(r[i * 2], r[i * 2 + 1]) < GATES[it]) idx.push(i);
			if (idx.length >= 6) {
				const rg = new Float64Array(idx.length * 2);
				idx.forEach((i, k) => {
					rg[k * 2] = r[i * 2];
					rg[k * 2 + 1] = r[i * 2 + 1];
				});
				parts.push({
					name: "match",
					idx,
					w: huberSqrtW(rg.map((v) => v / sig.match)),
				});
			}
		}
		if (!parts.length) return null;
		const res = (x: Float64Array) => {
			const out: number[] = [];
			for (const part of parts) {
				if (part.name === "sky") {
					const rr = skyResid(x, sk, W, H, part.cu, part.tgt);
					const k = Math.sqrt(N_EFF / rr.length) / sig.sky;
					for (let i = 0; i < rr.length; i++) out.push(part.w[i] * rr[i] * k);
				} else {
					const rr = matchResid(x, c as Corr, eye, part.idx);
					const k = Math.sqrt(N_EFF / (rr.length / 2)) / sig.match;
					for (let i = 0; i < rr.length; i++) out.push(part.w[i] * rr[i] * k);
				}
			}
			out.push((x[3] - Math.log(p.f0)) / p.fsig);
			return Float64Array.from(out);
		};
		const sol = leastSquares(res, q.subarray(0, 4), {
			xScale: STEPS.slice(0, 4).map((s) => s * 30),
			jacSteps: STEPS.slice(0, 4),
			maxNfev: 40 * 5,
		});
		q.set(sol.x, 0);
	}
	q[6] = Math.min(Math.max(q[6], AGL_FLOOR), p.cap);
	return q;
}

// ---------- coarse rotation search ----------

/** rot_search's candidate poses around the seed (yaw outer, pitch inner, as numpy's loops). */
export function rotCandidates(
	p: BasinProblem,
	seed: Pose,
	yawWin = 15.0,
	pitchWin = 3.0,
): Pose[] {
	const ystep = Math.max(0.05, Math.min(0.25, p.hfov / 100));
	const pstep = Math.max(0.1, Math.min(0.5, p.hfov / 60));
	const ny = arangeLen(-yawWin, yawWin + 1e-9, ystep);
	const np = arangeLen(-pitchWin, pitchWin + 1e-9, pstep);
	const out: Pose[] = [];
	for (let i = 0; i < ny; i++)
		for (let j = 0; j < np; j++)
			out.push({
				...seed,
				yaw: seed.yaw + (-yawWin + i * ystep),
				pitch: seed.pitch + (-pitchWin + j * pstep),
			});
	return out;
}

/** One candidate's coarse score: mean S along the projected skyline × column coverage (−∞ if < 20 dirs in view). */
export function rotScore(
	pose: Pose,
	dirs: Float64Array,
	sk: SkylineCue,
	W: number,
	H: number,
	f: number,
	rows: Float64Array,
): number {
	const { S, w, h } = sk;
	const R = poseToR(pose);
	rows.fill(Number.POSITIVE_INFINITY);
	let kc = 0;
	for (let i = 0; i < dirs.length / 3; i++) {
		const a = dirs[i * 3];
		const b = dirs[i * 3 + 1];
		const c = dirs[i * 3 + 2];
		const z = R[6] * a + R[7] * b + R[8] * c;
		if (!(z > 0.1)) continue;
		const u = ((W / 2 + (f * (R[0] * a + R[1] * b + R[2] * c)) / z) / W) * w;
		const v = ((H / 2 + (f * (R[3] * a + R[4] * b + R[5] * c)) / z) / H) * h;
		if (!(u >= 0 && u < w && v >= 0 && v < h)) continue;
		kc++;
		const col = Math.trunc(u);
		if (v < rows[col]) rows[col] = v;
	}
	if (kc < 20) return Number.NEGATIVE_INFINITY;
	let sum = 0;
	let ncol = 0;
	for (let col = 0; col < w; col++) {
		const r = rows[col];
		if (!Number.isFinite(r)) continue;
		ncol++;
		sum += S[Math.trunc(r) * w + col];
	}
	return (sum / Math.max(ncol, 1)) * Math.min(1.0, ncol / (0.6 * w));
}

export type RotHyp = { score: number; pose: Pose; index: number };

/** rot_search's selection: stable descending order, 1° NMS (yaw or pitch), top 3. */
export function topHyps(
	scores: ArrayLike<number>,
	cands: Pose[],
	k = 3,
): RotHyp[] {
	const order = Array.from({ length: scores.length }, (_, i) => i).sort(
		(a, b) => scores[b] - scores[a] || a - b,
	);
	const out: RotHyp[] = [];
	for (const i of order) {
		if (!Number.isFinite(scores[i])) break;
		const pose = cands[i];
		if (
			out.every(
				(q) =>
					Math.abs(dang(pose.yaw, q.pose.yaw)) > 1.0 ||
					Math.abs(pose.pitch - q.pose.pitch) > 1.0,
			)
		)
			out.push({ score: scores[i], pose, index: i });
		if (out.length >= k) break;
	}
	return out;
}

/** The grid's coarse search: per node (dirs) the top-3 hypotheses. GPU implementation in ./basin-gpu.ts. */
export type GridScorer = (
	nodeDirs: Float64Array[],
	cands: Pose[],
	sk: SkylineCue,
	W: number,
	H: number,
	f: number,
) => Promise<RotHyp[][]>;

export const rotSearchCpu: GridScorer = async (
	nodeDirs,
	cands,
	sk,
	W,
	H,
	f,
) => {
	const rows = new Float64Array(sk.w);
	return nodeDirs.map((dirs) => {
		const scores = cands.map((c) => rotScore(c, dirs, sk, W, H, f, rows));
		return topHyps(scores, cands);
	});
};

export type BasinGap = {
	gap: number | null;
	grid: {
		step: number;
		n: number;
		evaluated: number;
		best: { E: number; N: number; cost: number };
		second: { E: number; N: number; cost: number } | null;
	} | null;
	sigma: Sig;
	ms: number;
	scorer: string;
};

/** pose6.basin_gap: σ at the start eye, the grid search, the gap. */
export async function basinGap(
	p: BasinProblem,
	o: {
		scorer?: GridScorer;
		scorerName?: string;
		gridR?: number;
		gridN?: number;
		nodeLm?: number;
		tick?: () => void;
	} = {},
): Promise<BasinGap> {
	const t0 = performance.now();
	const { W, H } = p;
	const gridR = o.gridR ?? GRID_R;
	const gridN = o.gridN ?? GRID_N;
	const nodeLm = o.nodeLm ?? NODE_LM;
	const x4 = xFromPose(p.pose0, H);
	const sk0 = skyWith(p, deltaDirs(p, p.py0));
	const sig = sigmas(p, x4, p.eye0, sk0);
	const E0 = p.eye0[0];
	const N0 = p.eye0[1];
	const step = (2 * gridR) / (gridN - 1);
	const pts: [number, number][] = [];
	for (let i = 0; i < gridN; i++)
		for (let j = 0; j < gridN; j++)
			pts.push([E0 - gridR + i * step, N0 - gridR + j * step]);
	const eyes = pts.map(([E, N]) => basinEye(p, E, N, p.aglRef));
	o.tick?.();
	const profs = await p.dem.horizons(eyes, p.az0, p.az1, p.azstep);
	const dirs = profs.map((py) => deltaDirs(p, py));
	o.tick?.();
	const cands = rotCandidates(p, p.pose0);
	const f = focalPx(p.pose0.vfov, H);
	const hyps = await (o.scorer ?? rotSearchCpu)(dirs, cands, p.sk, W, H, f);
	const nodes = pts
		.map(([E, N], i) => ({ E, N, i, hyps: hyps[i] }))
		.filter((n) => n.hyps.length)
		.map((n) => ({ ...n, coarse: n.hyps[0].score }));
	const res: BasinGap = {
		gap: null,
		grid: null,
		sigma: sig,
		ms: 0,
		scorer: o.scorerName ?? "cpu",
	};
	if (!nodes.length) return { ...res, ms: Math.round(performance.now() - t0) };
	nodes.sort((a, b) => b.coarse - a.coarse);
	const ev: { E: number; N: number; cost: number }[] = [];
	for (const n of nodes.slice(0, nodeLm)) {
		o.tick?.();
		const eye = eyes[n.i];
		const sk = skyWith(p, dirs[n.i]);
		let best: [Float64Array, number] | null = null;
		for (const h of n.hyps) {
			const q0 = Float64Array.of(...xFromPose(h.pose, H), n.E, n.N, p.aglRef);
			const q = solveRotationAtEye(p, q0, sig, eye, sk);
			if (!q) continue;
			const cst = totalCost(p, q, sig, eye, sk);
			if (!best || cst < best[1]) best = [q, cst];
		}
		if (best) ev.push({ E: n.E, N: n.N, cost: best[1] });
	}
	ev.sort((a, b) => a.cost - b.cost);
	if (!ev.length) return { ...res, ms: Math.round(performance.now() - t0) };
	const c1 = ev[0].cost;
	const far = ev.filter(
		(n) => Math.hypot(n.E - ev[0].E, n.N - ev[0].N) >= 2 * step - 1e-6,
	);
	const c2 = far.length ? far[0].cost : Number.POSITIVE_INFINITY;
	const gap = (c2 - c1) / Math.max(Math.abs(c1), 1e-9);
	return {
		...res,
		gap,
		grid: {
			step,
			n: nodes.length,
			evaluated: ev.length,
			best: ev[0],
			second: far[0] ?? null,
		},
		ms: Math.round(performance.now() - t0),
	};
}

export { poseFromX };

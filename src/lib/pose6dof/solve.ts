// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Robust 6-DoF (+focal) ground-control-point solver: RANSAC over minimal solvers, then
// Levenberg–Marquardt with Huber IRLS over [dx,dy,dz,yaw,pitch,roll,vfov] with Gaussian priors.
import { focalFromVfov, type Pose } from "../camera";
import { wrap180 } from "../geodesy";
import { invSym, solveLinear, sub3, type Vec3 } from "../linalg";
import {
	bearing,
	dlt,
	p3p,
	rotationFromBearings,
	vfovFromPair,
	yawFromOnePoint,
} from "./minimal";
import {
	type Basis,
	basis,
	dirFromAzEl,
	NP,
	PARAM_NAMES,
	project,
	unproject,
} from "./project";
import type {
	Correspondence,
	GcpSolveResult,
	Priors,
	SolveOptions,
} from "./types";

const D = Math.PI / 180;
const BEHIND = 1e3; // whitened residual for points behind the camera

export type GcpParams = number[]; // [dx,dy,dz,yaw,pitch,roll,vfov]

export const toParams = (pose: Pose, eye: ArrayLike<number>): GcpParams => [
	eye[0],
	eye[1],
	eye[2],
	pose.yaw,
	pose.pitch,
	pose.roll,
	pose.vfov,
];
export const paramsPose = (p: GcpParams): Pose => ({
	yaw: p[3],
	pitch: p[4],
	roll: p[5],
	vfov: p[6],
});

type Ctx = {
	corrs: Correspondence[];
	aspect: number;
	W: number;
	H: number;
	sigmaPx: number;
};

type Block = {
	/** whitened residual components */
	r: number[];
	/** rows (one per residual component), length NP each; null when not requested */
	J: number[][] | null;
	/** unwhitened px error (norm) — NaN when behind */
	px: number;
};

/** Residual of one correspondence at params p (whitened by its σ). */
function block(
	ctx: Ctx,
	c: Correspondence,
	p: GcpParams,
	withJ: boolean,
	B = basis(p[3], p[4], p[5]),
): Block {
	const sig = c.sigmaPx ?? ctx.sigmaPx;
	const pose = paramsPose(p);
	if (c.kind === "level" || c.kind === "azimuth") {
		// 1-D angular constraint, converted to px: elevation miss × f, or azimuth miss × f·cos(el)
		const f = (q: GcpParams, Bq?: Basis) => {
			const qp = paramsPose(q);
			const fpx = focalFromVfov(qp.vfov, ctx.H);
			const d = unproject(
				qp,
				ctx.aspect,
				c.u,
				c.v,
				Bq ?? basis(qp.yaw, qp.pitch, qp.roll),
			);
			if (c.kind === "level")
				return (
					(Math.asin(Math.max(-1, Math.min(1, d[2]))) / D - c.el) * D * fpx
				);
			const az = Math.atan2(d[0], d[1]) / D;
			return wrap180(az - c.az) * D * fpx * Math.hypot(d[0], d[1]);
		};
		const res = f(p, B);
		let J: number[][] | null = null;
		if (withJ) {
			const row = new Array<number>(NP).fill(0);
			for (let k = 3; k < NP; k++) {
				const h = 1e-4;
				const pp = p.slice();
				const pm = p.slice();
				pp[k] += h;
				pm[k] -= h;
				row[k] = (f(pp) - f(pm)) / (2 * h) / sig;
			}
			J = [row];
		}
		return { r: [res / sig], J, px: Math.abs(res) };
	}
	const target = c.kind === "point" ? { world: c.world } : { dir: c.dir };
	const pr = project(pose, ctx.aspect, p, target, withJ, B);
	if (!pr)
		return {
			r: [BEHIND, BEHIND],
			J: withJ ? [new Array(NP).fill(0), new Array(NP).fill(0)] : null,
			px: Number.NaN,
		};
	const ru = (pr.u - c.u) * ctx.W;
	const rv = (pr.v - c.v) * ctx.H;
	let J: number[][] | null = null;
	if (withJ && pr.Ju && pr.Jv) {
		const Ju = pr.Ju;
		const Jv = pr.Jv;
		J = [Ju.map((x) => (x * ctx.W) / sig), Jv.map((x) => (x * ctx.H) / sig)];
	}
	return { r: [ru / sig, rv / sig], J, px: Math.hypot(ru, rv) };
}

/** Pixel error per correspondence (NaN when behind the camera). */
export function residualsPx(
	corrs: Correspondence[],
	pose: Pose,
	eye: ArrayLike<number>,
	aspect: number,
	imageWidth: number,
): number[] {
	const ctx: Ctx = {
		corrs,
		aspect,
		W: imageWidth,
		H: imageWidth / aspect,
		sigmaPx: 1,
	};
	const p = toParams(pose, eye);
	const B = basis(p[3], p[4], p[5]);
	return corrs.map((c) => block(ctx, c, p, false, B).px);
}

type PriorVec = { mean: number[]; sigma: number[] };
/** A usable Gaussian prior (σ finite and > 0). σ = 0 means "held", handled via the active set. */
const hasPrior = (s: number) => Number.isFinite(s) && s > 0;

function priorVec(priors: Priors, relax: number): PriorVec {
	const pos = priors.position ?? {
		value: [0, 0, 0] as [number, number, number],
		sigmaH: 15,
		sigmaV: 20,
	};
	// σ: undefined / +Infinity = unknown (no prior), 0 = held exactly at the prior value
	// (the parameter is removed from the active set), > 0 = Gaussian prior. Anything else throws.
	const s = (x: number | undefined, name: string) => {
		if (x === undefined) return Number.POSITIVE_INFINITY;
		if (Number.isNaN(x) || x < 0)
			throw new RangeError(
				`pose6dof: prior sigma for ${name} must be >= 0, Infinity or undefined (got ${x})`,
			);
		return x;
	};
	const sH = s(pos.sigmaH ?? 15, "position.sigmaH") * relax;
	const sV = s(pos.sigmaV ?? 20, "position.sigmaV") * relax;
	return {
		mean: [
			pos.value[0],
			pos.value[1],
			pos.value[2],
			priors.yaw.value,
			priors.pitch.value,
			priors.roll.value,
			priors.vfov.value,
		],
		sigma: [
			sH,
			sH,
			sV,
			s(priors.yaw.sigma, "yaw"),
			s(priors.pitch.sigma, "pitch"),
			s(priors.roll.sigma, "roll"),
			s(priors.vfov.sigma, "vfov"),
		],
	};
}

export type Loss = "huber" | "cauchy";
/** Robust cost of a squared whitened residual norm, and its IRLS weight. */
const rhoOf = (s2: number, k: number, loss: Loss) => {
	if (loss === "cauchy") return k * k * Math.log1p(s2 / (k * k));
	const s = Math.sqrt(s2);
	return s <= k ? s2 : 2 * k * s - k * k;
};
const weightOf = (s2: number, k: number, loss: Loss) => {
	if (loss === "cauchy") return 1 / (1 + s2 / (k * k));
	const s = Math.sqrt(s2);
	return s <= k ? 1 : k / s;
};

type LmOut = {
	p: GcpParams;
	cost: number;
	iterations: number;
	converged: boolean;
	H: number[][];
	dataChi2: number;
	nData: number;
};

/** LM with Huber IRLS on the active parameters. `use[i]` = include correspondence i. */
export function lmSolve(
	ctx: Ctx,
	p0: GcpParams,
	active: boolean[],
	use: boolean[],
	prior: PriorVec,
	huberK: number,
	maxIter: number,
	loss: Loss = "huber",
): LmOut {
	const idx = PARAM_NAMES.map((_, i) => i).filter((i) => active[i]);
	const n = idx.length;
	let p = p0.slice();
	const evalCost = (q: GcpParams) => {
		const B = basis(q[3], q[4], q[5]);
		let cost = 0;
		ctx.corrs.forEach((c, i) => {
			if (!use[i]) return;
			const b = block(ctx, c, q, false, B);
			cost += rhoOf(
				b.r.reduce((a, x) => a + x * x, 0),
				huberK,
				loss,
			);
		});
		for (const k of idx) {
			if (!hasPrior(prior.sigma[k])) continue;
			const d = k === 3 ? wrap180(q[k] - prior.mean[k]) : q[k] - prior.mean[k];
			cost += (d / prior.sigma[k]) ** 2;
		}
		return cost;
	};
	const linearise = (q: GcpParams) => {
		const B = basis(q[3], q[4], q[5]);
		const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
		const g = new Array<number>(n).fill(0);
		let cost = 0;
		let dataChi2 = 0;
		let nData = 0;
		ctx.corrs.forEach((c, i) => {
			if (!use[i]) return;
			const b = block(ctx, c, q, true, B);
			const s2 = b.r.reduce((a, x) => a + x * x, 0);
			const w = weightOf(s2, huberK, loss);
			cost += rhoOf(s2, huberK, loss);
			dataChi2 += w * s2;
			nData += b.r.length;
			const J = b.J as number[][];
			for (let m = 0; m < b.r.length; m++) {
				const row = J[m];
				for (let a = 0; a < n; a++) {
					const ja = row[idx[a]];
					if (ja === 0) continue;
					g[a] += w * ja * b.r[m];
					for (let bb = a; bb < n; bb++) A[a][bb] += w * ja * row[idx[bb]];
				}
			}
		});
		idx.forEach((k, a) => {
			if (!hasPrior(prior.sigma[k])) return;
			const d = k === 3 ? wrap180(q[k] - prior.mean[k]) : q[k] - prior.mean[k];
			const r = d / prior.sigma[k];
			cost += r * r;
			g[a] += r / prior.sigma[k];
			A[a][a] += 1 / (prior.sigma[k] * prior.sigma[k]);
		});
		for (let a = 0; a < n; a++)
			for (let bb = 0; bb < a; bb++) A[a][bb] = A[bb][a];
		return { A, g, cost, dataChi2, nData };
	};
	let lambda = 1e-3;
	let lin = linearise(p);
	let cost = lin.cost;
	let converged = false;
	let it = 0;
	if (n === 0)
		return {
			p,
			cost,
			iterations: 0,
			converged: true,
			H: [],
			dataChi2: lin.dataChi2,
			nData: lin.nData,
		};
	for (; it < maxIter; it++) {
		let accepted = false;
		while (lambda < 1e10) {
			const A = lin.A.map((row, a) =>
				row.map((x, b) =>
					a === b ? x + lambda * Math.max(x, 1e-9) + 1e-12 : x,
				),
			);
			const delta = solveLinear(
				A,
				lin.g.map((x) => -x),
			);
			if (!delta) {
				lambda *= 10;
				continue;
			}
			const q = p.slice();
			idx.forEach((k, a) => {
				q[k] += delta[a];
			});
			if (q[6] <= 1 || q[6] >= 170 || Math.abs(q[4]) > 89.9) {
				lambda *= 10;
				continue;
			}
			const c2 = evalCost(q);
			if (c2 <= cost) {
				const rel = (cost - c2) / Math.max(cost, 1e-12);
				const step = Math.max(...delta.map(Math.abs));
				p = q;
				lambda = Math.max(lambda / 3, 1e-12);
				lin = linearise(p);
				cost = lin.cost;
				accepted = true;
				if (rel < 1e-10 || step < 1e-9) converged = true;
				break;
			}
			lambda *= 4;
		}
		if (!accepted) {
			converged = true; // no downhill step exists at this precision
			break;
		}
		if (converged) break;
	}
	return {
		p,
		cost,
		iterations: it + 1,
		converged,
		H: lin.A,
		dataChi2: lin.dataChi2,
		nData: lin.nData,
	};
}

// ---------- DOF ladder ----------

export type Ladder = {
	active: boolean[];
	nEff: number;
	nFinite: number;
	relax: boolean;
};

/**
 * DOF ladder. `parallaxPx[i]` (optional) = image motion in px of finite point i for a 1σ
 * horizontal GPS shift; position only unlocks if some used point moves ≥ opts.minParallaxPx.
 */
export function ladder(
	corrs: Correspondence[],
	use: boolean[],
	opts: SolveOptions,
	parallaxPx?: number[],
	held?: boolean[],
): Ladder {
	const l = ladderRaw(corrs, use, opts, parallaxPx);
	if (held) for (let k = 0; k < NP; k++) if (held[k]) l.active[k] = false;
	return l;
}

function ladderRaw(
	corrs: Correspondence[],
	use: boolean[],
	opts: SolveOptions,
	parallaxPx?: number[],
): Ladder {
	let nBear = 0;
	let nLevel = 0;
	let nAz = 0;
	let nFinite = 0;
	let maxPar = 0;
	corrs.forEach((c, i) => {
		if (!use[i]) return;
		if (c.kind === "level") nLevel++;
		else if (c.kind === "azimuth") nAz++;
		else nBear++;
		if (c.kind === "point") {
			nFinite++;
			maxPar = Math.max(
				maxPar,
				parallaxPx ? parallaxPx[i] : Number.POSITIVE_INFINITY,
			);
		}
	});
	const nEff = nBear + (nLevel + nAz) / 2;
	const a = new Array<boolean>(NP).fill(false);
	if (opts.forceParams) {
		const f = new Set(opts.forceParams);
		a[0] = a[1] = a[2] = f.has("position");
		a[3] = f.has("yaw");
		a[4] = f.has("pitch");
		a[5] = f.has("roll");
		a[6] = f.has("vfov");
		return { active: a, nEff, nFinite, relax: nFinite >= (opts.relaxAt ?? 6) };
	}
	if (nBear + nAz > 0) a[3] = true; // yaw needs at least one azimuth-bearing correspondence
	if (nEff >= 0.5) a[4] = true;
	if (nEff >= 2 || nLevel >= 2) a[5] = true;
	if (nEff >= 3 && (opts.solveFov ?? true)) a[6] = true;
	const observable = maxPar >= (opts.minParallaxPx ?? 2 * (opts.sigmaPx ?? 2));
	if (
		nEff >= 4 &&
		nFinite >= (opts.minFiniteForPosition ?? 3) &&
		observable &&
		(opts.solvePosition ?? true)
	)
		a[0] = a[1] = a[2] = true;
	return {
		active: a,
		nEff,
		nFinite,
		relax: a[0] && nFinite >= (opts.relaxAt ?? 6),
	};
}

// ---------- RANSAC hypotheses ----------

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function* subsets(
	n: number,
	k: number,
	max: number,
	rnd: () => number,
): Generator<number[]> {
	// exhaustive when C(n,k) ≤ max, otherwise random draws
	let total = 1;
	for (let i = 0; i < k; i++) total = (total * (n - i)) / (i + 1);
	if (total <= max) {
		const c = Array.from({ length: k }, (_, i) => i);
		while (true) {
			yield c.slice();
			let i = k - 1;
			while (i >= 0 && c[i] === n - k + i) i--;
			if (i < 0) return;
			c[i]++;
			for (let j = i + 1; j < k; j++) c[j] = c[j - 1] + 1;
		}
	}
	for (let m = 0; m < max; m++) {
		const s = new Set<number>();
		while (s.size < k) s.add(Math.floor(rnd() * n));
		yield [...s].sort((a, b) => a - b);
	}
}

function shuffle<T>(a: T[], rnd: () => number): T[] {
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

type Hyp = { p: GcpParams; init: string; score: number; use: boolean[] };

/**
 * Solve pose (+ eye offset, vfov) from correspondences and priors.
 * Pure function; no DOM. Typical run time < 20 ms for 15 points.
 */
export function solvePose6dof(
	corrs: Correspondence[],
	priors: Priors,
	opts: SolveOptions,
): GcpSolveResult {
	const W = opts.imageWidth;
	const H = W / opts.aspect;
	const sigmaPx = opts.sigmaPx ?? 2;
	const huberK = opts.huberK ?? 2;
	const th = opts.inlierPx ?? Math.max(4 * sigmaPx, 0.006 * W);
	const maxHyp = opts.maxHypotheses ?? 300;
	const maxIter = opts.maxIterations ?? 60;
	const ctx: Ctx = { corrs, aspect: opts.aspect, W, H, sigmaPx };
	const rnd = mulberry32(opts.seed ?? 1);
	const prior0 = priorVec(priors, 1);
	const priorPose: Pose = {
		yaw: priors.yaw.value,
		pitch: priors.pitch.value,
		roll: priors.roll.value,
		vfov: priors.vfov.value,
	};
	const eye0: Vec3 = [prior0.mean[0], prior0.mean[1], prior0.mean[2]];
	const all = corrs.map(() => true);
	const fpx0 = focalFromVfov(priors.vfov.value, H);
	const parallax = corrs.map((c) =>
		c.kind === "point"
			? (prior0.sigma[0] * fpx0) /
				Math.max(
					1,
					Math.hypot(
						c.world[0] - eye0[0],
						c.world[1] - eye0[1],
						c.world[2] - eye0[2],
					),
				)
			: 0,
	);
	// parameters whose prior σ is exactly 0 are held at the prior value
	const held = prior0.sigma.map((x) => x === 0);
	const ladFor = (use: boolean[]) => ladder(corrs, use, opts, parallax, held);
	const lad0 = ladFor(all);

	// ---- score = MSAC truncated cost + clipped prior penalty
	// Hypotheses carry systematic error from the priors they fix (vfov ±3 %, GPS eye), so they are
	// ranked with a looser threshold; LO then tightens to `th`.
	const thH = Math.max(th, opts.hypothesisPx ?? 3 * th);
	const score = (p: GcpParams, t = th) => {
		const th2 = (t / sigmaPx) ** 2;
		const B = basis(p[3], p[4], p[5]);
		let s = 0;
		const use: boolean[] = [];
		for (const c of corrs) {
			const b = block(ctx, c, p, false, B);
			const ok = b.px <= t;
			use.push(ok);
			s += ok ? (b.px / sigmaPx) ** 2 : th2;
		}
		for (let k = 0; k < NP; k++) {
			if (!hasPrior(prior0.sigma[k])) continue;
			const d =
				k === 3 ? wrap180(p[k] - prior0.mean[k]) : p[k] - prior0.mean[k];
			s += Math.min((d / prior0.sigma[k]) ** 2, 25);
		}
		return { s, use };
	};
	const hyps: Hyp[] = [];
	const posActive = lad0.active[0];
	// Sampling pools: rot2 / DLT draw bearings (point + dir), P3P draws finite points. The adaptive
	// stop measures each pool's own inlier ratio (CR-50): inliers of other kinds (azimuth, level, …)
	// say nothing about the chance of an all-inlier sample from the pool, and counted over all
	// correspondences they could stop a sampler early.
	const poolIndex = {
		bear: corrs.flatMap((c, i) =>
			c.kind === "point" || c.kind === "dir" ? [i] : [],
		),
		fin: corrs.flatMap((c, i) => (c.kind === "point" ? [i] : [])),
	};
	type Pool = keyof typeof poolIndex;
	const bestInl: Record<Pool, number> = { bear: 0, fin: 0 };
	const push = (pose: Pose, eye: ArrayLike<number>, init: string) => {
		if (
			![
				pose.yaw,
				pose.pitch,
				pose.roll,
				pose.vfov,
				eye[0],
				eye[1],
				eye[2],
			].every(Number.isFinite)
		)
			return;
		if (!(pose.vfov > 1 && pose.vfov < 170)) return;
		const e = posActive ? eye : eye0;
		// hard reject absurd positions (> 20σ and > 1 km from the prior)
		const dh = Math.hypot(e[0] - eye0[0], e[1] - eye0[1]);
		if (dh > Math.max(20 * prior0.sigma[0], 1000)) return;
		const p = toParams(pose, e);
		if (!lad0.active[6]) p[6] = priorPose.vfov;
		for (let k = 0; k < NP; k++) if (held[k]) p[k] = prior0.mean[k];
		const { s, use } = score(p, thH);
		hyps.push({ p, init, score: s, use });
		for (const pool of Object.keys(poolIndex) as Pool[]) {
			let n = 0;
			for (const i of poolIndex[pool]) if (use[i]) n++;
			bestInl[pool] = Math.max(bestInl[pool], n);
		}
	};
	// adaptive RANSAC stopping: enough samples of size k from `pool` for 99.9 % confidence at the
	// best inlier ratio within that pool
	const enough = (m: number, k: number, pool: Pool) => {
		const w = Math.min(
			0.999,
			bestInl[pool] / Math.max(1, poolIndex[pool].length),
		);
		if (m < 12 || w <= 0) return false;
		return m >= Math.log(0.001) / Math.log(1 - w ** k);
	};

	push(priorPose, eye0, "prior");
	const bear = corrs
		.map((c, i) => ({ c, i }))
		.filter((x) => x.c.kind === "point" || x.c.kind === "dir");
	const dirOf = (c: Correspondence, eye: ArrayLike<number>): Vec3 | null =>
		c.kind === "point"
			? sub3(c.world, eye)
			: c.kind === "dir"
				? [c.dir[0], c.dir[1], c.dir[2]]
				: null;
	const gravityKnown =
		Number.isFinite(prior0.sigma[4]) && Number.isFinite(prior0.sigma[5]);
	// 1-point gravity-aided yaw
	const azCorrs = corrs.filter(
		(c): c is Extract<Correspondence, { kind: "azimuth" }> =>
			c.kind === "azimuth",
	);
	for (const c of [...bear.map((x) => x.c), ...azCorrs]) {
		const d =
			c.kind === "azimuth" ? dirFromAzEl(c.az, 0) : (dirOf(c, eye0) as Vec3);
		push(
			{
				...priorPose,
				yaw: yawFromOnePoint(c.u, c.v, d, priorPose, opts.aspect),
			},
			eye0,
			"yaw1",
		);
		if (!gravityKnown) break;
	}

	// 2-point rotation (position fixed at the prior)
	if (bear.length >= 2)
		for (const [m, s] of shuffle(
			[...subsets(bear.length, 2, maxHyp, rnd)],
			rnd,
		).entries()) {
			if (enough(m, 2, "bear")) break;
			const pair = s.map((k) => bear[k].c);
			const dirs = pair.map((c) => dirOf(c, eye0) as Vec3);
			const uv = pair.map((c) => [c.u, c.v] as [number, number]);
			push(
				rotationFromBearings(uv, dirs, priorPose.vfov, opts.aspect),
				eye0,
				"rot2",
			);
			if (lad0.active[6]) {
				// 2-point rotation + focal from the inter-ray angle (only if well conditioned)
				const vf = vfovFromPair(
					uv,
					dirs,
					opts.aspect,
					priorPose.vfov * 0.8,
					priorPose.vfov * 1.25,
				);
				if (
					vf !== null &&
					Math.hypot((uv[0][0] - uv[1][0]) * opts.aspect, uv[0][1] - uv[1][1]) >
						0.3
				)
					push(rotationFromBearings(uv, dirs, vf, opts.aspect), eye0, "rot2f");
			}
		}
	// P3P with known focal on finite points
	const fin = bear.filter((x) => x.c.kind === "point");
	if (posActive && fin.length >= 3)
		for (const [m, s] of shuffle(
			[...subsets(fin.length, 3, maxHyp, rnd)],
			rnd,
		).entries()) {
			if (enough(m, 3, "fin")) break;
			const tri = s.map((k) => fin[k].c) as Extract<
				Correspondence,
				{ kind: "point" }
			>[];
			const bs = tri.map((c) => bearing(c.u, c.v, priorPose.vfov, opts.aspect));
			for (const sol of p3p(
				bs,
				tri.map((c) => c.world),
				priorPose.vfov,
			))
				push(sol.pose, sol.eye, "p3p");
		}
	// DLT
	if (lad0.active[6] && posActive && bear.length >= 6 && fin.length >= 4) {
		const inp = bear.map(({ c }) =>
			c.kind === "point"
				? { u: c.u, v: c.v, world: c.world }
				: { u: c.u, v: c.v, dir: (c as { dir: Vec3 }).dir },
		);
		const d = dlt(inp, opts.aspect);
		if (d) push(d.pose, d.eye, "dlt");
		for (const [m, s] of shuffle(
			[...subsets(bear.length, 6, Math.floor(maxHyp / 2), rnd)],
			rnd,
		).entries()) {
			if (enough(m, 6, "bear")) break;
			const sub = s.map((k) => inp[k]);
			const r = dlt(sub, opts.aspect);
			if (r) push(r.pose, r.eye, "dlt6");
		}
	}

	// ---- pick distinct top hypotheses, polish each with LM
	hyps.sort((a, b) => a.score - b.score);
	opts.debug?.("hypotheses", hyps);
	const seeds: Hyp[] = [];
	for (const h of hyps) {
		if (seeds.length >= (opts.seeds ?? 4)) break;
		if (
			seeds.some(
				(s) =>
					Math.abs(wrap180(s.p[3] - h.p[3])) < 0.5 &&
					Math.abs(s.p[4] - h.p[4]) < 0.5 &&
					Math.hypot(s.p[0] - h.p[0], s.p[1] - h.p[1]) <
						Math.max(3 * prior0.sigma[0], 20),
			)
		)
			continue;
		seeds.push(h);
	}
	let best: {
		p: GcpParams;
		lm: LmOut;
		use: boolean[];
		lad: Ladder;
		init: string;
		final: number;
	} | null = null;
	// Outlier rejection needs redundancy: with < minPointsForRejection effective points every
	// correspondence is kept (Huber still limits the pull of a bad one).
	const canReject = lad0.nEff >= (opts.minPointsForRejection ?? 5);
	for (const seed of seeds) {
		// Local optimisation from two starting inlier sets: the hypothesis' own inliers, and a loose
		// set (3× threshold) so a start made with the prior vfov / GPS eye does not lose edge points.
		// Each is tightened to the threshold; the best MSAC score wins.
		const px0 = residualsPx(corrs, paramsPose(seed.p), seed.p, opts.aspect, W);
		for (const mul of canReject ? [1, 0] : [-1]) {
			let use = mul === 1 ? px0.map((x) => x <= th) : all;
			if (!use.some(Boolean)) continue;
			let p = seed.p;
			if (mul === 0) {
				// redescending (Cauchy) pass over all points with the full ladder: from a roughly right
				// start, outliers stop pulling and the GPS eye / prior vfov can move before inliers are cut
				const pv = priorVec(priors, lad0.relax ? (opts.relaxFactor ?? 5) : 1);
				const start = p.slice();
				for (let k = 0; k < NP; k++) if (!lad0.active[k]) start[k] = pv.mean[k];
				p = lmSolve(
					ctx,
					start,
					lad0.active,
					all,
					pv,
					th / sigmaPx / 2,
					maxIter,
					"cauchy",
				).p;
				use = residualsPx(corrs, paramsPose(p), p, opts.aspect, W).map(
					(x) => x <= th,
				);
				if (!use.some(Boolean)) continue;
			}
			let lm: LmOut | null = null;
			let lad = ladFor(use);
			// `fitted` = the exact set the last LM ran on (reported as `inliers`, used for RMS / σ)
			let fitted = use;
			for (let round = 0; round < 6; round++) {
				lad = ladFor(use);
				const pv = priorVec(priors, lad.relax ? (opts.relaxFactor ?? 5) : 1);
				const start = p.slice();
				for (let k = 0; k < NP; k++) if (!lad.active[k]) start[k] = pv.mean[k];
				lm = lmSolve(ctx, start, lad.active, use, pv, huberK, maxIter);
				p = lm.p;
				fitted = use;
				if (!canReject) break;
				const px = residualsPx(corrs, paramsPose(p), p, opts.aspect, W);
				const nu = px.map((x) => x <= th);
				if (nu.every((x, i) => x === use[i]) || ladFor(nu).nEff < 2) break;
				use = nu;
			}
			use = fitted;
			const final = score(p).s;
			opts.debug?.("lo", {
				init: seed.init,
				mul,
				p,
				final,
				use,
				active: lad.active,
			});
			if (lm && (!best || final < best.final))
				best = { p, lm, use, lad, init: seed.init, final };
		}
	}
	if (!best) {
		const p = toParams(priorPose, eye0);
		return finish(
			ctx,
			p,
			lad0,
			all,
			"prior",
			{
				p,
				cost: 0,
				iterations: 0,
				converged: false,
				H: [],
				dataChi2: 0,
				nData: 0,
			},
			priors,
			th,
			huberK,
			opts.relaxFactor ?? 5,
		);
	}
	return finish(
		ctx,
		best.p,
		best.lad,
		best.use,
		best.init,
		best.lm,
		priors,
		th,
		huberK,
		opts.relaxFactor ?? 5,
	);
}

function finish(
	ctx: Ctx,
	p: GcpParams,
	lad: Ladder,
	fitted: boolean[],
	init: string,
	lm: LmOut,
	priors: Priors,
	th: number,
	huberK: number,
	relaxFactor: number,
): GcpSolveResult {
	const px = residualsPx(ctx.corrs, paramsPose(p), p, ctx.aspect, ctx.W);
	// Inliers / RMS / σ describe exactly the set the final LM fitted (all points when rejection is
	// disabled below minPointsForRejection); the plain threshold test is reported separately.
	const use = fitted.slice();
	const overThreshold = px.map((x) => !(x <= th));
	const inl = px.filter((x, i) => use[i] && Number.isFinite(x));
	const rms = inl.length
		? Math.sqrt(inl.reduce((a, x) => a + x * x, 0) / inl.length)
		: 0;
	const idx = PARAM_NAMES.map((_, i) => i).filter((i) => lad.active[i]);
	let cov: number[][] = [];
	const sigma = new Array<number>(NP).fill(Number.NaN);
	const pv = priorVec(priors, 1);
	for (let k = 0; k < NP; k++)
		if (!lad.active[k])
			sigma[k] = Number.isFinite(pv.sigma[k]) ? pv.sigma[k] : Number.NaN; // 0 when held
	if (idx.length) {
		// Data information matrix over all 7 params (Huber-weighted, inliers only), then
		// "consider" covariance: parameters held at their prior still contribute their prior
		// variance through the sensitivity of the active ones (e.g. GPS error when position is fixed).
		const info = Array.from({ length: NP }, () =>
			new Array<number>(NP).fill(0),
		);
		let chi = 0;
		let m = 0;
		const B = basis(p[3], p[4], p[5]);
		ctx.corrs.forEach((c, i) => {
			if (!use[i]) return;
			const b = block(ctx, c, p, true, B);
			const s2 = b.r.reduce((a, x) => a + x * x, 0);
			const w = weightOf(s2, huberK, "huber");
			chi += w * s2;
			m += b.r.length;
			for (const row of b.J as number[][])
				for (let a = 0; a < NP; a++)
					for (let bb = 0; bb < NP; bb++) info[a][bb] += w * row[a] * row[bb];
		});
		const pa = priorVec(priors, lad.relax ? relaxFactor : 1);
		const Haa = idx.map((a) =>
			idx.map(
				(bb) =>
					info[a][bb] +
					(a === bb && hasPrior(pa.sigma[a]) ? 1 / pa.sigma[a] ** 2 : 0),
			),
		);
		const Hinv = invSym(Haa);
		const dof = m - idx.length;
		const s2 = dof >= 3 ? chi / dof : 1;
		cov = Hinv.map((r) => r.map((x) => x * s2));
		for (let k = 0; k < NP; k++) {
			if (lad.active[k] || !hasPrior(pv.sigma[k])) continue;
			const sk = idx.map(
				(_, a) =>
					-idx.reduce((acc, bb, j) => acc + Hinv[a][j] * info[bb][k], 0),
			);
			for (let a = 0; a < idx.length; a++)
				for (let bb = 0; bb < idx.length; bb++)
					cov[a][bb] += pv.sigma[k] ** 2 * sk[a] * sk[bb];
		}
		idx.forEach((k, a) => {
			sigma[k] = Math.sqrt(Math.max(cov[a][a], 0));
		});
	}
	const yaw = ((p[3] % 360) + 360) % 360;
	return {
		pose: { yaw, pitch: p[4], roll: p[5], vfov: p[6] },
		eyeOffset: [p[0], p[1], p[2]],
		residualsPx: px,
		rmsPx: rms,
		inliers: use,
		overThreshold,
		sigma: {
			dx: sigma[0],
			dy: sigma[1],
			dz: sigma[2],
			yaw: sigma[3],
			pitch: sigma[4],
			roll: sigma[5],
			vfov: sigma[6],
		},
		covariance: cov,
		activeParams: idx.map((k) => PARAM_NAMES[k]),
		init,
		iterations: lm.iterations,
		converged: lm.converged,
		cost: lm.cost,
	};
}

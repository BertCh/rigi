// PEAKFIX per-eye rotation + focal fit and the arm costs (tools/research/peakfix/PROTOCOL.txt).
// Pinhole on a W×H pixel basis (long side 1600 in the evals), principal point centred, no k1:
// identical to camera/index.ts projectPoint with intrinsics fScale (concord CameraX), written out so
// the camera basis is computed once per evaluation.

import { poseBasis } from "../camera";
import type { EyeHorizon } from "../pose6dof/eye";
import type { ImgPeak, WorldPeak } from "./peaks";

const D = Math.PI / 180;

export type Arm = "dense" | "peak" | "both";

/** yaw, pitch, roll (deg), ln fScale. */
export type Params = [number, number, number, number];

export type Obs = {
	W: number;
	H: number;
	/** vfov (deg) that fScale multiplies. */
	vfov: number;
	/** Sky-boundary samples (px) and weights. */
	samples: { x: number; y: number; w: number }[];
	peaks: ImgPeak[];
};

export type FitOpts = {
	sigmaPx: number;
	/** Truncation in σ. */
	trunc: number;
	gatePx: number;
	/** Peak prominence threshold (px); the other side is matched with hysteresis × this. */
	promPx: number;
	hysteresis: number;
	/** |ln fScale| bound. */
	lnfMax: number;
};

export const PK_OPTS: FitOpts = {
	sigmaPx: 1.5,
	trunc: 6,
	gatePx: 25,
	promPx: 6,
	hysteresis: 0.6,
	lnfMax: Math.log(1.08),
};

type Cam = {
	f: number;
	cx: number;
	cy: number;
	fw: [number, number, number];
	rt: [number, number, number];
	up: [number, number, number];
};

function camOf(p: Params, o: Obs): Cam {
	const b = poseBasis({ yaw: p[0], pitch: p[1], roll: p[2], vfov: o.vfov });
	return {
		f: (o.H / 2 / Math.tan((o.vfov * D) / 2)) * Math.exp(p[3]),
		cx: o.W / 2,
		cy: o.H / 2,
		fw: b.forward as Cam["fw"],
		rt: b.right as Cam["rt"],
		up: b.up as Cam["up"],
	};
}

export function pxPerDeg(p: Params, o: Obs): number {
	return (o.H / 2 / Math.tan((o.vfov * D) / 2)) * Math.exp(p[3]) * D;
}

/** World direction (az, el deg) → px, null if behind. */
export function projectAzEl(
	c: Cam,
	az: number,
	el: number,
): [number, number] | null {
	const ce = Math.cos(el * D);
	const v = [Math.sin(az * D) * ce, Math.cos(az * D) * ce, Math.sin(el * D)];
	const z = v[0] * c.fw[0] + v[1] * c.fw[1] + v[2] * c.fw[2];
	if (z <= 1e-6) return null;
	const x = v[0] * c.rt[0] + v[1] * c.rt[1] + v[2] * c.rt[2];
	const y = v[0] * c.up[0] + v[1] * c.up[1] + v[2] * c.up[2];
	return [c.cx + (c.f * x) / z, c.cy - (c.f * y) / z];
}

/** px → world (az deg 0..360, el deg). */
function unproject(c: Cam, px: number, py: number): [number, number] {
	const x = (px - c.cx) / c.f;
	const y = (c.cy - py) / c.f;
	const d0 = c.fw[0] + c.rt[0] * x + c.up[0] * y;
	const d1 = c.fw[1] + c.rt[1] * x + c.up[1] * y;
	const d2 = c.fw[2] + c.rt[2] * x + c.up[2] * y;
	const az = Math.atan2(d0, d1) / D;
	return [
		az < 0 ? az + 360 : az,
		Math.atan2(d2, Math.hypot(d0, d1)) / D,
	];
}

export function hzEl(hz: EyeHorizon, az: number): number {
	const n = hz.elevation.length;
	const x = az / hz.step;
	const i = Math.floor(x);
	const t = x - i;
	const a = hz.elevation[((i % n) + n) % n];
	const b = hz.elevation[(((i + 1) % n) + n) % n];
	if (a <= -89 || b <= -89) return Number.NaN;
	return a * (1 - t) + b * t;
}

export type Pair = { photo: number; model: number; side: "photo" | "model" };

/** Symmetric nearest-neighbour association with hysteresis (PROTOCOL: gate, prominence). */
export function associate(
	c: Cam,
	model: WorldPeak[],
	obs: Obs,
	o: FitOpts,
	ppd: number,
): { pairs: Pair[]; nItems: number; mpx: ([number, number] | null)[] } {
	const hi = o.promPx;
	const lo = o.promPx * o.hysteresis;
	const mpx = model.map((m) => {
		const q = projectAzEl(c, m.az, m.el);
		return q && q[0] >= 0 && q[0] <= obs.W && q[1] >= 0 && q[1] <= obs.H
			? q
			: null;
	});
	const pairs: Pair[] = [];
	let nItems = 0;
	const near = (
		x: number,
		y: number,
		cands: { i: number; x: number; y: number }[],
	) => {
		let best = -1;
		let bd = o.gatePx;
		for (const k of cands) {
			const dd = Math.hypot(k.x - x, k.y - y);
			if (dd < bd) {
				bd = dd;
				best = k.i;
			}
		}
		return best;
	};
	const modelLo = model
		.map((m, i) => ({ i, m, q: mpx[i] }))
		.filter((e) => e.q && e.m.prom * ppd >= lo)
		.map((e) => ({ i: e.i, x: e.q![0], y: e.q![1] }));
	const photoLo = obs.peaks
		.map((p, i) => ({ i, x: p.x, y: p.y, prom: p.prom }))
		.filter((p) => p.prom >= lo);
	obs.peaks.forEach((p, i) => {
		if (p.prom < hi) return;
		nItems++;
		const k = near(p.x, p.y, modelLo);
		if (k >= 0) pairs.push({ photo: i, model: k, side: "photo" });
	});
	model.forEach((m, i) => {
		const q = mpx[i];
		if (!q || m.prom * ppd < hi) return;
		nItems++;
		const k = near(q[0], q[1], photoLo);
		if (k >= 0) pairs.push({ photo: k, model: i, side: "model" });
	});
	return { pairs, nItems, mpx };
}

type Eval = { r: number[]; w: number[]; cost: number };

function denseEval(p: Params, hz: EyeHorizon, obs: Obs, o: FitOpts, stride = 1): Eval {
	const c = camOf(p, obs);
	const ppd = c.f * D;
	const T2 = o.trunc * o.trunc;
	const r: number[] = [];
	const w: number[] = [];
	let cost = 0;
	let wsum = 0;
	for (let i = 0; i < obs.samples.length; i += stride) {
		const s = obs.samples[i];
		const [az, el] = unproject(c, s.x, s.y);
		const eh = hzEl(hz, az);
		const res = Number.isFinite(eh) ? ((el - eh) * ppd) / o.sigmaPx : o.trunc * 2;
		const q = Math.min(res * res, T2);
		cost += s.w * q;
		wsum += s.w;
		r.push(res);
		w.push(res * res < T2 ? Math.sqrt(s.w) : 0);
	}
	return { r, w, cost: wsum > 0 ? cost / wsum : T2 };
}

function peakEval(
	p: Params,
	model: WorldPeak[],
	obs: Obs,
	o: FitOpts,
	pairs: Pair[] | null,
	nItemsFixed?: number,
): Eval & { pairs: Pair[]; nItems: number } {
	const c = camOf(p, obs);
	const ppd = c.f * D;
	const T2 = o.trunc * o.trunc;
	let pr = pairs;
	let nItems = nItemsFixed ?? 0;
	if (!pr) {
		const a = associate(c, model, obs, o, ppd);
		pr = a.pairs;
		nItems = a.nItems;
	}
	const r: number[] = [];
	const w: number[] = [];
	let cost = 0;
	let matchedCost = 0;
	for (const q of pr) {
		const m = model[q.model];
		const ph = obs.peaks[q.photo];
		const pp = projectAzEl(c, m.az, m.el);
		const dx = pp ? (pp[0] - ph.x) / o.sigmaPx : o.trunc * 2;
		const dy = pp ? (pp[1] - ph.y) / o.sigmaPx : o.trunc * 2;
		const e2 = dx * dx + dy * dy;
		matchedCost += Math.min(e2, T2);
		const wi = e2 < T2 ? 1 : 0;
		r.push(dx, dy);
		w.push(wi, wi);
	}
	// unmatched items cost T² each
	cost = nItems > 0 ? (matchedCost + (nItems - pr.length) * T2) / nItems : T2;
	return { r, w, cost, pairs: pr, nItems };
}

function solve4(A: number[][], b: number[]): number[] | null {
	const n = 4;
	const M = A.map((row, i) => [...row, b[i]]);
	for (let c = 0; c < n; c++) {
		let piv = c;
		for (let r = c + 1; r < n; r++)
			if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
		if (Math.abs(M[piv][c]) < 1e-12) return null;
		[M[c], M[piv]] = [M[piv], M[c]];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = M[r][c] / M[c][c];
			for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
		}
	}
	return M.map((row, i) => row[n] / row[i]);
}

export type FitResult = {
	p: Params;
	cost: number;
	dense: number;
	peak: number;
	pairs: Pair[];
	nItems: number;
	/** Matched photo-side pairs with a residual inside the truncation. */
	nMatched: number;
};

/** Coarse yaw/pitch scan with the DENSE cost (subsampled), from p0. */
export function scanStart(
	p0: Params,
	hz: EyeHorizon,
	obs: Obs,
	o: FitOpts,
	yawHalf = 3,
	pitchHalf = 1.5,
	step = 0.25,
): Params {
	let best = p0;
	let bc = Number.POSITIVE_INFINITY;
	for (let dy = -yawHalf; dy <= yawHalf + 1e-9; dy += step)
		for (let dp = -pitchHalf; dp <= pitchHalf + 1e-9; dp += step) {
			const p: Params = [p0[0] + dy, p0[1] + dp, p0[2], p0[3]];
			const c = denseEval(p, hz, obs, o, 4).cost;
			if (c < bc) {
				bc = c;
				best = p;
			}
		}
	return best;
}

/** Gauss-Newton / LM (IRLS on the truncated loss) for one arm at one eye. */
export function fitArm(
	arm: Arm,
	p0: Params,
	hz: EyeHorizon,
	model: WorldPeak[],
	obs: Obs,
	o: FitOpts = PK_OPTS,
	iters = 8,
): FitResult {
	const H = [0.01, 0.01, 0.01, 1e-4];
	const total = (p: Params, pairs: Pair[] | null, nItems?: number) => {
		const de =
			arm === "peak" ? null : denseEval(p, hz, obs, o, 1);
		const pe =
			arm === "dense" ? null : peakEval(p, model, obs, o, pairs, nItems);
		const nD = de ? Math.max(1, de.r.length) : 1;
		const nP = pe ? Math.max(1, pe.nItems) : 1;
		const r: number[] = [];
		const w: number[] = [];
		if (de) {
			const s = 1 / Math.sqrt(nD);
			for (let i = 0; i < de.r.length; i++) {
				r.push(de.r[i] * s);
				w.push(de.w[i]);
			}
		}
		if (pe) {
			const s = 1 / Math.sqrt(nP);
			for (let i = 0; i < pe.r.length; i++) {
				r.push(pe.r[i] * s);
				w.push(pe.w[i]);
			}
		}
		return {
			r,
			w,
			cost: (de?.cost ?? 0) + (pe?.cost ?? 0),
			dense: de?.cost ?? Number.NaN,
			peak: pe?.cost ?? Number.NaN,
			pairs: pe?.pairs ?? [],
			nItems: pe?.nItems ?? 0,
		};
	};
	let p = [...p0] as Params;
	let cur = total(p, null);
	let lambda = 1e-3;
	for (let it = 0; it < iters; it++) {
		const pairs = arm === "dense" ? null : cur.pairs;
		const base = total(p, pairs, cur.nItems);
		const m = base.r.length;
		if (!m) break;
		const J: number[][] = [];
		for (let k = 0; k < 4; k++) {
			const q = [...p] as Params;
			q[k] += H[k];
			const e = total(q, pairs, cur.nItems);
			J.push(e.r.map((v, i) => (v - base.r[i]) / H[k]));
		}
		const A = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
		const g = [0, 0, 0, 0];
		for (let i = 0; i < m; i++) {
			const wi = base.w[i] * base.w[i];
			if (!wi) continue;
			for (let a = 0; a < 4; a++) {
				g[a] += wi * J[a][i] * base.r[i];
				for (let b = 0; b < 4; b++) A[a][b] += wi * J[a][i] * J[b][i];
			}
		}
		let improved = false;
		for (let tries = 0; tries < 5 && !improved; tries++) {
			const Ad = A.map((row, a) =>
				row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-9 : v)),
			);
			const dx = solve4(Ad, g.map((v) => -v));
			if (!dx) break;
			const q: Params = [p[0] + dx[0], p[1] + dx[1], p[2] + dx[2], p[3] + dx[3]];
			q[3] = Math.max(-o.lnfMax, Math.min(o.lnfMax, q[3]));
			const e = total(q, null);
			if (e.cost < cur.cost) {
				p = q;
				cur = e;
				lambda = Math.max(1e-6, lambda / 4);
				improved = true;
			} else lambda *= 8;
		}
		if (!improved) break;
	}
	const T2 = o.trunc * o.trunc;
	let nMatched = 0;
	if (arm !== "dense") {
		const c = camOf(p, obs);
		for (const q of cur.pairs) {
			if (q.side !== "photo") continue;
			const m = model[q.model];
			const pp = projectAzEl(c, m.az, m.el);
			if (!pp) continue;
			const ph = obs.peaks[q.photo];
			const e2 = ((pp[0] - ph.x) ** 2 + (pp[1] - ph.y) ** 2) / o.sigmaPx ** 2;
			if (e2 < T2) nMatched++;
		}
	}
	return {
		p,
		cost: cur.cost,
		dense: cur.dense,
		peak: cur.peak,
		pairs: cur.pairs,
		nItems: cur.nItems,
		nMatched,
	};
}

export { camOf };

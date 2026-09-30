// Acceptance checks for the GA1 MAP solver (synthetic scenes; no DEM, no network):
//   1. recovery: priors + 2D–3D points (10 % gross outliers, Cauchy) + skyline against a synthetic
//      ridge horizon; start perturbed by 2° / 1° / 1° / 3 % focal / 30 m eye ⇒ truth recovered;
//   2. fixed parameters (free.eye / free.focal false) are never updated and their cov rows are 0;
//   3. Monte Carlo (200 noise draws of data AND prior means, l2): the Laplace σ of every free parameter
//      is within ±20 % of the spread of the MAP estimates;
//   4. all-far scene (points 15–30 km, ridge ~20 km): σ_EN ≥ 0.8·σ_GPS (the eye is unobserved and the
//      covariance says so);
//   5. near scene (points 0.3–1 km): σ_EN ≪ σ_GPS;
//   6. Student-t compass: a 90° heading blunder moves yaw < 0.2× what the same l2 compass does, < 0.02°.
//
//   npx tsx src/lib/geocam/map/map.check.ts
import {
	type CameraX,
	IDENTITY_INTRINSICS,
	projectX,
	unprojectDirX,
} from "../../concord/core";
import { defaultDemSigmaM } from "../../concord/cues/contours";
import { focalPx1600 } from "../../concord/solve/joint";
import type {
	EyeHorizon,
	HorizonsAtEyes,
	SkylineSample,
} from "../../pose6dof/eye";
import {
	type Factor,
	type GeoState,
	IDX,
	type MapProblem,
	NP,
	PARAMS,
	stateFromCameraX,
	type Vec3,
} from "../core";
import { CLUSTER_DEFAULTS, clusterKey } from "./cluster";
import {
	altFactor,
	type Corr2D3D,
	compassFactor,
	focalFactor,
	gpsFactor,
	gravityFactor,
	pointFactor,
	skylineFactor,
} from "./factors";
import { solveMap } from "./solve";

let seed = 20260929;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};
const randn = () => {
	const u = Math.max(1e-12, rnd());
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
};
let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
	if (!ok) failed++;
};
const D = Math.PI / 180;

// ---------------------------------------------------------------- synthetic scene

const base: CameraX = {
	pose: { yaw: 30, pitch: 2, roll: 1, vfov: 50 },
	eye: [0, 0, 0],
	aspect: 4 / 3,
	intr: { ...IDENTITY_INTRINSICS },
};
const f0 = focalPx1600(base);
const truth: GeoState = stateFromCameraX(base);

/** Ridge: world points along azimuths (from the origin) in yaw ± 70°, at distance d(az), height z(az). */
function ridge(dScale: number): Vec3[] {
	const out: Vec3[] = [];
	for (let a = -40; a <= 100; a += 0.004) {
		const d = dScale * (1 + 0.3 * Math.sin(3 * a * D));
		const z =
			(dScale / 8000) *
			(800 + 300 * Math.sin(5 * a * D) + 150 * Math.cos(11 * a * D));
		out.push([d * Math.sin(a * D), d * Math.cos(a * D), z]);
	}
	return out;
}

/** Horizon (0.05° bins, −90 = no data) of a ridge seen from an eye. */
function horizonOf(R: Vec3[], eye: Vec3): EyeHorizon {
	const step = 0.05;
	const n = 7200;
	const elevation = new Float32Array(n).fill(-90);
	const distance = new Float32Array(n);
	// exact per bin: interpolate the ridge polyline at the bin centre azimuth
	const az = R.map(
		(p) => (((Math.atan2(p[0] - eye[0], p[1] - eye[1]) / D) % 360) + 360) % 360,
	);
	for (let i = 0; i + 1 < R.length; i++) {
		const a0 = az[i];
		let a1 = az[i + 1];
		if (a1 - a0 > 180) a1 -= 360;
		if (a0 - a1 > 180) a1 += 360;
		const lo = Math.ceil(Math.min(a0, a1) / step);
		const hi = Math.floor(Math.max(a0, a1) / step);
		for (let k = lo; k <= hi; k++) {
			const t = a1 === a0 ? 0 : (k * step - a0) / (a1 - a0);
			const p = [0, 1, 2].map((j) => R[i][j] + t * (R[i + 1][j] - R[i][j]));
			const dh = Math.hypot(p[0] - eye[0], p[1] - eye[1]);
			const el = Math.atan2(p[2] - eye[2], dh) / D;
			const b = ((k % n) + n) % n;
			if (el > elevation[b]) {
				elevation[b] = el;
				distance[b] = dh;
			}
		}
	}
	return { step, elevation, distance };
}

function provider(R: Vec3[]): HorizonsAtEyes & { calls: () => number } {
	const memo = new Map<string, EyeHorizon>();
	let calls = 0;
	const f = async (eyes: Vec3[]) =>
		eyes.map((e) => {
			const k = e.map((v) => v.toFixed(3)).join(",");
			let h = memo.get(k);
			if (!h) {
				calls++;
				if (memo.size > 400) memo.clear();
				h = horizonOf(R, e);
				memo.set(k, h);
			}
			return h;
		});
	return Object.assign(f, { calls: () => calls });
}

const hzEl = (h: EyeHorizon, az: number) => {
	const t = (((az % 360) + 360) % 360) / h.step;
	const i = Math.floor(t);
	const fr = t - i;
	const a = h.elevation[i % 7200];
	const b = h.elevation[(i + 1) % 7200];
	return a * (1 - fr) + b * fr;
};

/** Noise-free skyline samples of the true camera (bisection per column). */
function skylineOf(cam: CameraX, h: EyeHorizon, nCol = 100): SkylineSample[] {
	const out: SkylineSample[] = [];
	for (let c = 0; c < nCol; c++) {
		const u = (c + 0.5) / nCol;
		const g = (v: number) => {
			const d = unprojectDirX(cam, u, v);
			const az = (((Math.atan2(d[0], d[1]) / D) % 360) + 360) % 360;
			return Math.asin(d[2]) / D - hzEl(h, az);
		};
		let lo = 0;
		let hi = 1;
		if (!(g(lo) > 0 && g(hi) < 0)) continue;
		for (let k = 0; k < 50; k++) {
			const m = (lo + hi) / 2;
			if (g(m) > 0) lo = m;
			else hi = m;
		}
		out.push({ u, v: (lo + hi) / 2, w: 1 });
	}
	return out;
}

/** Random world points seen by the true camera at log-uniform depth in [d0, d1]. */
function pointsOf(cam: CameraX, n: number, d0: number, d1: number) {
	const out: { u: number; v: number; world: Vec3 }[] = [];
	for (let i = 0; i < n; i++) {
		const u = 0.05 + 0.9 * rnd();
		const v = 0.05 + 0.9 * rnd();
		const d = d0 * (d1 / d0) ** rnd();
		const dir = unprojectDirX(cam, u, v);
		out.push({
			u,
			v,
			world: [
				cam.eye[0] + d * dir[0],
				cam.eye[1] + d * dir[1],
				cam.eye[2] + d * dir[2],
			],
		});
	}
	return out;
}

const { W: BW, H: BH } =
	base.aspect >= 1
		? { W: 1600, H: 1600 / base.aspect }
		: { W: 1600 * base.aspect, H: 1600 };

type Scene = {
	pts: { u: number; v: number; world: Vec3 }[];
	sky: SkylineSample[];
	hz: HorizonsAtEyes & { calls: () => number };
};
function scene(nPts: number, d0: number, d1: number, ridgeD: number): Scene {
	const R = ridge(ridgeD);
	const hz = provider(R);
	const h0 = horizonOf(R, [0, 0, 0]);
	return { pts: pointsOf(base, nPts, d0, d1), sky: skylineOf(base, h0), hz };
}

type Noise = {
	pxPts: number;
	pxSky: number;
	gps: number;
	alt: number;
	grav: number;
	compass: number;
	focalFrac: number;
	outlierFrac?: number;
};
const SIG: Noise = {
	pxPts: 1,
	pxSky: 1,
	gps: 20,
	alt: 3,
	grav: 1.5,
	compass: 7,
	focalFrac: 0.03,
};

/** A MAP problem with noisy observations + noisy prior means drawn from the model at `truth`. */
function problem(
	S: Scene,
	N: Noise,
	o: {
		loss: "l2" | "robust";
		free?: MapProblem["free"];
		compassBlunder?: number;
		compassLoss?: "student" | "l2";
		noSky?: boolean;
		/** Default DEM error model (σDEM(d), clusters, nEff) instead of the pure-noise model. */
		realistic?: boolean;
	},
): MapProblem {
	const corrs: Corr2D3D[] = S.pts.map((p) => {
		const out = N.outlierFrac && rnd() < N.outlierFrac;
		return {
			u: p.u + (out ? (rnd() - 0.5) * 0.2 : (N.pxPts * randn()) / BW),
			v: p.v + (out ? (rnd() - 0.5) * 0.2 : (N.pxPts * randn()) / BH),
			world: p.world,
		};
	});
	// skyline noise of σ px in elevation·f (the residual's unit), converted to v
	const sky = S.sky.map((s) => {
		const e = (v: number) => {
			const d = unprojectDirX(base, s.u, v);
			return Math.asin(d[2]) * f0;
		};
		const dedv = e(s.v + 0.5 / BH) - e(s.v - 0.5 / BH);
		return { ...s, v: s.v + (N.pxSky * randn()) / dedv / BH };
	});
	const lossData =
		o.loss === "l2"
			? ({ kind: "l2" } as const)
			: ({ kind: "cauchy", c: 2.5 } as const);
	const cmp = compassFactor(
		truth[IDX.yaw] + (o.compassBlunder ?? N.compass * randn()),
		{
			sigmaNoiseDeg: N.compass / Math.SQRT2,
			sigmaBiasDeg: N.compass / Math.SQRT2,
		},
	);
	if (o.compassLoss === "l2") cmp.loss = { kind: "l2" };
	const factors: Factor[] = [
		gpsFactor(N.gps * randn(), N.gps * randn(), N.gps),
		// altFactor reads the eye as alt − altBias: pass alt = truthU + altBias + noise
		altFactor(-7 + N.alt * randn(), -7, N.alt),
		gravityFactor(
			truth[IDX.pitch] + N.grav * randn(),
			truth[IDX.roll] + N.grav * randn(),
			N.grav,
		),
		cmp,
		focalFactor(f0, f0 * (1 + N.focalFrac * randn()), f0 * N.focalFrac),
		pointFactor(
			base,
			corrs,
			o.realistic
				? { sigmaPx: N.pxPts, loss: lossData, nEff: 60 }
				: { sigmaPx: N.pxPts, demSigmaM: null, loss: lossData },
		),
	];
	if (!o.noSky)
		factors.push(
			skylineFactor(
				base,
				sky,
				S.hz,
				o.realistic
					? { sigmaPx: N.pxSky }
					: {
							sigmaPx: N.pxSky,
							demSigmaM: () => 0,
							sigmaK: 0,
							cluster: null,
							loss: o.loss === "l2" ? { kind: "l2" } : { kind: "cauchy", c: 2 },
							nEff: o.loss === "l2" ? Number.POSITIVE_INFINITY : 60,
						},
			),
		);
	return {
		base,
		f0Px1600: f0,
		factors,
		free: o.free ?? { rotation: true, focal: true, eye: true },
	};
}

const perturbed = (): GeoState => {
	const x = Float64Array.from(truth);
	x[IDX.yaw] += 2;
	x[IDX.pitch] -= 1;
	x[IDX.roll] += 1;
	x[IDX.logf] += Math.log(1.03);
	x[IDX.E] += 30;
	x[IDX.N] -= 20;
	x[IDX.U] += 5;
	return x;
};

// 1. recovery (robust, with 10 % outliers)
{
	const S = scene(150, 300, 30_000, 8000);
	const p = problem(S, { ...SIG, outlierFrac: 0.1 }, { loss: "robust" });
	const r = await solveMap(p, perturbed());
	const dRot = Math.max(
		Math.abs(r.x[IDX.yaw] - truth[IDX.yaw]),
		Math.abs(r.x[IDX.pitch] - truth[IDX.pitch]),
		Math.abs(r.x[IDX.roll] - truth[IDX.roll]),
	);
	const dEye = Math.hypot(r.x[IDX.E], r.x[IDX.N], r.x[IDX.U]);
	const dF = Math.abs(r.x[IDX.logf]);
	const z = [
		(r.x[IDX.yaw] - truth[IDX.yaw]) / r.sigma.yaw,
		(r.x[IDX.E] - truth[IDX.E]) / r.sigma.E,
		(r.x[IDX.N] - truth[IDX.N]) / r.sigma.N,
	];
	check(
		"recovery (priors + points 10% outliers + skyline, robust)",
		dRot < 0.02 && dEye < 5 && dF < 0.003 && z.every((v) => Math.abs(v) < 4),
		`|Δrot| ${dRot.toFixed(4)}°, |Δeye| ${dEye.toFixed(2)} m, |Δlogf| ${dF.toExponential(1)}, σ yaw ${r.sigma.yaw.toFixed(4)}° σEN ${r.sigmaEN.toFixed(2)} m, mad ${r.mad.toFixed(2)}, outer ${r.outer}, it ${r.iterations}, ${r.ms} ms`,
	);
}

// 2. fixed parameters
{
	const S = scene(60, 300, 30_000, 8000);
	const p = problem(S, SIG, {
		loss: "l2",
		free: { rotation: true, focal: false, eye: false },
	});
	const x0 = perturbed();
	const r = await solveMap(p, x0);
	let covFixed = 0;
	for (const k of [IDX.logf, IDX.E, IDX.N, IDX.U])
		for (let j = 0; j < NP; j++)
			covFixed += Math.abs(r.cov[k * NP + j]) + Math.abs(r.cov[j * NP + k]);
	const same = [IDX.logf, IDX.E, IDX.N, IDX.U].every((k) => r.x[k] === x0[k]);
	check(
		"fixed params untouched, cov rows 0",
		same && covFixed === 0 && r.sigma.yaw > 0 && r.sigmaEN === 0,
		`fixed equal ${same}, Σ|cov fixed| ${covFixed}, σ yaw ${r.sigma.yaw.toFixed(4)}`,
	);
}

// 3. Monte Carlo calibration
{
	const S = scene(40, 300, 30_000, 6000);
	const N = 200;
	const errs: number[][] = PARAMS.map(() => []);
	const sig: number[][] = PARAMS.map(() => []);
	const t0 = Date.now();
	for (let t = 0; t < N; t++) {
		const p = problem(S, SIG, { loss: "l2" });
		const r = await solveMap(p, truth, { madRescale: false });
		PARAMS.forEach((k, i) => {
			errs[i].push(r.x[i] - truth[i]);
			sig[i].push(r.sigma[k]);
		});
	}
	const rows = PARAMS.map((k, i) => {
		const e = errs[i];
		const m = e.reduce((a, b) => a + b, 0) / e.length;
		const sd = Math.sqrt(
			e.reduce((a, b) => a + (b - m) ** 2, 0) / (e.length - 1),
		);
		const s = [...sig[i]].sort((a, b) => a - b)[sig[i].length >> 1];
		return { k, sd, s, ratio: s / sd };
	});
	const ok = rows.every((r) => r.ratio > 0.8 && r.ratio < 1.2);
	check(
		`Monte Carlo σ within ±20 % (${N} trials, ${((Date.now() - t0) / 1000).toFixed(1)} s)`,
		ok,
		rows
			.map(
				(r) =>
					`${r.k} σ ${r.s.toPrecision(3)}/sd ${r.sd.toPrecision(3)} (×${r.ratio.toFixed(2)})`,
			)
			.join("; "),
	);
}

// 3b. Monte Carlo with cluster-correlated DEM error generated as modelled (points only): the cluster
// whitening's σ matches the spread
{
	const S = scene(120, 300, 30_000, 6000);
	const rho = CLUSTER_DEFAULTS.rho;
	const N = 300;
	const errs: number[][] = PARAMS.map(() => []);
	const sig: number[][] = PARAMS.map(() => []);
	const t0 = Date.now();
	const dist = S.pts.map((p) => Math.hypot(p.world[0], p.world[1], p.world[2]));
	const keys = S.pts.map((p, i) =>
		clusterKey(
			Math.atan2(p.world[0], p.world[1]) / D,
			dist[i],
			CLUSTER_DEFAULTS.sectorDeg,
		),
	);
	const byKey = new Map<string, number[]>();
	keys.forEach((k, i) => {
		byKey.set(k, [...(byKey.get(k) ?? []), dist[i]]);
	});
	const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
	for (let t = 0; t < N; t++) {
		const off = new Map<string, Vec3>();
		for (const [k, ds] of byKey) {
			const sc = Math.sqrt(rho) * defaultDemSigmaM(med(ds));
			off.set(k, [sc * randn(), sc * randn(), sc * randn()]);
		}
		const corrs: Corr2D3D[] = S.pts.map((p, i) => {
			const b = off.get(keys[i]) as Vec3;
			const q = projectX(base, [
				p.world[0] + b[0],
				p.world[1] + b[1],
				p.world[2] + b[2],
			]);
			if (!q) throw new Error("behind");
			const si = Math.hypot(
				SIG.pxPts,
				(f0 * Math.sqrt(1 - rho) * defaultDemSigmaM(dist[i])) / dist[i],
			);
			return {
				u: q.u + (si * randn()) / BW,
				v: q.v + (si * randn()) / BH,
				world: p.world,
			};
		});
		const p: MapProblem = {
			base,
			f0Px1600: f0,
			factors: [
				gpsFactor(SIG.gps * randn(), SIG.gps * randn(), SIG.gps),
				altFactor(-7 + SIG.alt * randn(), -7, SIG.alt),
				gravityFactor(
					truth[IDX.pitch] + SIG.grav * randn(),
					truth[IDX.roll] + SIG.grav * randn(),
					SIG.grav,
				),
				focalFactor(f0, f0 * (1 + SIG.focalFrac * randn()), f0 * SIG.focalFrac),
				pointFactor(base, corrs, {
					sigmaPx: SIG.pxPts,
					loss: { kind: "l2" },
				}),
			],
			free: { rotation: true, focal: true, eye: true },
		};
		const r = await solveMap(p, truth, { madRescale: false });
		PARAMS.forEach((k, i) => {
			errs[i].push(r.x[i] - truth[i]);
			sig[i].push(r.sigma[k]);
		});
	}
	const rows = PARAMS.map((k, i) => {
		const e = errs[i];
		const m = e.reduce((a, b) => a + b, 0) / e.length;
		const sd = Math.sqrt(
			e.reduce((a, b) => a + (b - m) ** 2, 0) / (e.length - 1),
		);
		const s = [...sig[i]].sort((a, b) => a - b)[sig[i].length >> 1];
		return { k, sd, s, ratio: s / sd };
	});
	check(
		`Monte Carlo with cluster-correlated DEM error (${N} trials, ${byKey.size} clusters, ${((Date.now() - t0) / 1000).toFixed(1)} s)`,
		rows.every((r) => r.ratio > 0.8 && r.ratio < 1.2),
		rows
			.map(
				(r) =>
					`${r.k} σ ${r.s.toPrecision(3)}/sd ${r.sd.toPrecision(3)} (×${r.ratio.toFixed(2)})`,
			)
			.join("; "),
	);
}

// 4. all-far scene: eye unobserved
{
	const S = scene(80, 15_000, 30_000, 20_000);
	const p = problem(S, SIG, { loss: "robust", realistic: true });
	const r = await solveMap(p, perturbed());
	check(
		"all-far: σ_EN ≥ 0.8·σ_GPS",
		r.sigmaEN >= 0.8 * SIG.gps,
		`σ_EN ${r.sigmaEN.toFixed(2)} m vs σ_GPS ${SIG.gps} m (σE ${r.sigma.E.toFixed(1)}, σN ${r.sigma.N.toFixed(1)}, σU ${r.sigma.U.toFixed(2)})`,
	);
}

// 5. near scene: eye observed
{
	const S = scene(80, 300, 1000, 1500);
	const p = problem(S, SIG, { loss: "robust", realistic: true });
	const r = await solveMap(p, perturbed());
	const dEye = Math.hypot(r.x[IDX.E], r.x[IDX.N]);
	check(
		"near points: σ_EN ≪ σ_GPS",
		r.sigmaEN < 0.25 * SIG.gps && dEye < 4 * r.sigmaEN + 0.5,
		`σ_EN ${r.sigmaEN.toFixed(2)} m vs σ_GPS ${SIG.gps} m; |ΔEN| ${dEye.toFixed(2)} m`,
	);
}

// 6. Student-t compass vs a 90° blunder (weak image evidence: 6 far points, no skyline)
{
	const S = scene(6, 5000, 20_000, 8000);
	const shift = async (loss: "student" | "l2", blunder: number) => {
		seed = 777;
		const p = problem(
			S,
			{ ...SIG, pxPts: 3 },
			{ loss: "l2", compassBlunder: blunder, compassLoss: loss, noSky: true },
		);
		const r = await solveMap(p, truth);
		return r.x[IDX.yaw];
	};
	const yS0 = await shift("student", 0);
	const yS = await shift("student", 90);
	const yL0 = await shift("l2", 0);
	const yL = await shift("l2", 90);
	const dS = Math.abs(yS - yS0);
	const dL = Math.abs(yL - yL0);
	check(
		"Student-t compass robust to a 90° blunder",
		dS < 0.2 * dL && dS < 0.02,
		`yaw shift student ${dS.toFixed(4)}° vs l2 ${dL.toFixed(4)}°`,
	);
}

if (failed) {
	console.log(`\n${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("\nall map checks passed");

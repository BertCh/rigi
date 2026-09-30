// GA1 factors: priors and image evidence as whitened residual blocks over the GeoState (plan §1
// map/factors.ts). Every factory returns a core Factor; residuals are dimensionless (σ-normalised).
//
// Priors (prior: true, excluded from the MAD covariance rescale)
//   gps       horizontal fix (E0, N0) ± σH                                  l2
//   alt       U − (alt − altBias) ± σA (concord/priors/altitude.ts defaults) l2
//   ground    standing height U − ground(E, N) − 1.6, σ 2 m above / 0.5 m below (joint.ts)  l2, asymmetric
//   gravity   pitch, roll ± 1.5°                                             l2
//   compass   dAngle(yaw, heading) ± √(σn² + σbias²) (bias folded in: not identifiable from one photo)
//             Student-t ν = 3 (a 90° compass blunder must not drag the pose)
//   focal     f0·exp(logf) − fPrior ± σf (concord/priors/focal-table.ts focalPrior)          l2
// Evidence
//   skyline   (el(u, v) − horizon(az; eye))·f per observed skyline sample (as concord joint.ts skylineResidualsX),
//             the horizon linearised in the eye by central differences of horizons at eye ± δ
//             (HorizonsAtEyes; re-linearised by solveMap's outer loop). Per-sample σ is refine/model.ts
//             columnSigma at the horizon distance: σpx ⊕ f·σDEM(d)/d ⊕ f·σK·d/2R. Cauchy c = 2, nEff 60.
//   point     2D–3D correspondence, projectX residual (px @1600), σ = σpx ⊕ f·σDEM(d)/d
//             (concord/cues/contours.ts defaultDemSigmaM). Cauchy c = 2.5.
//   edge / level / shore / point cues: concordCueFactors wraps joint-residual.ts cueResidualPx (one factor per kind;
//             nEff per kind from JOINT_DEFAULTS.groupEff; pins uncapped).
import { projectX, unprojectDirX } from "../../concord/core";
import { defaultDemSigmaM } from "../../concord/cues/contours";
import { EYE_PRIOR_DEFAULTS } from "../../concord/priors/altitude";
import {
	basisPx,
	cueResidualPx,
	focalPx1600,
	horizonEl,
	JOINT_DEFAULTS,
	type JointCue,
} from "./joint-residual";
import type {
	EyeHorizon,
	HorizonsAtEyes,
	SkylineSample,
} from "../../pose6dof/eye";
import { columnSigma } from "../../refine/model";
import {
	type CameraX,
	cameraXFromState,
	dAngle,
	type Factor,
	type GeoState,
	IDX,
	type Loss,
	NP,
	stateFromCameraX as stateOf,
	type Vec3,
} from "../core";
import {
	CLUSTER_DEFAULTS,
	type ClusterOpts,
	type ClusterWhitener,
	clusterKey,
	clusterWhitener,
} from "./cluster";

const D = Math.PI / 180;

const azEl = (d: ArrayLike<number>): [number, number] => [
	(((Math.atan2(d[0], d[1]) / D) % 360) + 360) % 360,
	Math.asin(Math.max(-1, Math.min(1, d[2]))) / D,
];

/** A dim×7 Jacobian with the given (row, col, value) entries. */
function sparseJ(dim: number, e: [number, number, number][]): Float64Array {
	const J = new Float64Array(dim * NP);
	for (const [r, c, v] of e) J[r * NP + c] = v;
	return J;
}

// ---------------------------------------------------------------- priors

export function gpsFactor(E0: number, N0: number, sigmaH: number): Factor {
	return {
		family: "gps",
		name: "gps",
		dim: 2,
		loss: { kind: "l2" },
		prior: true,
		residual: (x) =>
			Float64Array.of((x[IDX.E] - E0) / sigmaH, (x[IDX.N] - N0) / sigmaH),
		jacobian: () =>
			sparseJ(2, [
				[0, IDX.E, 1 / sigmaH],
				[1, IDX.N, 1 / sigmaH],
			]),
	};
}

/**
 * GPS altitude, in the problem's vertical frame. The eye is read as alt − altBias (altitude.ts: iPhone
 * GPSAltitude − (true ground + 1.6) ≈ altBias = −7 m on DEV), σA = 3 m.
 */
export function altFactor(
	alt: number,
	altBias: number = EYE_PRIOR_DEFAULTS.altBias,
	sigmaA: number = EYE_PRIOR_DEFAULTS.sigmaA,
): Factor {
	const mu = alt - altBias;
	return {
		family: "alt",
		name: "alt",
		dim: 1,
		loss: { kind: "l2" },
		prior: true,
		residual: (x) => Float64Array.of((x[IDX.U] - mu) / sigmaA),
		jacobian: () => sparseJ(1, [[0, IDX.U, 1 / sigmaA]]),
	};
}

/**
 * Standing height above the DEM: U − ground(E, N) − h, σ `sigmaAbove` when above, `sigmaBelow` when
 * below (being under the ground is much less likely than standing on a wall or a tower).
 */
export function groundFactor(
	ground: (e: number, n: number) => number,
	h: number = EYE_PRIOR_DEFAULTS.eyeAboveGround,
	sigmaAbove = JOINT_DEFAULTS.groundSigmaM,
	sigmaBelow = JOINT_DEFAULTS.groundBelowSigmaM,
): Factor {
	const above = (x: GeoState) => x[IDX.U] - ground(x[IDX.E], x[IDX.N]) - h;
	return {
		family: "ground",
		name: "ground",
		dim: 1,
		loss: { kind: "l2" },
		prior: true,
		residual: (x) => {
			const a = above(x);
			return Float64Array.of(a / (a < 0 ? sigmaBelow : sigmaAbove));
		},
		jacobian: (x) => {
			const a = above(x);
			const s = a < 0 ? sigmaBelow : sigmaAbove;
			const e = x[IDX.E];
			const n = x[IDX.N];
			const h1 = 0.5;
			const gE = (ground(e + h1, n) - ground(e - h1, n)) / (2 * h1);
			const gN = (ground(e, n + h1) - ground(e, n - h1)) / (2 * h1);
			return sparseJ(1, [
				[0, IDX.E, Number.isFinite(gE) ? -gE / s : 0],
				[0, IDX.N, Number.isFinite(gN) ? -gN / s : 0],
				[0, IDX.U, 1 / s],
			]);
		},
	};
}

/** Accelerometer pitch / roll (photo.pitch / photo.roll or geo/camera.ts gravityInDisplayFrame). */
export function gravityFactor(
	pitchG: number,
	rollG: number,
	sigmaDeg = 1.5,
): Factor {
	return {
		family: "gravity",
		name: "gravity",
		dim: 2,
		loss: { kind: "l2" },
		prior: true,
		residual: (x) =>
			Float64Array.of(
				(x[IDX.pitch] - pitchG) / sigmaDeg,
				dAngle(x[IDX.roll], rollG) / sigmaDeg,
			),
		jacobian: () =>
			sparseJ(2, [
				[0, IDX.pitch, 1 / sigmaDeg],
				[1, IDX.roll, 1 / sigmaDeg],
			]),
	};
}

export const COMPASS_DEFAULTS = { sigmaNoiseDeg: 5, sigmaBiasDeg: 5, nu: 3 };

/** Compass heading (TRUE north, declination applied by the caller), Student-t. */
export function compassFactor(
	headingTrue: number,
	o: { sigmaNoiseDeg?: number; sigmaBiasDeg?: number; nu?: number } = {},
): Factor {
	const sn = o.sigmaNoiseDeg ?? COMPASS_DEFAULTS.sigmaNoiseDeg;
	const sb = o.sigmaBiasDeg ?? COMPASS_DEFAULTS.sigmaBiasDeg;
	const s = Math.hypot(sn, sb);
	return {
		family: "compass",
		name: "compass",
		dim: 1,
		loss: { kind: "student", nu: o.nu ?? COMPASS_DEFAULTS.nu },
		prior: true,
		residual: (x) => Float64Array.of(dAngle(x[IDX.yaw], headingTrue) / s),
		jacobian: () => sparseJ(1, [[0, IDX.yaw, 1 / s]]),
	};
}

/**
 * Focal prior in px @1600 (long side 1600): f0·exp(logf) − fPx ± σ. Build it from
 * concord/priors/focal-table.ts focalPrior (scale its px to the 1600 basis).
 */
export function focalFactor(
	f0Px1600: number,
	fPx1600: number,
	sigmaPx1600: number,
): Factor {
	return {
		family: "focal",
		name: "focal",
		dim: 1,
		loss: { kind: "l2" },
		prior: true,
		residual: (x) =>
			Float64Array.of(
				(f0Px1600 * Math.exp(x[IDX.logf]) - fPx1600) / sigmaPx1600,
			),
		jacobian: (x) =>
			sparseJ(1, [
				[0, IDX.logf, (f0Px1600 * Math.exp(x[IDX.logf])) / sigmaPx1600],
			]),
	};
}

// ---------------------------------------------------------------- skyline

type HzLin = {
	eL: Vec3;
	h0: EyeHorizon;
	/** [+δ, −δ] horizons per eye axis, or null when the eye is not linearised. */
	d: [EyeHorizon, EyeHorizon][] | null;
	delta: number;
};

/** Horizon elevation at az for an eye near lin.eL (first order in the eye). As joint.ts linHorizonEl. */
export function linHorizonEl(lin: HzLin, az: number, eye: ArrayLike<number>) {
	const b = horizonEl(lin.h0, az);
	if (!Number.isFinite(b) || !lin.d) return b;
	let s = b;
	for (let k = 0; k < 3; k++) {
		const de = eye[k] - lin.eL[k];
		if (de === 0) continue;
		const hp = horizonEl(lin.d[k][0], az);
		const hm = horizonEl(lin.d[k][1], az);
		if (Number.isFinite(hp) && Number.isFinite(hm))
			s += ((hp - hm) / (2 * lin.delta)) * de;
	}
	return s;
}

/** Horizon distance at an azimuth (nearest bin), NaN if the horizon carries none. */
function horizonDist(h: EyeHorizon, az: number): number {
	if (!h.distance) return Number.NaN;
	const n = h.distance.length;
	const i = Math.round((((az % 360) + 360) % 360) / h.step) % n;
	const d = h.distance[i];
	return d > 0 ? d : Number.NaN;
}

export type SkylineOpts = {
	/** Detection noise, px @1600. Default 2 (joint.ts). */
	sigmaPx?: number;
	/** DEM σ at distance d (m). Default concord defaultDemSigmaM (3 + 0.001·d). */
	demSigmaM?: (d: number) => number;
	/** Refraction coefficient σ (refine default 0.05). */
	sigmaK?: number;
	loss?: Loss;
	/** Effective sample cap (default 60, joint.ts); Infinity = independent rows. */
	nEff?: number;
	/** Linearise the horizon in the eye (7 horizons per re-linearisation). Default true. */
	eye?: boolean;
	/** Finite-difference step (m) and eye quantum (m) for horizon requests. */
	stepM?: number;
	quantumM?: number;
	/** Cluster-correlated DEM error (./cluster.ts); null = independent rows. Needs eye = true. */
	cluster?: ClusterOpts | null;
};

export type SkylineFactor = Factor & {
	/** Current linearisation (null before the first relinearize). */
	lin(): HzLin | null;
	/** Per-sample σ (px @1600) of the current linearisation. */
	sigmas(): Float64Array;
	horizonCalls(): number;
};

/**
 * Observed skyline samples (u, v normalised, weight w) against the DEM horizon at the state's eye.
 * `relinearize(x)` must run before `residual` (solveMap does). Sample weights enter as σ/√(w/w̄).
 */
export function skylineFactor(
	base: CameraX,
	samples: SkylineSample[],
	horizonsAtEyes: HorizonsAtEyes,
	o: SkylineOpts = {},
): SkylineFactor {
	const sigPx = o.sigmaPx ?? JOINT_DEFAULTS.skylineSigmaPx;
	const demSig = o.demSigmaM ?? defaultDemSigmaM;
	const sigK = o.sigmaK ?? 0.05;
	const withEye = o.eye ?? true;
	const cl =
		o.cluster === null || !withEye
			? null
			: { ...CLUSTER_DEFAULTS, ...o.cluster };
	const rho = cl ? cl.rho : 0;
	const delta = o.stepM ?? 5;
	const quantum = o.quantumM ?? 0.25;
	const wMean =
		samples.reduce((a, s) => a + (s.w ?? 1), 0) / Math.max(1, samples.length);
	const wScale = samples.map((s) =>
		Math.sqrt(Math.max(1e-3, (s.w ?? 1) / wMean)),
	);
	let lin: HzLin | null = null;
	let sig = new Float64Array(samples.length).fill(sigPx);
	let white: ClusterWhitener | null = null;
	let calls = 0;
	const q = (v: number) => Math.round(v / quantum) * quantum;
	return {
		family: "skyline",
		name: "skyline",
		dim: samples.length,
		loss: o.loss ?? { kind: "cauchy", c: 2 },
		nEff: o.nEff ?? JOINT_DEFAULTS.skylineEff,
		lin: () => lin,
		sigmas: () => sig,
		horizonCalls: () => calls,
		async relinearize(x: GeoState) {
			const eL: Vec3 = [q(x[IDX.E]), q(x[IDX.N]), q(x[IDX.U])];
			if (
				lin &&
				lin.eL[0] === eL[0] &&
				lin.eL[1] === eL[1] &&
				lin.eL[2] === eL[2]
			)
				return;
			const eyes: Vec3[] = [eL];
			if (withEye)
				for (let k = 0; k < 3; k++)
					for (const s of [1, -1]) {
						const e: Vec3 = [eL[0], eL[1], eL[2]];
						e[k] += s * delta;
						eyes.push(e);
					}
			const hs = await horizonsAtEyes(eyes);
			calls += eyes.length;
			const L: HzLin = {
				eL,
				h0: hs[0],
				d: withEye
					? [
							[hs[1], hs[2]],
							[hs[3], hs[4]],
							[hs[5], hs[6]],
						]
					: null,
				delta,
			};
			lin = L;
			// per-sample σ (independent part) and cluster whitening at the current camera, fixed until
			// the next relinearize
			const cam = cameraXFromState(base, x);
			const f = focalPx1600(cam);
			const s2 = new Float64Array(samples.length);
			const G = new Float64Array(samples.length * 3);
			const groups = new Map<string, { rows: number[]; d: number[] }>();
			samples.forEach((s, i) => {
				const [az] = azEl(unprojectDirX(cam, s.u, s.v));
				const d = horizonDist(hs[0], az);
				const c = Number.isFinite(d)
					? columnSigma(
							{
								sigmaPx: sigPx,
								sigmaZ: Math.sqrt(1 - rho) * demSig(d),
								sigmaK: sigK,
								sigmaXY: 0,
							},
							f,
							d,
							0,
						)
					: sigPx;
				s2[i] = c / wScale[i];
				if (!cl || !L.d || !Number.isFinite(d)) return;
				for (let k = 0; k < 3; k++) {
					const g =
						(horizonEl(L.d[k][0], az) - horizonEl(L.d[k][1], az)) / (2 * delta);
					G[i * 3 + k] = Number.isFinite(g) ? (-g * D * f) / s2[i] : 0;
				}
				const key = clusterKey(az, d, cl.sectorDeg);
				let gr = groups.get(key);
				if (!gr) {
					gr = { rows: [], d: [] };
					groups.set(key, gr);
				}
				gr.rows.push(i);
				gr.d.push(d);
			});
			sig = s2;
			white = cl
				? clusterWhitener(
						G,
						[...groups.values()].map((g) => ({
							rows: g.rows,
							sigmaM: Math.sqrt(rho) * demSig(medianOf(g.d)),
						})),
					)
				: null;
		},
		residual(x: GeoState) {
			if (!lin) throw new Error("skylineFactor: relinearize(x) first");
			const cam = cameraXFromState(base, x);
			const f = focalPx1600(cam);
			const eye = cam.eye;
			const r = new Float64Array(samples.length);
			for (let i = 0; i < samples.length; i++) {
				const s = samples[i];
				const [az, el] = azEl(unprojectDirX(cam, s.u, s.v));
				r[i] = ((el - linHorizonEl(lin, az, eye)) * D * f) / sig[i];
			}
			return white ? white.apply(r) : r;
		},
	};
}

const medianOf = (a: number[]) => {
	const s = [...a].sort((x, y) => x - y);
	return s[s.length >> 1];
};

// ---------------------------------------------------------------- points and concord cues

export type Corr2D3D = {
	/** Observed pixel, normalised (0..1, v down). */
	u: number;
	v: number;
	/** World point in the problem frame (same frame as the eye). */
	world: Vec3;
	sigmaPx?: number;
	depthM?: number;
};

export type PointOpts = {
	sigmaPx?: number;
	/** DEM σ(d) m; null = pixel σ only (and no clusters). Default defaultDemSigmaM. */
	demSigmaM?: ((d: number) => number) | null;
	/** Cluster-correlated DEM error (./cluster.ts); null = independent rows. */
	cluster?: ClusterOpts | null;
	loss?: Loss;
	nEff?: number;
	name?: string;
};

/**
 * 2D–3D correspondences: rows (û − u)·W / σ, (v̂ − v)·H / σ (px @1600) with σ = σpx ⊕ f·√(1−ρ)·σDEM(d)/d
 * (ρ = cluster share, 0 without clusters), σ fixed at construction from the base camera's focal and
 * d = |world − base.eye| (or depthM). The cluster whitening is built at construction (base camera) and
 * rebuilt by relinearize(x).
 */
export function pointFactor(
	base: CameraX,
	corrs: Corr2D3D[],
	o: PointOpts = {},
): Factor {
	const demSig =
		o.demSigmaM === null ? null : (o.demSigmaM ?? defaultDemSigmaM);
	const cl =
		o.cluster === null || !demSig
			? null
			: { ...CLUSTER_DEFAULTS, ...o.cluster };
	const rho = cl ? cl.rho : 0;
	const f = focalPx1600(base);
	const { W, H } = basisPx(base.aspect);
	const dist = corrs.map((c) =>
		Math.max(
			1,
			c.depthM ??
				Math.hypot(
					c.world[0] - base.eye[0],
					c.world[1] - base.eye[1],
					c.world[2] - base.eye[2],
				),
		),
	);
	const sig = corrs.map((c, i) => {
		const sp = c.sigmaPx ?? o.sigmaPx ?? 2;
		if (!demSig) return sp;
		const d = dist[i];
		return Math.hypot(sp, (f * Math.sqrt(1 - rho) * demSig(d)) / d);
	});
	const raw = (cam: CameraX) => {
		const r = new Float64Array(2 * corrs.length);
		corrs.forEach((c, i) => {
			const q = projectX(cam, c.world);
			if (!q) {
				r[2 * i] = r[2 * i + 1] = Number.NaN;
				return;
			}
			r[2 * i] = ((q.u - c.u) * W) / sig[i];
			r[2 * i + 1] = ((q.v - c.v) * H) / sig[i];
		});
		return r;
	};
	let white: ClusterWhitener | null = null;
	const build = (x: GeoState) => {
		if (!cl || !demSig) return;
		const cam = cameraXFromState(base, x);
		const G = new Float64Array(2 * corrs.length * 3);
		const h = 0.5;
		for (let k = 0; k < 3; k++) {
			const ep = [...cam.eye] as Vec3;
			const em = [...cam.eye] as Vec3;
			ep[k] += h;
			em[k] -= h;
			const rp = raw({ ...cam, eye: ep });
			const rm = raw({ ...cam, eye: em });
			for (let i = 0; i < rp.length; i++) {
				const g = (rp[i] - rm[i]) / (2 * h);
				G[i * 3 + k] = Number.isFinite(g) ? g : 0;
			}
		}
		const groups = new Map<string, { rows: number[]; d: number[] }>();
		corrs.forEach((c, i) => {
			const az =
				Math.atan2(c.world[0] - cam.eye[0], c.world[1] - cam.eye[1]) / D;
			const key = clusterKey(az, dist[i], cl.sectorDeg);
			let g = groups.get(key);
			if (!g) {
				g = { rows: [], d: [] };
				groups.set(key, g);
			}
			g.rows.push(2 * i, 2 * i + 1);
			g.d.push(dist[i]);
		});
		white = clusterWhitener(
			G,
			[...groups.values()].map((g) => ({
				rows: g.rows,
				sigmaM: Math.sqrt(rho) * demSig(medianOf(g.d)),
			})),
		);
	};
	build(stateOf(base));
	return {
		family: "point",
		name: o.name ?? "point",
		dim: 2 * corrs.length,
		loss: o.loss ?? { kind: "cauchy", c: 2.5 },
		nEff: o.nEff,
		relinearize: cl
			? async (x: GeoState) => {
					build(x);
				}
			: undefined,
		residual(x) {
			const r = raw(cameraXFromState(base, x));
			return white ? white.apply(r) : r;
		},
	};
}

export type CueFactorOpts = {
	/** Shore cues without `world`: lake level → frame z. */
	frame?: { alt0: number; rEff: number };
	/** Fixed edge-cue offset along the normal (px; WP-C measured −1.5…−2.7). Default 0. */
	edgeBiasPx?: number;
	loss?: Loss;
	/** nEff per kind (default JOINT_DEFAULTS.groupEff); cues whose source starts "pin" are uncapped. */
	groupEff?: Record<string, number>;
	/** DEM σ for point cues (as joint.ts; null = none). */
	demSigmaM?: ((d: number) => number) | null;
};

/**
 * concord JointCues (point / edge / level / shore) as factors, one per (kind, pin-or-not): residuals
 * joint.ts cueResidualPx / σ. Families: point, edge, level, shore.
 */
export function concordCueFactors(
	base: CameraX,
	cues: JointCue[],
	o: CueFactorOpts = {},
): Factor[] {
	const demSig =
		o.demSigmaM === null
			? null
			: (o.demSigmaM ?? ((d: number) => 3 + 0.001 * d));
	const eff = { ...JOINT_DEFAULTS.groupEff, ...(o.groupEff ?? {}) };
	const f0 = focalPx1600(base);
	const ok = cues.filter(
		(c) =>
			Number.isFinite(c.u) &&
			Number.isFinite(c.v) &&
			Number.isFinite(c.sigmaPx) &&
			c.sigmaPx > 0,
	);
	const groups = new Map<string, JointCue[]>();
	for (const c of ok) {
		const pin = c.source.startsWith("pin");
		const k = `${c.kind}${pin ? ":pin" : ""}`;
		groups.set(k, [...(groups.get(k) ?? []), c]);
	}
	const out: Factor[] = [];
	for (const [k, cs] of groups) {
		const kind = cs[0].kind;
		const pin = k.endsWith(":pin");
		const dimOf = kind === "point" ? 2 : 1;
		const sig = cs.map((c) => {
			if (c.kind !== "point" || !demSig || pin) return c.sigmaPx;
			const d = Math.max(c.depthM, 1);
			return Math.hypot(c.sigmaPx, (f0 * demSig(d)) / d);
		});
		const nEff = pin ? undefined : (eff[kind] ?? JOINT_DEFAULTS.defaultEff);
		out.push({
			family: kind,
			name: `cue:${k}`,
			dim: dimOf * cs.length,
			loss: o.loss ?? { kind: "cauchy", c: JOINT_DEFAULTS.cueScale },
			nEff: Number.isFinite(nEff) ? nEff : undefined,
			residual(x) {
				const cam = cameraXFromState(base, x);
				const r = new Float64Array(dimOf * cs.length);
				cs.forEach((c, i) => {
					const v = cueResidualPx(cam, c, o.edgeBiasPx ?? 0, o.frame);
					for (let j = 0; j < dimOf; j++) r[dimOf * i + j] = v[j] / sig[i];
				});
				return r;
			},
		});
	}
	return out;
}

// ---------------------------------------------------------------- lake floor (GA0 "eye ≥ lake level")
// Moved from lakes/factors.ts (GA4 waterline factors removed 2026-09-30): a one-sided eye floor
// U ≥ level + margin (scene-frame z) as a prior factor (zero residual when satisfied, stiff quadratic
// below). A veto-style bound, not a pull (guard-rail 2).

export type LakeFloorOpts = {
	/** Eye must be at least this far above the level (m). Default 0.3 (lakes/floor.ts margin). */
	marginM?: number;
	/** Stiffness below the floor (m). Default 0.25. */
	sigmaM?: number;
};

/**
 * One-sided eye floor: U ≥ levelZ + margin, levelZ in the SCENE frame (absolute level − alt0 −
 * curvature drop at the eye, i.e. what lakes/floor.ts returns converted by the caller). Zero residual
 * above; (floor − U)/σ below. Prior factor (excluded from the MAD rescale), analytic Jacobian.
 */
export function lakeFloorFactor(levelZ: number, o: LakeFloorOpts = {}): Factor {
	const floorZ = levelZ + (o.marginM ?? 0.3);
	const sig = o.sigmaM ?? 0.25;
	return {
		family: "lakeFloor",
		name: "lakeFloor",
		dim: 1,
		loss: { kind: "l2" },
		prior: true,
		residual: (x) =>
			Float64Array.of(x[IDX.U] < floorZ ? (floorZ - x[IDX.U]) / sig : 0),
		jacobian: (x) => {
			const j = new Float64Array(NP);
			if (x[IDX.U] < floorZ) j[IDX.U] = -1 / sig;
			return j;
		},
	};
}

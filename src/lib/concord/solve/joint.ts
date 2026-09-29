// Joint whole-frame solver (WP-D, reports/concordance-research.md §4).
//
// State: yaw, pitch, roll, focal scale, eye E/N/U, optionally k1, plus one nuisance (a per-photo
// edge-cue offset along the cue normal, px; WP-C measured a −1.5…−2.7 px contour offset at the GT pose
// in every band, i.e. a detector/canopy effect that must not be read as pose).
//
// Residual stack (all whitened, robust loss on data rows, priors quadratic):
//   skyline   (observed elevation − DEM horizon) · f, px; the horizon depends on the eye. It is
//             linearised in the eye by central differences of horizons at eye ± δ (HorizonsAtEyes) and
//             re-linearised at the new eye (outer loop, proximal trust term) until the eye stops
//             moving: the variable-projection-over-eye idea of pose6dof/eye.ts refineEyeFromSkyline,
//             in Gauss–Newton form. Samples are scaled to weigh like `effectiveSamples` observations.
//   cues      point (2 rows), edge (along the normal, minus the edge offset), level (elevation only),
//             shore (signed shore distance of the lake-plane hit, converted to px by its image
//             gradient). Each cue group (kind + source) is capped at an effective count.
//   priors    eye: GPS horizontal σH, vertical σV around eyePrior.eye0, and standing height above the
//             near DEM (the altitude-contour term of WP-B split into its two measurements); focal
//             (focal table, WP-B); k1 (0 ± σ); weak rotation prior around cam0; edge offset (0 ± σ).
//
// Freedom rules (plan §4 WP-D / §5): the eye is freed only when ≥ minNearCues cues lie closer than
// nearM (near cues are the only ones with enough parallax to move it); k1 only with ≥ minCornerCues
// cues in the corner radius band; the principal point is never freed.
//
// Pure TS, no DOM; the horizon provider is injected (src/lib/gpu/eye or a CPU ray march).
import { invSym } from "../../linalg";
import type {
	EyeHorizon,
	HorizonsAtEyes,
	SkylineSample,
} from "../../pose6dof/eye";
import {
	type CameraX,
	type Cue,
	distanceBand,
	projectX,
	radiusBand,
	unprojectDirX,
	type Vec3,
} from "../core";
import type { EyePrior } from "../priors/altitude";

const D = Math.PI / 180;

/**
 * A cue as the solver consumes it. `residualPx` (WP-C MatchedCue) is only read for "edge" cues: their
 * (u, v) is the PREDICTED contour point at extraction and the observed edge is (u, v) − residualPx·n
 * (px @1600). Point, level and shore cues carry the OBSERVED pixel in (u, v). `world` is read for level
 * and shore cues when present (WP-C WaterCue: the lake-level shore point, scene frame).
 */
export type JointCue = Cue & {
	residualPx?: number;
	conf?: number;
	world?: Vec3;
};

export type JointFree = { eye: boolean; fScale: boolean; k1: boolean };

export type JointInput = {
	/** Prior reference and "before" camera (its rotation is the rotation-prior mean). */
	cam0: CameraX;
	/** Eye prior in the SAME frame as cam0.eye (callers convert WP-B's fix-centred frame). */
	eyePrior: EyePrior;
	skyline: SkylineSample[];
	/** Horizons at absolute eyes in cam0.eye's frame. */
	horizonsAtEyes: HorizonsAtEyes;
	cues: JointCue[];
	/** Focal prior. px at the 1600 basis (long side 1600) unless `basisLongPx` says otherwise. */
	focal: { fPx: number; sigmaPx: number; basisLongPx?: number };
	/** k1 is freed only if corner-cue coverage passes. */
	free: JointFree;
	// ---- additive
	/** Start camera (default cam0), e.g. the previous round's solution. */
	start?: CameraX;
	/**
	 * Near DEM in the frame of cam0.eye: absolute (e, n) → z. Default: eyePrior.isoBand.ground (offset
	 * from eyePrior.eye0). Used for the standing-height prior.
	 */
	ground?: (e: number, n: number) => number;
	/** Frame convention for shore cues without `world` (lake level → frame z). */
	frame?: { alt0: number; rEff: number };
};

export type JointResult = {
	cam: CameraX;
	/** Covariance of the parameters (row-major, PARAM_NAMES order; 0 for fixed ones). */
	cov: Float64Array;
	sigma: Record<string, number>;
	skylineRmsBefore: number;
	skylineRmsAfter: number;
	cueRmsBefore: number;
	cueRmsAfter: number;
	spread: { quadrants: number; bands: number };
	accepted: boolean;
	reasons: string[];
	// ---- additive
	cam0: CameraX;
	/** Parameters actually freed (after the near-cue and corner-cue rules). */
	freed: JointFree;
	/** eye − cam0.eye (m) and its horizontal size in σH. */
	eyeShift: Vec3;
	eyeShiftSigmaH: number;
	/** Focal deviation from the prior mean, in prior σ. */
	focalZ: number;
	/** Nuisance: edge-cue offset along the normal, px. */
	edgeBiasPx: number;
	skylineInlierBefore: number;
	skylineInlierAfter: number;
	/** Cue counts: total, near (< nearM), corner. */
	counts: { cues: number; near: number; corner: number; skyline: number };
	iterations: number;
	outer: number;
	horizonCalls: number;
	converged: boolean;
	ms: number;
};

export type JointOpts = {
	loss?: "huber" | "cauchy";
	maxIter?: number;
	// ---- additive
	/** Robust scale of cue rows in σ units. Default 2.5. */
	cueScale?: number;
	skyline?: {
		sigmaPx?: number;
		/** Cauchy/Huber scale, px. Default 4 (pose6dof/eye.ts). */
		scalePx?: number;
		effectiveSamples?: number;
		/** |r| below this counts in skylineRms. Default 30 px (eval lib convention). */
		rmsClipPx?: number;
	};
	/** Effective count per cue group (kind:source-prefix). Unlisted groups: `defaultEff`. */
	groupEff?: Record<string, number>;
	defaultEff?: number;
	/** Cue σ floor for DEM error: σz(d) m (default 3 + 0.001·d), added in quadrature for point cues. */
	demSigmaM?: ((d: number) => number) | null;
	/** Rotation prior σ (deg) around cam0. Default 5 / 3 / 3. */
	rotationSigma?: { yaw: number; pitch: number; roll: number };
	/** Edge-offset nuisance prior σ, px (0 = no nuisance). Default 3. */
	edgeBiasSigmaPx?: number;
	/** Standing height and its σ (m); σ below that height is `groundBelowSigmaM`. */
	eyeAboveGround?: number;
	groundSigmaM?: number;
	groundBelowSigmaM?: number;
	k1Sigma?: number;
	nearM?: number;
	minNearCues?: number;
	minCornerCues?: number;
	/** Horizon finite-difference step (m) and eye quantum for horizon requests (m). */
	horizonStepM?: number;
	eyeQuantumM?: number;
	/** Proximal trust σ on the eye around the linearisation point (m) and re-linearisation limit. */
	trustM?: number;
	maxOuter?: number;
	relinM?: number;
	/** Clip for cueRms, px. Default 20. */
	cueClipPx?: number;
	signal?: AbortSignal;
};

export const JOINT_DEFAULTS = {
	cueScale: 2.5,
	skylineSigmaPx: 2,
	skylineScalePx: 4,
	skylineEff: 60,
	rmsClipPx: 30,
	groupEff: {
		edge: 40,
		level: 20,
		shore: 20,
		point: 60,
		"point:pin": Number.POSITIVE_INFINITY,
		"level:pin": Number.POSITIVE_INFINITY,
	} as Record<string, number>,
	defaultEff: 40,
	rotationSigma: { yaw: 5, pitch: 3, roll: 3 },
	edgeBiasSigmaPx: 3,
	eyeAboveGround: 1.6,
	groundSigmaM: 2,
	groundBelowSigmaM: 0.5,
	k1Sigma: 0.05,
	nearM: 2000,
	minNearCues: 6,
	minCornerCues: 6,
	horizonStepM: 5,
	eyeQuantumM: 0.25,
	trustM: 10,
	maxOuter: 4,
	relinM: 1,
	cueClipPx: 20,
	maxIter: 40,
};

export const PARAM_NAMES = [
	"yaw",
	"pitch",
	"roll",
	"fScale",
	"eE",
	"eN",
	"eU",
	"k1",
	"edgeBias",
] as const;
const NP = PARAM_NAMES.length;
const FD_STEP = [1e-4, 1e-4, 1e-4, 1e-5, 0.01, 0.01, 0.01, 1e-5, 1e-3];

// ---------------------------------------------------------------- geometry helpers

export const basisPx = (aspect: number) =>
	aspect >= 1 ? { W: 1600, H: 1600 / aspect } : { W: 1600 * aspect, H: 1600 };

/** Focal (px @1600, long side 1600) of a CameraX, including fScale. */
export function focalPx1600(cam: CameraX): number {
	const { H } = basisPx(cam.aspect);
	return (H / 2 / Math.tan((cam.pose.vfov * D) / 2)) * cam.intr.fScale;
}

const azEl = (d: ArrayLike<number>): [number, number] => [
	(((Math.atan2(d[0], d[1]) / D) % 360) + 360) % 360,
	Math.asin(Math.max(-1, Math.min(1, d[2]))) / D,
];

/** Horizon elevation at an azimuth (linear interpolation; NaN on no-data ≤ −89). */
export function horizonEl(h: EyeHorizon, az: number): number {
	const n = h.elevation.length;
	const t = (((az % 360) + 360) % 360) / h.step;
	const i = Math.floor(t);
	const f = t - i;
	const a = h.elevation[i % n];
	const b = h.elevation[(i + 1) % n];
	if (!(a > -89) || !(b > -89)) return Number.NaN;
	return a * (1 - f) + b * f;
}

/** Skyline residuals (px @1600) of samples against a horizon under a camera (intrinsics honoured). */
export function skylineResidualsX(
	cam: CameraX,
	samples: SkylineSample[],
	h: EyeHorizon,
): number[] {
	const f = focalPx1600(cam);
	return samples.map((s) => {
		const [az, el] = azEl(unprojectDirX(cam, s.u, s.v));
		return (el - horizonEl(h, az)) * D * f;
	});
}

/** RMS over |r| < clip, and the fraction of samples inside the clip. */
export function clippedRms(r: number[], clip: number) {
	let s = 0;
	let n = 0;
	for (const x of r)
		if (Number.isFinite(x) && Math.abs(x) < clip) {
			s += x * x;
			n++;
		}
	return {
		rms: n ? Math.sqrt(s / n) : Number.NaN,
		inlierFrac: r.length ? n / r.length : 0,
	};
}

const groupOf = (c: JointCue) => `${c.kind}:${c.source.split(":")[0]}`;

/**
 * Pixel residual(s) of one cue under `cam` (px @1600, predicted − observed). point: [dx, dy];
 * edge: [along-normal − edgeBias]; level: [dy]; shore: [signed px distance to the predicted shore].
 * NaN when the cue cannot be evaluated (behind the camera, ray misses the lake plane).
 */
export function cueResidualPx(
	cam: CameraX,
	c: JointCue,
	edgeBias = 0,
	frame?: { alt0: number; rEff: number },
): number[] {
	const { W, H } = basisPx(cam.aspect);
	switch (c.kind) {
		case "point": {
			const q = projectX(cam, c.world);
			if (!q) return [Number.NaN, Number.NaN];
			return [(q.u - c.u) * W, (q.v - c.v) * H];
		}
		case "edge": {
			const q = projectX(cam, c.world);
			if (!q) return [Number.NaN];
			const r0 = c.residualPx ?? 0;
			const ox = c.u * W - r0 * c.nu;
			const oy = c.v * H - r0 * c.nv;
			return [(q.u * W - ox) * c.nu + (q.v * H - oy) * c.nv - edgeBias];
		}
		case "level": {
			const [, elObs] = azEl(unprojectDirX(cam, c.u, c.v));
			let elT = c.el;
			if (c.world) {
				const dx = c.world[0] - cam.eye[0];
				const dy = c.world[1] - cam.eye[1];
				elT = Math.atan2(c.world[2] - cam.eye[2], Math.hypot(dx, dy)) / D;
			}
			return [focalPx1600(cam) * (elObs - elT) * D];
		}
		case "shore": {
			let lz: number;
			if (c.world) lz = c.world[2];
			else if (frame) {
				// shore distance ~ depth; the curvature drop at the cue's depth
				lz = c.lakeM - frame.alt0 - (c.depthM * c.depthM) / (2 * frame.rEff);
			} else return [Number.NaN];
			const sd = (u: number, v: number) => {
				const d = unprojectDirX(cam, u, v);
				if (d[2] > -1e-6) return Number.NaN;
				const t = (lz - cam.eye[2]) / d[2];
				if (!(t > 0)) return Number.NaN;
				return c.shoreDist(cam.eye[0] + t * d[0], cam.eye[1] + t * d[1]);
			};
			const s0 = sd(c.u, c.v);
			const gu = sd(c.u + 1 / W, c.v) - s0;
			const gv = sd(c.u, c.v + 1 / H) - s0;
			const g = Math.hypot(gu, gv);
			if (!Number.isFinite(s0) || !(g > 1e-9)) return [Number.NaN];
			return [s0 / g];
		}
	}
}

// ---------------------------------------------------------------- linearised horizon

type HzLin = {
	eL: Vec3;
	h0: EyeHorizon;
	/** [+δ, −δ] horizons per eye axis, or null when the eye is fixed. */
	d: [EyeHorizon, EyeHorizon][] | null;
	delta: number;
};

function linHorizonEl(lin: HzLin, az: number, eye: Vec3): number {
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

// ---------------------------------------------------------------- the solver

type Row = { a: number; c: number; quad: boolean };

/** Robust cost and IRLS weight of a whitened residual. */
function rho(z: number, c: number, loss: "huber" | "cauchy") {
	if (loss === "cauchy") return c * c * Math.log1p((z * z) / (c * c));
	const a = Math.abs(z);
	return a <= c ? z * z : 2 * c * a - c * c;
}
function psi(z: number, c: number, loss: "huber" | "cauchy") {
	if (loss === "cauchy") return 1 / (1 + (z * z) / (c * c));
	const a = Math.abs(z);
	return a <= c ? 1 : c / a;
}

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

export function camFromParams(base: CameraX, p: ArrayLike<number>): CameraX {
	return {
		pose: {
			yaw: ((p[0] % 360) + 360) % 360,
			pitch: p[1],
			roll: p[2],
			vfov: base.pose.vfov,
		},
		eye: [p[4], p[5], p[6]],
		aspect: base.aspect,
		intr: { fScale: p[3], k1: p[7], cx: base.intr.cx, cy: base.intr.cy },
	};
}

function paramsOf(cam: CameraX, bias = 0): number[] {
	return [
		cam.pose.yaw,
		cam.pose.pitch,
		cam.pose.roll,
		cam.intr.fScale,
		cam.eye[0],
		cam.eye[1],
		cam.eye[2],
		cam.intr.k1,
		bias,
	];
}

/**
 * Solve the joint whole-frame problem. Deterministic for a given input. Never throws on bad data: a
 * degenerate problem returns cam = start with accepted = false and the reason.
 */
export async function solveJoint(
	inp: JointInput,
	opts: JointOpts = {},
): Promise<JointResult> {
	const t0 = Date.now();
	const J = JOINT_DEFAULTS;
	const loss = opts.loss ?? "cauchy";
	const maxIter = opts.maxIter ?? J.maxIter;
	const cueScale = opts.cueScale ?? J.cueScale;
	const skySig = opts.skyline?.sigmaPx ?? J.skylineSigmaPx;
	const skyScale = (opts.skyline?.scalePx ?? J.skylineScalePx) / skySig;
	const skyEff = opts.skyline?.effectiveSamples ?? J.skylineEff;
	const rmsClip = opts.skyline?.rmsClipPx ?? J.rmsClipPx;
	const groupEff = { ...J.groupEff, ...(opts.groupEff ?? {}) };
	const defaultEff = opts.defaultEff ?? J.defaultEff;
	const demSigma =
		opts.demSigmaM === null
			? null
			: (opts.demSigmaM ?? ((d: number) => 3 + 0.001 * d));
	const rotSig = opts.rotationSigma ?? J.rotationSigma;
	const biasSig = opts.edgeBiasSigmaPx ?? J.edgeBiasSigmaPx;
	const hAbove = opts.eyeAboveGround ?? J.eyeAboveGround;
	const gSig = opts.groundSigmaM ?? J.groundSigmaM;
	const gSigBelow = opts.groundBelowSigmaM ?? J.groundBelowSigmaM;
	const k1Sig = opts.k1Sigma ?? J.k1Sigma;
	const nearM = opts.nearM ?? J.nearM;
	const minNear = opts.minNearCues ?? J.minNearCues;
	const minCorner = opts.minCornerCues ?? J.minCornerCues;
	const delta = opts.horizonStepM ?? J.horizonStepM;
	const quantum = opts.eyeQuantumM ?? J.eyeQuantumM;
	const trustM = opts.trustM ?? J.trustM;
	const maxOuter = opts.maxOuter ?? J.maxOuter;
	const relinM = opts.relinM ?? J.relinM;
	const cueClip = opts.cueClipPx ?? J.cueClipPx;

	const cam0 = inp.cam0;
	const start = inp.start ?? cam0;
	const reasons: string[] = [];
	const prior = inp.eyePrior;
	const ground =
		inp.ground ??
		(prior.isoBand
			? (e: number, n: number) =>
					(prior.isoBand as NonNullable<EyePrior["isoBand"]>).ground(
						e - prior.eye0[0],
						n - prior.eye0[1],
					)
			: undefined);

	// ---- freedom rules
	const cues = inp.cues.filter(
		(c) =>
			Number.isFinite(c.u) &&
			Number.isFinite(c.v) &&
			Number.isFinite(c.sigmaPx) &&
			c.sigmaPx > 0,
	);
	const nNear = cues.filter((c) => c.depthM < nearM).length;
	const nCorner = cues.filter(
		(c) => radiusBand(c.u, c.v, cam0.aspect) === "corner",
	).length;
	const freed: JointFree = {
		eye: inp.free.eye && nNear >= minNear,
		fScale: inp.free.fScale,
		k1: inp.free.k1 && nCorner >= minCorner,
	};
	if (inp.free.eye && !freed.eye)
		reasons.push(`eye fixed: ${nNear} cues < ${nearM} m (need ${minNear})`);
	if (inp.free.k1 && !freed.k1)
		reasons.push(`k1 fixed: ${nCorner} corner cues (need ${minCorner})`);
	const hasEdge = cues.some((c) => c.kind === "edge");
	const active = [
		true,
		true,
		true,
		freed.fScale,
		freed.eye,
		freed.eye,
		freed.eye,
		freed.k1,
		hasEdge && biasSig > 0,
	];
	const idx = active.flatMap((a, i) => (a ? [i] : []));

	// ---- rows
	const skyW = inp.skyline.map((s) => s.w ?? 1);
	const skyWSum = skyW.reduce((a, b) => a + b, 0) || 1;
	const skyRows: Row[] = skyW.map((w) => ({
		a: (skyEff * w) / skyWSum,
		c: skyScale,
		quad: false,
	}));
	const gCount = new Map<string, number>();
	for (const c of cues)
		gCount.set(groupOf(c), (gCount.get(groupOf(c)) ?? 0) + 1);
	const effOf = (g: string) =>
		groupEff[g] ?? groupEff[g.split(":")[0]] ?? defaultEff;
	const fStart = focalPx1600(start);
	const cueSig = cues.map((c) => {
		if (c.kind !== "point" || !demSigma || c.source.startsWith("pin"))
			return c.sigmaPx;
		const d = Math.max(c.depthM, 1);
		return Math.hypot(c.sigmaPx, (fStart * demSigma(d)) / d);
	});
	const cueA = cues.map((c) => {
		const g = groupOf(c);
		return Math.min(1, effOf(g) / (gCount.get(g) ?? 1));
	});

	// focal prior at the 1600 basis
	const fb = inp.focal.basisLongPx ?? 1600;
	const fPrior = (inp.focal.fPx * 1600) / fb;
	const fPriorSig = (inp.focal.sigmaPx * 1600) / fb;
	const f1 = focalPx1600({ ...cam0, intr: { ...cam0.intr, fScale: 1 } });

	let lin: HzLin;
	let horizonCalls = 0;
	const q = (x: number) => Math.round(x / quantum) * quantum;
	const linearise = async (e: Vec3, withD: boolean): Promise<HzLin> => {
		const eL: Vec3 = [q(e[0]), q(e[1]), q(e[2])];
		const eyes: Vec3[] = [eL];
		if (withD)
			for (let k = 0; k < 3; k++)
				for (const s of [1, -1]) {
					const x: Vec3 = [eL[0], eL[1], eL[2]];
					x[k] += s * delta;
					eyes.push(x);
				}
		const hs = await inp.horizonsAtEyes(eyes);
		horizonCalls += eyes.length;
		return {
			eL,
			h0: hs[0],
			d: withD
				? [
						[hs[1], hs[2]],
						[hs[3], hs[4]],
						[hs[5], hs[6]],
					]
				: null,
			delta,
		};
	};

	type Eval = { z: Float64Array; rows: Row[]; nData: number };
	const evaluate = (p: number[], trust: Vec3 | null): Eval => {
		const cam = camFromParams(cam0, p);
		const f = focalPx1600(cam);
		const z: number[] = [];
		const rows: Row[] = [];
		const eye = cam.eye;
		for (let i = 0; i < inp.skyline.length; i++) {
			const s = inp.skyline[i];
			const [az, el] = azEl(unprojectDirX(cam, s.u, s.v));
			z.push(((el - linHorizonEl(lin, az, eye)) * D * f) / skySig);
			rows.push(skyRows[i]);
		}
		for (let i = 0; i < cues.length; i++) {
			const r = cueResidualPx(cam, cues[i], p[8], inp.frame);
			for (const x of r) {
				z.push(x / cueSig[i]);
				rows.push({ a: cueA[i], c: cueScale, quad: false });
			}
		}
		const nData = z.length;
		const pr = (v: number) => {
			z.push(v);
			rows.push({ a: 1, c: 0, quad: true });
		};
		pr(wrap180(p[0] - cam0.pose.yaw) / rotSig.yaw);
		pr((p[1] - cam0.pose.pitch) / rotSig.pitch);
		pr((p[2] - cam0.pose.roll) / rotSig.roll);
		if (active[3]) pr((f1 * p[3] - fPrior) / fPriorSig);
		if (active[4]) {
			pr((p[4] - prior.eye0[0]) / prior.sigmaH);
			pr((p[5] - prior.eye0[1]) / prior.sigmaH);
			pr((p[6] - prior.eye0[2]) / prior.sigmaV);
			if (ground) {
				const g = ground(p[4], p[5]);
				if (Number.isFinite(g)) {
					const above = p[6] - g - hAbove;
					pr(above / (above < 0 ? gSigBelow : gSig));
				}
			}
			if (trust) {
				pr((p[4] - trust[0]) / trustM);
				pr((p[5] - trust[1]) / trustM);
				pr((p[6] - trust[2]) / trustM);
			}
		}
		if (active[7]) pr(p[7] / k1Sig);
		if (active[8]) pr(p[8] / biasSig);
		return { z: Float64Array.from(z), rows, nData };
	};
	const costOf = (e: Eval) => {
		let s = 0;
		for (let i = 0; i < e.z.length; i++) {
			const r = e.rows[i];
			const z = e.z[i];
			if (r.quad) s += z * z;
			else if (Number.isFinite(z)) s += r.a * rho(z, r.c, loss);
			else s += r.a * rho(3 * r.c, r.c, loss);
		}
		return s;
	};

	// ---- LM on the active parameters for a fixed linearisation
	let iterations = 0;
	let converged = false;
	let lastA: number[][] | null = null;
	const lm = (p0: number[], trust: Vec3 | null) => {
		let p = p0.slice();
		let E = evaluate(p, trust);
		let cost = costOf(E);
		let lambda = 1e-3;
		let conv = false;
		for (let it = 0; it < maxIter; it++) {
			iterations++;
			const n = idx.length;
			const cols: Float64Array[] = [];
			for (const k of idx) {
				const pp = p.slice();
				pp[k] += FD_STEP[k];
				const E2 = evaluate(pp, trust);
				const col = new Float64Array(E.z.length);
				for (let i = 0; i < col.length; i++) {
					const a = E.z[i];
					const b = E2.z[i];
					col[i] =
						Number.isFinite(a) && Number.isFinite(b) ? (b - a) / FD_STEP[k] : 0;
				}
				cols.push(col);
			}
			const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
			const g = new Array<number>(n).fill(0);
			for (let i = 0; i < E.z.length; i++) {
				const z = E.z[i];
				if (!Number.isFinite(z)) continue;
				const r = E.rows[i];
				const w = r.quad ? 1 : r.a * psi(z, r.c, loss);
				for (let a = 0; a < n; a++) {
					const ja = cols[a][i];
					if (ja === 0) continue;
					g[a] += w * ja * z;
					for (let b = 0; b <= a; b++) A[a][b] += w * ja * cols[b][i];
				}
			}
			for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[b][a] = A[a][b];
			lastA = A;
			let accepted = false;
			let small = false;
			while (lambda < 1e10) {
				const M = A.map((row, a) =>
					row.map((x, b) => (a === b ? x * (1 + lambda) + 1e-12 : x)),
				);
				const d = solveSym(
					M,
					g.map((x) => -x),
				);
				if (!d) {
					lambda *= 10;
					continue;
				}
				const pn = p.slice();
				idx.forEach((k, j) => {
					pn[k] += d[j];
				});
				const En = evaluate(pn, trust);
				const cn = costOf(En);
				if (cn <= cost) {
					small = idx.every((k, j) => Math.abs(d[j]) < FD_STEP[k] * 0.1);
					p = pn;
					E = En;
					const drop = cost - cn;
					cost = cn;
					lambda = Math.max(lambda / 3, 1e-9);
					accepted = true;
					if (drop < 1e-9 * Math.max(1, cost)) small = true;
					break;
				}
				lambda *= 4;
			}
			if (!accepted || small) {
				conv = true;
				break;
			}
		}
		return { p, cost, conv, E };
	};

	// ---- outer loop (horizon re-linearisation)
	let p = paramsOf(start, 0);
	// edge offset start: median edge residual at the start camera (a nuisance; start near its optimum)
	if (active[8]) {
		const rs = cues
			.filter((c) => c.kind === "edge")
			.map((c) => cueResidualPx(start, c, 0, inp.frame)[0])
			.filter(Number.isFinite)
			.sort((a, b) => a - b);
		if (rs.length) p[8] = rs[rs.length >> 1];
	}
	let outer = 0;
	try {
		lin = await linearise(start.eye, freed.eye);
		for (; outer < maxOuter; outer++) {
			if (opts.signal?.aborted) throw new Error("aborted");
			const res = lm(p, freed.eye ? lin.eL : null);
			p = res.p;
			converged = res.conv;
			if (!freed.eye) break;
			const mv = Math.hypot(
				p[4] - lin.eL[0],
				p[5] - lin.eL[1],
				p[6] - lin.eL[2],
			);
			if (mv < relinM) break;
			lin = await linearise([p[4], p[5], p[6]], true);
		}
	} catch (e) {
		return fail(`solver error: ${(e as Error).message}`);
	}

	function fail(why: string): JointResult {
		return {
			cam: start,
			cov: new Float64Array(NP * NP),
			sigma: {},
			skylineRmsBefore: Number.NaN,
			skylineRmsAfter: Number.NaN,
			cueRmsBefore: Number.NaN,
			cueRmsAfter: Number.NaN,
			spread: { quadrants: 0, bands: 0 },
			accepted: false,
			reasons: [...reasons, why],
			cam0,
			freed,
			eyeShift: [0, 0, 0],
			eyeShiftSigmaH: 0,
			focalZ: Number.NaN,
			edgeBiasPx: 0,
			skylineInlierBefore: 0,
			skylineInlierAfter: 0,
			counts: {
				cues: cues.length,
				near: nNear,
				corner: nCorner,
				skyline: inp.skyline.length,
			},
			iterations,
			outer,
			horizonCalls,
			converged: false,
			ms: Date.now() - t0,
		};
	}

	const cam = camFromParams(cam0, p);
	if (!p.every(Number.isFinite)) return fail("non-finite solution");

	// ---- covariance (IRLS normal matrix at the solution, without the trust term)
	const cov = new Float64Array(NP * NP);
	const sigma: Record<string, number> = {};
	{
		const E = evaluate(p, null);
		const n = idx.length;
		const cols: Float64Array[] = idx.map((k) => {
			const pp = p.slice();
			pp[k] += FD_STEP[k];
			const E2 = evaluate(pp, null);
			const col = new Float64Array(E.z.length);
			for (let i = 0; i < col.length; i++) {
				const a = E.z[i];
				const b = E2.z[i];
				col[i] =
					Number.isFinite(a) && Number.isFinite(b) ? (b - a) / FD_STEP[k] : 0;
			}
			return col;
		});
		const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
		for (let i = 0; i < E.z.length; i++) {
			const z = E.z[i];
			if (!Number.isFinite(z)) continue;
			const r = E.rows[i];
			const w = r.quad ? 1 : r.a * psi(z, r.c, loss);
			for (let a = 0; a < n; a++)
				for (let b = 0; b < n; b++) A[a][b] += w * cols[a][i] * cols[b][i];
		}
		const Ai = n ? invSym(A) : [];
		idx.forEach((ka, a) => {
			idx.forEach((kb, b) => {
				cov[ka * NP + kb] = Ai[a][b];
			});
			sigma[PARAM_NAMES[ka]] = Math.sqrt(Math.max(0, Ai[a][a]));
		});
	}
	void lastA;

	// ---- before / after diagnostics (exact horizons)
	const want: Vec3[] = [cam0.eye, cam.eye].map(
		(e) => [q(e[0]), q(e[1]), q(e[2])] as Vec3,
	);
	const hz = await inp.horizonsAtEyes(want);
	horizonCalls += 2;
	const skyB = clippedRms(skylineResidualsX(cam0, inp.skyline, hz[0]), rmsClip);
	const skyA = clippedRms(skylineResidualsX(cam, inp.skyline, hz[1]), rmsClip);
	const bias0 = (() => {
		const rs = cues
			.filter((c) => c.kind === "edge")
			.map((c) => cueResidualPx(cam0, c, 0, inp.frame)[0])
			.filter(Number.isFinite)
			.sort((a, b) => a - b);
		return rs.length ? rs[rs.length >> 1] : 0;
	})();
	const cueRms = (c: CameraX, b: number) => {
		let s = 0;
		let n = 0;
		for (const cu of cues)
			for (const x of cueResidualPx(c, cu, b, inp.frame)) {
				const v = Number.isFinite(x) ? Math.min(Math.abs(x), cueClip) : cueClip;
				s += v * v;
				n++;
			}
		return n ? Math.sqrt(s / n) : Number.NaN;
	};
	const cueRmsBefore = cueRms(cam0, active[8] ? bias0 : 0);
	const cueRmsAfter = cueRms(cam, active[8] ? p[8] : 0);

	// ---- spread
	const quadN = [0, 0, 0, 0];
	const bandN = new Map<string, number>();
	for (const c of cues) {
		quadN[(c.u < 0.5 ? 0 : 1) + (c.v < 0.5 ? 0 : 2)]++;
		const b = distanceBand(c.depthM);
		bandN.set(b, (bandN.get(b) ?? 0) + 1);
	}
	const spread = {
		quadrants: quadN.filter((n) => n >= 3).length,
		bands: [...bandN.values()].filter((n) => n >= 3).length,
	};

	const shift: Vec3 = [
		cam.eye[0] - cam0.eye[0],
		cam.eye[1] - cam0.eye[1],
		cam.eye[2] - cam0.eye[2],
	];
	if (!converged) reasons.push("LM hit maxIter");
	return {
		cam,
		cov,
		sigma,
		skylineRmsBefore: skyB.rms,
		skylineRmsAfter: skyA.rms,
		cueRmsBefore,
		cueRmsAfter,
		spread,
		accepted: true,
		reasons,
		cam0,
		freed,
		eyeShift: shift,
		eyeShiftSigmaH: Math.hypot(shift[0], shift[1]) / prior.sigmaH,
		focalZ: freed.fScale ? (focalPx1600(cam) - fPrior) / fPriorSig : 0,
		edgeBiasPx: active[8] ? p[8] : 0,
		skylineInlierBefore: skyB.inlierFrac,
		skylineInlierAfter: skyA.inlierFrac,
		counts: {
			cues: cues.length,
			near: nNear,
			corner: nCorner,
			skyline: inp.skyline.length,
		},
		iterations,
		outer: outer + 1,
		horizonCalls,
		converged,
		ms: Date.now() - t0,
	};
}

/** Small dense symmetric solve (Gaussian elimination with partial pivoting). */
function solveSym(A: number[][], b: number[]): number[] | null {
	const n = b.length;
	const M = A.map((r, i) => [...r, b[i]]);
	for (let c = 0; c < n; c++) {
		let piv = c;
		for (let r = c + 1; r < n; r++)
			if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
		if (Math.abs(M[piv][c]) < 1e-300) return null;
		[M[c], M[piv]] = [M[piv], M[c]];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = M[r][c] / M[c][c];
			if (f === 0) continue;
			for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
		}
	}
	const x = M.map((r, i) => r[n] / r[i]);
	return x.every(Number.isFinite) ? x : null;
}

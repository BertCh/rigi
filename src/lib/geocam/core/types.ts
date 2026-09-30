// Geometry-first camera (GEO, reports/geometry-first-pose.md): shared types. FROZEN API: additive
// changes only. Every geocam package (map, priors, lakes, observe, tjunc, integrity) codes against these.
//
// State vector (PARAMS order): yaw, pitch, roll in degrees (camera/index.ts convention: yaw = true
// heading clockwise from north, pitch up +, roll right side down +), logf = ln(f / f0) where f0 is the
// problem's reference focal, and the eye E, N, U in metres in the frame of `MapProblem.base.eye`
// (camera-anchored ENU; the base eye is usually [0,0,0] with world coordinates relative to it).
import type { CameraX, Vec3 } from "../../concord/core";

export type { CameraX, Vec3 };

export const PARAMS = ["yaw", "pitch", "roll", "logf", "E", "N", "U"] as const;
export type ParamName = (typeof PARAMS)[number];
export const NP = PARAMS.length; // 7
export const IDX: Readonly<Record<ParamName, number>> = Object.freeze({
	yaw: 0,
	pitch: 1,
	roll: 2,
	logf: 3,
	E: 4,
	N: 5,
	U: 6,
});

/** Length-7 parameter vector, PARAMS order. */
export type GeoState = Float64Array;

export type CueFamily =
	| "gps"
	| "alt"
	| "ground"
	| "lakeFloor"
	| "gravity"
	| "compass"
	| "focal"
	| "skyline"
	| "point"
	| "edge"
	| "junction"
	| "level"
	| "shore";

/** Families that are priors (not image evidence). */
export const PRIOR_FAMILIES: readonly CueFamily[] = [
	"gps",
	"alt",
	"ground",
	"lakeFloor",
	"gravity",
	"compass",
	"focal",
];

export type Loss =
	| { kind: "l2" }
	| { kind: "huber" | "cauchy"; c: number }
	/** Student-t with ν degrees of freedom (IRLS weight (ν+1)/(ν+z²)). */
	| { kind: "student"; nu: number };

/**
 * One block of whitened residuals. `residual` returns dimensionless (σ-normalised) residuals; NaN marks
 * a row with no data at this state (it is dropped for that iteration). `jacobian`, if given, returns the
 * dim×7 row-major derivative of the whitened residual w.r.t. the state (columns in PARAMS order);
 * otherwise the solver uses central differences (steps: 1e-3° rotation, 1e-4 logf, 0.5 m eye).
 */
export interface Factor {
	family: CueFamily;
	name: string;
	dim: number;
	loss: Loss;
	residual(x: GeoState): Float64Array;
	jacobian?(x: GeoState): Float64Array;
	/**
	 * Effective sample count cap for correlated rows (grid thinning): the factor's information is scaled
	 * by min(1, nEff / validRows). Omit for independent rows.
	 */
	nEff?: number;
	/** True for quadratic priors; excluded from the MAD covariance rescale. */
	prior?: boolean;
	/**
	 * Eye-dependent predictors (horizons, junctions, lake cues) re-linearise here between outer
	 * iterations. Must be idempotent for the same x.
	 */
	relinearize?(x: GeoState): Promise<void>;
}

export type MapFree = { rotation: true; focal: boolean; eye: boolean };

export type MapProblem = {
	/** Reference camera: its pose/vfov/aspect/intrinsics define x = 0 offsets for logf and the frame. */
	base: CameraX;
	/** Reference focal in px at the long-side-1600 basis (f0 in logf = ln(f/f0)). */
	f0Px1600: number;
	factors: Factor[];
	free: MapFree;
};

export type FamilyReport = {
	family: CueFamily;
	/** Valid rows at the solution. */
	n: number;
	nEff: number;
	/** Σ of robust-weighted squared whitened residuals. */
	chi2: number;
	/** This family's 7×7 information JᵀWJ (row-major, nEff-scaled). */
	info: Float64Array;
};

export type MapResult = {
	x: GeoState;
	cam: CameraX;
	/** 7×7 covariance, row-major, PARAMS order; rows/cols of fixed params are 0. */
	cov: Float64Array;
	sigma: Record<ParamName, number>;
	/** √λmax of the E/N covariance block (m): the horizontal eye uncertainty. */
	sigmaEN: number;
	perFamily: FamilyReport[];
	/** MAD scale of the data residuals (1 = as modelled). */
	mad: number;
	iterations: number;
	outer: number;
	converged: boolean;
	ms: number;
};

export type MapOpts = {
	maxIter?: number;
	maxOuter?: number;
	/** Outer loop stops when the eye moves less than this (m). */
	relinM?: number;
	/** Rescale the data block of the covariance by max(1, MAD scale)². Default true. */
	madRescale?: boolean;
	signal?: AbortSignal;
};

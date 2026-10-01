// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Types for the 6-DoF ground-control-point solver. Conventions follow src/lib/camera exactly:
// camera-anchored ENU (x=E, y=N, z=Up, metres); yaw = true heading clockwise from north,
// pitch up +, roll right-side-down +, vfov = vertical FOV — all degrees.
// Image coords are normalised 0..1 with v (y) pointing down.

import type { Pose } from "../camera";

type Base = {
	/** Normalised image coords (0..1, y down) — same as camera projectPoint returns. */
	u: number;
	v: number;
	/** Measurement σ in px (default: options.sigmaPx). */
	sigmaPx?: number;
	label?: string;
};

/** A finite world point in the camera-anchored ENU frame (metres). */
export type PointCorr = Base & {
	kind: "point";
	world: [number, number, number];
};
/** A direction only (point at infinity, e.g. an az/el pair). Unaffected by the eye offset. */
export type DirCorr = Base & { kind: "dir"; dir: [number, number, number] };
/**
 * A pixel whose apparent elevation angle (deg) is known but azimuth is not — a far lake shore or
 * sea horizon. Gives one equation (0.5 of a point for the DOF ladder).
 */
export type LevelCorr = Base & { kind: "level"; el: number };

/**
 * A pixel whose azimuth (deg, clockwise from north) is known but elevation is not — e.g. a skyline
 * feature at a DEM azimuth. One equation (0.5 of a point); constrains yaw.
 */
export type AzimuthCorr = Base & { kind: "azimuth"; az: number };

export type Correspondence = PointCorr | DirCorr | LevelCorr | AzimuthCorr;

/**
 * Gaussian prior. sigma undefined / Infinity = unknown (no prior; solved freely if the ladder allows);
 * sigma 0 = held exactly at `value` (never solved, reported σ 0); sigma > 0 = Gaussian prior.
 * Negative or NaN sigma throws a RangeError.
 */
export type PriorValue = { value: number; sigma?: number };

export type Priors = {
	/**
	 * Prior on the ABSOLUTE eye position in the correspondences' ENU frame (metres). It must be the
	 * eye the renderer uses: for the app's engine (frame = EnuFrame(lat, lon, 0), eye = (0, 0, eyeAlt))
	 * pass `[eye.x, eye.y, eye.z]`, not [0,0,0]. Default [0,0,0] (only right if the frame origin is the
	 * eye itself, e.g. cameraFrame(lat, lon, eyeAlt)). sigmaH/sigmaV follow the PriorValue rules
	 * (0 = hold that component; default 15 / 20 m).
	 */
	position?: {
		value: [number, number, number];
		sigmaH?: number;
		sigmaV?: number;
	};
	yaw: PriorValue;
	pitch: PriorValue;
	roll: PriorValue;
	vfov: PriorValue;
};

export type SolveOptions = {
	/** Image aspect ratio width / height. */
	aspect: number;
	/** Image width in px — residuals/thresholds are in these pixels. */
	imageWidth: number;
	/** Pixel noise σ (default 2). */
	sigmaPx?: number;
	/** Huber threshold in σ units (default 2). */
	huberK?: number;
	/** RANSAC inlier threshold in px (default max(4σ, 0.6 % of width)). */
	inlierPx?: number;
	/** Threshold used to rank RANSAC hypotheses (default 3 × inlierPx). */
	hypothesisPx?: number;
	/** Solve vfov when the ladder allows it (default true). */
	solveFov?: boolean;
	/** Allow position to be solved when the ladder allows it (default true). */
	solvePosition?: boolean;
	/** Force the DOF set instead of using the ladder. */
	forceParams?: ("position" | "yaw" | "pitch" | "roll" | "vfov")[];
	/** Effective point count below which no correspondence is rejected as an outlier (default 5). */
	minPointsForRejection?: number;
	/** Finite (non-direction) points needed before position unlocks (default 3). */
	minFiniteForPosition?: number;
	/**
	 * Position only unlocks if a 1σ horizontal GPS shift moves at least one finite point by this many
	 * px (default 2·sigmaPx) — i.e. position must be observable above the label noise.
	 */
	minParallaxPx?: number;
	/** With ≥ this many finite points, position priors are relaxed by `relaxFactor` (default 6 / 5). */
	relaxAt?: number;
	relaxFactor?: number;
	/** RANSAC iterations cap (default 300). */
	maxHypotheses?: number;
	/** Distinct RANSAC hypotheses polished by LM (default 4). */
	seeds?: number;
	/** LM iterations (default 60). */
	maxIterations?: number;
	/** Optional trace hook (stage name + data) for debugging. */
	debug?: (stage: string, data: unknown) => void;
	/** Deterministic RNG seed (default 1). */
	seed?: number;
};

export type SolveResult = {
	pose: Pose;
	/**
	 * The solved ABSOLUTE eye position in the correspondences' ENU frame, metres [E, N, U]
	 * (starts from `priors.position.value`). Despite the name it is not an increment: use it as the
	 * new eye directly (e.g. engine.eye.set(...eyeOffset)); never add it to the old eye.
	 */
	eyeOffset: [number, number, number];
	/** Per-correspondence residual in px (2-D distance; for level points the vertical miss). NaN if behind. */
	residualsPx: number[];
	/** RMS px over `inliers` (the set the final LM fitted). */
	rmsPx: number;
	/**
	 * Correspondences the final fit used. Below `minPointsForRejection` effective points nothing is
	 * rejected, so this is all-true even if a point misses by a lot (see `overThreshold`).
	 */
	inliers: boolean[];
	/** residualsPx > inlierPx (or NaN) — a plain "large miss" flag, independent of rejection. */
	overThreshold: boolean[];
	/**
	 * 1σ per parameter from the covariance over the `inliers` set. Parameters not solved report their
	 * prior σ (0 if held with sigma 0, NaN if the prior is unknown).
	 */
	sigma: {
		dx: number;
		dy: number;
		dz: number;
		yaw: number;
		pitch: number;
		roll: number;
		vfov: number;
	};
	/** Covariance over the active parameters (whitened by σ_px, scaled by the posterior variance factor). */
	covariance: number[][];
	activeParams: string[];
	/** Which minimal solver produced the winning start. */
	init: string;
	iterations: number;
	converged: boolean;
	/** Final robust cost (whitened, priors included). */
	cost: number;
};

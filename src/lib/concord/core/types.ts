// Whole-image concordance: shared types (WP-A, frozen API — see reports/concordance-research.md §4).
// Additive changes only. Every other concord package codes against these.
import type { Vec3 } from "#/lib/ontology/core/geometry";
import type { Pose } from "../../camera";

export type { Vec3 };

/** Deviation from the app's pinhole; IDENTITY ⇒ bit-identical to camera/index.ts. */
export type Intrinsics = {
	/** Multiplies the focal implied by pose.vfov (1 = none). */
	fScale: number;
	/**
	 * Radial term in focal-normalised coords (0 = none). Convention (matches the concordance audit,
	 * where pins favour k1 ≈ +0.04): distorted = ideal · (1 + k1·r²), r² of the IDEAL normalised
	 * point; the inverse (photo → ideal) is the 5-iteration fixed point in `undistortUV`.
	 */
	k1: number;
	/** Principal-point offset, normalised image units (u, v; 0 = centred). */
	cx: number;
	cy: number;
};
export const IDENTITY_INTRINSICS: Intrinsics = Object.freeze({
	fScale: 1,
	k1: 0,
	cx: 0,
	cy: 0,
}) as Intrinsics;

/** pose: rotation + vfov (camera/index.ts); eye: ENU offset of the eye in the pose's frame (usually [0,0,0] with world coords relative to the eye); aspect = W/H. */
export type CameraX = {
	pose: Pose;
	eye: Vec3;
	aspect: number;
	intr: Intrinsics;
};

export type DistanceBand = "<0.5km" | "0.5-2km" | "2-5km" | "5-15km" | ">15km";
/** r < 0.35, < 0.7, ≥ 0.7 of the half-diagonal. */
export type RadiusBand = "centre" | "mid" | "corner";

export const DISTANCE_BANDS: readonly DistanceBand[] = [
	"<0.5km",
	"0.5-2km",
	"2-5km",
	"5-15km",
	">15km",
];
export const RADIUS_BANDS: readonly RadiusBand[] = ["centre", "mid", "corner"];

export type PinKind =
	| "shore"
	| "waterline"
	| "building"
	| "junction"
	| "bridge"
	| "notch"
	| "summit"
	| "other";

/**
 * x, y: pixels in the 1600 basis = image WIDTH 1600 px, v down (the data/control-points.json and
 * engine.ts convention: portrait photos are 1600 × 2133). Residuals are reported in px at the
 * long-side-1600 basis ("px @1600").
 */
export type InteriorPin = {
	photo: string;
	id: string;
	x: number;
	y: number;
	basis: 1600;
	lat: number;
	lon: number;
	/** Absolute elevation (m). Absent ⇒ DEM at lat/lon (+ hAbove). */
	h?: number;
	hAbove?: number;
	/** Waterline: elevation-only constraint. */
	level?: { lakeM: number };
	kind: PinKind;
	source: "osm" | "swisstopo" | "manual";
	/** Per PHOTO, frozen in tools/concord/pins/PROTOCOL.txt. */
	split: "dev" | "holdout";
	sigmaPx?: number;
	note?: string;
};

/** A residual cue: anything a solver or field can consume. u,v normalised (0..1, v down). */
export type Cue =
	| {
			kind: "point";
			u: number;
			v: number;
			world: Vec3;
			depthM: number;
			sigmaPx: number;
			source: string;
	  }
	| {
			/** Residual along the normal (nu, nv) only. */
			kind: "edge";
			u: number;
			v: number;
			nu: number;
			nv: number;
			world: Vec3;
			depthM: number;
			sigmaPx: number;
			source: string;
	  }
	| {
			kind: "level";
			u: number;
			v: number;
			el: number;
			depthM: number;
			sigmaPx: number;
			source: string;
	  }
	| {
			kind: "shore";
			u: number;
			v: number;
			lakeM: number;
			shoreDist: (e: number, n: number) => number;
			depthM: number;
			sigmaPx: number;
			source: string;
	  };

export type PinResidual = {
	id: string;
	dxPx: number;
	dyPx: number;
	px: number;
	distM: number;
	band: DistanceBand;
	radius: RadiusBand;
};

export type BandStat = { n: number; medPx: number; p90Px: number };

export type ConcordReport = {
	photo: string;
	n: number;
	byBand: Record<DistanceBand, BandStat>;
	byRadius: Record<RadiusBand, BandStat>;
	skylineRmsPx?: number;
};

/** Display field W: photo uv → render uv offset (render = photo + W). */
export type ResidualField = {
	/** Grid, e.g. 96×72, cell-centred, v down. */
	w: number;
	h: number;
	/** Normalised units, row-major (index = j·w + i). */
	du: Float32Array;
	dv: Float32Array;
	/** Posterior 1σ at the 1600 basis. */
	sigmaPx: Float32Array;
	maxAbsPx: number;
	provenance: {
		sources: string[];
		n: number;
		looGainPx: number | null;
		bound: { px: number; metres: number };
	};
};

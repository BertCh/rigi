// Interior cue extraction (WP-C) shared types. Frozen shapes from reports/concordance-research.md §4
// WP-C; everything beyond them is additive and optional.
import type { Cue, Vec3 } from "../core";

/**
 * Photo-space geometry at a camera: one ray per pixel (cell-centred, v down), row-major.
 * xyz: scene-frame ENU of the first terrain hit (NaN on sky); range: 3-D distance from the eye (m,
 * +Infinity on sky); sky: 1 where the ray misses the DEM.
 */
export type GeomBuffer = {
	w: number;
	h: number;
	xyz: Float32Array;
	range: Float32Array;
	sky: Uint8Array;
	/** Additive: the eye the buffer was cast from (scene frame). */
	eye?: Vec3;
	/**
	 * Additive: scene-frame convention, needed to turn absolute altitudes (lake levels) into frame z:
	 * z = alt − alt0 − (e² + n²) / (2·rEff) (the eval frame of scripts/concord/lib.ts).
	 */
	frame?: { alt0: number; rEff: number };
	/** Additive: cast one extra ray through photo uv (bisection refinement); null ⇒ sky. */
	cast?: (u: number, v: number) => RayHit | null;
};

export type RayHit = {
	/** Horizontal distance from the eye (m). */
	d: number;
	range: number;
	world: Vec3;
};

/**
 * Photo edge map. mag: edge strength (≥ 0); ori: direction of the intensity gradient (radians,
 * x right / y down, pointing dark → bright in luminance), i.e. the edge NORMAL. Row-major.
 */
export type PhotoEdges = {
	w: number;
	h: number;
	mag: Float32Array;
	ori: Float32Array;
	/** Additive: smoothed luminance 0..1 (waterline mirror test). */
	lum?: Float32Array;
};

/** A cue with a measured photo residual. residualPx: (predicted − observed) along the cue normal, px @1600. */
export type MatchedCue = Cue & { residualPx: number; conf: number };

export type EdgeCue = Extract<Cue, { kind: "edge" }>;

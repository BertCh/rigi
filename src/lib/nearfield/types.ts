// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside: the shared contract between the near-field service (tools/nearfield), DEM anchoring,
// the splat renderers (three + deck), the camera-roll multi-view work and the generative research.
// Design: reports/step-inside-design.md. Additive fields only once other modules depend on this.

/** Where a surface came from. Rendered by the "Truth" toggle; `generated` never enters measurement exports. */
export type Provenance = "observed" | "reconstructed" | "dem" | "generated";
export const PROVENANCE_CODE: Record<Provenance, number> = {
	observed: 0,
	reconstructed: 1,
	dem: 2,
	generated: 3,
};

/** Per-pixel class after the depth split. Stored as Uint8 in `SplitResult.cls`. */
export enum PixelClass {
	Sky = 0,
	/** Model depth agrees with the DEM range: the terrain drape renders it, no splat. */
	Terrain = 1,
	/** Model depth well in front of the DEM: people, huts, trees, rocks. Kept as splats. */
	Object = 2,
	/** Beyond the near-field radius or no reliable depth: DEM only. */
	Far = 3,
	/** Model has no valid depth and there is no DEM hit (e.g. mask hole). */
	Unknown = 4,
}

/**
 * Monocular geometry from the service, in the camera frame of the photo as given (OpenCV: x right,
 * y down, z forward). Row 0 = top. `depth` is z-depth (not ray length) in the model's metric-ish metres.
 */
export type NearFieldDepth = {
	width: number;
	height: number;
	depth: Float32Array; // NaN / 0 = invalid
	valid: Uint8Array; // 1 = model thinks this pixel has geometry (not sky)
	normal?: Float32Array; // width*height*3, camera frame, optional
	/** Model's own intrinsics in normalised units (fx/W, fy/H, cx/W, cy/H), if it predicts them. */
	intrinsicsNorm?: { fx: number; fy: number; cx: number; cy: number };
	model: string; // e.g. "moge-2-vitl-normal"
	seconds: number;
};

/**
 * 3D Gaussians. Positions are in the ENU frame of the photo (Renderer.frame; metres, x east, y north,
 * z up) once anchored; in the camera frame (OpenCV) when `frame === "camera"`.
 * Packed SoA arrays so they transfer to workers and GPU buffers without copies.
 */
export type GaussianCloud = {
	count: number;
	frame: "camera" | "enu";
	positions: Float32Array; // 3*count
	/** Linear scales (not log), metres, 3*count. */
	scales: Float32Array;
	/** Unit quaternions (w, x, y, z), 4*count. */
	rotations: Float32Array;
	/** RGBA 0..255 (alpha = opacity), 4*count. SH degree 0 only. */
	colors: Uint8Array;
	/** PROVENANCE_CODE per splat, count. */
	provenance: Uint8Array;
	/** Optional per-splat source photo index (camera-roll fusion), count. */
	source?: Uint16Array;
};

/** Result of fitting the model's depth to the DEM range on terrain pixels. */
export type AnchorFit = {
	/** Multiply model depth by this to get metres consistent with the DEM. */
	scale: number;
	/** Optional additive offset in metres (affine fit); 0 when the fit is scale-only. */
	shift: number;
	/** Median |log(scaled model depth / DEM range)| over the inlier terrain pixels. */
	residualLog: number;
	/** Fraction of candidate terrain pixels that are inliers. */
	inlierFrac: number;
	/** Number of terrain pixels used. */
	n: number;
	/** 0..1 trust in the anchoring; the UI hides Step Inside below ANCHOR_MIN_QUALITY. */
	quality: number;
	/** Max range (m) used for the fit (depth models are useless far away). */
	maxRange: number;
	/**
	 * Range-dependent calibration (anchor.ts fitCurve): metres = exp(interp(log modelRay; x → y)), slope 1 beyond
	 * the end knots. When present it takes precedence over scale/shift for placement (anchor.anchoredRange);
	 * `scale` is then the curve's ratio f(m)/m at the median candidate model ray and `shift` is 0.
	 */
	curve?: { x: number[]; y: number[] };
	/** Median |log residual| over ALL candidates (the spike's calibrated quality input; `residualLog` is inliers only). */
	residualLogAll?: number;
};
/** Hide Step Inside below this anchor quality (P0 spike calibration; anchor.ts ANCHOR_LOW_TRUST labels 0.15..0.35). */
export const ANCHOR_MIN_QUALITY = 0.15;

export type SplitParams = {
	/** Pixels whose scaled model depth < demRange * (1 - objectMargin) are Object. */
	objectMargin: number; // default 0.5
	/** Beyond this range (m, scaled model depth) everything is Far. Model pixels with no DEM hit within it are Object. */
	nearRadius: number; // default 150
	/** Minimum absolute gap (m) between model depth and DEM range for Object. */
	minGapM: number; // default 3
};
/** P0 spike recommendation (tools/nearfield/spike/SUMMARY.txt): 1/16 clean photos with false Object vs 10/16. */
export const DEFAULT_SPLIT: SplitParams = {
	objectMargin: 0.5,
	nearRadius: 150,
	minGapM: 3,
};

export type SplitResult = {
	width: number;
	height: number;
	cls: Uint8Array; // PixelClass
	/** Counts per class, indexed by PixelClass. */
	counts: number[];
};

/** Everything the renderers need for one photo. */
export type NearFieldScene = {
	photoId: string;
	anchor: AnchorFit;
	split: SplitResult;
	/** Object splats (and optionally reconstructed near terrain) in ENU. */
	splats: GaussianCloud;
	/** Radius (m) around the eye inside which the Step Inside camera may move. */
	confidenceRadius: number;
	/** Model that produced the splats, e.g. "moge2-lift" or "sharp" (export licence; optional). */
	model?: string;
};

export type NearFieldViewOpts = {
	/** Tint surfaces by provenance (the "Truth" toggle). */
	truth?: boolean;
	/** Mask Object pixels out of the photo drape (In map fix). Default true. */
	maskDrape?: boolean;
	/** Splat opacity multiplier 0..1 (for fades). */
	opacity?: number;
};

// ---- near-field service (tools/nearfield, default http://127.0.0.1:8767) ----
// POST /depth       multipart: image (jpeg/png), model? ("moge2"|"da3"), maxSide? → NearFieldDepthWire
// POST /gaussians   multipart: image, model? ("sharp"|"lift") → binary .splat-v1 (see encodeSplatV1)
// POST /multiview   multipart: images[] (+ poses.json optional) → MultiViewWire (camera-roll, P2)
// GET  /health      → { ok, models: string[], device }
export const NEARFIELD_URL_DEFAULT = "http://127.0.0.1:8767";

/** JSON header of /depth; the binary body follows (see nearfield client). */
export type NearFieldDepthWire = {
	width: number;
	height: number;
	model: string;
	seconds: number;
	intrinsicsNorm?: { fx: number; fy: number; cx: number; cy: number };
	/** Base64 float16 little-endian arrays. */
	depthF16: string;
	validU8: string;
	normalF16?: string;
};

export type MultiViewWire = {
	model: string;
	/** Per input image: camera-to-first-camera 4x4 row-major (OpenCV), and normalised intrinsics. */
	cameras: {
		c2w: number[];
		intrinsicsNorm: { fx: number; fy: number; cx: number; cy: number };
	}[];
	/** Per image depth, same encoding as NearFieldDepthWire. */
	depths: Omit<NearFieldDepthWire, "model" | "seconds">[];
	seconds: number;
};

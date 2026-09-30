// Shared numeric helpers for the near-field core: intrinsics, z-depth → ray length, mask and DEM
// lookups on the depth grid. Pure TS (no three/deck).
import type { Pose } from "../camera";
import type { NearFieldDepth } from "./types";

/**
 * Pinhole intrinsics in NORMALISED units: fx/W, fy/H, cx/W, cy/H (same as NearFieldDepth.intrinsicsNorm),
 * so they apply to the depth grid at any resolution. Normalised image coords u = (col + 0.5)/W,
 * v = (row + 0.5)/H, v down (the Renderer.sampleAt convention).
 */
export type IntrinsicsNorm = { fx: number; fy: number; cx: number; cy: number };

/**
 * The app camera's intrinsics for a pose (identical to camera.unprojectDir / projectPoint):
 * fy = 0.5 / tan(vfov/2), fx = fy / aspect (aspect = photo W/H), principal point at the centre.
 */
export function intrinsicsFromPose(pose: Pose, aspect: number): IntrinsicsNorm {
	const t = Math.tan((pose.vfov * Math.PI) / 360);
	return { fx: 0.5 / (t * aspect), fy: 0.5 / t, cx: 0.5, cy: 0.5 };
}

/** |ray| / z for normalised coords (u, v): multiply a z-depth by this to get the ray length. */
export function rayFactor(K: IntrinsicsNorm, u: number, v: number): number {
	const x = (u - K.cx) / K.fx;
	const y = (v - K.cy) / K.fy;
	return Math.sqrt(1 + x * x + y * y);
}

/** Ray length to the terrain in metres at normalised coords, null for sky / no DEM (Renderer.sampleAt()?.range). */
export type DemRangeAt = (u: number, v: number) => number | null;

/** Binary-or-probability mask, row 0 = top (FgMask / sky P(sky) mask shape). */
export type MaskLike = {
	width: number;
	height: number;
	data: ArrayLike<number>;
};

/**
 * Nearest-neighbour mask lookup at normalised coords. Masks whose max value is ≤ 1 are treated as 0/1,
 * otherwise as 0..255 with the threshold 128 (P ≥ 0.5).
 */
export function maskSampler(
	m: MaskLike | null | undefined,
): ((u: number, v: number) => boolean) | null {
	if (!m || !m.width || !m.height) return null;
	let max = 0;
	for (let i = 0; i < m.data.length && max <= 1; i++)
		if (m.data[i] > max) max = m.data[i];
	const thr = max <= 1 ? 1 : 128;
	const { width: w, height: h, data } = m;
	return (u, v) => {
		const x = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
		const y = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
		return data[y * w + x] >= thr;
	};
}

/** Model z-depth at a cell, or NaN when invalid (valid = 0, non-finite or ≤ 0). */
export function modelDepth(d: NearFieldDepth, k: number): number {
	const z = d.depth[k];
	return d.valid[k] && z > 0 && Number.isFinite(z) ? z : Number.NaN;
}

/**
 * Sample the DEM range once per depth-grid cell (NaN = no terrain). Renderer.sampleAt converts to lat/lon on
 * every call, so the scene builder grids it once and hands `gridDemRange(grid)` to fitAnchor / splitPixels.
 */
export function sampleDemGrid(
	width: number,
	height: number,
	demRangeAt: DemRangeAt,
): Float32Array {
	const g = new Float32Array(width * height);
	for (let j = 0; j < height; j++)
		for (let i = 0; i < width; i++) {
			const r = demRangeAt((i + 0.5) / width, (j + 0.5) / height);
			g[j * width + i] = r != null && r > 0 ? r : Number.NaN;
		}
	return g;
}

/** Nearest-cell DemRangeAt over a grid from sampleDemGrid. */
export function gridDemRange(
	grid: Float32Array,
	width: number,
	height: number,
): DemRangeAt {
	return (u, v) => {
		const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
		const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
		const r = grid[y * width + x];
		return r > 0 ? r : null;
	};
}

/** Median of a numeric array (sorts a copy). NaN when empty. */
export function median(a: ArrayLike<number>): number {
	if (!a.length) return Number.NaN;
	const s = Float64Array.from(a).sort();
	const m = s.length >> 1;
	return s.length & 1 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

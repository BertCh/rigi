// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// "Measure anything" (reports/step-inside-design.md): the hover readout on near-field objects.
//
// For a pixel the split classed Object, the position comes from the anchored near field itself: the
// scene's ENU splats are projected back through the photo camera and binned on the split grid, keeping
// the nearest splat per cell. That is exactly the geometry Step Inside renders, so the readout agrees with
// what the user sees, whatever the anchoring model (scale-only, affine or range-dependent) placed it with.
// Generated splats never measure (design decision 4).
import type { Pose } from "../camera";
import type { EnuFrame } from "../geodesy";
import { intrinsicsFromPose } from "./geom";
import { camToEnuMatrix } from "./lift";
import { type NearFieldScene, PixelClass, PROVENANCE_CODE } from "./types";

export type NearFieldMeasureGrid = {
	width: number;
	height: number;
	/** Nearest splat range per cell (m), NaN = none. */
	range: Float32Array;
	/** That splat's ENU position, 3 per cell. */
	enu: Float32Array;
};

/** What measuring needs beyond the scene: the camera the scene was built at and the ENU frame. */
export type MeasureContext = {
	pose: Pose;
	aspect: number;
	eye: { x: number; y: number; z: number };
	frame: Pick<EnuFrame, "toGeo">;
};

/** A NearFieldScene with its measurement grid attached (the controller attaches it after the build). */
export type MeasurableScene = NearFieldScene & {
	measure?: NearFieldMeasureGrid & MeasureContext;
};

export type NearFieldSample = {
	enu: [number, number, number];
	lat: number;
	lon: number;
	/** Ellipsoidal/orthometric height as the engine's frame reports it (same as Sample.h). */
	elevation: number;
	/** Distance from the photo eye (m). */
	range: number;
	source: "object";
};

/** Bin the scene's splats on the split grid (nearest per cell) as seen from the photo camera. */
export function buildMeasureGrid(
	scene: NearFieldScene,
	ctx: MeasureContext,
): NearFieldMeasureGrid {
	const { width: W, height: H } = scene.split;
	const range = new Float32Array(W * H).fill(Number.NaN);
	const enu = new Float32Array(3 * W * H);
	const s = scene.splats;
	const K = intrinsicsFromPose(ctx.pose, ctx.aspect);
	const m = camToEnuMatrix(ctx.pose); // row-major cam → ENU; its transpose maps ENU → cam
	const gen = PROVENANCE_CODE.generated;
	for (let i = 0; i < s.count; i++) {
		if (s.provenance[i] === gen) continue;
		const px = s.positions[3 * i];
		const py = s.positions[3 * i + 1];
		const pz = s.positions[3 * i + 2];
		const dx = px - ctx.eye.x;
		const dy = py - ctx.eye.y;
		const dz = pz - ctx.eye.z;
		const x = m[0] * dx + m[3] * dy + m[6] * dz;
		const y = m[1] * dx + m[4] * dy + m[7] * dz;
		const z = m[2] * dx + m[5] * dy + m[8] * dz;
		if (!(z > 0)) continue;
		const u = K.cx + (K.fx * x) / z;
		const v = K.cy + (K.fy * y) / z;
		if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) continue;
		const k = Math.floor(v * H) * W + Math.floor(u * W);
		const r = Math.hypot(dx, dy, dz);
		if (range[k] <= r) continue; // NaN (empty cell) compares false
		range[k] = r;
		enu[3 * k] = px;
		enu[3 * k + 1] = py;
		enu[3 * k + 2] = pz;
	}
	return { width: W, height: H, range, enu };
}

/**
 * Position of the near-field object under normalised photo coords (u right, v down), or null when the
 * pixel is not an Object pixel or no (non-generated) splat covers it. Looks at the cell, then the nearest
 * covered Object cell within 2 cells (splats are lifted on a stride).
 */
export function nearFieldSampleAt(
	scene: MeasurableScene | null | undefined,
	u: number,
	v: number,
): NearFieldSample | null {
	const g = scene?.measure;
	if (!scene || !g || !(u >= 0 && u < 1 && v >= 0 && v < 1)) return null;
	const { width: W, height: H } = g;
	const cls = scene.split.cls;
	const i0 = Math.floor(u * W);
	const j0 = Math.floor(v * H);
	if (cls[j0 * W + i0] !== PixelClass.Object) return null;
	let best = -1;
	let bestD = Number.POSITIVE_INFINITY;
	for (let dj = -2; dj <= 2; dj++)
		for (let di = -2; di <= 2; di++) {
			const i = i0 + di;
			const j = j0 + dj;
			if (i < 0 || j < 0 || i >= W || j >= H) continue;
			const k = j * W + i;
			if (cls[k] !== PixelClass.Object || !(g.range[k] > 0)) continue;
			const d = di * di + dj * dj;
			if (d < bestD) {
				bestD = d;
				best = k;
			}
		}
	if (best < 0) return null;
	const x = g.enu[3 * best];
	const y = g.enu[3 * best + 1];
	const z = g.enu[3 * best + 2];
	const geo = g.frame.toGeo(x, y, z);
	return {
		enu: [x, y, z],
		lat: geo.lat,
		lon: geo.lon,
		elevation: geo.h,
		range: g.range[best],
		source: "object",
	};
}

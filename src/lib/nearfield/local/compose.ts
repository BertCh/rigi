// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// MoGe-2 network outputs → the NearFieldDepth the former near-field service's /depth returned
// (moge/model/v2.py infer() with force_projection and apply_mask, then its _compute_depth): the
// focal and z shift from the 64 × 64 samples (./focal-shift.ts), depth = (z + shift) · metric scale
// on mask > 0.5 and depth > 0, normals zeroed off the mask, intrinsics normalised with the centre at
// (0.5, 0.5). Pure CPU on arrays already read back (an O(W·H) pass).
import type { NearFieldDepth } from "../types";
import {
	focalShiftSamples,
	intrinsicsFromFocal,
	solveFocalShift,
} from "./focal-shift";

export type DepthNetArrays = {
	width: number;
	height: number;
	/** W·H affine z */
	z: Float32Array;
	/** W·H P(geometry) */
	mask: Float32Array;
	/** 3·W·H unit normals, or null */
	normal: Float32Array | null;
	/** 64·64·3 and 64·64: the nearest downsamples of the point map and mask */
	points64: Float32Array;
	mask64: Float32Array;
	focalGrid?: readonly [number, number];
	metricScale: number;
};

export function composeDepth(
	a: DepthNetArrays,
	model: string,
	seconds = 0,
): NearFieldDepth & { focal: number; shift: number } {
	const { width: W, height: H } = a;
	const s = focalShiftSamples(a.points64, a.mask64, W, H, a.focalGrid);
	const { focal, shift } = solveFocalShift(s.uv, s.xyz, s.n);
	const n = W * H;
	const depth = new Float32Array(n);
	const valid = new Uint8Array(n);
	const normal = a.normal ? new Float32Array(3 * n) : undefined;
	for (let k = 0; k < n; k++) {
		const zs = a.z[k] + shift;
		if (!(a.mask[k] > 0.5) || !(zs > 0)) continue;
		const d = zs * a.metricScale;
		if (!(d > 0) || !Number.isFinite(d)) continue;
		depth[k] = d;
		valid[k] = 1;
		if (normal && a.normal) {
			const nx = a.normal[3 * k];
			const ny = a.normal[3 * k + 1];
			const nz = a.normal[3 * k + 2];
			if (Number.isFinite(nx + ny + nz)) {
				normal[3 * k] = nx;
				normal[3 * k + 1] = ny;
				normal[3 * k + 2] = nz;
			}
		}
	}
	return {
		width: W,
		height: H,
		depth,
		valid,
		...(normal ? { normal } : {}),
		intrinsicsNorm: intrinsicsFromFocal(focal, W, H),
		model,
		seconds,
		focal,
		shift,
	};
}

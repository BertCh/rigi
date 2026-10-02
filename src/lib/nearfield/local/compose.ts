// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// MoGe-2 network outputs → the NearFieldDepth the former near-field service's /depth returned
// (moge/model/v2.py infer() with force_projection and apply_mask, then its _compute_depth): the
// focal and z shift from the 64 × 64 samples (./focal-shift.ts), depth = (z + shift) · metric scale
// on mask > 0.5 and depth > 0, normals zeroed off the mask, intrinsics normalised with the centre at
// (0.5, 0.5). Without the normal head (the quantized downloads drop it) the normals come from the metric
// depth instead (normalsFromDepth). Pure CPU on arrays already read back (O(W·H) passes).
//
// The CPU path above (composeDepth, normalsFromDepth) is the REFERENCE and what nearfield/live uses. Step
// Inside's client runs the same arithmetic on the GPU (./pipeline-gpu.ts: a compose kernel and a
// normals-from-depth kernel on the net's own z / mask / normal buffers); the only CPU part of that flow
// is solveCamera below (64 x 64 samples), shared by both.
import type { NearFieldDepth } from "../types";
import {
	focalShiftSamples,
	intrinsicsFromFocal,
	solveFocalShift,
	solveShiftKnownFocal,
} from "./focal-shift";

export type DepthNetArrays = {
	width: number;
	height: number;
	/** W·H affine z */
	z: Float32Array;
	/** W·H P(geometry) */
	mask: Float32Array;
	/** 3·W·H unit normals, or null (derived from the depth) */
	normal: Float32Array | null;
	/** 64·64·3 and 64·64: the nearest downsamples of the point map and mask */
	points64: Float32Array;
	mask64: Float32Array;
	focalGrid?: readonly [number, number];
	/** MoGe focal of a camera whose field of view is known (focalFromVfov): only the shift is solved. */
	knownFocal?: number;
	metricScale: number;
};

/** The focal and z shift from the 64 x 64 downsamples (the only part of composeDepth that is not per pixel). */
export function solveCamera(
	points64: Float32Array,
	mask64: Float32Array,
	width: number,
	height: number,
	focalGrid?: readonly [number, number],
	/** a known focal (live: the camera is calibrated): only the shift is solved */
	knownFocal?: number,
): {
	focal: number;
	shift: number;
	intrinsicsNorm: { fx: number; fy: number; cx: number; cy: number };
} {
	const s = focalShiftSamples(points64, mask64, width, height, focalGrid);
	const { focal, shift } =
		knownFocal && knownFocal > 0
			? solveShiftKnownFocal(s.uv, s.xyz, s.n, knownFocal)
			: solveFocalShift(s.uv, s.xyz, s.n);
	return {
		focal,
		shift,
		intrinsicsNorm: intrinsicsFromFocal(focal, width, height),
	};
}

export function composeDepth(
	a: DepthNetArrays,
	model: string,
	seconds = 0,
): NearFieldDepth & { focal: number; shift: number } {
	const { width: W, height: H } = a;
	const { focal, shift, intrinsicsNorm } = solveCamera(
		a.points64,
		a.mask64,
		W,
		H,
		a.focalGrid,
		a.knownFocal,
	);
	const n = W * H;
	const depth = new Float32Array(n);
	const valid = new Uint8Array(n);
	let normal: Float32Array | undefined = a.normal
		? new Float32Array(3 * n)
		: undefined;
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
	normal ??= normalsFromDepth(depth, valid, W, H, intrinsicsNorm);
	return {
		width: W,
		height: H,
		depth,
		valid,
		...(normal ? { normal } : {}),
		intrinsicsNorm,
		model,
		seconds,
		focal,
		shift,
	};
}

/** Pixel offset of the depth differences: two pixels average out the bilinear head upsampling. */
export const NORMAL_STEP = 2;
/** A neighbour farther than this relative depth step is across an edge, not on the surface. */
export const NORMAL_EDGE = 0.08;

/**
 * Unit camera-frame normals (OpenCV: x right, y down, z forward; facing the camera, so z < 0 on a
 * surface seen head-on) from metric depth, by back-projecting each pixel and crossing the vertical and
 * horizontal tangents. Each tangent takes the side (±NORMAL_STEP) with the smaller depth change, so a
 * surface next to an occlusion edge keeps its own slope; with no usable side the normal stays 0 (the
 * lifts read |n| < 0.5 as "no normal").
 */
export function normalsFromDepth(
	depth: Float32Array,
	valid: Uint8Array,
	W: number,
	H: number,
	K: { fx: number; fy: number; cx: number; cy: number },
	opts: { step?: number; edge?: number } = {},
): Float32Array {
	const { step: s = NORMAL_STEP, edge = NORMAL_EDGE } = opts;
	const out = new Float32Array(3 * W * H);
	const ax = new Float32Array(W);
	const ay = new Float32Array(H);
	for (let i = 0; i < W; i++) ax[i] = ((i + 0.5) / W - K.cx) / K.fx;
	for (let j = 0; j < H; j++) ay[j] = ((j + 0.5) / H - K.cy) / K.fy;
	/** The tangent towards the better of k - d and k + d as [dx, dy, dz], or null. */
	const tangent = (
		z: number,
		i: number,
		j: number,
		di: number,
		dj: number,
	): [number, number, number] | null => {
		let best: [number, number, number] | null = null;
		let bestDz = Number.POSITIVE_INFINITY;
		for (const sign of [1, -1]) {
			const ii = i + sign * di;
			const jj = j + sign * dj;
			if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
			const kk = jj * W + ii;
			if (!valid[kk]) continue;
			const zz = depth[kk];
			const dz = Math.abs(zz - z);
			if (dz > edge * z || dz >= bestDz) continue;
			bestDz = dz;
			// oriented along +di / +dj whichever side was used
			best = [
				sign * (ax[ii] * zz - ax[i] * z),
				sign * (ay[jj] * zz - ay[j] * z),
				sign * (zz - z),
			];
		}
		return best;
	};
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			if (!valid[k]) continue;
			const z = depth[k];
			const tx = tangent(z, i, j, s, 0);
			const ty = tangent(z, i, j, 0, s);
			if (!tx || !ty) continue;
			// ty × tx faces the camera for a head-on surface (x right, y down)
			const nx = ty[1] * tx[2] - ty[2] * tx[1];
			const ny = ty[2] * tx[0] - ty[0] * tx[2];
			const nz = ty[0] * tx[1] - ty[1] * tx[0];
			const l = Math.hypot(nx, ny, nz);
			if (!(l > 0)) continue;
			out[3 * k] = nx / l;
			out[3 * k + 1] = ny / l;
			out[3 * k + 2] = nz / l;
		}
	return out;
}

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Camera-centre-fixed rotation solve (tools/matcher/match.py solve_rotation) for the matcher: the shared
// port in src/lib/pose6dof (cameraRotationRansacAsync: 2-point TRIAD hypotheses per focal try, scored as
// one batch on the luma compute graph when a compute device exists, else on the CPU; then three rounds
// of soft_l1 LM on the rotation, + log focal when free). Sampling uses its own seeded RNG instead of
// numpy's default_rng(0): hypotheses differ from the Python run, the refined optimum is the same.

import { cameraRotationRansacAsync } from "#/lib/pose6dof";
import type { Mat3F64 } from "./geometry";

export const PX_THRESH = 6.0;
export const RANSAC_ITERS = 3000;

export type RotationSolve = {
	R: Mat3F64;
	f: number;
	inliers: Uint8Array;
	rmse: number | null;
};

/** Unit world directions eye → X (N×3). */
export function worldDirs(X: Float64Array, eye: ArrayLike<number>) {
	const n = X.length / 3;
	const wd = new Float64Array(n * 3);
	for (let i = 0; i < n; i++) {
		const x = X[i * 3] - eye[0];
		const y = X[i * 3 + 1] - eye[1];
		const z = X[i * 3 + 2] - eye[2];
		const l = Math.hypot(x, y, z);
		wd[i * 3] = x / l;
		wd[i * 3 + 1] = y / l;
		wd[i * 3 + 2] = z / l;
	}
	return wd;
}

/** match.solve_rotation(x2d, X, eye, W, H, f0, free_focal): null below 6 correspondences or inliers. */
export async function solveRotation(
	x2d: Float64Array,
	X: Float64Array,
	eye: ArrayLike<number>,
	W: number,
	H: number,
	f0: number,
	freeFocal: boolean,
	opts: { iters?: number; seed?: number; thr?: number } = {},
): Promise<RotationSolve | null> {
	if (x2d.length / 2 < 6) return null;
	const r = await cameraRotationRansacAsync(
		x2d,
		worldDirs(X, eye),
		{ fx: f0, fy: f0, cx: W / 2, cy: H / 2 },
		{
			maxReprojErrorPx: opts.thr ?? PX_THRESH,
			maxIterations: opts.iters ?? RANSAC_ITERS,
			seed: opts.seed ?? 0,
			focal: freeFocal ? "free" : "fixed",
		},
	);
	if (!r) return null;
	return { R: r.R, f: r.focal, inliers: r.inliers, rmse: r.rmsPx };
}

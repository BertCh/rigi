// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Uniform blocks of the align kernels (WGSL `struct U` of cert.wgsl.ts, pose-bound.wgsl.ts and
// pose-grid.wgsl.ts), packed through defineUniformBlock. Pure (no GPU): core/uniform-block-a.check.ts
// proves each packer byte-identical to the former hand-packed words.

import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";

/** The band and gap sizes exactly as scorePose. */
const bandOf = (h: number) => Math.max(2, Math.round(h * 0.035));
const gapCoarseOf = (h: number) => Math.max(1, Math.round(h * 0.012));
const gapFineOf = (h: number) => Math.max(1, Math.round(h * 0.006));

/** cert.wgsl.ts struct U (128 B: 22 live words, 10 pad words that keep the binding size). */
export const CERT_U = defineUniformBlock({
	w: "u32",
	h: "u32",
	nDirs: "u32",
	nLanes: "u32",
	band: "i32",
	gapCoarse: "i32",
	gapFine: "i32",
	aspect: "f32",
	W: "u32",
	nonce: "u32",
	eCoef: "f32",
	total: "f32",
	logCap: "u32",
	zero: "u32",
	dB: "f32",
	relT: "f32",
	relV: "f32",
	penSlack: "f32",
	e2Coef: "f32",
	aspectHi: "f32",
	aspectLo: "f32",
	fault: "f32",
	pad1: "u32",
	pad2: "u32",
	pad3: "u32",
	pad4: "u32",
	pad5: "u32",
	pad6: "u32",
	pad7: "u32",
	pad8: "u32",
	pad9: "u32",
	pad10: "u32",
});

export type CertUniformArgs = {
	w: number;
	h: number;
	nDirs: number;
	nLanes: number;
	aspect: number;
	window: number;
	nonce: number;
	eCoef: number;
	logCap: number;
	dB: number;
	relT: number;
	relV: number;
	pen: number;
	e2Coef: number;
	aspectHi: number;
	aspectLo: number;
	fault: number;
};

/** The certified refine's uniform (u.zero, the df32 opaque zero, is always 0). */
export function packCertUniform(a: CertUniformArgs) {
	return CERT_U.pack({
		w: a.w,
		h: a.h,
		nDirs: a.nDirs,
		nLanes: a.nLanes,
		band: bandOf(a.h),
		gapCoarse: gapCoarseOf(a.h),
		gapFine: gapFineOf(a.h),
		aspect: a.aspect,
		W: a.window,
		nonce: a.nonce,
		eCoef: a.eCoef,
		total: a.nDirs,
		logCap: a.logCap,
		zero: 0,
		dB: a.dB,
		relT: a.relT,
		relV: a.relV,
		penSlack: a.pen,
		e2Coef: a.e2Coef,
		aspectHi: a.aspectHi,
		aspectLo: a.aspectLo,
		fault: a.fault,
	});
}

/** The module probe's uniform: only u.nDirs (= probe records) is non-zero. */
export const packCertProbeUniform = (n: number) => CERT_U.pack({ nDirs: n });

/** pose-bound.wgsl.ts struct U (48 B). */
export const POSE_BOUND_U = defineUniformBlock({
	w: "u32",
	h: "u32",
	nDirs: "u32",
	nPoses: "u32",
	band: "i32",
	gapCoarse: "i32",
	gapFine: "i32",
	aspect: "f32",
	nonce: "u32",
	pad0: "u32",
	pad1: "u32",
	pad2: "u32",
});

export const packPoseBoundUniform = (a: {
	w: number;
	h: number;
	nDirs: number;
	nPoses: number;
	aspect: number;
	nonce: number;
}) =>
	POSE_BOUND_U.pack({
		w: a.w,
		h: a.h,
		nDirs: a.nDirs,
		nPoses: a.nPoses,
		band: bandOf(a.h),
		gapCoarse: gapCoarseOf(a.h),
		gapFine: gapFineOf(a.h),
		aspect: a.aspect,
		nonce: a.nonce,
	});

/** pose-grid.wgsl.ts struct U (32 B). */
export const POSE_GRID_U = defineUniformBlock({
	w: "u32",
	h: "u32",
	nDirs: "u32",
	nPoses: "u32",
	band: "i32",
	gap: "i32",
	aspect: "f32",
	total: "f32",
});

export const packPoseGridUniform = (a: {
	w: number;
	h: number;
	nDirs: number;
	nPoses: number;
	aspect: number;
}) =>
	POSE_GRID_U.pack({
		w: a.w,
		h: a.h,
		nDirs: a.nDirs,
		nPoses: a.nPoses,
		band: bandOf(a.h),
		gap: gapCoarseOf(a.h),
		aspect: a.aspect,
		total: a.nDirs,
	});

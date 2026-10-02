// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Uniform blocks of the horizon kernels (horizon.wgsl.ts / certified.wgsl.ts / ridges.wgsl.ts
// struct U, the mosaic mip struct P), packed through defineUniformBlock. Pure (no GPU):
// core/uniform-block-a.check.ts (march: uniform-block-b.check.ts) proves each packer
// byte-identical to the former hand-packed words.

import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";

/** certified.wgsl.ts struct U (32 B, shared by every certified kernel). */
export const CERT_HORIZON_U = defineUniformBlock({
	n: "u32",
	nCols: "u32",
	zero: "u32",
	noHit: "f32",
	lumpEnu: "f32",
	lumpEnuRel: "f32",
	_a: "u32",
	_b: "u32",
});

export const packCertHorizonUniform = (a: {
	n: number;
	nCols: number;
	noHit: number;
	lumpEnu: number;
	lumpEnuRel: number;
}) =>
	CERT_HORIZON_U.pack({
		n: a.n,
		nCols: a.nCols,
		zero: 0, // opq's zero
		noHit: a.noHit,
		lumpEnu: a.lumpEnu,
		lumpEnuRel: a.lumpEnuRel,
	});

/** ridges.wgsl.ts struct U (64 B). */
export const RIDGES_U = defineUniformBlock({
	nCols: "u32",
	nSlabs: "u32",
	nDist: "u32",
	nRings: "u32",
	azOff: "u32",
	distOff: "u32",
	ringOff: "u32",
	slabOff: "u32",
	inv2R: "f32",
	zero: "u32",
	h0: "f32",
	h0lo: "f32",
	sinP1: "f32",
	cosP1: "f32",
	_p0: "u32",
	_p1: "u32",
});

export const packRidgesUniform = (a: {
	nCols: number;
	nSlabs: number;
	nDist: number;
	nRings: number;
	azOff: number;
	distOff: number;
	ringOff: number;
	slabOff: number;
	inv2R: number;
	eyeH: number;
	sinP1: number;
	cosP1: number;
}) =>
	RIDGES_U.pack({
		nCols: a.nCols,
		nSlabs: a.nSlabs,
		nDist: a.nDist,
		nRings: a.nRings,
		azOff: a.azOff,
		distOff: a.distOff,
		ringOff: a.ringOff,
		slabOff: a.slabOff,
		inv2R: a.inv2R,
		zero: 0,
		// the eye height as an f32 pair: the rounded value and the f64 remainder
		h0: Math.fround(a.eyeH),
		h0lo: a.eyeH - Math.fround(a.eyeH),
		sinP1: a.sinP1,
		cosP1: a.cosP1,
	});

/** mosaic-mips.ts struct P (32 B): one mip-level reduction. */
export const MOSAIC_MIP_P = defineUniformBlock({
	srcOff: "u32",
	srcW: "u32",
	srcH: "u32",
	dstOff: "u32",
	dstW: "u32",
	dstH: "u32",
	factor: "u32",
	pad: "u32",
});

/** horizon.wgsl.ts struct U (64 B): the march kernel. */
export const MARCH_U = defineUniformBlock({
	nAz: "u32",
	nEyes: "u32",
	eyeStride: "u32",
	azOff: "u32",
	eyeOff: "u32",
	ringOff: "u32",
	nRings: "u32",
	mipSkip: "u32",
	stepFactor: "f32",
	nearFactor: "f32",
	inv2R: "f32",
	maxIter: "u32",
	zero: "u32",
	_p1: "u32",
	_p2: "u32",
	_p3: "u32",
});

export const packMarchUniform = (a: {
	nAz: number;
	nEyes: number;
	eyeStride: number;
	azOff: number;
	eyeOff: number;
	ringOff: number;
	nRings: number;
	mipSkip: boolean;
	stepFactor: number;
	nearFactor: number;
	inv2R: number;
}) =>
	MARCH_U.pack({
		nAz: a.nAz,
		nEyes: a.nEyes,
		eyeStride: a.eyeStride,
		azOff: a.azOff,
		eyeOff: a.eyeOff,
		ringOff: a.ringOff,
		nRings: a.nRings,
		mipSkip: a.mipSkip ? 1 : 0,
		stepFactor: a.stepFactor,
		nearFactor: a.nearFactor,
		inv2R: a.inv2R,
		maxIter: 1_000_000,
		zero: 0, // U.zero
	});

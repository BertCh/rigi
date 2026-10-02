// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// skyglobal.wgsl.ts struct U (48 B), packed through defineUniformBlock. Pure (no GPU).

import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";

export const SKYGLOBAL_U = defineUniformBlock({
	w: "u32",
	h: "u32",
	n: "u32",
	sy: "u32",
	nYaw: "u32",
	nCombo: "u32",
	cntReq: "u32",
	cap: "u32",
	eps: "f32",
	zeps: "f32",
	smin: "f32",
	smax: "f32",
});

export interface SkyGlobalUniformArgs {
	w: number;
	h: number;
	n: number;
	sy: number;
	nYaw: number;
	nCombo: number;
	/** Math.floor(cntMin) + 1 is applied by the packer. */
	cntMin: number;
	cap: number;
	eps?: number;
	zeps?: number;
	smin: number;
	smax: number;
}

export function packSkyGlobalUniform(a: SkyGlobalUniformArgs): ArrayBuffer {
	return SKYGLOBAL_U.pack({
		w: a.w,
		h: a.h,
		n: a.n,
		sy: a.sy,
		nYaw: a.nYaw,
		nCombo: a.nCombo,
		cntReq: Math.floor(a.cntMin) + 1,
		cap: a.cap,
		eps: a.eps ?? 5e-3,
		zeps: a.zeps ?? 1e-5,
		smin: a.smin,
		smax: a.smax,
	});
}

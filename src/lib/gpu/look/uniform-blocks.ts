// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The look kernels' uniform structs as defineUniformBlock layouts, in WGSL field order
// (guided-filter.wgsl.ts, gather-tex.wgsl.ts, haze.wgsl.ts). Pad fields stay declared so the packed
// size matches the WGSL struct; unlisted fields pack as zero. uniform-block-look.check.ts proves each
// one byte-identical to the hand-packed words it replaced.

import { defineUniformBlock } from "../core/uniform-block";

/** guided-filter.wgsl.ts `P`; textures.ts guided jobs and guided-filter-graph.ts. */
export const GUIDED_PARAMS = defineUniformBlock({
	w: "u32",
	h: "u32",
	r: "u32",
	eps: "f32",
});

/** gather-tex.wgsl.ts TEX_PHOTO `P`. */
export const TEX_PHOTO_PARAMS = defineUniformBlock({
	W: "u32",
	H: "u32",
	srcH: "u32",
	flip: "u32",
	srgb: "u32",
	pad0: "u32",
	pad1: "u32",
	pad2: "u32",
});

/** gather-tex.wgsl.ts TEX_MASKS `P`. */
export const TEX_MASKS_PARAMS = defineUniformBlock({
	w: "u32",
	h: "u32",
	gw: "u32",
	gh: "u32",
	ss: "u32",
	flipGeo: "u32",
	sky: "u32",
	flipSky: "u32",
	skyH: "u32",
	fg: "u32",
	flipFg: "u32",
	fgH: "u32",
	geoR: "u32",
	pad0: "u32",
	pad1: "u32",
	pad2: "u32",
});

/** gather-tex.wgsl.ts TEX_STATS `P`. */
export const TEX_STATS_PARAMS = defineUniformBlock({
	w: "u32",
	h: "u32",
	gh: "u32",
	flipGeo: "u32",
	flipLayer: "u32",
	fg: "u32",
	flipFg: "u32",
	fgH: "u32",
	geoR: "u32",
	pad0: "u32",
	pad1: "u32",
	pad2: "u32",
});

/** gather-tex.wgsl.ts TEX_HAZE / TEX_FGBITS `P`. */
export const TEX_HAZE_PARAMS = defineUniformBlock({
	W: "u32",
	H: "u32",
	gh: "u32",
	flipGeo: "u32",
	sky: "u32",
	flipSky: "u32",
	skyH: "u32",
	fg: "u32",
	flipFg: "u32",
	fgH: "u32",
	geoR: "u32",
	pad0: "u32",
});

/** gather-tex.wgsl.ts PACK_MASKS `P`. */
export const PACK_MASKS_PARAMS = defineUniformBlock({
	w: "u32",
	h: "u32",
	rowWords: "u32",
	fmt: "u32",
	cut: "u32",
	fg: "u32",
	pad0: "u32",
	pad1: "u32",
});

/** haze.wgsl.ts prep / dilate / bin `P` (36 B of fields, packed to 48). */
export const HAZE_PREP_PARAMS = defineUniformBlock({
	W: "u32",
	H: "u32",
	pw: "u32",
	rad: "u32",
	fgRad: "u32",
	lo: "f32",
	span: "f32",
	rmin: "f32",
	rmax: "f32",
});

/** haze.wgsl.ts histogram / scan pass `S`. */
export const HAZE_PASS_PARAMS = defineUniformBlock({
	W: "u32",
	H: "u32",
	pass_: "u32",
	pad: "u32",
});

/** haze.wgsl.ts list / compaction `C`. */
export const HAZE_COUNT_PARAMS = defineUniformBlock({
	N: "u32",
	nBlk: "u32",
	K: "u32",
	pad: "u32",
});

/** color-stats.wgsl.ts BAND_STATS `P` (20 B of fields) plus BAND_FINALIZE's minCount word at byte 20. */
export const STATS_PARAMS = defineUniformBlock({
	w: "u32",
	h: "u32",
	threads: "u32",
	hasFg: "u32",
	minRange: "f32",
	minCount: "u32",
});

/** haze.wgsl.ts grid kernel `G` (64 B). */
export const HAZE_GRID_PARAMS = defineUniformBlock({
	S: "u32",
	NH: "u32",
	NA: "u32",
	NB: "u32",
	air: "vec4<f32>",
	betaR0: "vec4<f32>",
	lam: "f32",
	jBar: "f32",
	priorK: "f32",
	pad: "f32",
});

/** haze-band.wgsl.ts `B` (32 B). */
export const HAZE_BAND_PARAMS = defineUniformBlock({
	W: "u32",
	H: "u32",
	nCol: "u32",
	a0: "u32",
	a1: "u32",
	keyBelowHalf: "u32",
	keyBelow07: "u32",
	kMax: "u32",
});

/** relief.wgsl.ts `P` (80 B). */
export const RELIEF_PARAMS = defineUniformBlock({
	res: "u32",
	resH: "u32",
	sa: "u32",
	sb: "u32",
	s: "i32",
	sFloor: "i32",
	sFrac: "f32",
	drop: "f32",
	w: "f32",
	bias: "f32",
	shadowConst: "i32",
	pxH: "f32",
	ra: "i32",
	rb: "i32",
	da: "i32",
	db: "i32",
	ka: "f32",
	kb: "f32",
	g: "f32",
	svfR: "f32",
});

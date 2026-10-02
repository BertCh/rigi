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

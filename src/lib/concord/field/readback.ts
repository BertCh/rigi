// WP-E: CPU side of the display warp — the texture the composites sample, and the forward /
// inverse maps for everything drawn or read outside the composite (labels, hover, export overlays).
//
//   photo p → render r = p + W(p)          photoToRenderUV(W, p)     (hover: which terrain is under p)
//   render r → photo p = r + W⁻¹(r)        renderToPhotoUV(W⁻¹, r)   (labels / drape: where r is shown)
//
// DISPLAY ONLY: never feed either map into pose, confidence, pin errors, benchmarks or exports of
// measurements (XMP/KML/pose). Export IMAGES may carry warped labels, since they show the display.
import {
	encodeFieldRGBA8,
	invertField,
	type ResidualField,
	sampleField,
} from "../core";

export function photoToRenderUV(
	f: ResidualField,
	u: number,
	v: number,
): [number, number] {
	const [du, dv] = sampleField(f, u, v);
	return [u + du, v + dv];
}

/**
 * Render uv → photo uv from the gridded inverse. With `fwd` (additive), the answer is refined by
 * `iters` fixed-point steps p ← r − W(p) on the forward field: exact where the grid inverse blurs,
 * e.g. next to the skyline and depth silhouettes where W changes quickly.
 */
export function renderToPhotoUV(
	fInv: ResidualField,
	u: number,
	v: number,
	fwd?: ResidualField,
	iters = 4,
): [number, number] {
	const [du, dv] = sampleField(fInv, u, v);
	let pu = u + du;
	let pv = v + dv;
	if (fwd)
		for (let k = 0; k < iters; k++) {
			const [wu, wv] = sampleField(fwd, pu, pv);
			pu = u - wu;
			pv = v - wv;
		}
	return [pu, pv];
}

/** The warp texture: RGBA8, row 0 = top, NEAREST, no flip (see glsl.ts). */
export type WarpTexture = {
	data: Uint8Array;
	width: number;
	height: number;
	/** uWarpScale / warpScale */
	scale: number;
};

export function packWarpTexture(f: ResidualField): WarpTexture {
	const { data, scale } = encodeFieldRGBA8(f);
	return { data, width: f.w, height: f.h, scale };
}

/** `?concord=warp` (comma list; see reports/concordance-research.md §4 ground rules). */
export function warpFlag(search: string): boolean {
	const q = new URLSearchParams(search).get("concord");
	return !!q && q.split(",").some((s) => s.trim() === "warp");
}

/**
 * What a renderer holds while a warp is on: the field, its inverse and the packed texture. Built once
 * per field (invertField is ~7k cells × 8 bilinear samples: < 5 ms).
 */
export class WarpState {
	readonly field: ResidualField;
	readonly inverse: ResidualField;
	readonly texture: WarpTexture;
	constructor(field: ResidualField) {
		this.field = field;
		this.inverse = invertField(field);
		this.texture = packWarpTexture(field);
	}
	/** Where render uv r is displayed in the photo (labels, drape). */
	photoOf(u: number, v: number): [number, number] {
		return renderToPhotoUV(this.inverse, u, v, this.field);
	}
	/** The render uv shown at photo uv p (hover / geo readback). */
	renderOf(u: number, v: number): [number, number] {
		return photoToRenderUV(this.field, u, v);
	}
}

// Display residual field W (photo uv → render uv offset, render = photo + W) on a cell-centred
// grid. Display-only: never feeds pose, confidence, benchmarks or exports.
import { clamp } from "../../math";
import type { ResidualField } from "./types";

function bilinear(
	a: Float32Array,
	w: number,
	h: number,
	u: number,
	v: number,
): number {
	const gx = clamp(u * w - 0.5, 0, w - 1);
	const gy = clamp(v * h - 0.5, 0, h - 1);
	const i0 = Math.floor(gx);
	const j0 = Math.floor(gy);
	const i1 = Math.min(i0 + 1, w - 1);
	const j1 = Math.min(j0 + 1, h - 1);
	const fx = gx - i0;
	const fy = gy - j0;
	const a00 = a[j0 * w + i0];
	const a10 = a[j0 * w + i1];
	const a01 = a[j1 * w + i0];
	const a11 = a[j1 * w + i1];
	return (
		(a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy
	);
}

/** Bilinear sample of W at photo uv (clamped to the outermost cell centres). */
export function sampleField(
	f: ResidualField,
	u: number,
	v: number,
): [du: number, dv: number] {
	return [bilinear(f.du, f.w, f.h, u, v), bilinear(f.dv, f.w, f.h, u, v)];
}

/**
 * Inverse field on the same grid: render uv q → photo uv offset (photo = q + W⁻¹(q)).
 * Per cell centre q: fixed point p ← q − W(p), then W⁻¹(q) = p − q. Converges for |∇W| < 1.
 */
export function invertField(f: ResidualField, iters = 8): ResidualField {
	const n = f.w * f.h;
	const du = new Float32Array(n);
	const dv = new Float32Array(n);
	const sigmaPx = new Float32Array(n);
	for (let j = 0; j < f.h; j++) {
		for (let i = 0; i < f.w; i++) {
			const qu = (i + 0.5) / f.w;
			const qv = (j + 0.5) / f.h;
			let pu = qu;
			let pv = qv;
			for (let k = 0; k < iters; k++) {
				const [wu, wv] = sampleField(f, pu, pv);
				pu = qu - wu;
				pv = qv - wv;
			}
			const idx = j * f.w + i;
			du[idx] = pu - qu;
			dv[idx] = pv - qv;
			sigmaPx[idx] = bilinear(f.sigmaPx, f.w, f.h, pu, pv);
		}
	}
	return {
		w: f.w,
		h: f.h,
		du,
		dv,
		sigmaPx,
		maxAbsPx: f.maxAbsPx,
		provenance: {
			...f.provenance,
			sources: [...f.provenance.sources, "inverse"],
		},
	};
}

/**
 * Pack (du, dv) as 16-bit fixed point per component into RGBA8: R,G = du hi,lo; B,A = dv hi,lo.
 * Decode: value = (code / 65535 · 2 − 1) · scale, code = hi·256 + lo (see decodeFieldRGBA8).
 */
export function encodeFieldRGBA8(f: ResidualField): {
	data: Uint8Array;
	scale: number;
} {
	const n = f.w * f.h;
	let scale = 0;
	for (let k = 0; k < n; k++)
		scale = Math.max(scale, Math.abs(f.du[k]), Math.abs(f.dv[k]));
	if (!(scale > 0)) scale = 1e-6;
	const data = new Uint8Array(n * 4);
	const enc = (x: number) =>
		Math.round(clamp((x / scale) * 0.5 + 0.5, 0, 1) * 65535);
	for (let k = 0; k < n; k++) {
		const a = enc(f.du[k]);
		const b = enc(f.dv[k]);
		data[k * 4] = a >> 8;
		data[k * 4 + 1] = a & 255;
		data[k * 4 + 2] = b >> 8;
		data[k * 4 + 3] = b & 255;
	}
	return { data, scale };
}

/** Inverse of encodeFieldRGBA8 (for tests and CPU consumers). */
export function decodeFieldRGBA8(
	data: Uint8Array,
	scale: number,
	w: number,
	h: number,
): { du: Float32Array; dv: Float32Array } {
	const n = w * h;
	const du = new Float32Array(n);
	const dv = new Float32Array(n);
	for (let k = 0; k < n; k++) {
		du[k] = (((data[k * 4] * 256 + data[k * 4 + 1]) / 65535) * 2 - 1) * scale;
		dv[k] =
			(((data[k * 4 + 2] * 256 + data[k * 4 + 3]) / 65535) * 2 - 1) * scale;
	}
	return { du, dv };
}

export const ZERO_FIELD = (w: number, h: number): ResidualField => ({
	w,
	h,
	du: new Float32Array(w * h),
	dv: new Float32Array(w * h),
	sigmaPx: new Float32Array(w * h),
	maxAbsPx: 0,
	provenance: {
		sources: [],
		n: 0,
		looGainPx: null,
		bound: { px: 0, metres: 0 },
	},
});

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// JS twin of the photo-prep kernels (./kernels.wgsl.ts), kernel for kernel, on the same u32 planes and
// with the same integer arithmetic (./softf64.ts is the twin of the WGSL soft-float). For node checks
// (./photoprep.check.ts): this is what the GPU computes, run where it can be compared with align.ts.
// Atomic histograms (luma GPUHistogram / GPUGroupAggregation count here) are order-free integer counts,
// so plain counting is their exact twin.
import { NBINS, RADIX_BINS, SKY_HIST_WORDS } from "./kernels.wgsl";
import * as F from "./softf64";

type V2 = F.V2;
const C = (x: number): V2 => F.bitsOf(x);
const C299 = C(0.299);
const C587 = C(0.587);
const C114 = C(0.114);
const C035 = C(0.35);
const C05 = C(0.5);
const C2 = C(2);
const C1 = C(1);
const C15 = C(1.5);
const C03 = C(0.3);
const C1E3 = C(1e-3);

const fgGt03 = (f: number) => F.f64GtPos(F.f64FromF32(f), C03);
const colorBin = (p: number) => {
	const r = ((p & 0xff) * 3) >>> 6;
	const g = (((p >>> 8) & 0xff) * 3) >>> 6;
	const b = (((p >>> 16) & 0xff) * 3) >>> 6;
	return (r * 12 + g) * 12 + b;
};

export type Dims = Uint32Array; // plan.ts photoPrepDims

export function lumab(dims: Dims, rgba: Uint32Array) {
	const n = dims[2];
	const lum = new Uint32Array(n);
	const blu = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		const p = rgba[i];
		const r = p & 0xff;
		const g = (p >>> 8) & 0xff;
		const b = (p >>> 16) & 0xff;
		const s = F.f64Add(
			F.f64Add(
				F.f64Mul(C299, F.f64FromU32(r)),
				F.f64Mul(C587, F.f64FromU32(g)),
			),
			F.f64Mul(C114, F.f64FromU32(b)),
		);
		lum[i] = F.f64ToF32(F.f64DivSmall(s, 255));
		blu[i] = F.f64ToF32(F.f64DivSmall(F.f64FromU32(b), r + g + b + 1));
	}
	return { lum, blu };
}

export function edge(dims: Dims, lum: Uint32Array, blu: Uint32Array) {
	const [w, h, n] = dims;
	const out = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		const x = i % w;
		const y = Math.floor(i / w);
		if (y < 2 || y + 2 >= h || x < 1 || x + 1 >= w) {
			out[i] = 0;
			continue;
		}
		const gy = F.f64Sub(
			F.f64FromF32(lum[i - 2 * w]),
			F.f64FromF32(lum[i + 2 * w]),
		);
		const gx = F.f64Sub(F.f64FromF32(lum[i + 1]), F.f64FromF32(lum[i - 1]));
		const by = F.f64Sub(
			F.f64FromF32(blu[i - 2 * w]),
			F.f64FromF32(blu[i + 2 * w]),
		);
		const oriented = F.f64Add(
			F.f64Max0(gy),
			F.f64Mul(C035, F.f64Max0(F.f64Neg(gy))),
		);
		const e = F.f64Add(
			F.f64Add(oriented, F.f64Mul(C05, F.f64Abs(gx))),
			F.f64Mul(C2, F.f64Max0(by)),
		);
		out[i] = F.f64ToF32(e);
	}
	return out;
}

const RADIX = [
	{ shift: 21, bits: 11 },
	{ shift: 10, bits: 11 },
	{ shift: 0, bits: 10 },
] as const;

/** The three histogram + select passes; returns sel = [value, rank left, p bits, 0]. */
export function radixSelect(dims: Dims, e: Uint32Array) {
	const n = dims[2];
	const sel = new Uint32Array(4);
	for (let pass = 0; pass < 3; pass++) {
		const { shift, bits } = RADIX[pass];
		const hist = new Uint32Array(RADIX_BINS);
		for (let i = 0; i < n; i++) {
			const v = e[i];
			const match = pass === 0 || v >>> RADIX[pass - 1].shift === sel[0];
			if (match) hist[(v >>> shift) & ((1 << bits) - 1)]++;
		}
		const prefix = pass === 0 ? 0 : sel[0];
		let krem = pass === 0 ? dims[3] : sel[1];
		let d = 0;
		let acc = 0;
		for (let j = 0; j < 1 << bits; j++) {
			const c = hist[j];
			if (krem < acc + c) {
				d = j;
				break;
			}
			acc += c;
		}
		krem -= acc;
		if (pass === 2) {
			const v = ((prefix << 10) | d) >>> 0;
			sel[0] = v;
			sel[1] = krem;
			sel[2] = v === 0 ? 0x3f800000 : v;
		} else {
			sel[0] = ((prefix << bits) | d) >>> 0;
			sel[1] = krem;
			sel[2] = 0;
		}
		sel[3] = dims[7];
	}
	return sel;
}

export function norm(
	dims: Dims,
	e: Uint32Array,
	fg: Uint32Array,
	sel: Uint32Array,
) {
	const n = dims[2];
	const out = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		const q = F.f64Div(F.f64FromF32(e[i]), F.f64FromF32(sel[2]));
		const qm = F.f64GtPos(q, C15) ? C15 : q;
		out[i] = F.f64ToF32(F.f64Mul(qm, F.f64Sub(C1, F.f64FromF32(fg[i]))));
	}
	return out;
}

const clamp = (v: number, lo: number, hi: number) =>
	Math.min(Math.max(v, lo), hi);

export function blurRow(dims: Dims, src: Uint32Array, r: number) {
	const [w, h] = dims;
	const dst = new Uint32Array(w * h);
	for (let y = 0; y < h; y++) {
		const row = y * w;
		let acc: V2 = [0, 0];
		for (let x = -r; x <= r; x++)
			acc = F.f64Add(acc, F.f64FromF32(src[row + clamp(x, 0, w - 1)]));
		for (let x = 0; x < w; x++) {
			dst[row + x] = F.f64ToF32(F.f64DivSmall(acc, 2 * r + 1));
			const a = F.f64FromF32(src[row + Math.min(x + r + 1, w - 1)]);
			const b = F.f64FromF32(src[row + Math.max(x - r, 0)]);
			acc = F.f64Add(acc, F.f64Sub(a, b));
		}
	}
	return dst;
}

export function blurCol(dims: Dims, src: Uint32Array, r: number) {
	const [w, h] = dims;
	const dst = new Uint32Array(w * h);
	for (let x = 0; x < w; x++) {
		let acc: V2 = [0, 0];
		for (let y = -r; y <= r; y++)
			acc = F.f64Add(acc, F.f64FromF32(src[clamp(y, 0, h - 1) * w + x]));
		for (let y = 0; y < h; y++) {
			dst[y * w + x] = F.f64ToF32(F.f64DivSmall(acc, 2 * r + 1));
			const a = F.f64FromF32(src[Math.min(y + r + 1, h - 1) * w + x]);
			const b = F.f64FromF32(src[Math.max(y - r, 0) * w + x]);
			acc = F.f64Add(acc, F.f64Sub(a, b));
		}
	}
	return dst;
}

export function scan(
	dims: Dims,
	rgba: Uint32Array,
	fg: Uint32Array,
	lim: Int32Array,
) {
	const [w, h] = dims;
	const lbl = new Uint32Array(w * h);
	const diff = (i: number, j: number) => {
		const a = rgba[i];
		const b = rgba[j];
		return (
			Math.abs((a & 0xff) - (b & 0xff)) +
			Math.abs(((a >>> 8) & 0xff) - ((b >>> 8) & 0xff)) +
			Math.abs(((a >>> 16) & 0xff) - ((b >>> 16) & 0xff))
		);
	};
	for (let x = 0; x < w; x++) {
		let stop = -1;
		for (let y = 3; y < h - 1; y++) {
			if (fgGt03(fg[y * w + x])) break;
			if (diff((y - 3) * w + x, (y + 1) * w + x) > 40) {
				stop = y;
				break;
			}
		}
		const top = stop < 0 ? dims[4] : stop;
		const banded = stop >= 0 && stop >= lim[2 * x] && stop <= lim[2 * x + 1];
		const bandEnd = Math.min(h, stop + 3 + dims[5]);
		const r80 = dims[6];
		for (let y = 0; y < h; y++) {
			let l = 0;
			if (y < top - 2) l = 1;
			if (banded && y >= stop + 3 && y < bandEnd) l = 2;
			if (y >= r80) l = 2;
			lbl[y * w + x] = l;
		}
	}
	return lbl;
}

export function skyHist(
	dims: Dims,
	rgba: Uint32Array,
	fg: Uint32Array,
	lbl: Uint32Array,
) {
	const n = dims[2];
	const sh = new Uint32Array(SKY_HIST_WORDS);
	for (let i = 0; i < n; i++) {
		const l = lbl[i];
		if (l !== 0 && !fgGt03(fg[i])) {
			const b = colorBin(rgba[i]);
			if (l === 1) {
				sh[b]++;
				sh[2 * NBINS]++;
			} else {
				sh[NBINS + b]++;
				sh[2 * NBINS + 1]++;
			}
		}
	}
	return sh;
}

export function skyTable(sh: Uint32Array) {
	const table = new Uint32Array(NBINS);
	const nb = F.f64FromU32(NBINS);
	const ns = F.f64FromU32(sh[2 * NBINS]);
	const nt = F.f64FromU32(sh[2 * NBINS + 1]);
	const aS = F.f64Add(F.f64Mul(F.f64DivSmall(ns, NBINS), C2), C1E3);
	const aT = F.f64Add(F.f64Mul(F.f64DivSmall(nt, NBINS), C2), C1E3);
	for (let b = 0; b < NBINS; b++) {
		const ps = F.f64Div(
			F.f64Add(F.f64FromU32(sh[b]), aS),
			F.f64Add(ns, F.f64Mul(aS, nb)),
		);
		const pt = F.f64Div(
			F.f64Add(F.f64FromU32(sh[NBINS + b]), aT),
			F.f64Add(nt, F.f64Mul(aT, nb)),
		);
		table[b] = F.f64ToF32(F.f64Div(ps, F.f64Add(ps, pt)));
	}
	return table;
}

export function skyGather(
	dims: Dims,
	rgba: Uint32Array,
	fg: Uint32Array,
	table: Uint32Array,
) {
	const n = dims[2];
	const sp = new Uint32Array(n);
	for (let i = 0; i < n; i++)
		sp[i] = fgGt03(fg[i]) ? 0x3f000000 : table[colorBin(rgba[i])];
	return sp;
}

export function skyCum(dims: Dims, sky: Uint32Array) {
	const [w, h] = dims;
	const cum = new Uint32Array(w * (h + 1));
	for (let x = 0; x < w; x++) {
		cum[x] = 0;
		let acc: V2 = [0, 0];
		for (let y = 0; y < h; y++) {
			acc = F.f64Add(acc, F.f64FromF32(sky[y * w + x]));
			cum[(y + 1) * w + x] = F.f64ToF32(acc);
		}
	}
	return cum;
}

/** The sky part of both graphs: labels → counts → table → S → blur r = 1 → column sums. */
export function emulateSky(
	dims: Dims,
	rgba: Uint32Array,
	fg: Uint32Array,
	lim: Int32Array,
) {
	const lbl = scan(dims, rgba, fg, lim);
	const table = skyTable(skyHist(dims, rgba, fg, lbl));
	const sp = skyGather(dims, rgba, fg, table);
	const sky = blurCol(dims, blurRow(dims, sp, 1), 1);
	return { sky, skyCum: skyCum(dims, sky) };
}

/** The whole edge graph (index.ts EDGE graph): RGBA words + fg bits → the planes it reads back. */
export function emulateEdge(
	dims: Dims,
	rgba: Uint32Array,
	fg: Uint32Array,
	lim: Int32Array,
) {
	const { lum, blu } = lumab(dims, rgba);
	const e = edge(dims, lum, blu);
	const sel = radixSelect(dims, e);
	const en = norm(dims, e, fg, sel);
	const coarse = blurCol(
		dims,
		blurRow(dims, blurCol(dims, blurRow(dims, en, 5), 5), 5),
		5,
	);
	const fine = blurCol(dims, blurRow(dims, en, 1), 1);
	return { coarse, fine, p: sel[2], ...emulateSky(dims, rgba, fg, lim) };
}

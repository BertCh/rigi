// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The look composite's CPU side (P4 amendment: no GPU passes), shared by both engines: the refined
// masks (LOOK_REFINE: terrain coverage and people guided-filtered on the photo), the per-band colour
// statistics (LOOK_HARMONIZE) and the photo's noise (LOOK_OUTPUT grain). Each runs once per pose
// settle (or per photo) on the buffers the engines already read back, at ≤ 512 px, and the engines
// upload the result as a texture / uniforms. compositeValues() / harmonizeValues() are the blocks'
// values (look/glsl/composite.ts).
import { lookGpuOn, trackLook } from "../gpu/look/opt-in";
import { smoothstep } from "../math";
import { hexToRgb01, srgbToLinear } from "../style/color";
import type { Hex, ViewStyle } from "../style/types";
import {
	bandInputs,
	type ColorStats,
	estimateNoiseSigma,
	identityStats,
	reduceBands,
} from "./color-stats";
import { guidedFilter } from "./guided-filter";

export const MASK_LONG_SIDE = 512;
export const STATS_LONG_SIDE = 256;

/** Range (m) at (x, y) of a w × h grid, row 0 = top; ≤ 0 or non-finite = sky. */
export type RangeGrid = {
	w: number;
	h: number;
	at: (x: number, y: number) => number;
};
/** An 8-bit mask, row 0 = top (people, P(sky)). */
export type Mask8 = {
	width: number;
	height: number;
	data: Uint8Array | Uint8ClampedArray;
};
/** The replace blend's cut (range / brush method) as the refined masks snap it: `key` names its inputs. */
export type Cut = {
	key: string;
	at: (u: number, v: number, range: number) => number;
};

/** blendCut's key without reading the brush. */
export const blendCutKey = (
	s: { method: string; rangeKm: number; feather: number },
	brushVersion: number,
) =>
	s.method === "range"
		? `range:${s.rangeKm}:${s.feather}`
		: s.method === "brush"
			? `brush:${brushVersion}`
			: "";

/** The cut of the blend settings (the classic shader's range band, or the brush canvas); null for swipe / lens. */
export function blendCut(
	s: { method: string; rangeKm: number; feather: number },
	brush: HTMLCanvasElement,
	brushVersion: number,
): Cut | null {
	if (s.method === "range") {
		const r = s.rangeKm * 1000;
		const f = Math.max(s.feather, 0.001) * 4;
		return {
			key: blendCutKey(s, brushVersion),
			at: (_u, _v, range) =>
				smoothstep(r * (1 - f), r * (1 + f), range > 0 ? range : 1e9),
		};
	}
	if (s.method !== "brush") return null;
	const { width: w, height: h } = brush;
	const d = (brush.getContext("2d") as CanvasRenderingContext2D).getImageData(
		0,
		0,
		w,
		h,
	).data;
	return {
		key: blendCutKey(s, brushVersion),
		at: (u, v) =>
			d[
				(Math.min(h - 1, Math.floor(v * h)) * w +
					Math.min(w - 1, Math.floor(u * w))) *
					4
			] / 255,
	};
}

/**
 * Nearest range (m) at which the photo and the terrain are trusted to line up: a GPS error of hAcc m
 * misregisters terrain at range r by ≈ hAcc / r rad; keep that under ~2° (≈ 25·hAcc), 150–500 m.
 * The band stats skip nearer terrain (it also differs most between the engines' meshes).
 */
export const trustedRange = (hAccuracy: number | null | undefined) =>
	Math.min(500, Math.max(150, (hAccuracy ?? 20) * 25));

export function gridSize(aspect: number, long: number): [number, number] {
	return aspect >= 1
		? [long, Math.max(1, Math.round(long / aspect))]
		: [Math.max(1, Math.round(long * aspect)), long];
}

const pixelCache = new WeakMap<HTMLImageElement, Map<string, ImageData>>();
/** The photo at w × h (cached per image and size). */
export function photoPixels(
	img: HTMLImageElement,
	w: number,
	h: number,
): ImageData {
	const m = pixelCache.get(img) ?? new Map<string, ImageData>();
	pixelCache.set(img, m);
	let d = m.get(`${w}x${h}`);
	if (!d) {
		const cv = document.createElement("canvas");
		cv.width = w;
		cv.height = h;
		const ctx = cv.getContext("2d", {
			willReadFrequently: true,
		}) as CanvasRenderingContext2D;
		ctx.drawImage(img, 0, 0, w, h);
		d = ctx.getImageData(0, 0, w, h);
		m.set(`${w}x${h}`, d);
	}
	return d;
}

const maskAt = (m: Mask8, u: number, v: number) =>
	m.data[
		Math.min(m.height - 1, Math.floor(v * m.height)) * m.width +
			Math.min(m.width - 1, Math.floor(u * m.width))
	] / 255;
const isTerrain = (r: number) => r > 0 && Number.isFinite(r);

export class CompositeLook {
	/** Refined coverage (r), blend cut (g) and people (b), RGBA8, row 0 = top, for geometry generation `gen` and cut `cut`. */
	masks: {
		w: number;
		h: number;
		data: Uint8Array;
		gen: number;
		cut: string;
	} | null = null;
	stats: ColorStats | null = null;
	/** The photo's noise σ (sRGB luma) scaled to its native width, for the grain. */
	noise = 0;
	/** Bumps whenever masks / stats change (engines re-upload). */
	version = 0;
	private sky: Mask8 | null = null;
	private maskIn: unknown[] = [];
	private statsKey = "";
	private noiseImg?: HTMLImageElement;
	/** Opt-in GPU path (gpu/look, the GPU look): masks / stats land later and this fires (re-upload). */
	onAsync?: () => void;
	private maskSeq = 0;
	private statsSeq = 0;

	/** P(sky) of the photo (composite.sky 'photo'). */
	setSky(m: Mask8 | null) {
		this.sky = m;
		this.maskIn = [];
		this.noiseImg = undefined;
		this.maskSeq++;
	}

	/**
	 * After a fresh geometry buffer (generation `gen`): the refined masks, if the style refines and
	 * the inputs changed. Coverage = the DEM's (× 1 − the photo's P(sky)), the blend cut, people = the
	 * segmentation, all guided by the photo's luma. True when new masks were made.
	 */
	updateMasks(o: {
		style: ViewStyle;
		gen: number;
		img?: HTMLImageElement;
		fg: Mask8 | null;
		cut: Cut | null;
		geo: () => RangeGrid;
	}): boolean {
		const c = o.style.composite;
		if (!c.refine || !o.img) return false;
		const sky = c.sky === "photo" ? this.sky : null;
		const input = [o.gen, o.img, o.fg, sky, o.cut?.key];
		if (input.every((v, i) => v === this.maskIn[i])) return false;
		this.maskIn = input;
		const g = o.geo();
		const [w, h] = gridSize(g.w / g.h, MASK_LONG_SIDE);
		const px = photoPixels(o.img, w, h).data;
		const n = w * h;
		const I = new Float32Array(n);
		const cov = new Float32Array(n);
		const fg = o.fg ? new Float32Array(n) : null;
		const cut = o.cut ? new Float32Array(n) : null;
		const sx = g.w / w;
		const sy = g.h / h;
		const ss = Math.max(1, Math.round(sx));
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const i = y * w + x;
				I[i] =
					(0.2126 * px[i * 4] +
						0.7152 * px[i * 4 + 1] +
						0.0722 * px[i * 4 + 2]) /
					255;
				const u = (x + 0.5) / w;
				const v = (y + 0.5) / h;
				let t = 0;
				for (let dy = 0; dy < ss; dy++)
					for (let dx = 0; dx < ss; dx++)
						t += isTerrain(
							g.at(
								Math.min(g.w - 1, Math.floor(x * sx) + dx),
								Math.min(g.h - 1, Math.floor(y * sy) + dy),
							),
						)
							? 1
							: 0;
				// the photo's sky only ever keeps more photo: the layer has nothing beyond the DEM's coverage
				cov[i] = (t / (ss * ss)) * (sky ? 1 - maskAt(sky, u, v) : 1);
				if (fg && o.fg) fg[i] = maskAt(o.fg, u, v);
				if (cut && o.cut)
					cut[i] = o.cut.at(
						u,
						v,
						g.at(
							Math.min(g.w - 1, Math.floor(u * g.w)),
							Math.min(g.h - 1, Math.floor(v * g.h)),
						),
					);
			}
		const mseq = ++this.maskSeq;
		if (lookGpuOn()) {
			this.masksAsync(mseq, I, w, h, cov, fg, cut, o.gen, o.cut?.key ?? "");
			return false;
		}
		// studio radii (10 px coverage, 1.2 % of the width for people at the output size), at this size
		const qc = guidedFilter(
			I,
			cov,
			w,
			h,
			Math.max(2, Math.round(w * 0.008)),
			4e-4,
		);
		const qf = fg
			? guidedFilter(I, fg, w, h, Math.max(3, Math.round(w * 0.012)), 1e-3)
			: null;
		// the cut only snaps to strong edges (larger ε)
		const qg = cut
			? guidedFilter(I, cut, w, h, Math.max(2, Math.round(w * 0.008)), 3e-3)
			: null;
		const data = new Uint8Array(n * 4);
		for (let i = 0; i < n; i++) {
			data[i * 4] = Math.round(qc[i] * 255);
			data[i * 4 + 1] = qg ? Math.round(qg[i] * 255) : 0;
			data[i * 4 + 2] = qf ? Math.round(qf[i] * 255) : 0;
			data[i * 4 + 3] = 255;
		}
		this.masks = { w, h, data, gen: o.gen, cut: o.cut?.key ?? "" };
		this.version++;
		return true;
	}

	/** updateMasks' guided filters on the GPU (gpu/look/hooks, CPU fallback there); same radii and packing. */
	private masksAsync(
		seq: number,
		I: Float32Array,
		w: number,
		h: number,
		cov: Float32Array,
		fg: Float32Array | null,
		cut: Float32Array | null,
		gen: number,
		cutKey: string,
	) {
		const jobs = [{ p: cov, r: Math.max(2, Math.round(w * 0.008)), eps: 4e-4 }];
		if (cut)
			jobs.push({ p: cut, r: Math.max(2, Math.round(w * 0.008)), eps: 3e-3 });
		if (fg)
			jobs.push({ p: fg, r: Math.max(3, Math.round(w * 0.012)), eps: 1e-3 });
		trackLook(
			import("../gpu/look/hooks")
				.then((m) => m.guidedFiltersAsync(I, w, h, jobs))
				.then((q) => {
					if (seq !== this.maskSeq) return;
					const [qc, qg, qf] = [
						q[0],
						cut ? q[1] : null,
						fg ? q[cut ? 2 : 1] : null,
					];
					const n = w * h;
					const data = new Uint8Array(n * 4);
					for (let i = 0; i < n; i++) {
						data[i * 4] = Math.round(qc[i] * 255);
						data[i * 4 + 1] = qg ? Math.round(qg[i] * 255) : 0;
						data[i * 4 + 2] = qf ? Math.round(qf[i] * 255) : 0;
						data[i * 4 + 3] = 255;
					}
					this.masks = { w, h, data, gen, cut: cutKey };
					this.version++;
					this.onAsync?.();
				})
				.catch((e) => console.warn("[look] async masks failed", e)),
		);
	}

	/** Whether band stats are due for `key` (the engine then renders its layer small and calls setStats). */
	wantsStats(amount: number, key: string) {
		return amount > 0 && key !== this.statsKey;
	}

	/** Band stats from the layer at w × h (linear RGBA floats, GL rows: row 0 = bottom), terrain beyond `minRange` m. */
	setStats(o: {
		key: string;
		img: HTMLImageElement;
		layer: Float32Array;
		w: number;
		h: number;
		geo: RangeGrid;
		fg: Mask8 | null;
		minRange: number;
	}) {
		const { w, h, geo, fg } = o;
		const layer = new Float32Array(o.layer.length);
		for (let y = 0; y < h; y++)
			layer.set(
				o.layer.subarray((h - 1 - y) * w * 4, (h - y) * w * 4),
				y * w * 4,
			);
		const sseq = ++this.statsSeq;
		if (lookGpuOn()) {
			// bandInputs' closures as arrays for the GPU (gpu/look/color-stats)
			const range = new Float32Array(w * h);
			const fa = fg ? new Float32Array(w * h) : null;
			for (let y = 0; y < h; y++)
				for (let x = 0; x < w; x++) {
					range[y * w + x] = geo.at(
						Math.floor(((x + 0.5) * geo.w) / w),
						Math.floor(((y + 0.5) * geo.h) / h),
					);
					if (fa && fg)
						fa[y * w + x] = maskAt(fg, (x + 0.5) / w, (y + 0.5) / h);
				}
			const input = {
				photo: photoPixels(o.img, w, h).data,
				layer,
				w,
				h,
				range,
				fg: fa,
				minRange: o.minRange,
			};
			this.statsKey = o.key;
			trackLook(
				import("../gpu/look/hooks")
					.then((m) => m.bandStatsAsync(input))
					.then((st) => {
						if (sseq !== this.statsSeq) return;
						this.stats = st;
						this.version++;
						this.onAsync?.();
					})
					.catch((e) => console.warn("[look] async band stats failed", e)),
			);
			return;
		}
		const { a, b } = bandInputs(
			photoPixels(o.img, w, h).data,
			layer,
			w,
			h,
			(x, y) =>
				geo.at(
					Math.floor(((x + 0.5) * geo.w) / w),
					Math.floor(((y + 0.5) * geo.h) / h),
				),
			fg ? (x, y) => maskAt(fg, (x + 0.5) / w, (y + 0.5) / h) : undefined,
			o.minRange,
		);
		this.stats = reduceBands(a, b, w * h);
		this.statsKey = o.key;
		this.version++;
	}

	/** The photo's noise, once per photo (and sky mask): flat sky from P(sky) or the DEM. */
	updateNoise(
		style: ViewStyle,
		img: HTMLImageElement | undefined,
		geo: () => RangeGrid,
	) {
		if (style.composite.output !== "neutral" || !img || this.noiseImg === img)
			return;
		this.noiseImg = img;
		const W = Math.min(img.naturalWidth, 1024);
		const H = Math.round((W * img.naturalHeight) / img.naturalWidth);
		const g = geo();
		const sky = this.sky;
		const isSky = (u: number, v: number) =>
			sky
				? maskAt(sky, u, v) > 0.9
				: !isTerrain(
						g.at(
							Math.min(g.w - 1, Math.floor(u * g.w)),
							Math.min(g.h - 1, Math.floor(v * g.h)),
						),
					);
		this.noise =
			estimateNoiseSigma(photoPixels(img, W, H), isSky) *
			(W / img.naturalWidth);
		this.version++;
	}
}

/** A "raw" shader colour (deck-apply.ts rawColor): float tuples exact, hex strings sRGB → linear. */
function raw(c: Hex): [number, number, number] {
	const [r, g, b] = hexToRgb01(c);
	return typeof c === "string"
		? [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]
		: [r, g, b];
}

/** COMP_BLOCK values for one frame. `visibility` (m): the haze fit's, sets how fast ink fades. */
export function compositeValues(
	style: ViewStyle,
	o: {
		outW: number;
		outH: number;
		refine: boolean;
		cut: boolean;
		crease: boolean;
		premul: boolean;
		noise: number;
		photoW: number;
		visibility?: number;
	},
) {
	const k = style.composite.ink;
	const inner = raw(k.inner);
	// dark ink (maps) reads further out than light ink over the photo
	const dark = 0.2126 * inner[0] + 0.7152 * inner[1] + 0.0722 * inner[2] < 0.2;
	return {
		inkInner: inner,
		inkSky: raw(k.skyline),
		outSize: [o.outW, o.outH],
		inkWidth: k.width * Math.max(1, o.outW / 1400),
		inkStrength: k.strength,
		// the normal pass describes the current pose only after it settles
		inkCrease: o.crease ? k.crease : 0,
		inkFade:
			Math.min(150000, Math.max(25000, o.visibility ?? 60000)) * (dark ? 2 : 1),
		refine: o.refine ? 1 : 0,
		cut: o.refine && o.cut ? 1 : 0,
		// the studio's mask sharpness 0.6
		maskSoft: 0.5 - 0.45 * 0.6,
		premul: o.premul ? 1 : 0,
		// photo noise is measured at native resolution; minification averages it down
		grain:
			style.composite.output === "neutral"
				? o.noise / Math.max(1, o.photoW / o.outW)
				: 0,
	};
}

/** HARM_BLOCK values: band stats as mat4s (column = band), identity (amount 0) without valid stats. */
export function harmonizeValues(stats: ColorStats | null, amount: number) {
	const ok = !!stats?.valid && amount > 0;
	const s = ok && stats ? stats : identityStats();
	const m = (a: Float32Array) =>
		Array.from({ length: 16 }, (_, i) =>
			i % 4 === 3 ? 0 : a[(i >> 2) * 3 + (i % 4)],
		);
	return {
		pm: m(s.photoMean),
		ps: m(s.photoStd),
		lm: m(s.layerMean),
		ls: m(s.layerStd),
		amount: ok ? amount : 0,
		chroma: 0.6,
	};
}

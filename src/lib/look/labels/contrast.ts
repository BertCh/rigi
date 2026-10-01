// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Backdrop-adaptive label contrast (labels.halo.adaptive). Each label measures the backdrop under
// its text box (a small luminance map of the photo, or the export canvas itself) and gets an extra
// soft glow in the halo colour when the text would otherwise wash out — white names on bright cloud
// or snow. Over dark rock or deep sky the need is 0 and the label is drawn exactly as before.
import { hexToRgba01, toCss } from "../../style/color";
import type { Hex, LabelStyle } from "../../style/types";

/** Relative luminance (linear, 0..1) on a small grid. */
export type LumaMap = { w: number; h: number; data: Float32Array };

/** A box in px of a `width` × `height` frame. */
export type Box = { x0: number; y0: number; x1: number; y1: number };

const lin = (c: number) =>
	c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
/** sRGB byte → linear, precomputed */
const LIN = Float32Array.from({ length: 256 }, (_, i) => lin(i / 255));

function lumaOf(rgba: Uint8ClampedArray, w: number, h: number): LumaMap {
	const data = new Float32Array(w * h);
	for (let i = 0, p = 0; i < data.length; i++, p += 4)
		data[i] =
			0.2126 * LIN[rgba[p]] +
			0.7152 * LIN[rgba[p + 1]] +
			0.0722 * LIN[rgba[p + 2]];
	return { w, h, data };
}

/** The photo's luminance map, at most `maxW` wide. Null when it can't be read (tainted / not loaded). */
export function lumaMapFrom(
	img: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
	maxW = 256,
): LumaMap | null {
	const sw = "naturalWidth" in img ? img.naturalWidth : img.width;
	const sh = "naturalHeight" in img ? img.naturalHeight : img.height;
	if (!sw || !sh) return null;
	const w = Math.min(maxW, sw);
	const h = Math.max(1, Math.round((sh / sw) * w));
	try {
		const c = document.createElement("canvas");
		c.width = w;
		c.height = h;
		const ctx = c.getContext("2d", { willReadFrequently: true });
		if (!ctx) return null;
		ctx.drawImage(img, 0, 0, w, h);
		return lumaOf(ctx.getImageData(0, 0, w, h).data, w, h);
	} catch {
		return null;
	}
}

/** Bright end of the luminance under a box (the 80th percentile: a cloud edge counts, a speck doesn't). */
function brightOf(vals: number[]): number {
	if (!vals.length) return 0;
	vals.sort((a, b) => a - b);
	return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.8))];
}

/** Backdrop luminance under `box` (px of a `width` × `height` frame) from a luma map of that frame. */
export function boxLuma(
	m: LumaMap,
	box: Box,
	width: number,
	height: number,
): number {
	const sx = m.w / width;
	const sy = m.h / height;
	const x0 = Math.max(0, Math.floor(box.x0 * sx));
	const x1 = Math.min(m.w - 1, Math.ceil(box.x1 * sx));
	const y0 = Math.max(0, Math.floor(box.y0 * sy));
	const y1 = Math.min(m.h - 1, Math.ceil(box.y1 * sy));
	const vals: number[] = [];
	for (let y = y0; y <= y1; y++)
		for (let x = x0; x <= x1; x++) vals.push(m.data[y * m.w + x]);
	return brightOf(vals);
}

/** Backdrop luminance under `box` read straight off a canvas (export: before any label is drawn). */
export function canvasBoxLuma(ctx: CanvasRenderingContext2D, box: Box): number {
	const x = Math.max(0, Math.floor(box.x0));
	const y = Math.max(0, Math.floor(box.y0));
	const w = Math.min(ctx.canvas.width - x, Math.ceil(box.x1) - x);
	const h = Math.min(ctx.canvas.height - y, Math.ceil(box.y1) - y);
	if (w <= 0 || h <= 0) return 0;
	try {
		// subsample big boxes (export at full resolution) to ~1k pixels
		const d = ctx.getImageData(x, y, w, h).data;
		const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 1024)));
		const vals: number[] = [];
		for (let j = 0; j < h; j += step)
			for (let i = 0; i < w; i += step) {
				const p = (j * w + i) * 4;
				vals.push(
					0.2126 * LIN[d[p]] + 0.7152 * LIN[d[p + 1]] + 0.0722 * LIN[d[p + 2]],
				);
			}
		return brightOf(vals);
	} catch {
		return 0;
	}
}

const yOf = (c: Hex) => {
	const [r, g, b] = hexToRgba01(c);
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const smooth = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/**
 * 0..1: how much extra halo a label needs on a backdrop of luminance `bgY`, from the WCAG contrast
 * ratio of the name colour against it (≥ 4.5 → 0, ≤ 1.5 → 1), scaled by halo.adaptive.
 */
export function contrastNeed(st: LabelStyle, bgY: number): number {
	const k = st.halo.adaptive;
	if (!(k > 0)) return 0;
	const tY = yOf(st.name.color);
	const ratio = (Math.max(tY, bgY) + 0.05) / (Math.min(tY, bgY) + 0.05);
	return k * (1 - smooth(1.5, 4.5, ratio));
}

/** The glow colour (no alpha): the halo colour, or black / white against the name colour for 'none'. */
function glowRgb(st: LabelStyle): [number, number, number] {
	if (st.halo.kind !== "none") {
		const [r, g, b] = hexToRgba01(st.halo.color);
		return [r, g, b];
	}
	return yOf(st.name.color) > 0.4 ? [0, 0, 0] : [1, 1, 1];
}

/** The glow for a label of `fontPx` at `need`: colour (with alpha) and blur radius, or null for none. */
export function contrastGlow(
	st: LabelStyle,
	need: number,
	fontPx: number,
): { color: string; blur: number } | null {
	if (need < 0.02) return null;
	const [r, g, b] = glowRgb(st);
	return {
		color: toCss([r, g, b, Math.min(1, 0.7 * need)]),
		blur: Math.max(3, fontPx * 0.45),
	};
}

/** CSS filter text for the glow (two stacked drop-shadows: one wide and soft, one tight), or "". */
export function contrastFilter(
	st: LabelStyle,
	need: number,
	fontPx: number,
): string {
	const g = contrastGlow(st, need, fontPx);
	if (!g) return "";
	const px = (v: number) => `${+v.toFixed(2)}px`;
	return `drop-shadow(0 0 ${px(g.blur)} ${g.color}) drop-shadow(0 0 ${px(g.blur * 0.35)} ${g.color})`;
}

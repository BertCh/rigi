// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Per-column sky to ground transition scan: the CPU twin (and reference) of the GPU kernel in
// skyline-gpu.ts. The frame is box-sampled to a reduced grid, reduced to a "skyness" value per
// pixel (bright and blue = sky), and each column picks the row with the largest sky-above minus
// sky-below step. Sub-pixel row by a parabola on the step, weight by the step strength.
// The tracker needs speed and a usable weight, not a clean mask: occluders, clouds and haze are
// rejected downstream by the robust solve.

/** Half window (rows) of the step detector at the reduced resolution. */
export const SCAN_HALF_WINDOW = 3;
/** Step strength that maps to weight 1 (step - STEP_FLOOR over STEP_RANGE, clamped). */
export const STEP_FLOOR = 0.04;
export const STEP_RANGE = 0.22;

/** An RGBA8 image, row 0 = top. */
export interface RgbaImage {
	width: number;
	height: number;
	data: Uint8Array | Uint8ClampedArray;
}

/** One skyline observation at the reduced resolution (edge coordinates: row y is the top edge of pixel row y). */
export interface ScanResult {
	/** Reduced grid size. */
	width: number;
	height: number;
	/** Sub-pixel skyline row per column (NaN when none). */
	rows: Float32Array;
	/** Weight 0..1 per column. */
	weights: Float32Array;
}

/** Reduced grid height for a source aspect ratio. */
export const MAX_SCAN_ROWS = 576;
export const scanHeight = (
	srcWidth: number,
	srcHeight: number,
	outWidth: number,
) =>
	Math.min(
		MAX_SCAN_ROWS,
		Math.max(8, Math.round((outWidth * srcHeight) / srcWidth)),
	);

/** Skyness of one reduced pixel: half brightness, half blueness (b - r). */
export function skyness(r: number, g: number, b: number): number {
	const lum = 0.299 * r + 0.587 * g + 0.114 * b;
	return 0.5 * lum + 0.5 * (0.5 + 0.5 * (b - r));
}

/** Integer centre texel of reduced index i; same integer arithmetic as the WGSL kernel. */
const centreTexel = (i: number, outSize: number, srcSize: number) =>
	Math.floor(((2 * i + 1) * srcSize) / (2 * outSize));

function reducedSkyness(
	img: RgbaImage,
	outWidth: number,
	outHeight: number,
	x: number,
	y: number,
): number {
	const cx = centreTexel(x, outWidth, img.width);
	const cy = centreTexel(y, outHeight, img.height);
	const x0 = Math.max(cx, 1) - 1;
	const x1 = Math.min(cx, img.width - 1);
	const y0 = Math.max(cy, 1) - 1;
	const y1 = Math.min(cy, img.height - 1);
	let r = 0;
	let g = 0;
	let b = 0;
	for (const yy of [y0, y1])
		for (const xx of [x0, x1]) {
			const o = (yy * img.width + xx) * 4;
			r += img.data[o];
			g += img.data[o + 1];
			b += img.data[o + 2];
		}
	return skyness(r / 1020, g / 1020, b / 1020);
}

/** Step strength at row boundary y (above window minus below window of mean skyness). */
export function stepAt(s: ArrayLike<number>, y: number, n: number): number {
	const k = SCAN_HALF_WINDOW;
	let above = 0;
	let below = 0;
	for (let i = 1; i <= k; i++) {
		above += s[Math.max(0, y - i)];
		below += s[Math.min(n - 1, y + i - 1)];
	}
	return (above - below) / k;
}

/** Reference scan: reduces `img` to outWidth columns and finds each column's transition. */
export function scanColumnsCpu(img: RgbaImage, outWidth: number): ScanResult {
	const outHeight = scanHeight(img.width, img.height, outWidth);
	const rows = new Float32Array(outWidth).fill(Number.NaN);
	const weights = new Float32Array(outWidth);
	const s = new Float32Array(outHeight);
	const k = SCAN_HALF_WINDOW;
	for (let x = 0; x < outWidth; x++) {
		for (let y = 0; y < outHeight; y++)
			s[y] = reducedSkyness(img, outWidth, outHeight, x, y);
		let best = -Infinity;
		let bestY = -1;
		for (let y = k; y <= outHeight - k; y++) {
			const e = stepAt(s, y, outHeight);
			if (e > best) {
				best = e;
				bestY = y;
			}
		}
		if (bestY < 0) continue;
		const em = stepAt(s, bestY - 1, outHeight);
		const ep = stepAt(s, bestY + 1, outHeight);
		const den = em - 2 * best + ep;
		const off = Math.abs(den) > 1e-9 ? (0.5 * (em - ep)) / den : 0;
		rows[x] = bestY + Math.max(-0.5, Math.min(0.5, off));
		weights[x] = Math.max(0, Math.min(1, (best - STEP_FLOOR) / STEP_RANGE));
	}
	return { width: outWidth, height: outHeight, rows, weights };
}

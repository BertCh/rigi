// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Mixed-depth edge snap (research_notes/completion_integration_2026-09.md §2.1, bullet 1; the "depth edge
// sharpening" of 3D Photo Inpainting). MoGe-2 smooths a fg/bg transition (hair against grass) over several
// cells, each step below the lift's flying-pixel threshold, so the ramp survives as a stretched sheet of
// intermediate-depth Gaussians. Here, in a (2r+1)² window around every depth edge, the foreground depth is a
// low percentile of the window's log depths and the background a high one; each cell snaps to its nearer mode
// and cells in the middle third of the ramp are dropped.
//
// Provenance: this only moves or removes OBSERVED depth samples, it invents no pixel, so whatever it feeds
// keeps its provenance (observed stays observed). Pure and deterministic.
import type { MaskLike } from "../geom";
import { PixelClass } from "../types";

export type EdgeSnapOpts = {
	/** Half window; 2 = the 5x5 window. */
	radius?: number;
	/** A cell is an edge when its central-difference |grad log z| (per cell) exceeds this. Default 0.05. */
	gradLog?: number;
	/** Snap only windows whose log-depth span (bg - fg) is at least this (ratio exp(0.3) = 1.35). Default 0.3. */
	minJumpLog?: number;
	/** Percentile (0..1) of the window's valid log depths taken as the foreground mode. Default 0.1. */
	fgPercentile?: number;
	/** Percentile taken as the background mode. Default 0.9. */
	bgPercentile?: number;
};

export type EdgeSnapResult = {
	/** New z grid: snapped values, NaN where invalid or dropped. The input is never modified. */
	z: Float32Array;
	/** 1 where a cell was dropped (middle third of a ramp). */
	dropped: Uint8Array;
	/** 1 where a cell was moved onto the foreground or background mode. */
	snapped: Uint8Array;
	/** Cells inside an edge window. */
	zoneCount: number;
};

function percentile(sorted: number[], p: number): number {
	const t = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
	const lo = Math.floor(t);
	const hi = Math.min(sorted.length - 1, lo + 1);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (t - lo);
}

/**
 * Snap the depth grid `z` (W*H, row 0 = top, NaN or <= 0 = invalid). Cells away from edges are copied
 * unchanged, so a smooth grid comes back identical with nothing dropped.
 */
export function snapMixedDepthEdges(
	z: ArrayLike<number>,
	width: number,
	height: number,
	opts: EdgeSnapOpts = {},
): EdgeSnapResult {
	const r = Math.max(1, Math.round(opts.radius ?? 2));
	const gradLog = opts.gradLog ?? 0.05;
	const minJump = opts.minJumpLog ?? 0.3;
	const fgP = opts.fgPercentile ?? 0.1;
	const bgP = opts.bgPercentile ?? 0.9;
	const n = width * height;
	const lz = new Float32Array(n);
	for (let k = 0; k < n; k++) {
		const v = z[k];
		lz[k] = v > 0 && Number.isFinite(v) ? Math.log(v) : Number.NaN;
	}
	const edge = new Uint8Array(n);
	for (let j = 0; j < height; j++)
		for (let i = 0; i < width; i++) {
			const k = j * width + i;
			if (Number.isNaN(lz[k])) continue;
			const at = (ii: number, jj: number) => {
				const v =
					ii < 0 || jj < 0 || ii >= width || jj >= height
						? Number.NaN
						: lz[jj * width + ii];
				return Number.isNaN(v) ? lz[k] : v; // missing neighbour: no gradient from it
			};
			const gx = (at(i + 1, j) - at(i - 1, j)) / 2;
			const gy = (at(i, j + 1) - at(i, j - 1)) / 2;
			if (Math.hypot(gx, gy) > gradLog) edge[k] = 1;
		}
	const out = new Float32Array(n);
	const dropped = new Uint8Array(n);
	const snapped = new Uint8Array(n);
	let zoneCount = 0;
	const win: number[] = [];
	for (let j = 0; j < height; j++)
		for (let i = 0; i < width; i++) {
			const k = j * width + i;
			const v = lz[k];
			out[k] = Number.isNaN(v) ? Number.NaN : z[k];
			if (Number.isNaN(v)) continue;
			// inside a window of an edge cell?
			let near = false;
			win.length = 0;
			for (let dj = -r; dj <= r; dj++)
				for (let di = -r; di <= r; di++) {
					const ii = i + di;
					const jj = j + dj;
					if (ii < 0 || jj < 0 || ii >= width || jj >= height) continue;
					const q = jj * width + ii;
					if (edge[q]) near = true;
					if (!Number.isNaN(lz[q])) win.push(lz[q]);
				}
			if (!near) continue;
			zoneCount++;
			win.sort((a, b) => a - b);
			const fg = percentile(win, fgP);
			const bg = percentile(win, bgP);
			if (!(bg - fg >= minJump)) continue;
			const t = (v - fg) / (bg - fg);
			if (t < 1 / 3) {
				out[k] = Math.exp(fg);
				snapped[k] = 1;
			} else if (t > 2 / 3) {
				out[k] = Math.exp(bg);
				snapped[k] = 1;
			} else {
				out[k] = Number.NaN;
				dropped[k] = 1;
			}
		}
	return { z: out, dropped, snapped, zoneCount };
}

export type RimAlphaOpts = {
	/** Rim width in cells from the Object border. Default 2. */
	rim?: number;
	/** Alpha floor on the rim so a rim cell never vanishes entirely. Default 0.25. */
	floor?: number;
};

/**
 * Per-cell opacity multiplier 0..1 (1 inside, softened on the 1..rim-cell border of the Object region): the
 * soft people mask (MediaPipe, 0..255) read at the cell becomes the rim's Gaussian opacity, clamped to
 * [floor, 1]. Cells with no soft mask value, or not on the rim, stay 1, so the photo view only changes at the
 * silhouette. Display opacity only: it adds no splat and changes no provenance.
 */
export function computeRimAlpha(
	cls: ArrayLike<number>,
	width: number,
	height: number,
	softMask: MaskLike | null | undefined,
	opts: RimAlphaOpts = {},
): Float32Array {
	const rim = Math.max(1, Math.round(opts.rim ?? 2));
	const floor = opts.floor ?? 0.25;
	const out = new Float32Array(width * height).fill(1);
	if (!softMask || !softMask.width || !softMask.height) return out;
	let max = 0;
	for (let i = 0; i < softMask.data.length && max <= 1; i++)
		if (softMask.data[i] > max) max = softMask.data[i];
	const scale = max <= 1 ? 1 : 1 / 255;
	const isObj = (i: number, j: number) =>
		i >= 0 &&
		j >= 0 &&
		i < width &&
		j < height &&
		cls[j * width + i] === PixelClass.Object;
	for (let j = 0; j < height; j++)
		for (let i = 0; i < width; i++) {
			if (!isObj(i, j)) continue;
			let onRim = false;
			for (let dj = -rim; dj <= rim && !onRim; dj++)
				for (let di = -rim; di <= rim; di++)
					if (!isObj(i + di, j + dj)) {
						onRim = true;
						break;
					}
			if (!onRim) continue;
			const x = Math.min(
				softMask.width - 1,
				Math.floor(((i + 0.5) / width) * softMask.width),
			);
			const y = Math.min(
				softMask.height - 1,
				Math.floor(((j + 0.5) / height) * softMask.height),
			);
			const a = softMask.data[y * softMask.width + x] * scale;
			out[j * width + i] = Math.min(1, Math.max(floor, a));
		}
	return out;
}

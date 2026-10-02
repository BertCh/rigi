// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The near-field service's /gaussians "lift" (tools/nearfield/service/splat.py lift_gaussians), in the
// browser: one Gaussian per stride × stride cell of a depth map, in the camera frame (OpenCV: x right,
// y down, z forward). This file is the CPU twin and the reference of the graph kernel in ./lift-gpu.ts.
//
// Per cell (centre pixel (i·s + ⌊s/2⌋, j·s + ⌊s/2⌋)):
// - kept when valid, finite, z > 0, and (edgeRatio > 0) the max / min z over its 3 × 3 cell window
//   (edge-replicated, invalid cells ignored) is ≤ edgeRatio (flying pixels at depth edges are dropped);
// - position = the ray through the centre pixel's centre at depth z (intrinsics `K` normalised);
// - colour = the mean RGB over the s × s block (cv2 INTER_AREA at an integer factor), alpha 255;
// - σ = sigmaFrac · s · z / mean(fx, fy) px; with a unit normal the Gaussian is a disc in the tangent
//   plane facing the camera, stretched along the view direction's tangent projection by 1 / |cos|
//   (≤ maxStretch) and flattened along the normal (flatFrac), else isotropic.
// Cells come out in row-major order, like numpy boolean indexing.
import { quatFromMatrix } from "../lift";
import type { GaussianCloud } from "../types";
import { PROVENANCE_CODE } from "../types";

export type IntrinsicsNorm = { fx: number; fy: number; cx: number; cy: number };

/** Depth, validity, optional normals and colour on one W × H grid (row 0 = top). */
export type LiftInput = {
	width: number;
	height: number;
	/** z-depth (m); ≤ 0 / NaN = invalid. */
	depth: Float32Array;
	/** 1 = geometry (not sky). */
	valid: Uint8Array;
	/** Camera-frame normals, 3 per pixel (any length; < 0.5 = no normal). */
	normal?: Float32Array | null;
	/** RGBA, 4 per pixel. */
	rgba: Uint8Array | Uint8ClampedArray;
	K: IntrinsicsNorm;
};

export type LiftParams = {
	stride: number;
	/** ≤ 0 keeps flying pixels. */
	edgeRatio: number;
	sigmaFrac: number;
	flatFrac: number;
	maxStretch: number;
};

/** splat.py lift_gaussians defaults (the service's /gaussians: stride 2, edgeRatio 1.5). */
export const LIFT_DEFAULTS: LiftParams = {
	stride: 2,
	edgeRatio: 1.5,
	sigmaFrac: 0.6,
	flatFrac: 0.15,
	maxStretch: 4,
};

export type LiftGrid = { gw: number; gh: number; cells: number };

export function liftGrid(
	width: number,
	height: number,
	stride: number,
): LiftGrid {
	const s = Math.max(1, Math.floor(stride));
	const gw = Math.floor(width / s);
	const gh = Math.floor(height / s);
	return { gw, gh, cells: gw * gh };
}

/** Floats per cell record shared with the GPU kernel: pos 3, scale 3, rot 4 (w x y z), rgba (u32 bits), kept (u32). */
export const LIFT_RECORD_WORDS = 12;

/**
 * One cell → its record (`out` at word offset `o`): exactly what the WGSL kernel computes. Returns
 * whether the cell is kept. `zCell(i, j)` is the cell's centre depth (NaN when not ok).
 */
function liftCell(
	inp: LiftInput,
	p: LiftParams,
	s: number,
	grid: LiftGrid,
	zCell: (gi: number, gj: number) => number,
	gi: number,
	gj: number,
	out: Float32Array,
	outU: Uint32Array,
	o: number,
): boolean {
	const { width: W, height: H, K } = inp;
	const z = zCell(gi, gj);
	if (!(z > 0)) return false;
	if (p.edgeRatio > 0) {
		let lo = Number.POSITIVE_INFINITY;
		let hi = 0;
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const zz = zCell(
					Math.min(grid.gw - 1, Math.max(0, gi + dx)),
					Math.min(grid.gh - 1, Math.max(0, gj + dy)),
				);
				if (!(zz > 0)) continue;
				if (zz < lo) lo = zz;
				if (zz > hi) hi = zz;
			}
		if (hi / lo > p.edgeRatio) return false;
	}
	const c0 = s >> 1;
	const px = gi * s + c0;
	const py = gj * s + c0;
	const fx = K.fx * W;
	const fy = K.fy * H;
	const x = ((px + 0.5 - K.cx * W) / fx) * z;
	const y = ((py + 0.5 - K.cy * H) / fy) * z;
	out[o] = x;
	out[o + 1] = y;
	out[o + 2] = z;
	const sig = (p.sigmaFrac * s * z) / (0.5 * (fx + fy));
	let sx = sig;
	const sy = sig;
	let sz = sig;
	let q: [number, number, number, number] = [1, 0, 0, 0];
	const nm = inp.normal;
	if (nm) {
		const k = 3 * (py * W + px);
		let nx = nm[k];
		let ny = nm[k + 1];
		let nz = nm[k + 2];
		const nl = Math.hypot(nx, ny, nz);
		if (nl > 0.5 && Number.isFinite(nl)) {
			nx /= nl;
			ny /= nl;
			nz /= nl;
			const vl = Math.hypot(x, y, z);
			const vx = x / vl;
			const vy = y / vl;
			const vz = z / vl;
			let d = nx * vx + ny * vy + nz * vz;
			// face the camera
			if (d > 0) {
				nx = -nx;
				ny = -ny;
				nz = -nz;
				d = -d;
			}
			const cos = Math.abs(d);
			// t1 = the view direction projected into the tangent plane (the stretch axis)
			let t1x = vx - d * nx;
			let t1y = vy - d * ny;
			let t1z = vz - d * nz;
			const t1l = Math.hypot(t1x, t1y, t1z);
			if (t1l > 1e-4) {
				t1x /= t1l;
				t1y /= t1l;
				t1z /= t1l;
			} else {
				// looking straight down the normal: n × x̂, else n × ŷ
				let ax = 0;
				let ay = nz;
				let az = -ny;
				if (Math.hypot(ax, ay, az) < 1e-3) {
					ax = -nz;
					ay = 0;
					az = nx;
				}
				const al = Math.max(Math.hypot(ax, ay, az), 1e-6);
				t1x = ax / al;
				t1y = ay / al;
				t1z = az / al;
			}
			// t2 = n × t1
			const t2x = ny * t1z - nz * t1y;
			const t2y = nz * t1x - nx * t1z;
			const t2z = nx * t1y - ny * t1x;
			// columns t1, t2, n (row-major)
			q = quatFromMatrix([t1x, t2x, nx, t1y, t2y, ny, t1z, t2z, nz]);
			const stretch = Math.min(1 / Math.max(cos, 1e-3), p.maxStretch);
			sx = sig * stretch;
			sz = sig * p.flatFrac;
		}
	}
	out[o + 3] = sx;
	out[o + 4] = sy;
	out[o + 5] = sz;
	out[o + 6] = q[0];
	out[o + 7] = q[1];
	out[o + 8] = q[2];
	out[o + 9] = q[3];
	// block mean colour
	let r = 0;
	let g = 0;
	let b = 0;
	const x0 = gi * s;
	const y0 = gj * s;
	for (let yy = y0; yy < y0 + s; yy++)
		for (let xx = x0; xx < x0 + s; xx++) {
			const k = 4 * (yy * W + xx);
			r += inp.rgba[k];
			g += inp.rgba[k + 1];
			b += inp.rgba[k + 2];
		}
	const n = s * s;
	outU[o + 10] =
		(Math.round(r / n) |
			(Math.round(g / n) << 8) |
			(Math.round(b / n) << 16) |
			(255 << 24)) >>>
		0;
	outU[o + 11] = 1;
	return true;
}

/** z of the cell centres (NaN where not ok), the shared input of the CPU twin and the edge test. */
function cellDepth(inp: LiftInput, s: number, grid: LiftGrid): Float32Array {
	const { width: W } = inp;
	const c0 = s >> 1;
	const z = new Float32Array(grid.cells);
	for (let gj = 0; gj < grid.gh; gj++)
		for (let gi = 0; gi < grid.gw; gi++) {
			const k = (gj * s + c0) * W + gi * s + c0;
			const d = inp.depth[k];
			z[gj * grid.gw + gi] =
				inp.valid[k] && d > 0 && Number.isFinite(d) ? d : Number.NaN;
		}
	return z;
}

/** Per-cell records (LIFT_RECORD_WORDS each; word 11 = kept), the CPU twin of the GPU kernel. */
export function liftRecordsCpu(
	inp: LiftInput,
	params: Partial<LiftParams> = {},
): { grid: LiftGrid; records: Float32Array } {
	const p = { ...LIFT_DEFAULTS, ...params };
	const s = Math.max(1, Math.floor(p.stride));
	const grid = liftGrid(inp.width, inp.height, s);
	const zc = cellDepth(inp, s, grid);
	const zCell = (gi: number, gj: number) => zc[gj * grid.gw + gi];
	const records = new Float32Array(grid.cells * LIFT_RECORD_WORDS);
	const u = new Uint32Array(records.buffer);
	for (let gj = 0; gj < grid.gh; gj++)
		for (let gi = 0; gi < grid.gw; gi++)
			liftCell(
				inp,
				p,
				s,
				grid,
				zCell,
				gi,
				gj,
				records,
				u,
				(gj * grid.gw + gi) * LIFT_RECORD_WORDS,
			);
	return { grid, records };
}

/** Kept records → a camera-frame GaussianCloud (provenance reconstructed, like the service). */
export function cloudFromRecords(
	records: Float32Array,
	cells: number,
): GaussianCloud {
	const u = new Uint32Array(records.buffer, records.byteOffset, records.length);
	let n = 0;
	for (let c = 0; c < cells; c++) if (u[c * LIFT_RECORD_WORDS + 11]) n++;
	const positions = new Float32Array(3 * n);
	const scales = new Float32Array(3 * n);
	const rotations = new Float32Array(4 * n);
	const colors = new Uint8Array(4 * n);
	const provenance = new Uint8Array(n).fill(PROVENANCE_CODE.reconstructed);
	let k = 0;
	for (let c = 0; c < cells; c++) {
		const o = c * LIFT_RECORD_WORDS;
		if (!u[o + 11]) continue;
		positions.set(records.subarray(o, o + 3), 3 * k);
		scales.set(records.subarray(o + 3, o + 6), 3 * k);
		rotations.set(records.subarray(o + 6, o + 10), 4 * k);
		const rgba = u[o + 10];
		colors[4 * k] = rgba & 255;
		colors[4 * k + 1] = (rgba >>> 8) & 255;
		colors[4 * k + 2] = (rgba >>> 16) & 255;
		colors[4 * k + 3] = rgba >>> 24;
		k++;
	}
	return {
		count: n,
		frame: "camera",
		positions,
		scales,
		rotations,
		colors,
		provenance,
	};
}

/** The whole lift on the CPU (the no-WebGPU path and the reference). */
export function liftGaussiansCpu(
	inp: LiftInput,
	params: Partial<LiftParams> = {},
): GaussianCloud {
	const { grid, records } = liftRecordsCpu(inp, params);
	return cloudFromRecords(records, grid.cells);
}

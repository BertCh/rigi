// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure logic of the batched terrain's GPU cull (terrain-cull.ts, terrain-cull.wgsl.ts), node-safe:
// the buffer packing and the CPU twins of both kernels. terrain-cull-math.check.ts runs them against
// BatchedTerrainCore.visibleRows' test (camera.ts sphereInView) without a GPU.
import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";
import type { CameraUniforms } from "../camera";
import {
	CAND_BYTES,
	CULL_SLOTS,
	MARGIN_ABS,
	MARGIN_REL,
	RECORD_WORDS,
} from "./terrain-cull.wgsl";

/** visibleRows' pad (the WebGL path's sphereCuller / matrixCuller): r·1.02 + 1. */
export const padRadius = (r: number) => r * 1.02 + 1;

/** A cull candidate: a resident tile in tile-set order. */
export type CullCandidate = {
	/** grid.sphere: ENU centre and radius (unpadded) */
	sphere: readonly [number, number, number, number];
	/** tile-table row (the instance attribute) */
	row: number;
	/** index of the tile's seg in the seg table (< CULL_SLOTS) */
	seg: number;
};

/** The uniform block P (80 B), field for field as in terrain-cull.wgsl.ts. */
const CULL_PARAMS = defineUniformBlock({
	eye: "vec3<f32>",
	near: "f32",
	right: "vec3<f32>",
	tanX: "f32",
	up: "vec3<f32>",
	tanY: "f32",
	fwd: "vec3<f32>",
	kx: "f32",
	off: "vec2<f32>",
	ky: "f32",
	n: "u32",
});

/** The uniform block P (80 B): see terrain-cull.wgsl.ts. */
export function packCullParams(u: CameraUniforms, n: number): ArrayBuffer {
	return CULL_PARAMS.pack({
		eye: u.eye,
		near: u.near,
		right: u.right,
		tanX: u.tanHalfX,
		up: u.up,
		tanY: u.tanHalfY,
		fwd: u.forward,
		kx: Math.sqrt(1 + u.tanHalfX * u.tanHalfX),
		off: [u.offset[0] * u.tanHalfX, u.offset[1] * u.tanHalfY],
		ky: Math.sqrt(1 + u.tanHalfY * u.tanHalfY),
		n,
	});
}

/** cand[] (32 B each): padded sphere in f32, row, seg. */
export function packCandidates(c: readonly CullCandidate[], cap = c.length) {
	const out = new ArrayBuffer(Math.max(1, cap) * CAND_BYTES);
	const fl = new Float32Array(out);
	const u = new Uint32Array(out);
	c.forEach((x, i) => {
		const o = (i * CAND_BYTES) / 4;
		fl[o] = x.sphere[0];
		fl[o + 1] = x.sphere[1];
		fl[o + 2] = x.sphere[2];
		fl[o + 3] = padRadius(x.sphere[3]);
		u[o + 4] = x.row;
		u[o + 5] = x.seg;
	});
	return out;
}

/** The f32 values the kernel reads (Float32 round trip of the packed buffers). */
export function unpackParams(buf: ArrayBuffer) {
	const f = new Float32Array(buf);
	return {
		eye: [f[0], f[1], f[2]],
		near: f[3],
		right: [f[4], f[5], f[6]],
		tanX: f[7],
		up: [f[8], f[9], f[10]],
		tanY: f[11],
		fwd: [f[12], f[13], f[14]],
		kx: f[15],
		off: [f[16], f[17]],
		ky: f[18],
		n: new Uint32Array(buf)[19],
	};
}
export type CullParamsF32 = ReturnType<typeof unpackParams>;

const fr = Math.fround;
const dot3 = (a: number[], b: number[]) =>
	fr(fr(fr(a[0] * b[0]) + fr(a[1] * b[1])) + fr(a[2] * b[2]));

/**
 * CPU twin of the WGSL in_view (f32 per operation, no fused multiply-add). `s` is the packed
 * candidate's sphere (padded radius, f32 values).
 */
export function inViewF32(p: CullParamsF32, s: readonly number[]): boolean {
	const d = [fr(s[0] - p.eye[0]), fr(s[1] - p.eye[1]), fr(s[2] - p.eye[2])];
	const r = s[3];
	const a = [0, 1, 2].map((k) =>
		fr(fr(Math.abs(s[k]) + Math.abs(p.eye[k])) + Math.abs(d[k])),
	);
	const m = fr(
		fr(fr(MARGIN_REL) * fr(fr(fr(a[0] + a[1]) + a[2]) + r)) + fr(MARGIN_ABS),
	);
	const z = dot3(d, p.fwd);
	if (z < fr(fr(p.near - r) - m)) return false;
	const x = dot3(d, p.right);
	const y = dot3(d, p.up);
	const mx = fr(m * fr(fr(fr(1 + Math.abs(p.off[0])) + p.tanX) + p.kx));
	const my = fr(m * fr(fr(fr(1 + Math.abs(p.off[1])) + p.tanY) + p.ky));
	if (
		Math.abs(fr(x + fr(p.off[0] * z))) >
		fr(fr(fr(p.tanX * z) + fr(r * p.kx)) + mx)
	)
		return false;
	if (
		Math.abs(fr(y + fr(p.off[1] * z))) >
		fr(fr(fr(p.tanY * z) + fr(r * p.ky)) + my)
	)
		return false;
	return true;
}

/** The compaction's result: per draw slot the seg and its rows (CPU twin of COMPACT_WGSL). */
export type CompactResult = {
	/** per draw slot: seg index or -1, and the visible rows in candidate order */
	slots: { seg: number; rows: number[] }[];
	/** the indirect records, CULL_SLOTS × RECORD_WORDS words */
	args: Uint32Array;
};

/** CPU twin of COMPACT_WGSL given the visibility flags. */
export function compactTwin(
	cands: readonly CullCandidate[],
	vis: readonly boolean[],
	segs: readonly { indexCount: number; firstIndex: number }[],
): CompactResult {
	const first = new Array<number>(CULL_SLOTS).fill(Infinity);
	const rows: number[][] = Array.from({ length: CULL_SLOTS }, () => []);
	cands.forEach((c, i) => {
		if (!vis[i]) return;
		first[c.seg] = Math.min(first[c.seg], i);
		rows[c.seg].push(c.row);
	});
	const order = [...first.keys()]
		.filter((k) => first[k] < Infinity)
		.sort((a, b) => first[a] - first[b]);
	const args = new Uint32Array(CULL_SLOTS * RECORD_WORDS);
	const slots = Array.from({ length: CULL_SLOTS }, (_, s) => {
		const k = order[s];
		if (k === undefined) return { seg: -1, rows: [] as number[] };
		args[s * RECORD_WORDS] = segs[k].indexCount;
		args[s * RECORD_WORDS + 1] = rows[k].length;
		args[s * RECORD_WORDS + 2] = segs[k].firstIndex;
		return { seg: k, rows: rows[k] };
	});
	return { slots, args };
}

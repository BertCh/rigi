// WP-F: photo-space occluder range = min(DEM range, DSM object hit, anchored objects, people).
//
// Consumers (hooks.patch.txt, flag ?concord=occl) bind it as one texture `tOccl`: trail / contour / ridge
// fragments dim where their range r > occl·1.05 + 3 m (OCCL_RULE), peak labels test the same, and the drape
// stops projecting photo pixels whose occluder is well in front of the terrain behind them.
//
// Only DSM cells that stand ≥ minObjM above the DTM (nDSM) occlude: the bare-earth part of the DSM is already
// the render's DEM, and counting it would make DSM-vs-DEM noise at grazing angles look like objects.

import { EARTH_R, REFRACTION_K } from "../../geodesy";
import type { CameraX, Vec3 } from "../core";
import { unprojectDirX } from "../core";
import type { NearDsm } from "./ndsm";

/** Photo-space geometry at `cam` (WP-C's GeomBuffer): xyz/range of the DEM hit per pixel, sky = no hit. */
export type GeomBuffer = {
	w: number;
	h: number;
	xyz: Float32Array;
	range: Float32Array;
	sky: Uint8Array;
};

export type OcclOpts = {
	/** Minimum nDSM (m) for a DSM cell to count as an object. Default 2.5 (split.ts object rule). */
	minObjM?: number;
	/** Ignore DSM hits closer than this (m): GPS error puts the eye inside the hut / tree it stands by. */
	nearSkipM?: number;
	/** Horizontal march step as a fraction of the DSM cell. Default 0.5. */
	stepFrac?: number;
	/** Eye altitude (m, engine world z) when cam.eye is not in the dsm frame's absolute-z convention. */
	eyeZ?: number;
};

/** The shared dimming rule: a fragment at range r is behind the occluder iff r > occl·1.05 + 3 m. */
export const OCCL_RULE = { ratio: 1.05, slackM: 3 } as const;
export const occludedBy = (r: number, occl: number) =>
	r > occl * OCCL_RULE.ratio + OCCL_RULE.slackM;

/** GLSL twin of occludedBy for the composites (sampler holds metres; 0 texels ⇒ people). */
export const OCCL_GLSL = /* glsl */ `
float occlDim(sampler2D tOccl, vec2 uv, float r) {
  float o = texture2D(tOccl, uv).r;
  return r > o * ${OCCL_RULE.ratio.toFixed(2)} + ${OCCL_RULE.slackM.toFixed(1)} ? 1.0 : 0.0;
}`;

const R_DROP = (1 - REFRACTION_K) / (2 * EARTH_R);
const BLOCK = 16;

type Prep = {
	/** per BLOCK×BLOCK cells: max object-top height (m), dilated 3×3; -Infinity if no object. */
	bmax: Float32Array;
	bw: number;
	bh: number;
	minObjM: number;
};
const PREP = new WeakMap<NearDsm, Prep>();

function prep(d: NearDsm, minObjM: number): Prep {
	const hit = PREP.get(d);
	if (hit && hit.minObjM === minObjM) return hit;
	const bw = Math.ceil(d.w / BLOCK);
	const bh = Math.ceil(d.h / BLOCK);
	const raw = new Float32Array(bw * bh).fill(Number.NEGATIVE_INFINITY);
	for (let j = 0; j < d.h; j++)
		for (let i = 0; i < d.w; i++) {
			const k = j * d.w + i;
			const s = d.dsm[k];
			if (!(s - d.dtm[k] >= minObjM)) continue;
			const b = ((j / BLOCK) | 0) * bw + ((i / BLOCK) | 0);
			if (s > raw[b]) raw[b] = s;
		}
	const bmax = new Float32Array(bw * bh).fill(Number.NEGATIVE_INFINITY);
	for (let j = 0; j < bh; j++)
		for (let i = 0; i < bw; i++) {
			let m = Number.NEGATIVE_INFINITY;
			for (let dj = -1; dj <= 1; dj++)
				for (let di = -1; di <= 1; di++) {
					const jj = j + dj;
					const ii = i + di;
					if (jj < 0 || ii < 0 || jj >= bh || ii >= bw) continue;
					const v = raw[jj * bw + ii];
					if (v > m) m = v;
				}
			bmax[j * bw + i] = m;
		}
	const p = { bmax, bw, bh, minObjM };
	PREP.set(d, p);
	return p;
}

/** Bilinear of a grid array; NaN outside. */
function bil(d: NearDsm, a: Float32Array, x: number, y: number): number {
	if (!(x >= 0 && y >= 0 && x <= d.w - 1 && y <= d.h - 1)) return Number.NaN;
	const ix = Math.min(d.w - 2, x | 0);
	const iy = Math.min(d.h - 2, y | 0);
	const tx = x - ix;
	const ty = y - iy;
	const o = iy * d.w + ix;
	return (
		(a[o] * (1 - tx) + a[o + 1] * tx) * (1 - ty) +
		(a[o + d.w] * (1 - tx) + a[o + d.w + 1] * tx) * ty
	);
}

/**
 * Range (m, along the unit ray) of the first DSM object (nDSM ≥ minObjM) the ray from `eye` (engine world:
 * ENU of dsm.frame, z = altitude) meets before maxT; Infinity if none (or the ray dives under the DTM first).
 */
export function objectHitRange(
	d: NearDsm,
	eye: Vec3,
	dir: Vec3,
	maxT: number,
	opts: OcclOpts = {},
): number {
	const minObj = opts.minObjM ?? 2.5;
	const near = opts.nearSkipM ?? 15;
	const hs = Math.hypot(dir[0], dir[1]);
	if (hs < 1e-6) return Number.POSITIVE_INFINITY;
	const P = prep(d, minObj);
	const tMax = Math.min(maxT, (d.radiusM + Math.hypot(eye[0], eye[1])) / hs);
	const dt = (d.res * (opts.stepFrac ?? 0.5)) / hs;
	const coarse = (BLOCK * d.res) / hs;
	const inv = 1 / d.res;
	const zAt = (t: number) => {
		const e = eye[0] + t * dir[0];
		const n = eye[1] + t * dir[1];
		return eye[2] + t * dir[2] + (e * e + n * n) * R_DROP; // ray z + drop ⇒ compare to raw heights
	};
	/** 1 = object above the ray, -1 = ray under terrain, 0 = free */
	const test = (t: number) => {
		const x = (eye[0] + t * dir[0] - d.e0) * inv;
		const y = (d.n0 - (eye[1] + t * dir[1])) * inv;
		const s = bil(d, d.dsm, x, y);
		if (!Number.isFinite(s)) return 0;
		const g = bil(d, d.dtm, x, y);
		const z = zAt(t);
		if (Number.isFinite(g) && z < g - 1) return -1;
		if (z <= s && s - g >= minObj) return 1;
		return 0;
	};
	let t = near;
	while (t < tMax) {
		const t1 = Math.min(tMax, t + coarse);
		// skip the coarse segment when its lowest ray point is above every object top around it
		const x = (eye[0] + t * dir[0] - d.e0) * inv;
		const y = (d.n0 - (eye[1] + t * dir[1])) * inv;
		const bi = Math.floor(x / BLOCK);
		const bj = Math.floor(y / BLOCK);
		const top =
			bi >= 0 && bj >= 0 && bi < P.bw && bj < P.bh
				? P.bmax[bj * P.bw + bi]
				: Number.NEGATIVE_INFINITY;
		if (Math.min(zAt(t), zAt(t1)) - 0.5 > top) {
			t = t1;
			continue;
		}
		for (let s = t; s < t1; s += dt) {
			const r = test(s);
			if (r < 0) return Number.POSITIVE_INFINITY;
			if (r > 0) {
				// bisect between the previous free sample and s
				let a = Math.max(near, s - dt);
				let b = s;
				for (let k = 0; k < 6; k++) {
					const m = (a + b) / 2;
					if (test(m) > 0) b = m;
					else a = m;
				}
				return b;
			}
		}
		t = t1;
	}
	return Number.POSITIVE_INFINITY;
}

/**
 * Photo grid (g.w × g.h, row 0 = top) of the nearest occluder range in metres: min of the DEM range (g.range;
 * sky ⇒ none), the DSM object hit (dsm null ⇒ skipped), `objects` (per-pixel range of anchored near-field
 * objects, e.g. split.ts Object depth; ≤ 0 / NaN ⇒ none) and `people` (mask > 127 ⇒ 0 m: nothing is drawn
 * over a person). Infinity where nothing occludes. cam.eye must be engine world coordinates (ENU of
 * dsm.frame, z = eye altitude), or pass opts.eyeZ.
 */
export function occluderRange(
	g: GeomBuffer,
	cam: CameraX,
	dsm: NearDsm | null,
	objects?: Float32Array,
	people?: Uint8Array,
	opts: OcclOpts = {},
): Float32Array {
	const out = new Float32Array(g.w * g.h);
	const eye: Vec3 = [cam.eye[0], cam.eye[1], opts.eyeZ ?? cam.eye[2]];
	for (let j = 0; j < g.h; j++)
		for (let i = 0; i < g.w; i++) {
			const k = j * g.w + i;
			let r =
				g.sky[k] || !(g.range[k] > 0) ? Number.POSITIVE_INFINITY : g.range[k];
			if (people && people[k] > 127) {
				out[k] = 0;
				continue;
			}
			const o = objects?.[k];
			if (o !== undefined && o > 0 && o < r) r = o;
			if (dsm) {
				const dir = unprojectDirX(cam, (i + 0.5) / g.w, (j + 0.5) / g.h);
				const h = objectHitRange(dsm, eye, dir, r, opts);
				if (h < r) r = h;
			}
			out[k] = r;
		}
	return out;
}

/** Texture payload: Infinity → 1e7 m (fits a float/half-float texture's "far"). */
export function occlTexture(occl: Float32Array): Float32Array {
	const t = new Float32Array(occl.length);
	for (let k = 0; k < occl.length; k++)
		t[k] = Number.isFinite(occl[k]) ? occl[k] : 1e7;
	return t;
}

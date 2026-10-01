// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside P3 (research flag): the pure-TS half of DEM-conditioned generation.
//   RGB-D cache view (cache-render.ts) → hole mask → [inpainter fills the holes] → lift ONLY the filled
//   pixels into Gaussians with provenance `generated`.
// Depth of a filled pixel: the DEM range of the novel view wherever the DEM has a surface there ("plausible
// texture on true geometry"); else, optionally, a monocular depth of the filled image aligned to the rendered
// DEM range around the hole; else (sky, nothing known) the pixel is not lifted. The monocular fallback is
// conservative by default so generated content never floats: it needs a LOCAL alignment (fitted next to the
// holes, not the global fallback) and a DEM surface just below the pixel in its column (within
// monoSupportRows) that the pixel stands in front of; anything else is skipped.
import { type Pose, poseBasis } from "../../camera";
import { type IntrinsicsNorm, intrinsicsFromPose } from "../geom";
import {
	type GaussianCloud,
	type NearFieldDepth,
	PROVENANCE_CODE,
} from "../types";
import type { NovelCamera } from "./trajectory";

/** One rendered novel view of the true scene (DEM + photo drape + near-field splats). Row 0 = top. */
export type RgbdView = {
	width: number;
	height: number;
	camera: NovelCamera;
	/** Aspect (W/H) the view was rendered with (= the photo's). */
	aspect: number;
	/** sRGB RGBA 0..255 of the observed content; hole pixels are 0. */
	rgba: Uint8ClampedArray;
	/** DEM surface point per pixel, ENU (engine frame), 3·W·H; NaN where the DEM has no surface. */
	world: Float32Array;
	/** Ray length (m) from the novel eye to the DEM surface; 0 = no DEM surface (sky / unloaded). */
	range: Float32Array;
	/** 1 = observed: photo drape, photo sky seen along the same direction, or ≥ 50 % splat coverage. */
	observed: Uint8Array;
	/** 1 = observed via the photo's sky (no DEM surface here or in the photo along this direction). */
	sky: Uint8Array;
};

export type HoleStats = {
	/** Fraction of the view that is a hole (after dilation). */
	holeFrac: number;
	/** Fraction of hole pixels with a DEM surface (their depth is true geometry). */
	demBacked: number;
	/** Fraction of hole pixels without a DEM surface (sky out of frame, or unknown). */
	noGeo: number;
};

/** 1 = hole (not observed), dilated by `dilate` px (hides the ragged drape edge; default 1). */
export function holeMask(view: RgbdView, dilate = 1): Uint8Array {
	const { width: W, height: H } = view;
	let m = new Uint8Array(W * H);
	for (let k = 0; k < W * H; k++) m[k] = view.observed[k] ? 0 : 1;
	for (let it = 0; it < dilate; it++) {
		const o = m.slice();
		for (let j = 0; j < H; j++)
			for (let i = 0; i < W; i++) {
				const k = j * W + i;
				if (m[k]) continue;
				if (
					(i > 0 && m[k - 1]) ||
					(i < W - 1 && m[k + 1]) ||
					(j > 0 && m[k - W]) ||
					(j < H - 1 && m[k + W])
				)
					o[k] = 1;
			}
		m = o;
	}
	return m;
}

export function holeStats(view: RgbdView, hole: Uint8Array): HoleStats {
	let n = 0;
	let dem = 0;
	for (let k = 0; k < hole.length; k++) {
		if (!hole[k]) continue;
		n++;
		if (view.range[k] > 0) dem++;
	}
	return {
		holeFrac: n / hole.length,
		demBacked: n ? dem / n : 0,
		noGeo: n ? (n - dem) / n : 0,
	};
}

/** Normalised intrinsics of a novel view (same vfov and aspect as the photo). */
export const viewIntrinsics = (view: RgbdView): IntrinsicsNorm =>
	intrinsicsFromPose(view.camera.pose, view.aspect);

/** Unit ENU ray through normalised coords (u right, v down) of a pose. */
export function rayDir(
	pose: Pose,
	K: IntrinsicsNorm,
	u: number,
	v: number,
	B = poseBasis(pose),
): [number, number, number] {
	const x = (u - K.cx) / K.fx;
	const y = (v - K.cy) / K.fy; // OpenCV: y down
	const d = [0, 1, 2].map((a) => B.right[a] * x - B.up[a] * y + B.forward[a]);
	const l = Math.hypot(d[0], d[1], d[2]);
	return [d[0] / l, d[1] / l, d[2] / l];
}

export type MonoAlign = {
	/** Multiply the monocular ray length by this to get metres consistent with the rendered DEM. */
	scale: number;
	/** Median |log(scaled mono / DEM)| over the fit pixels. */
	residualLog: number;
	n: number;
	/** "local": fitted on DEM pixels within `band` px of the no-DEM holes; "global": all DEM pixels < maxRange. */
	mode: "local" | "global" | "none";
};

/**
 * Align a monocular depth of the (filled) novel view to its rendered DEM range. MoGe-2 compresses range
 * (tools/nearfield/spike/SUMMARY.txt: DEM/MoGe ≈ 1 at 15–30 m, ≈ 3 at 100–300 m), so one global scale is
 * wrong across ranges: fit on DEM pixels near the holes that need it (`band` px), falling back to all DEM
 * pixels within `maxRange`. Scale = exp(median log ratio).
 */
export function alignMono(
	view: RgbdView,
	mono: NearFieldDepth,
	needs: Uint8Array,
	opts: { band?: number; maxRange?: number; minN?: number } = {},
): MonoAlign {
	const { width: W, height: H } = view;
	const K = viewIntrinsics(view);
	const band = opts.band ?? 24;
	const maxRange = opts.maxRange ?? 300;
	const minN = opts.minN ?? 200;
	// distance-limited neighbourhood of the pixels that need mono depth (box dilation, separable)
	const near = boxDilate(needs, W, H, band);
	const monoRay = (i: number, j: number) => {
		const u = (i + 0.5) / W;
		const v = (j + 0.5) / H;
		const mi = Math.min(mono.width - 1, Math.floor(u * mono.width));
		const mj = Math.min(mono.height - 1, Math.floor(v * mono.height));
		const k = mj * mono.width + mi;
		const z = mono.depth[k];
		if (!mono.valid[k] || !(z > 0) || !Number.isFinite(z)) return Number.NaN;
		const x = (u - K.cx) / K.fx;
		const y = (v - K.cy) / K.fy;
		return z * Math.sqrt(1 + x * x + y * y);
	};
	const fit = (local: boolean) => {
		const r: number[] = [];
		const step = Math.max(1, Math.round(Math.sqrt((W * H) / 60000)));
		for (let j = 0; j < H; j += step)
			for (let i = 0; i < W; i += step) {
				const k = j * W + i;
				const d = view.range[k];
				if (!(d > 0) || d > maxRange || needs[k]) continue;
				if (local && !near[k]) continue;
				const m = monoRay(i, j);
				if (m > 0) r.push(Math.log(d / m));
			}
		return r;
	};
	let mode: MonoAlign["mode"] = "local";
	let r = fit(true);
	if (r.length < minN) {
		mode = "global";
		r = fit(false);
	}
	if (r.length < 30)
		return { scale: 1, residualLog: Number.NaN, n: r.length, mode: "none" };
	const s = medianOf(r);
	const res = medianOf(r.map((x) => Math.abs(x - s)));
	return { scale: Math.exp(s), residualLog: res, n: r.length, mode };
}

export type LiftGeneratedOpts = {
	/** View pixels per Gaussian along each axis. Default 2. */
	stride?: number;
	/** Gaussian std-dev as a fraction of the block footprint. Default 0.7. */
	footprint?: number;
	/**
	 * Pull each Gaussian this fraction of its range toward the novel eye (plus 0.05 m), so it sits just in front
	 * of the un-draped DEM it lies on instead of z-fighting it. Default 0.002.
	 */
	towardEye?: number;
	/** Monocular depth of the filled view + its alignment, for hole pixels without a DEM surface. */
	mono?: { depth: NearFieldDepth; align: MonoAlign } | null;
	/** Max aligned monocular range (m) that is lifted; beyond it the pixel is treated as sky. Default 300. */
	monoMaxRange?: number;
	/**
	 * Also use a GLOBAL monocular alignment (alignMono's fallback when too few DEM pixels lie near the holes).
	 * Default false: only a local alignment is trusted, else no-DEM holes are skipped.
	 */
	monoGlobal?: boolean;
	/**
	 * A mono-lifted pixel must stand on modelled terrain: within this many rows below it (same column) there is
	 * a DEM pixel of the view, and the aligned range is not behind that DEM range (x1.05). Default 24; 0 disables
	 * the support test (content may float: research only).
	 */
	monoSupportRows?: number;
	/** Provenance code. Default generated (this module never makes anything else). */
	provenance?: number;
};

export type LiftGeneratedStats = {
	/** Gaussians placed on the DEM surface. */
	demBacked: number;
	/** Gaussians placed at aligned monocular depth. */
	mono: number;
	/** Hole blocks not lifted (no DEM, no usable mono depth: sky or unknown). */
	skipped: number;
};

/**
 * Lift the filled hole pixels of a view into ENU Gaussians (provenance `generated`). Only blocks whose centre
 * pixel is a hole are lifted; observed pixels never become generated splats. `filled` = sRGB RGBA of the
 * inpainted view (same size). DEM-backed Gaussians are discs on the local DEM plane (normal from the
 * neighbouring DEM points), monocular ones are isotropic.
 */
export function liftGenerated(
	view: RgbdView,
	filled: ArrayLike<number>,
	hole: Uint8Array,
	opts: LiftGeneratedOpts = {},
): { cloud: GaussianCloud; stats: LiftGeneratedStats } {
	const { width: W, height: H } = view;
	const st = Math.max(1, Math.round(opts.stride ?? 2));
	const fp = opts.footprint ?? 0.7;
	const toward = opts.towardEye ?? 0.002;
	const prov = opts.provenance ?? PROVENANCE_CODE.generated;
	const monoMax = opts.monoMaxRange ?? 300;
	const monoAlign = opts.mono?.align.mode;
	const monoOn =
		!!opts.mono &&
		(monoAlign === "local" || (monoAlign === "global" && !!opts.monoGlobal));
	const support = Math.max(0, Math.round(opts.monoSupportRows ?? 24));
	/** DEM range of the first view pixel with a surface below (i, j) within `support` rows, else 0. */
	const demBelow = (i: number, j: number) => {
		for (let y = j + 1; y <= Math.min(H - 1, j + support); y++) {
			const r = view.range[y * W + i];
			if (r > 0) return r;
		}
		return 0;
	};
	const K = viewIntrinsics(view);
	const B = poseBasis(view.camera.pose);
	const eye = view.camera.eye;
	const P = view.world;
	const pos: number[] = [];
	const scl: number[] = [];
	const rot: number[] = [];
	const col: number[] = [];
	const stats: LiftGeneratedStats = { demBacked: 0, mono: 0, skipped: 0 };
	const pt = (k: number) => [P[3 * k], P[3 * k + 1], P[3 * k + 2]];
	for (let j0 = 0; j0 < H; j0 += st)
		for (let i0 = 0; i0 < W; i0 += st) {
			const i = Math.min(W - 1, i0 + (st >> 1));
			const j = Math.min(H - 1, j0 + (st >> 1));
			const k = j * W + i;
			if (!hole[k]) continue;
			const u = (i + 0.5) / W;
			const v = (j + 0.5) / H;
			const d = rayDir(view.camera.pose, K, u, v, B);
			let range = view.range[k];
			let normal: number[] | null = null;
			if (range > 0) {
				// local DEM plane from the neighbours (central differences; one side at the border / sky edge)
				const kl = j * W + Math.max(0, i - st);
				const kr = j * W + Math.min(W - 1, i + st);
				const ku = Math.max(0, j - st) * W + i;
				const kd = Math.min(H - 1, j + st) * W + i;
				if (
					view.range[kl] > 0 &&
					view.range[kr] > 0 &&
					view.range[ku] > 0 &&
					view.range[kd] > 0
				) {
					const a = pt(kr).map((x, q) => x - pt(kl)[q]);
					const b = pt(kd).map((x, q) => x - pt(ku)[q]);
					const n = [
						a[1] * b[2] - a[2] * b[1],
						a[2] * b[0] - a[0] * b[2],
						a[0] * b[1] - a[1] * b[0],
					];
					const l = Math.hypot(n[0], n[1], n[2]);
					if (l > 1e-9) normal = n.map((x) => x / l);
				}
				stats.demBacked++;
			} else if (opts.mono && monoOn) {
				const m = opts.mono.depth;
				const mi = Math.min(m.width - 1, Math.floor(u * m.width));
				const mj = Math.min(m.height - 1, Math.floor(v * m.height));
				const mk = mj * m.width + mi;
				const z = m.depth[mk];
				const x = (u - K.cx) / K.fx;
				const y = (v - K.cy) / K.fy;
				const r = z * Math.sqrt(1 + x * x + y * y) * opts.mono.align.scale;
				const below = support > 0 ? demBelow(i, j) : Number.POSITIVE_INFINITY;
				if (
					m.valid[mk] &&
					r > 0 &&
					r <= monoMax &&
					Number.isFinite(r) &&
					below > 0 &&
					r <= below * 1.05
				) {
					range = r;
					stats.mono++;
				} else {
					stats.skipped++;
					continue;
				}
			} else {
				stats.skipped++;
				continue;
			}
			const rr = Math.max(0, range * (1 - toward) - 0.05);
			pos.push(eye[0] + d[0] * rr, eye[1] + d[1] * rr, eye[2] + d[2] * rr);
			const bw = Math.min(st, W - i0);
			const bh = Math.min(st, H - j0);
			const s = 0.5 * fp * range * (bw / W / K.fx + bh / H / K.fy);
			if (normal) {
				// the disc grows along the slope as the surface tilts away from the ray (capped at 3x)
				const cosT = Math.abs(
					normal[0] * d[0] + normal[1] * d[1] + normal[2] * d[2],
				);
				const g = Math.min(3, 1 / Math.max(1 / 3, cosT));
				const q = quatFromZ(normal[0], normal[1], normal[2]);
				scl.push(s * g, s * g, 0.1 * s);
				rot.push(q[0], q[1], q[2], q[3]);
			} else {
				scl.push(s, s, s);
				rot.push(1, 0, 0, 0);
			}
			// mean filled colour over the block
			let r = 0;
			let g = 0;
			let b = 0;
			let c = 0;
			for (let y = j0; y < j0 + bh; y++)
				for (let x = i0; x < i0 + bw; x++) {
					const o = 4 * (y * W + x);
					r += filled[o];
					g += filled[o + 1];
					b += filled[o + 2];
					c++;
				}
			col.push(Math.round(r / c), Math.round(g / c), Math.round(b / c), 255);
		}
	const count = pos.length / 3;
	return {
		cloud: {
			count,
			frame: "enu",
			positions: Float32Array.from(pos),
			scales: Float32Array.from(scl),
			rotations: Float32Array.from(rot),
			colors: Uint8Array.from(col),
			provenance: new Uint8Array(count).fill(prov),
		},
		stats,
	};
}

/** Concatenate ENU clouds (fresh arrays). `source` survives only if every part has it. */
export function mergeClouds(...parts: GaussianCloud[]): GaussianCloud {
	for (const p of parts)
		if (p.frame !== "enu" && p.count > 0)
			throw new Error("mergeClouds: expects ENU clouds");
	const n = parts.reduce((a, p) => a + p.count, 0);
	const out: GaussianCloud = {
		count: n,
		frame: "enu",
		positions: new Float32Array(3 * n),
		scales: new Float32Array(3 * n),
		rotations: new Float32Array(4 * n),
		colors: new Uint8Array(4 * n),
		provenance: new Uint8Array(n),
	};
	const withSource = parts.every((p) => p.source || p.count === 0);
	if (withSource) out.source = new Uint16Array(n);
	let o = 0;
	for (const p of parts) {
		const c = p.count;
		out.positions.set(p.positions.subarray(0, 3 * c), 3 * o);
		out.scales.set(p.scales.subarray(0, 3 * c), 3 * o);
		out.rotations.set(p.rotations.subarray(0, 4 * c), 4 * o);
		out.colors.set(p.colors.subarray(0, 4 * c), 4 * o);
		out.provenance.set(p.provenance.subarray(0, c), o);
		if (out.source && p.source) out.source.set(p.source.subarray(0, c), o);
		o += c;
	}
	return out;
}

// ---- small helpers ----

function medianOf(a: number[]): number {
	const s = Float64Array.from(a).sort();
	const m = s.length >> 1;
	return s.length & 1 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** Box dilation of a 0/1 mask by r px (separable running max). */
function boxDilate(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
	const tmp = new Uint8Array(W * H);
	for (let j = 0; j < H; j++) {
		// two passes: nearest set pixel to the left and to the right
		let prev = -1e9;
		for (let i = 0; i < W; i++) {
			if (m[j * W + i]) prev = i;
			if (i - prev <= r) tmp[j * W + i] = 1;
		}
		let next = 1e9;
		for (let i = W - 1; i >= 0; i--) {
			if (m[j * W + i]) next = i;
			if (next - i <= r) tmp[j * W + i] = 1;
		}
	}
	const out = new Uint8Array(W * H);
	for (let i = 0; i < W; i++) {
		let prev = -1e9;
		for (let j = 0; j < H; j++) {
			if (tmp[j * W + i]) prev = j;
			if (j - prev <= r) out[j * W + i] = 1;
		}
		let next = 1e9;
		for (let j = H - 1; j >= 0; j--) {
			if (tmp[j * W + i]) next = j;
			if (next - j <= r) out[j * W + i] = 1;
		}
	}
	return out;
}

/** Shortest-arc unit quaternion (w,x,y,z) rotating +z onto the unit vector (x,y,z) (sign-symmetric disc). */
function quatFromZ(
	x: number,
	y: number,
	z: number,
): [number, number, number, number] {
	if (z < 0) {
		x = -x;
		y = -y;
		z = -z;
	}
	const w = 1 + z;
	const l = Math.hypot(w, y, x);
	return [w / l, -y / l, x / l, 0];
}

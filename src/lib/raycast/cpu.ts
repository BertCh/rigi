// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Per-pixel heightfield ray caster, CPU reference (f64). FUND E5 (reports/fundamentals-plan.md F3).
 * Not wired into the app. The WGSL twin is ./gpu.ts + ./raycast.wgsl.ts; this file is the reference.
 *
 * Model (the app's: horizon-fast/march.ts, geo/horizon.ts, geodesy.ts REFRACTION_K):
 * a ray leaves the eye along a great-circle azimuth with apparent slope s = tan(elevation). At ground
 * distance d (arc length on EARTH_R) its height above the eye is  r(d) = s·d + c·d²,
 * c = (1 − k) / (2 R), i.e. curvature and refraction applied per ray. Terrain at (d, h) is hit when
 * h − h0 ≥ r(d); the march's t = (h − h0)/d − d·c ≥ s is the same statement.
 *
 * Traversal (Tevs / Dick style): the first hit along the ray, front to back, over the horizon-fast
 * Mercator ring mosaics and their exact-partition max mips. At each sample the largest mip block that
 * the ray provably clears (block max, incl. the bilinear footprint, below the ray's minimum height over
 * the block's exit span; r is a convex parabola so the minimum is closed form) is skipped. Samples sit
 * on a fixed lattice that does not depend on the skips, so mip skipping gives EXACTLY the brute-force
 * result (same first hit, same refinement): per octave [2^k, 2^(k+1)) of ground distance, n_k equal
 * steps, n_k = ceil(2^k / step(2^k)) with step(d) = max(stepFactor·d, clamp(nearFactor·d, 0.25 m,
 * cellSteps·cell of the ring serving 2^k)), the horizon-fast step rule. The hit is refined by
 * bisection between the lattice point before it (above terrain) and the hit sample.
 *
 * Path: the great circle is piecewise linear in Mercator pixels between breakpoints (ring boundaries
 * and chords whose sagitta is < segmentTolerance of the distance), exactly as the march. Breakpoint
 * offsets from the eye use cancellation-free forms (sin φ2 − sin φ1, 1 − cos D) so the GPU can do them
 * in f32 and the two stay twins.
 *
 * Outputs: per pixel hit range (m, Infinity = sky), ENU xyz of the hit in the eye's tangent frame (true
 * geometry, no refraction lift), the ground arc distance and the sky flag. Column mode: the top-most
 * terrain elevation angle per azimuth (a horizon profile), by bisection on the slope over the same
 * first-hit predicate.
 */
import { type Pose, poseBasis } from "../camera";
import { MIN_VALID } from "../dem";
import { DEG, EARTH_R, REFRACTION_K } from "../geodesy";
import { buildMips, type Mosaic, mercator } from "../horizon-fast/mosaic";

export interface RayEye {
	lat: number;
	lon: number;
	/** Eye height above MSL, metres. */
	h: number;
}

export interface RayCastOptions {
	/** Refraction coefficient (default REFRACTION_K = 0.13). */
	k?: number;
	/** Distance cap, metres (default 150 km, clipped to the last mosaic). */
	maxDistance?: number;
	/** First sample distance, metres (default 20, as the march). */
	minDistance?: number;
	stepFactor?: number;
	cellSteps?: number;
	nearFactor?: number;
	/** Max-mip block skipping (default on; off = brute force over the same lattice). */
	mipSkip?: boolean;
	segmentTolerance?: number;
	/** Bisection steps refining a hit (default 24). */
	refineIterations?: number;
	/** Bisection steps on the slope for column mode (default 28 over [-90°, 90°], 6.7e-7°). */
	columnIterations?: number;
}

export interface RaySceneRing {
	data: Float32Array;
	W: number;
	H: number;
	/** Mosaic worldPx. */
	sx: number;
	/** Eye position in the mosaic's pixel coordinates (pixel centres on integers), f64. */
	ue: number;
	ve: number;
	cell: number;
	mips: Float32Array[] | null;
	mipW: number[];
	mipH: number[];
	/** Cell size of the finest level, pixels. */
	S0: number;
	minLevel: number;
	mosaic: Mosaic;
}

export interface RayScene {
	eye: RayEye;
	h0: number;
	/** (1 − k) / (2 R) */
	c: number;
	minD: number;
	maxD: number;
	stepFactor: number;
	cellSteps: number;
	nearFactor: number;
	mipSkip: boolean;
	refineIterations: number;
	columnIterations: number;
	rings: RaySceneRing[];
	/** Breakpoints: distance, sin D, 1 − cos D, and the ring of segment [i, i + 1]. */
	segD: Float64Array;
	segSin: Float64Array;
	segOmc: Float64Array;
	segRing: Int32Array;
	sinP1: number;
	cosP1: number;
	/** Distance lattice: octave exponent k0 of octave 0, base 2^k, steps n and spacing base / n. */
	k0: number;
	octBase: Float64Array;
	octN: Int32Array;
	octSp: Float64Array;
	/** Per-trace outputs (last traceRay / refine). */
	hitD: number;
	hitH: number;
	/** Samples evaluated and blocks skipped by the traces so far. */
	samples: number;
	skips: number;
}

const INV_2PI = 1 / (2 * Math.PI);

/** Ring boundaries plus chords short enough that the great circle stays within tolerance (as march.ts). */
function buildSegments(
	mosaics: Mosaic[],
	lat: number,
	minD: number,
	maxD: number,
	eps: number,
) {
	const kappa =
		Math.max(0.05, Math.tan(Math.min(80, Math.abs(lat) + 3) * DEG)) / EARTH_R;
	const segD: number[] = [minD];
	const segRing: number[] = [];
	let d = minD;
	let ri = 0;
	while (d < maxD) {
		while (ri < mosaics.length - 1 && d >= mosaics[ri].maxDistance) ri++;
		const ringEnd = ri < mosaics.length - 1 ? mosaics[ri].maxDistance : maxD;
		const len = Math.max(200, Math.sqrt((8 * eps * d) / kappa));
		const next = Math.min(d + len, ringEnd, maxD);
		segRing.push(ri);
		segD.push(next);
		d = next;
	}
	return { segD, segRing };
}

/** Prepares everything the traces need for one eye over a mosaic set. */
export function makeRayScene(
	mosaics: Mosaic[],
	eye: RayEye,
	opts: RayCastOptions = {},
): RayScene {
	const k = opts.k ?? REFRACTION_K;
	const maxD = Math.min(
		opts.maxDistance ?? 150_000,
		mosaics[mosaics.length - 1].maxDistance,
	);
	const minD = opts.minDistance ?? 20;
	const stepFactor = opts.stepFactor ?? 3.5e-4;
	const cellSteps = opts.cellSteps ?? 0.5;
	const nearFactor = opts.nearFactor ?? 0.01;
	const mipSkip = opts.mipSkip ?? true;
	const m0 = mercator(eye.lon, eye.lat);
	const rings: RaySceneRing[] = mosaics.map((m) => {
		if (mipSkip && !m.mip) m.mip = buildMips(m);
		const mip = mipSkip ? m.mip : undefined;
		return {
			data: m.data,
			W: m.width,
			H: m.height,
			sx: m.worldPx,
			ue: m0.x * m.worldPx - 0.5 - m.x0,
			ve: m0.y * m.worldPx - 0.5 - m.y0,
			cell: m.cellMeters,
			mips: mip ? mip.mips : null,
			mipW: mip ? [...mip.widths] : [],
			mipH: mip ? [...mip.heights] : [],
			S0: mip ? 1 << mip.minLevel : 1,
			minLevel: mip ? mip.minLevel : 0,
			mosaic: m,
		};
	});
	const { segD, segRing } = buildSegments(
		mosaics,
		eye.lat,
		minD,
		maxD,
		opts.segmentTolerance ?? 2e-5,
	);
	const n = segD.length;
	const segSin = new Float64Array(n);
	const segOmc = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const a = segD[i] / EARTH_R;
		segSin[i] = Math.sin(a);
		const sh = Math.sin(a / 2);
		segOmc[i] = 2 * sh * sh;
	}
	// Distance lattice: octaves 2^k0 .. covering maxD.
	const k0 = Math.floor(Math.log2(minD));
	const octBase: number[] = [];
	const octN: number[] = [];
	const octSp: number[] = [];
	let ri = 0;
	for (let kk = k0; 2 ** kk < maxD; kk++) {
		const b = 2 ** kk;
		while (ri < mosaics.length - 1 && b >= mosaics[ri].maxDistance) ri++;
		const cs = rings[ri].cell * cellSteps;
		let sc = nearFactor * b;
		if (sc > cs) sc = cs;
		else if (sc < 0.25) sc = 0.25;
		const raw = Math.max(stepFactor * b, sc);
		const cnt = Math.max(1, Math.ceil(b / raw));
		octBase.push(b);
		octN.push(cnt);
		octSp.push(b / cnt);
	}
	return {
		eye,
		h0: eye.h,
		c: (1 - k) / (2 * EARTH_R),
		minD,
		maxD,
		stepFactor,
		cellSteps,
		nearFactor,
		mipSkip,
		refineIterations: opts.refineIterations ?? 24,
		columnIterations: opts.columnIterations ?? 28,
		rings,
		segD: Float64Array.from(segD),
		segSin,
		segOmc,
		segRing: Int32Array.from(segRing),
		sinP1: Math.sin(eye.lat * DEG),
		cosP1: Math.cos(eye.lat * DEG),
		k0,
		octBase: Float64Array.from(octBase),
		octN: Int32Array.from(octN),
		octSp: Float64Array.from(octSp),
		hitD: -1,
		hitH: 0,
		samples: 0,
		skips: 0,
	};
}

/** Lattice distance of (octave o, step j). */
const latticeD = (S: RayScene, o: number, j: number) =>
	S.octBase[o] + j * S.octSp[o];

/** Smallest lattice index with distance >= d, as [octave, step]; octave == nOct when past the table. */
function latticeCeil(S: RayScene, d: number, out: number[]) {
	const nOct = S.octBase.length;
	let o = 0;
	while (o + 1 < nOct && d >= S.octBase[o + 1]) o++;
	let j = Math.ceil((d - S.octBase[o]) / S.octSp[o]);
	if (j < 0) j = 0;
	if (j >= S.octN[o]) {
		o++;
		j = 0;
	}
	out[0] = o;
	out[1] = j;
}

/** Normalised Mercator offset of the great-circle point at (sin D, 1 − cos D) along azimuth (sinA, cosA). */
function breakpointOffset(
	S: RayScene,
	i: number,
	sinA: number,
	cosA: number,
	out: Float64Array,
	at: number,
) {
	const sinD = S.segSin[i];
	const omc = S.segOmc[i];
	const { sinP1, cosP1 } = S;
	const ds = cosP1 * sinD * cosA - sinP1 * omc; // sin φ2 − sin φ1
	const den = cosP1 * cosP1 - sinP1 * ds; // 1 − sin φ1 sin φ2
	const dl = Math.atan2(sinA * sinD * cosP1, den - omc);
	const dy = Math.atanh(ds / den);
	out[at] = dl * INV_2PI;
	out[at + 1] = -dy * INV_2PI;
}

/** Minimum of r(x) = s·x + c·x² over [a, b] (c > 0: convex). */
function minRay(s: number, c: number, a: number, b: number) {
	if (s < 0) {
		const xs = -s / (2 * c);
		if (xs > a && xs < b) return -(s * s) / (4 * c);
	}
	const ra = s * a + c * a * a;
	const rb = s * b + c * b * b;
	return ra < rb ? ra : rb;
}

const scratchIdx = [0, 0];
const scratchB = new Float64Array(4);

/**
 * First hit of the ray (azimuth sinA / cosA, apparent slope s). True when it hits terrain; the
 * ground arc distance and terrain height of the (refined) hit are then in scene.hitD / scene.hitH.
 * `refine` false skips the bisection (hitD is the first hit lattice distance): enough for
 * "does this slope hit".
 */
export function traceRay(
	S: RayScene,
	sinA: number,
	cosA: number,
	s: number,
	refine = true,
): boolean {
	const { h0, c, maxD, segD, segRing } = S;
	const nSeg = segRing.length;
	const mipSkip = S.mipSkip;
	latticeCeil(S, S.minD, scratchIdx);
	let o = scratchIdx[0];
	let j = scratchIdx[1];
	const o0 = o;
	const j0 = j;
	const nOct = S.octBase.length;
	let seg = -1;
	let dA = 0;
	let dB = Number.NEGATIVE_INFINITY;
	let uA = 0;
	let vA = 0;
	let du = 0;
	let dv = 0;
	let r: RaySceneRing = S.rings[0];
	let noTest = 0;
	let samples = 0;
	let skips = 0;
	const B = scratchB;
	let found = false;
	let hitIdxO = 0;
	let hitIdxJ = 0;
	while (o < nOct) {
		const d = latticeD(S, o, j);
		if (!(d < maxD)) break;
		if (d >= dB) {
			const prev = seg;
			while (seg + 1 < nSeg && d >= segD[seg + 1]) seg++;
			if (seg < 0) seg = 0;
			if (seg === prev + 1 && prev >= 0) {
				B[0] = B[2];
				B[1] = B[3];
			} else breakpointOffset(S, seg, sinA, cosA, B, 0);
			breakpointOffset(S, seg + 1, sinA, cosA, B, 2);
			r = S.rings[segRing[seg]];
			dA = segD[seg];
			dB = segD[seg + 1];
			const inv = 1 / (dB - dA);
			uA = r.ue + B[0] * r.sx;
			vA = r.ve + B[1] * r.sx;
			du = (B[2] - B[0]) * r.sx * inv;
			dv = (B[3] - B[1]) * r.sx * inv;
			noTest = 0;
		}
		const f = d - dA;
		const u = uA + f * du;
		const v = vA + f * dv;
		if (u >= 0 && v >= 0 && u < r.W - 1 && v < r.H - 1) {
			if (mipSkip && r.mips !== null && d >= noTest) {
				let Sz = r.S0;
				let skipTo = -1;
				const mips = r.mips;
				for (let L = 0; L < mips.length; L++) {
					const cu = Math.floor(u / Sz);
					const cv = Math.floor(v / Sz);
					const mw = r.mipW[L];
					const mh = r.mipH[L];
					if (cu >= mw || cv >= mh) break;
					const M = mips[L];
					const oo = cv * mw + cu;
					const cu1 = cu + 1 < mw;
					const cv1 = cv + 1 < mh;
					let Hm = M[oo];
					if (cu1 && M[oo + 1] > Hm) Hm = M[oo + 1];
					if (cv1) {
						if (M[oo + mw] > Hm) Hm = M[oo + mw];
						if (cu1 && M[oo + mw + 1] > Hm) Hm = M[oo + mw + 1];
					}
					const ex =
						du > 0
							? ((cu + 1) * Sz - u) / du
							: du < 0
								? (cu * Sz - u) / du
								: Number.POSITIVE_INFINITY;
					const ey =
						dv > 0
							? ((cv + 1) * Sz - v) / dv
							: dv < 0
								? (cv * Sz - v) / dv
								: Number.POSITIVE_INFINITY;
					const far = d + (ex < ey ? ex : ey);
					if (Hm - h0 < minRay(s, c, d, far)) {
						skipTo = far;
						Sz *= 2;
					} else {
						if (L === 0) noTest = far;
						break;
					}
				}
				if (skipTo >= 0) {
					if (skipTo > dB) skipTo = dB;
					skips++;
					latticeCeil(S, skipTo, scratchIdx);
					if (scratchIdx[0] > o || (scratchIdx[0] === o && scratchIdx[1] > j)) {
						o = scratchIdx[0];
						j = scratchIdx[1];
					} else if (++j >= S.octN[o]) {
						o++;
						j = 0;
					}
					continue;
				}
			}
			const x0 = u | 0;
			const y0 = v | 0;
			const fx = u - x0;
			const fy = v - y0;
			const i = y0 * r.W + x0;
			const a0 = r.data[i];
			const a1 = r.data[i + 1];
			const b0 = r.data[i + r.W];
			const b1 = r.data[i + r.W + 1];
			const h = a0 + (a1 - a0) * fx + (b0 - a0 + (a0 - a1 - b0 + b1) * fx) * fy;
			samples++;
			if (h > MIN_VALID && s * d + c * d * d <= h - h0) {
				found = true;
				hitIdxO = o;
				hitIdxJ = j;
				break;
			}
		}
		if (++j >= S.octN[o]) {
			o++;
			j = 0;
		}
	}
	S.samples += samples;
	S.skips += skips;
	if (!found) return false;
	const dHit = latticeD(S, hitIdxO, hitIdxJ);
	if (!refine || (hitIdxO === o0 && hitIdxJ === j0)) {
		S.hitD = dHit;
		S.hitH = heightAt(r, uA + (dHit - dA) * du, vA + (dHit - dA) * dv);
		return true;
	}
	// Lattice predecessor: above terrain (evaluated and not a hit, or skipped as hidden).
	let po = hitIdxO;
	let pj = hitIdxJ - 1;
	if (pj < 0) {
		po--;
		pj = S.octN[po] - 1;
	}
	let lo = Math.max(latticeD(S, po, pj), dA);
	let hi = dHit;
	for (let it = 0; it < S.refineIterations; it++) {
		const mid = 0.5 * (lo + hi);
		const fm = mid - dA;
		const h = heightAt(r, uA + fm * du, vA + fm * dv);
		if (h > MIN_VALID && s * mid + c * mid * mid <= h - h0) hi = mid;
		else lo = mid;
	}
	S.hitD = hi;
	S.hitH = heightAt(r, uA + (hi - dA) * du, vA + (hi - dA) * dv);
	return true;
}

/** Bilinear height at local pixel coordinates; NaN outside the window. */
function heightAt(r: RaySceneRing, u: number, v: number) {
	if (!(u >= 0 && v >= 0 && u < r.W - 1 && v < r.H - 1)) return Number.NaN;
	const x0 = u | 0;
	const y0 = v | 0;
	const fx = u - x0;
	const fy = v - y0;
	const i = y0 * r.W + x0;
	const a0 = r.data[i];
	const a1 = r.data[i + 1];
	const b0 = r.data[i + r.W];
	const b1 = r.data[i + r.W + 1];
	return a0 + (a1 - a0) * fx + (b0 - a0 + (a0 - a1 - b0 + b1) * fx) * fy;
}

/** The elevation (degrees) the bisection brackets: the horizon lies strictly inside. */
export const COLUMN_ELEVATION_LIMIT = 89.9999;

/**
 * Top-most terrain elevation angle (degrees) for one azimuth: the largest ray elevation that still
 * hits terrain, by bisection on the angle over the first-hit predicate. -90 when no terrain at all
 * (as computeHorizonFast).
 */
export function columnElevation(S: RayScene, azDeg: number): number {
	const sinA = Math.sin(azDeg * DEG);
	const cosA = Math.cos(azDeg * DEG);
	let lo = -COLUMN_ELEVATION_LIMIT;
	let hi = COLUMN_ELEVATION_LIMIT;
	if (!traceRay(S, sinA, cosA, Math.tan(lo * DEG), false)) return -90;
	for (let it = 0; it < S.columnIterations; it++) {
		const mid = 0.5 * (lo + hi);
		if (traceRay(S, sinA, cosA, Math.tan(mid * DEG), false)) lo = mid;
		else hi = mid;
	}
	return lo;
}

/** Horizon profile at azimuths i · step (degrees), elevations in degrees (-90 = no terrain). */
export function columnProfile(S: RayScene, step = 0.1, i0 = 0, i1?: number) {
	const n = Math.round(360 / step);
	const end = i1 ?? n;
	const elevation = new Float64Array(end - i0);
	for (let i = i0; i < end; i++)
		elevation[i - i0] = columnElevation(S, i * step);
	return { step, i0, elevation };
}

export interface RayCamera {
	pose: Pose;
	width: number;
	height: number;
}

/** ENU unit direction through the centre of pixel (x, y) (image y down). */
export function pixelDirection(
	cam: RayCamera,
	x: number,
	y: number,
	out: number[] = [0, 0, 0],
) {
	const { forward, right, up } = poseBasis(cam.pose);
	const t = Math.tan((cam.pose.vfov * DEG) / 2);
	const aspect = cam.width / cam.height;
	const px = (((x + 0.5) / cam.width) * 2 - 1) * t * aspect;
	const py = (1 - ((y + 0.5) / cam.height) * 2) * t;
	const dx = forward[0] + right[0] * px + up[0] * py;
	const dy = forward[1] + right[1] * px + up[1] * py;
	const dz = forward[2] + right[2] * px + up[2] * py;
	const inv = 1 / (Math.hypot(dx, dy, dz) || 1);
	out[0] = dx * inv;
	out[1] = dy * inv;
	out[2] = dz * inv;
	return out;
}

/** Largest |slope| of a pixel ray (a ray straight up or down). */
export const MAX_SLOPE = 1e6;

/** ENU (true geometry, eye tangent frame) of the terrain point at ground arc distance d, height h. */
export function hitEnu(
	S: RayScene,
	sinA: number,
	cosA: number,
	d: number,
	h: number,
	out: number[] = [0, 0, 0],
) {
	const ang = d / EARTH_R;
	const sh = Math.sin(ang / 2);
	const rho = (EARTH_R + h) * Math.sin(ang);
	out[0] = rho * sinA;
	out[1] = rho * cosA;
	out[2] = (h - S.h0) * Math.cos(ang) - 2 * (EARTH_R + S.h0) * sh * sh;
	return out;
}

/**
 * The apparent ray (azimuth, slope) that sees ENU point (e, n, u): the inverse of hitEnu followed by
 * the refraction model. For reprojection checks.
 */
export function enuToApparent(S: RayScene, e: number, n: number, u: number) {
	const rho = Math.hypot(e, n);
	const ang = Math.atan2(rho, EARTH_R + S.h0 + u);
	const d = EARTH_R * ang;
	const h = Math.hypot(rho, EARTH_R + S.h0 + u) - EARTH_R;
	return {
		sinA: e / rho,
		cosA: n / rho,
		d,
		h,
		slope: (h - S.h0) / d - d * S.c,
	};
}

export interface RayFrame {
	width: number;
	height: number;
	/** Pixel stride of this frame over the camera's full resolution (1 = every pixel). */
	stride: number;
	/** Straight-line range eye to hit, metres; Infinity = sky. */
	range: Float64Array;
	/** Ground arc distance, metres; Infinity = sky. */
	groundDistance: Float64Array;
	/** ENU xyz of the hit (3 per pixel); NaN = sky. */
	enu: Float64Array;
	sky: Uint8Array;
	ms: number;
	samples: number;
}

/**
 * Casts the camera's rays. `stride` > 1 renders every stride-th pixel (x and y, pixel centres of the
 * full-resolution frame) into a (width / stride) x (height / stride) frame.
 */
export function rayCastFrame(
	S: RayScene,
	cam: RayCamera,
	stride = 1,
): RayFrame {
	const t0 = performance.now();
	const w = Math.floor(cam.width / stride);
	const h = Math.floor(cam.height / stride);
	const range = new Float64Array(w * h).fill(Number.POSITIVE_INFINITY);
	const ground = new Float64Array(w * h).fill(Number.POSITIVE_INFINITY);
	const enu = new Float64Array(3 * w * h).fill(Number.NaN);
	const sky = new Uint8Array(w * h).fill(1);
	const dir = [0, 0, 0];
	const p = [0, 0, 0];
	const s0 = S.samples;
	for (let j = 0; j < h; j++)
		for (let i = 0; i < w; i++) {
			// the (stride >> 1)-th pixel of each stride x stride block (pixelDirection takes its centre)
			pixelDirection(
				cam,
				i * stride + (stride >> 1),
				j * stride + (stride >> 1),
				dir,
			);
			const rho = Math.hypot(dir[0], dir[1]);
			let sinA = 0;
			let cosA = 1;
			let slope: number;
			if (rho < 1e-12) slope = dir[2] > 0 ? MAX_SLOPE : -MAX_SLOPE;
			else {
				sinA = dir[0] / rho;
				cosA = dir[1] / rho;
				slope = Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, dir[2] / rho));
			}
			if (!traceRay(S, sinA, cosA, slope, true)) continue;
			const k = j * w + i;
			hitEnu(S, sinA, cosA, S.hitD, S.hitH, p);
			enu[3 * k] = p[0];
			enu[3 * k + 1] = p[1];
			enu[3 * k + 2] = p[2];
			range[k] = Math.hypot(p[0], p[1], p[2]);
			ground[k] = S.hitD;
			sky[k] = 0;
		}
	return {
		width: w,
		height: h,
		stride,
		range,
		groundDistance: ground,
		enu,
		sky,
		ms: performance.now() - t0,
		samples: S.samples - s0,
	};
}

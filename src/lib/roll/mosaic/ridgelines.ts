// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Viewpoint terrain for the panorama strip: the full 360° view from one eye, as depth-layered ridgelines
// (the homepage panorama's method, scripts/brand/rigi.ts, run live for any viewpoint). Every distance slab
// contributes the parts of its top edge that no nearer slab hides, so slopes read as range contours, and
// edges the ground falls away behind are flagged as ridges for a heavier stroke. Output is on the strip's
// canvas: x = true azimuth, y = elevation, degrees, in the eye's ENU frame (the frame poses live in).
// Pure: the worker (ridgelines.worker.ts) supplies the height sampler.
import { simplifyIndices } from "../../geo/simplify";
import {
	DEG,
	destination,
	distanceBearing,
	EARTH_R,
	EnuFrame,
	REFRACTION_K,
} from "../../geodesy";

/** Height at a point (m MSL), NaN where there is no data; `d` is its distance from the eye (picks a LOD). */
export type HeightAt = (lat: number, lon: number, d: number) => number;

export type RidgeOptions = {
	/** Azimuth step per column, degrees. */
	step?: number;
	/** Distance slabs (log-spaced between dMin and dMax). */
	slabs?: number;
	dMin?: number;
	dMax?: number;
	/** Slab edges lower than this (degrees) are dropped: the ground at your feet is noise. */
	elMin?: number;
	/** Douglas–Peucker tolerance, degrees. */
	tolerance?: number;
	/** Ground nearer than this (m) does not hide the cue ridges or peaks: a viewpoint's photos are up to
	 * 250 m apart, so what is underfoot at the centroid is not in front of every camera. */
	occludeFrom?: number;
	k?: number;
};

export type RidgePeak = {
	name: string;
	ele: number;
	/** ENU azimuth (0..360) and elevation of the summit, degrees. */
	az: number;
	el: number;
	/** Distance, metres. */
	d: number;
	/** Standing out from the ridge behind it by at least this much (degrees), for label ranking. */
	prominence: number | null;
};

export type RidgelinePeakInput = {
	name: string;
	lat: number;
	lon: number;
	ele: number;
	prominence?: number | null;
};

export type ViewpointTerrain = {
	eye: { lat: number; lon: number; h: number };
	/** Number of slabs (a stroke's depth is slab / (slabs − 1)); slab i starts at dMin·(dMax/dMin)^(i/slabs). */
	slabs: number;
	dMin: number;
	dMax: number;
	/** All stroke points (az, el) back to back; azimuths are unwrapped within a stroke. */
	pts: Float32Array;
	/** Stroke i spans points start[i] .. start[i + 1] (pairs); length = strokes + 1. */
	start: Uint32Array;
	/** Per stroke: slab index. */
	slab: Uint8Array;
	/** Per stroke: 1 = ridge (ground falls away behind), 0 = slope contour. */
	ridge: Uint8Array;
	/** Ridge strokes seen past the near ground (only terrain beyond `occludeFrom` hides them), for the
	 * match cue drawn over photos: same layout as pts/start/slab. */
	cuePts: Float32Array;
	cueStart: Uint32Array;
	cueSlab: Uint8Array;
	/** Skyline elevation per column (0..360 at `step`), ENU-ish (spherical) degrees; −90 = no terrain. */
	skyline: Float32Array;
	step: number;
	peaks: RidgePeak[];
};

/** Peaks closer than this (m) are the one underfoot, not a label. */
const MIN_PEAK_D = 60;

/** The trace's sampling schedule (shared by the CPU march below and the GPU kernel, gpu/horizon/ridges.ts). */
export function ridgeSchedule(o: RidgeOptions = {}) {
	const step = o.step ?? 0.1;
	const S = o.slabs ?? 56;
	const dMin = o.dMin ?? 40;
	const dMax = o.dMax ?? 120_000;
	const inv2R = (1 - (o.k ?? REFRACTION_K)) / (2 * EARTH_R);
	const cols = Math.round(360 / step);
	const edge = (i: number) => dMin * (dMax / dMin) ** (i / S);
	const dists: number[] = [];
	for (let d = dMin; d < dMax; d += Math.max(10, d * 0.004)) dists.push(d);
	const slabOf = new Uint8Array(dists.length);
	for (let i = 0, s = 0; i < dists.length; i++) {
		while (s < S - 1 && dists[i] >= edge(s + 1)) s++;
		slabOf[i] = s;
	}
	return { step, S, dMin, dMax, inv2R, cols, edge, dists, slabOf };
}

/** Per (slab, column): the top edge's elevation angle (degrees, −∞ = no data) and its distance, laid
 * out slab · cols + column. The CPU fills them from heightAt; the GPU path (gpu/horizon/ridges.ts) can
 * supply them to traceViewpoint instead. */
export type RidgeTops = { top: Float32Array; topD: Float32Array };

/** The CPU march: every sample distance along every column, one heightAt each (the GPU kernel's twin). */
export function ridgeTopsCpu(
	heightAt: HeightAt,
	eye: { lat: number; lon: number; h: number },
	o: RidgeOptions = {},
): RidgeTops {
	const { step, S, inv2R, cols, dists, slabOf } = ridgeSchedule(o);
	const angle = (h: number, d: number) =>
		Math.atan2(h - eye.h - d * d * inv2R, d) / DEG;
	const top = new Float32Array(S * cols).fill(Number.NEGATIVE_INFINITY);
	const topD = new Float32Array(S * cols);
	const φ1 = eye.lat * DEG;
	const λ1 = eye.lon * DEG;
	const sφ1 = Math.sin(φ1);
	const cφ1 = Math.cos(φ1);
	const sδ = dists.map((d) => Math.sin(d / EARTH_R));
	const cδ = dists.map((d) => Math.cos(d / EARTH_R));
	for (let c = 0; c < cols; c++) {
		const θ = c * step * DEG;
		const sθ = Math.sin(θ);
		const cθ = Math.cos(θ);
		for (let i = 0; i < dists.length; i++) {
			const sφ2 = sφ1 * cδ[i] + cφ1 * sδ[i] * cθ;
			const φ2 = Math.asin(sφ2);
			const λ2 = λ1 + Math.atan2(sθ * sδ[i] * cφ1, cδ[i] - sφ1 * sφ2);
			const h = heightAt(φ2 / DEG, λ2 / DEG, dists[i]);
			if (Number.isNaN(h)) continue;
			const a = angle(h, dists[i]);
			const k = slabOf[i] * cols + c;
			if (a > top[k]) {
				top[k] = a;
				topD[k] = dists[i];
			}
		}
	}
	return { top, topD };
}

export function traceViewpoint(
	heightAt: HeightAt,
	eye: { lat: number; lon: number; h: number },
	peaks: RidgelinePeakInput[] = [],
	o: RidgeOptions = {},
	/** Precomputed tops (the GPU's), else marched here from heightAt. heightAt still places the peaks. */
	tops?: RidgeTops,
): ViewpointTerrain {
	const { step, S, dMin, dMax, inv2R, cols, edge } = ridgeSchedule(o);
	const elMin = o.elMin ?? -40;
	const tol = o.tolerance ?? 0.012;
	const occludeFrom = o.occludeFrom ?? 250;
	const angle = (h: number, d: number) =>
		Math.atan2(h - eye.h - d * d * inv2R, d) / DEG;

	// top edge (and its distance) of every slab, per column
	const { top, topD } = tops ?? ridgeTopsCpu(heightAt, eye, o);

	// visible runs of each slab's top edge, hidden only by slabs from `fromSlab` on; the loop runs one
	// column past 360° so rings close
	type Run = { s: number; ridge: boolean; p: number[] };
	const EPS = 0.004;
	const traceRuns = (fromSlab: number, ridgesOnly: boolean) => {
		const runs: Run[] = [];
		const nearer = new Float32Array(cols).fill(Number.NEGATIVE_INFINITY);
		for (let s = 0; s < S; s++) {
			let run: Run | null = null;
			const flush = () => {
				if (run && run.p.length > 3 && (!ridgesOnly || run.ridge))
					runs.push(run);
				run = null;
			};
			for (let cc = 0; cc <= cols; cc++) {
				const c = cc % cols;
				const a = top[s * cols + c];
				const visible = a > nearer[c] + EPS && a > elMin;
				let behind = Number.NEGATIVE_INFINITY;
				for (let j = s + 1; j < Math.min(S, s + 4); j++)
					behind = Math.max(behind, top[j * cols + c]);
				const ridge = behind < a - 0.01;
				const pt = [cc * step, a, topD[s * cols + c]];
				if (!visible || (run && (run as Run).ridge !== ridge)) {
					if (run && visible) (run as Run).p.push(...pt); // join the class change
					flush();
				}
				if (visible) {
					run ??= { s, ridge, p: [] };
					(run as Run).p.push(...pt);
				}
			}
			flush();
			if (s >= fromSlab)
				for (let c = 0; c < cols; c++)
					nearer[c] = Math.max(nearer[c], top[s * cols + c]);
		}
		return { runs, skyline: nearer };
	};
	const main = traceRuns(0, false);
	let occluderSlab = 0;
	while (occluderSlab < S && edge(occluderSlab) < occludeFrom) occluderSlab++;
	const cue = traceRuns(occluderSlab, true);

	// simplify, then take each point to the eye's ENU frame (poses and the photo meshes use it; the march
	// above is spherical, off by up to ~0.1° in azimuth): back to its geographic point, then EnuFrame
	const frame = new EnuFrame(eye.lat, eye.lon, 0);
	const v = [0, 0, 0];
	const toEnu = (az: number, el: number, d: number): [number, number] => {
		const p = destination(eye.lat, eye.lon, az, d);
		frame.fromGeo(
			p.lat,
			p.lon,
			eye.h + d * (Math.tan(el * DEG) + d * inv2R),
			v,
		);
		const b = Math.atan2(v[0], v[1]) / DEG;
		return [
			az + ((((b - az) % 360) + 540) % 360) - 180,
			Math.atan2(v[2] - eye.h, Math.hypot(v[0], v[1])) / DEG,
		];
	};
	const pack = (runs: Run[]) => {
		const out: number[] = [];
		const start = [0];
		const slab: number[] = [];
		const ridge: number[] = [];
		for (const r of runs) {
			const keep = simplify(r.p, tol);
			if (keep.length < 2) continue;
			if (Math.abs(r.p[keep[keep.length - 1] * 3] - r.p[keep[0] * 3]) < 0.15)
				continue;
			for (const i of keep)
				out.push(...toEnu(r.p[i * 3], r.p[i * 3 + 1], r.p[i * 3 + 2]));
			start.push(out.length / 2);
			slab.push(r.s);
			ridge.push(r.ridge ? 1 : 0);
		}
		return {
			pts: new Float32Array(out),
			start: new Uint32Array(start),
			slab: new Uint8Array(slab),
			ridge: new Uint8Array(ridge),
		};
	};
	const strokes = pack(main.runs);
	const cueStrokes = pack(cue.runs);

	return {
		eye,
		slabs: S,
		dMin,
		dMax,
		...strokes,
		cuePts: cueStrokes.pts,
		cueStart: cueStrokes.start,
		cueSlab: cueStrokes.slab,
		skyline: main.skyline,
		step,
		peaks: visiblePeaks(
			peaks,
			heightAt,
			eye,
			top,
			cols,
			step,
			edge,
			occluderSlab,
			S,
			dMax,
			angle,
			toEnu,
		),
	};
}

/** Peaks on the skyline or clear of nearer terrain beyond the viewpoint's own ground (the brand panorama's test). */
function visiblePeaks(
	peaks: RidgelinePeakInput[],
	heightAt: HeightAt,
	eye: { lat: number; lon: number },
	top: Float32Array,
	cols: number,
	step: number,
	edge: (i: number) => number,
	occluderSlab: number,
	S: number,
	dMax: number,
	angle: (h: number, d: number) => number,
	toEnu: (az: number, el: number, d: number) => [number, number],
): RidgePeak[] {
	const out: RidgePeak[] = [];
	for (const p of peaks) {
		const { distance: d, bearing: az } = distanceBearing(
			eye.lat,
			eye.lon,
			p.lat,
			p.lon,
		);
		// nearer than this you are standing on it
		if (d < MIN_PEAK_D || d > dMax) continue;
		// DEM summit near the OSM node (nodes are often a few pixels off the true top); the search
		// shrinks for close peaks so it never reaches back to the eye's own slope
		const r = Math.min(60, d / 4);
		let h = Number.NEGATIVE_INFINITY;
		for (let dy = -r; dy <= r + 1e-6; dy += r / 2)
			for (let dx = -r; dx <= r + 1e-6; dx += r / 2) {
				const a = destination(p.lat, p.lon, 0, dy);
				const b = destination(a.lat, a.lon, 90, dx);
				const z = heightAt(b.lat, b.lon, d);
				if (z > h) h = z;
			}
		const el = angle(Math.max(h, p.ele), d);
		const c = Math.round(az / step);
		let block = Number.NEGATIVE_INFINITY;
		for (let s = occluderSlab; s < S && edge(s + 1) < d * 0.97; s++)
			for (let dc = -1; dc <= 1; dc++)
				block = Math.max(block, top[s * cols + ((c + dc + cols) % cols)]);
		if (el < block + 0.02) continue;
		const [eaz, eel] = toEnu(az, el, d);
		out.push({
			name: p.name,
			ele: Math.round(p.ele),
			az: ((eaz % 360) + 360) % 360,
			el: eel,
			d: Math.round(d),
			prominence: p.prominence ?? null,
		});
	}
	return out;
}

/** Douglas–Peucker over (az, el) of [az, el, d] triples; returns the kept point indices. */
function simplify(p: number[], tol: number): number[] {
	return simplifyIndices(
		p.length / 3,
		(i) => p[i * 3],
		(i) => p[i * 3 + 1],
		tol,
	);
}

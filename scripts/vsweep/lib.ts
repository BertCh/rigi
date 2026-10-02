// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// VSWEEP vertical pass (tools/research/vsweep/PROTOCOL.txt): after a horizontal stage has fixed yaw,
// sweep pitch alone against either every confident skyline column (dense) or matched skyline
// peaks / saddles (apex to apex). Pure; pixels on the camera's own basis.

import {
	azimuthElevation,
	type Camera,
	perturbCamera,
	project,
	unproject,
} from "../../src/lib/geo/camera";
import type { HorizonProfile } from "../../src/lib/geo/horizon";
import { horizonAt, projectSkylineRows } from "../../src/lib/geo/solve";
import { DEG } from "../../src/lib/geodesy";
import type { Vec3 } from "../../src/lib/linalg";
import { profilePeaks } from "../../src/lib/peakfix/peaks";

export type Skyline = { rows: Float32Array; weight: Float32Array };

export type Apex = { x: number; y: number; prom: number };
export type Kind = "peak" | "saddle";

export const VS_OPTS = {
	rangeDeg: 1.5,
	stepDeg: 0.01,
	truncPx: 6,
	// VS_PROM / VS_WINDOW: post-hoc amendment runs only (the frozen run used 6 / 40)
	minPromPx: Number(process.env.VS_PROM ?? 6),
	windowPx: Number(process.env.VS_WINDOW ?? 40),
	gatePx: 25,
	// A2 (post hoc): apex by a ±r least-squares quadratic; 0 = the frozen 3-point parabola
	apexRadius: Number(process.env.VS_APEX_R ?? 0),
	minMatches: 3,
	minWeight: 0.3,
};

/** Apexes of a row profile: peaks = local minima of y, saddles = local maxima of y. */
export function apexes(rows: ArrayLike<number>, kind: Kind, o = VS_OPTS) {
	const s = kind === "peak" ? -1 : 1;
	const vals = Float64Array.from(rows, (v) =>
		Number.isFinite(v) ? s * v : Number.NaN,
	);
	return profilePeaks(vals, {
		minProm: o.minPromPx,
		window: o.windowPx,
	}).map((p): Apex => {
		const fit = o.apexRadius > 0 ? quadApex(vals, p.i, o.apexRadius) : null;
		const at = fit ?? { i: p.i, value: p.value };
		return { x: at.i + 0.5, y: s * at.value, prom: p.prom };
	});
}

/**
 * Amendment A2: the apex as the vertex of a least-squares quadratic over ±r samples. The 3-point
 * parabola of profilePeaks sits on the noisiest sample (the extreme of a noisy profile is biased
 * by the noise itself: about −1σ on peaks, +1σ on saddles); averaging over the window removes most
 * of it. null when the fit is not a maximum or its vertex leaves the window's middle half.
 */
function quadApex(vals: Float64Array, i: number, r: number) {
	const c = Math.round(i);
	let n = 0;
	let s1 = 0;
	let s2 = 0;
	let s3 = 0;
	let s4 = 0;
	let sy = 0;
	let sty = 0;
	let stty = 0;
	for (let t = -r; t <= r; t++) {
		const v = vals[c + t];
		if (!Number.isFinite(v)) continue;
		n++;
		s1 += t;
		s2 += t * t;
		s3 += t * t * t;
		s4 += t * t * t * t;
		sy += v;
		sty += t * v;
		stty += t * t * v;
	}
	if (n < 5) return null;
	// normal equations for v = a + b t + q t²
	const m = [
		[n, s1, s2],
		[s1, s2, s3],
		[s2, s3, s4],
	];
	const rhs = [sy, sty, stty];
	const det3 = (a: number[][]) =>
		a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
		a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
		a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
	const det = det3(m);
	if (Math.abs(det) < 1e-9) return null;
	const col = (k: number) =>
		det3(m.map((row, j) => row.map((x, l) => (l === k ? rhs[j] : x)))) / det;
	const a = col(0);
	const b = col(1);
	const q = col(2);
	if (q >= 0) return null;
	const tv = -b / (2 * q);
	if (Math.abs(tv) > r / 2) return null;
	return { i: c + tv, value: a + b * tv + q * tv * tv };
}

export function photoRows(sky: Skyline, o = VS_OPTS) {
	return Float32Array.from(sky.rows, (y, x) =>
		sky.weight[x] >= o.minWeight ? y : Number.NaN,
	);
}

export type Match = { photo: Apex; dem: Apex; dir: Vec3; kind: Kind };

/** Mutual-nearest apex association (x only, within the gate). */
export function matchApexes(
	cam: Camera,
	sky: Skyline,
	horizon: HorizonProfile,
	kind: Kind,
	o = VS_OPTS,
): Match[] {
	const ph = apexes(photoRows(sky, o), kind, o);
	const dm = apexes(projectSkylineRows(cam, horizon, cam.width), kind, o);
	const near = (a: Apex, list: Apex[]) => {
		let best: Apex | undefined;
		for (const b of list)
			if (!best || Math.abs(b.x - a.x) < Math.abs(best.x - a.x)) best = b;
		return best && Math.abs(best.x - a.x) <= o.gatePx ? best : undefined;
	};
	const out: Match[] = [];
	for (const d of dm) {
		const p = near(d, ph);
		if (p && near(p, dm) === d)
			out.push({ photo: p, dem: d, dir: unproject(cam, d.x, d.y), kind });
	}
	return out;
}

/** Signed apex residuals (photo − DEM, px) at a camera. */
export function apexResiduals(cam: Camera, matches: Match[]) {
	return matches.map((m) => {
		const p = project(cam, m.dir);
		return p ? m.photo.y - p[1] : Number.NaN;
	});
}

/** Signed dense residuals (photo − DEM, px; > 0 = photo skyline lower than the DEM line). */
export function denseResiduals(
	cam: Camera,
	sky: Skyline,
	horizon: HorizonProfile,
	o = VS_OPTS,
) {
	const r: number[] = [];
	const w: number[] = [];
	for (let x = 0; x < sky.rows.length; x++) {
		const y = sky.rows[x];
		if (!Number.isFinite(y) || sky.weight[x] < o.minWeight) continue;
		const [az, el] = azimuthElevation(unproject(cam, x + 0.5, y));
		r.push((horizonAt(horizon, az) - el) * DEG * cam.f);
		w.push(sky.weight[x]);
	}
	return { r, w };
}

const truncCost = (r: number[], w: number[] | undefined, t: number) => {
	let s = 0;
	for (let i = 0; i < r.length; i++)
		if (Number.isFinite(r[i]))
			s += (w ? w[i] : 1) * Math.min(Math.abs(r[i]), t);
	return s;
};

export type SweepResult = {
	cam: Camera;
	dPitch: number;
	n: number;
	/** true when the arm fell back to the start (too few matches) */
	fallback: boolean;
	cost: number;
};

/** 1-D pitch sweep around `start`; ties keep the smallest |Δ|. */
function sweep(
	start: Camera,
	cost: (c: Camera) => number,
	o = VS_OPTS,
): { cam: Camera; dPitch: number; cost: number } {
	let best = { cam: start, dPitch: 0, cost: cost(start) };
	const n = Math.round(o.rangeDeg / o.stepDeg);
	for (let k = -n; k <= n; k++) {
		const dp = k * o.stepDeg;
		const c = perturbCamera(start, 0, dp);
		const v = cost(c);
		if (
			v < best.cost - 1e-9 ||
			(Math.abs(v - best.cost) <= 1e-9 && Math.abs(dp) < Math.abs(best.dPitch))
		)
			best = { cam: c, dPitch: dp, cost: v };
	}
	return best;
}

export function verticalDense(
	start: Camera,
	sky: Skyline,
	horizon: HorizonProfile,
	o = VS_OPTS,
): SweepResult {
	const n = denseResiduals(start, sky, horizon, o).r.length;
	const b = sweep(
		start,
		(c) => {
			const { r, w } = denseResiduals(c, sky, horizon, o);
			return truncCost(r, w, o.truncPx);
		},
		o,
	);
	return { ...b, n, fallback: false };
}

export function verticalApex(
	start: Camera,
	sky: Skyline,
	horizon: HorizonProfile,
	kinds: Kind[],
	o = VS_OPTS,
): SweepResult & { matches: Match[] } {
	const matches = kinds.flatMap((k) => matchApexes(start, sky, horizon, k, o));
	if (matches.length < o.minMatches)
		return {
			cam: start,
			dPitch: 0,
			n: matches.length,
			fallback: true,
			cost: Number.NaN,
			matches,
		};
	const b = sweep(
		start,
		(c) => truncCost(apexResiduals(c, matches), undefined, o.truncPx),
		o,
	);
	return { ...b, n: matches.length, fallback: false, matches };
}

// PEAKFIX peak detection (tools/research/peakfix/PROTOCOL.txt). One detector for both sides:
// local maxima of a 1D profile with windowed topographic prominence and parabolic sub-sample refinement.
// World side: the apparent skyline el(az) from an eye (EyeHorizon, 0.05° bins, −90 = no data), so the
// silhouette point is recomputed for every candidate eye. Photo side: the sky boundary y(x), peak = minimum y.

import type { EyeHorizon } from "../pose6dof/eye";

export type ProfilePeak = {
	/** Fractional sample index of the refined maximum. */
	i: number;
	/** Refined value at the maximum. */
	value: number;
	/** Drop to the higher of the two flanking minima inside the window (same units as the values). */
	prom: number;
};

export type PeakOpts = {
	/** Minimum prominence, value units. */
	minProm: number;
	/** Half-window (samples) for the prominence walk and the local-max test. */
	window: number;
	/** Minimum valid samples on each side (rejects peaks cut by the frame edge or a gap). */
	minSide?: number;
	/** Non-maximum suppression radius (samples). */
	nms?: number;
};

/** Local maxima of `vals` (NaN = gap). */
export function profilePeaks(
	vals: ArrayLike<number>,
	o: PeakOpts,
): ProfilePeak[] {
	const n = vals.length;
	const minSide = o.minSide ?? 4;
	const nms = o.nms ?? Math.max(2, Math.round(o.window / 4));
	const out: ProfilePeak[] = [];
	for (let i = 1; i < n - 1; i++) {
		const v = vals[i];
		if (!Number.isFinite(v)) continue;
		// local max over ±2 (first sample of a plateau wins)
		let isMax = true;
		for (let k = -2; k <= 2 && isMax; k++) {
			if (k === 0) continue;
			const w = vals[i + k];
			if (!Number.isFinite(w)) continue;
			if (w > v || (k < 0 && w === v)) isMax = false;
		}
		if (!isMax) continue;
		const side = (dir: -1 | 1) => {
			let lo = v;
			let valid = 0;
			for (let k = 1; k <= o.window; k++) {
				const j = i + dir * k;
				if (j < 0 || j >= n) break;
				const w = vals[j];
				if (!Number.isFinite(w)) break;
				valid++;
				if (w > v) break;
				if (w < lo) lo = w;
			}
			return { lo, valid };
		};
		const L = side(-1);
		const R = side(1);
		if (L.valid < minSide || R.valid < minSide) continue;
		const prom = v - Math.max(L.lo, R.lo);
		if (prom < o.minProm) continue;
		// parabola through i-1, i, i+1
		const a = vals[i - 1];
		const c = vals[i + 1];
		let di = 0;
		let val = v;
		if (Number.isFinite(a) && Number.isFinite(c)) {
			const den = a - 2 * v + c;
			if (den < 0) {
				di = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
				val = v - 0.25 * (a - c) * di;
			}
		}
		out.push({ i: i + di, value: val, prom });
	}
	out.sort((p, q) => q.prom - p.prom);
	const kept: ProfilePeak[] = [];
	for (const p of out)
		if (kept.every((k) => Math.abs(k.i - p.i) > nms)) kept.push(p);
	return kept.sort((p, q) => p.i - q.i);
}

export type WorldPeak = {
	/** Azimuth (deg, 0..360) and elevation (deg) of the apparent summit. */
	az: number;
	el: number;
	/** Horizontal distance to the silhouette point (m). */
	d: number;
	/** Prominence (deg) inside the window. */
	prom: number;
};

/** Apparent-skyline peaks of a horizon over the sector [a0, a1] (deg; a1 may exceed 360). */
export function horizonPeaks(
	hz: EyeHorizon,
	a0: number,
	a1: number,
	o: { minPromDeg: number; windowDeg: number },
): WorldPeak[] {
	const n = hz.elevation.length;
	const k0 = Math.ceil(a0 / hz.step);
	const k1 = Math.floor(a1 / hz.step);
	const vals = new Float64Array(k1 - k0 + 1);
	for (let k = k0; k <= k1; k++) {
		const e = hz.elevation[((k % n) + n) % n];
		vals[k - k0] = e > -89 ? e : Number.NaN;
	}
	const win = Math.max(3, Math.round(o.windowDeg / hz.step));
	return profilePeaks(vals, { minProm: o.minPromDeg, window: win }).map((p) => {
		const k = Math.round(p.i) + k0;
		const az = (((p.i + k0) * hz.step) % 360 + 360) % 360;
		return {
			az,
			el: p.value,
			d: hz.distance ? hz.distance[((k % n) + n) % n] : Number.NaN,
			prom: p.prom,
		};
	});
}

export type ImgPeak = { x: number; y: number; prom: number };

/**
 * Sky-boundary peaks from regularly spaced samples (px; x ascending, `dx` apart where present).
 * Gaps (missing columns) break the prominence walk.
 */
export function skylinePeaks(
	samples: { x: number; y: number }[],
	dx: number,
	o: { minPromPx: number; windowPx: number },
): ImgPeak[] {
	if (!samples.length) return [];
	const x0 = samples[0].x;
	const n = Math.round((samples[samples.length - 1].x - x0) / dx) + 1;
	const vals = new Float64Array(n).fill(Number.NaN);
	for (const s of samples) vals[Math.round((s.x - x0) / dx)] = -s.y;
	const win = Math.max(3, Math.round(o.windowPx / dx));
	return profilePeaks(vals, {
		minProm: o.minPromPx,
		window: win,
		minSide: Math.max(3, Math.round(win / 3)),
	}).map((p) => ({ x: x0 + p.i * dx, y: -p.value, prom: p.prom }));
}

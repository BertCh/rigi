// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The f64 skyline-direction stage of the horizon-fast-app worker (dataflow D8), moved here verbatim so
// the worker, the certified-f32 tie path (./certified.ts) and the node check share one copy. This is
// the reference: every expression is the one the worker ran before the move (2026-10-01), so the
// worker's output is bit-identical.
//
//   const dirs = skylineDirsF64(prof, { lat, lon, k }, eyeH);   // the worker's `dirs`
//
// Per sample: the march's (elevation f32, distance f32) goes back to its geographic point (great
// circle), through EnuFrame.fromGeo (WGS84, k = 0.13 refraction lift) to an ENU (azimuth, elevation) in
// f64. Per column of GPU_COLUMNS: the profile linearly interpolated at the column azimuth, written as a
// unit direction (f32). Columns whose bracketing samples hit no terrain are skipped (compacted).
// SkylineF64 is the same computation, lazily per sample and per column (the certified path recomputes
// only the columns it could not certify).
import { destination, EARTH_R, EnuFrame } from "#/lib/geodesy";

/**
 * Azimuths of the columns the old GPU horizon read back: 8 perspective renders, 1024 columns over 50° each,
 * every 45°. align.scorePose averages over the projected directions, so this density (denser towards each
 * render's edges, doubled in the 5° overlaps) is part of what autoAlign was tuned on.
 */
export const GPU_COLUMNS: readonly number[] = (() => {
	const out: number[] = [];
	const t = Math.tan((25 * Math.PI) / 180);
	for (let r = 0; r < 8; r++)
		for (let x = 0; x < 1024; x++)
			out.push(
				(r * 45 +
					(Math.atan((((x + 0.5) / 1024) * 2 - 1) * t) * 180) / Math.PI +
					360) %
					360,
			);
	return out;
})();

/** What the stage reads from the marched profile. */
export type SkylineProfile = {
	step: number;
	i0: number;
	elevation: Float32Array;
	distance: Float32Array;
};

/** The job's geometry: eye lat/lon (the ENU frame's origin, at height 0) and the refraction k. */
export type SkylineJob = { lat: number; lon: number; k: number };

/**
 * Lazy f64 skyline: sample(i) and column(c) give exactly what skylineDirsF64 computes for that sample
 * or column (same expressions, same order).
 */
export class SkylineF64 {
	readonly n: number;
	readonly az: Float64Array;
	readonly el: Float64Array;
	private readonly done: Uint8Array;
	private readonly frame: EnuFrame;
	private readonly inv2R: number;
	private readonly v = [0, 0, 0];

	constructor(
		readonly prof: SkylineProfile,
		readonly job: SkylineJob,
		readonly eyeH: number,
	) {
		this.n = prof.elevation.length;
		this.frame = new EnuFrame(job.lat, job.lon, 0);
		this.inv2R = (1 - job.k) / (2 * EARTH_R);
		this.az = new Float64Array(this.n); // ENU azimuth, unwrapped to within ±180° of the march azimuth (in practice < 0.1°)
		this.el = new Float64Array(this.n); // ENU elevation, NaN where the ray found no terrain
		this.done = new Uint8Array(this.n);
	}

	/** Computes sample i's ENU azimuth / elevation (once). */
	sample(i: number) {
		if (this.done[i]) return;
		this.done[i] = 1;
		const { prof, job, eyeH, az, el } = this;
		const frame = this.frame;
		const inv2R = this.inv2R;
		const v = this.v;
		const D = Math.PI / 180;
		const a = (prof.i0 + i) * prof.step;
		const d = prof.distance[i];
		const e0 = prof.elevation[i];
		if (!(e0 > -90) || !(d > 0)) {
			az[i] = a;
			el[i] = Number.NaN;
			return;
		}
		const p = destination(job.lat, job.lon, a, d);
		frame.fromGeo(p.lat, p.lon, eyeH + d * (Math.tan(e0 * D) + d * inv2R), v);
		const z = v[2] - eyeH;
		const b = Math.atan2(v[0], v[1]) / D;
		az[i] = a + ((((b - a) % 360) + 540) % 360) - 180;
		el[i] = Math.atan2(z, Math.hypot(v[0], v[1])) / D;
	}

	/** az of profile index m (any integer; wraps with ±360° per turn), computing the sample if needed. */
	private at(m: number) {
		const n = this.n;
		const j = ((m % n) + n) % n;
		this.sample(j);
		return this.az[j] + Math.floor(m / n) * 360;
	}

	/**
	 * Column azimuth c (degrees): writes its unit direction to out[o..o+2] and returns true, or returns
	 * false when the bracketing samples hit no terrain (the column is skipped).
	 */
	column(c: number, out: Float32Array, o: number): boolean {
		const { n, el } = this;
		const step = this.prof.step;
		const D = Math.PI / 180;
		let i = Math.floor(c / step);
		while (this.at(i) > c) i--;
		while (this.at(i + 1) <= c) i++;
		const j0 = ((i % n) + n) % n;
		const j1 = (((i + 1) % n) + n) % n;
		this.sample(j0);
		this.sample(j1);
		const e0 = el[j0];
		const e1 = el[j1];
		if (Number.isNaN(e0) || Number.isNaN(e1)) return false;
		const t = Math.min(
			Math.max(
				(c - this.at(i)) / Math.max(this.at(i + 1) - this.at(i), 1e-9),
				0,
			),
			1,
		);
		const e = (e0 + (e1 - e0) * t) * D;
		out[o] = Math.sin(c * D) * Math.cos(e);
		out[o + 1] = Math.cos(c * D) * Math.cos(e);
		out[o + 2] = Math.sin(e);
		return true;
	}
}

/**
 * ENU unit directions (x east, y north, z up) in the engine's frame, 3 floats per kept column of
 * GPU_COLUMNS. horizon-fast marches a sphere; the engine's frame is WGS84 (EnuFrame, with the same
 * k = 0.13 refraction lift), whose azimuths differ by up to ~0.09° (M ≠ N). So each skyline sample goes
 * back to its geographic point (the lat/lon horizon-fast sampled, the DEM height it found) and through
 * EnuFrame.fromGeo, exactly as the terrain mesh vertices the GPU horizon rendered.
 */
export function skylineDirsF64(
	prof: SkylineProfile,
	job: SkylineJob,
	eyeH: number,
): Float32Array {
	const s = new SkylineF64(prof, job, eyeH);
	for (let i = 0; i < s.n; i++) s.sample(i);
	// the profile, linearly interpolated at the GPU horizon's column azimuths (n samples cover 360°)
	const out = new Float32Array(GPU_COLUMNS.length * 3);
	let k = 0;
	for (const c of GPU_COLUMNS) if (s.column(c, out, k)) k += 3;
	return out.slice(0, k);
}

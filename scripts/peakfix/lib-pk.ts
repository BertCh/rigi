// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// PEAKFIX eval helpers. sectorHorizonFrom = scripts/geocam/lib.ts sectorHorizon with a near cut (PROTOCOL A1:
// terrain nearer than dMin does not count), same step rule max(10, 0.004·d), curvature + refraction.
import type { Vec3 } from "../../src/lib/concord/core";
import { offsetLatLon } from "../../src/lib/concord/priors/ground";
import { destination } from "../../src/lib/geodesy";
import type { EyeHorizon } from "../../src/lib/pose6dof/eye";
import { type FastSampler, HZ_STEP, R_EFF, type Scene } from "../geocam/lib";

export const D_MIN = 150;
const DEG = Math.PI / 180;

type RayTable = {
	k0: number;
	nAz: number;
	ds: Float64Array;
	lat: Float64Array;
	lon: Float64Array;
};
const memo = new Map<string, RayTable>();
function rays(s: Scene, a0: number, a1: number, dMin: number): RayTable {
	const key = `${s.photo}_${a0}_${a1}_${dMin}`;
	let r = memo.get(key);
	if (!r) {
		memo.clear();
		const dl: number[] = [];
		for (let d = dMin; d <= 150_000; d += Math.max(10, d * 0.004)) dl.push(d);
		const k0 = Math.ceil(a0 / HZ_STEP);
		const nAz = Math.floor(a1 / HZ_STEP) - k0 + 1;
		const lat = new Float64Array(nAz * dl.length);
		const lon = new Float64Array(nAz * dl.length);
		for (let k = 0; k < nAz; k++)
			for (let j = 0; j < dl.length; j++) {
				const p = destination(s.lat, s.lon, (k0 + k) * HZ_STEP, dl[j]);
				lat[k * dl.length + j] = p.lat;
				lon[k * dl.length + j] = p.lon;
			}
		r = { k0, nAz, ds: Float64Array.from(dl), lat, lon };
		memo.set(key, r);
	}
	return r;
}

export function sectorHorizonFrom(
	s: Scene,
	fs_: FastSampler,
	eye: Vec3,
	a0: number,
	a1: number,
	dMin = D_MIN,
): EyeHorizon {
	const n = Math.round(360 / HZ_STEP);
	const elevation = new Float32Array(n).fill(-90);
	const distance = new Float32Array(n);
	const R = rays(s, a0, a1, dMin);
	const p0 = offsetLatLon(s.lat, s.lon, eye[0], eye[1]);
	const dLat = p0.lat - s.lat;
	const dLon = p0.lon - s.lon;
	const eyeAlt = s.eyeAlt + eye[2];
	const nd = R.ds.length;
	for (let k = 0; k < R.nAz; k++) {
		const i = (((R.k0 + k) % n) + n) % n;
		let best = -90;
		let bestD = 0;
		for (let j = 0; j < nd; j++) {
			const d = R.ds[j];
			const h = fs_.sampleAt(
				R.lon[k * nd + j] + dLon,
				R.lat[k * nd + j] + dLat,
				d,
			);
			if (Number.isNaN(h)) continue;
			const a = Math.atan2(h - eyeAlt - (d * d) / (2 * R_EFF), d) / DEG;
			if (a > best) {
				best = a;
				bestD = d;
			}
		}
		elevation[i] = best;
		distance[i] = bestD;
	}
	return { step: HZ_STEP, elevation, distance };
}

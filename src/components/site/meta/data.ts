// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Data for the "under the hood" visuals, baked by scripts/meta/bake.ts from the demo roll
// (public/demo/meta/). The camera math is the how-it-works scene's inlined pinhole
// (src/components/site/how/model.ts), so these pages do not pull in the pipeline either.

import { useEffect, useState } from "react";
import {
	type Angles,
	azEl,
	type Cam,
	camera,
	type Obs,
} from "#/components/site/how/model";
import { publicUrl } from "#/lib/public-url";

export type RollPhoto = {
	id: string;
	photo: string;
	thumb: string;
	width: number;
	height: number;
	takenAt: string;
	lat: number;
	lon: number;
	gpsAlt: number;
	hAccuracy: number;
	ground: number;
	eye: number;
	prior: Angles;
	solved: Angles;
	/** The fail-closed verdict of the CPU solve cascade (public/demo/gipfelbuch/index.json). */
	accepted: boolean;
	stage: string | null;
	confidence: number | null;
	rejectReason: string | null;
	inlierFraction: number | null;
	ambiguity: number | null;
	/** Photo skyline: rows as a fraction of the image height, COLS columns evenly across. */
	skyline: { rows: (number | null)[]; weight: number[] };
	/** Full 360° DEM skyline from the eye: elevation (deg) and distance (m), from azimuth 0. */
	horizon: { step: number; elevation: number[]; distance: number[] };
};

export type Roll = {
	generated: string;
	place: string;
	dem: string;
	photos: RollPhoto[];
};

export type Section = {
	az: number;
	skyline: { el: number; d: number };
	/** Inner silhouettes along this bearing, nearest first. */
	ridges: { el: number; d: number }[];
	/** [distance m, height m] with the curvature + refraction drop already subtracted. */
	points: [number, number][];
};

export type Hero = {
	id: string;
	photo: string;
	/** Working size of the depth grid's camera (800 wide). */
	width: number;
	height: number;
	lat: number;
	lon: number;
	eye: number;
	solved: Angles;
	hfov: number;
	/** Per 0.25° from az0: [elevation deg, distance m] crests, nearest first, the skyline last. */
	ridges: { az0: number; step: number; crests: [number, number][][] };
	/** One side section per whole degree across the view. */
	sections: Section[];
	/** Distance (m) from the eye to the terrain per cell at the solved pose; 0 = sky. Row-major. */
	depth: { w: number; h: number; metres: number[] };
	/** Hillshade, north up, centred on the camera, ±halfKm. */
	map: { src: string; halfKm: number; px: number; min: number; max: number };
};

function useJson<T>(url: string) {
	const [v, setV] = useState<T | null>(null);
	useEffect(() => {
		let live = true;
		fetch(url)
			.then((r) => (r.ok ? (r.json() as Promise<T>) : null))
			.then((x) => live && setV(x))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [url]);
	return v;
}

export const useRoll = () => useJson<Roll>(publicUrl("/demo/meta/roll.json"));
export const useHero = () => useJson<Hero>(publicUrl("/demo/meta/hero.json"));

import { wrap180, wrap360 } from "#/lib/geodesy";

export { wrap180, wrap360 };

/** DEM skyline elevation (deg) at any azimuth, linearly interpolated round the full circle. */
export function horizonEl(p: RollPhoto, az: number) {
	const { step, elevation } = p.horizon;
	const n = elevation.length;
	const t = wrap360(az) / step;
	const i = Math.floor(t);
	const a = elevation[i % n];
	const b = elevation[(i + 1) % n];
	return a + (b - a) * (t - i);
}

export function horizonDist(p: RollPhoto, az: number) {
	const { step, distance } = p.horizon;
	return distance[Math.round(wrap360(az) / step) % distance.length];
}

/** Confident photo-skyline columns in full-size image pixels. */
export function rollObservations(p: RollPhoto): Obs[] {
	const { rows, weight } = p.skyline;
	const n = rows.length;
	const out: Obs[] = [];
	rows.forEach((r, i) => {
		if (r !== null && weight[i] > 0.05)
			out.push({ x: ((i + 0.5) / n) * p.width, y: r * p.height, w: weight[i] });
	});
	return out;
}

/** Robust mismatch (px at full size) of the photo skyline against the 360° DEM skyline. */
export function rollMismatch(p: RollPhoto, cam: Cam, obs: Obs[], cap = 60) {
	let sum = 0;
	let wsum = 0;
	for (const o of obs) {
		const [az, el] = azEl(cam, o.x, o.y);
		const r = (el - horizonEl(p, az)) * (Math.PI / 180) * cam.f;
		sum += Math.min(Math.abs(r), cap) * o.w;
		wsum += o.w;
	}
	return wsum ? sum / wsum : cap;
}

/**
 * The coarse search, run round the whole circle: for each yaw the best mismatch over a narrow
 * pitch band around the phone's tilt (gravity is good, the compass is not).
 */
export function fullSweep(
	p: RollPhoto,
	step = 1,
	pitchHalf = 2,
	pitchStep = 0.5,
) {
	const obs = rollObservations(p);
	const out: { yaw: number; pitch: number; cost: number }[] = [];
	for (let yaw = 0; yaw < 360; yaw += step) {
		let best = { yaw, pitch: p.prior.pitch, cost: Number.POSITIVE_INFINITY };
		for (let dp = -pitchHalf; dp <= pitchHalf + 1e-9; dp += pitchStep) {
			const pitch = p.prior.pitch + dp;
			const cam = camera({ ...p.prior, yaw, pitch }, p.width, p.height);
			const cost = rollMismatch(p, cam, obs);
			if (cost < best.cost) best = { yaw, pitch, cost };
		}
		out.push(best);
	}
	return out;
}

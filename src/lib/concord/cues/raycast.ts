// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU ray cast of a DEM into photo space (GeomBuffer), for cue extraction without a GPU render.
//
// Per azimuth bin (step azStepDeg) a height profile is sampled along the ground track from the eye at
// geometrically growing distances; t(d) = (z(d) − z_eye)/d is the tangent of the elevation angle of
// the terrain sample and its prefix maximum tells, for any ray elevation, the first sample that the ray
// dips under (binary search). The hit distance is refined linearly between the bracketing samples.
// Rays use the pixel's own azimuth for the returned xyz, so projectX(cam, xyz) returns the pixel
// centre up to the bin quantisation of the height lookup (≤ azStepDeg/2).
//
// Heights are in the caller's scene frame (e.g. scripts/concord/lib.ts: z = alt − alt0 − d²/2R_eff,
// the curvature + refraction drop folded in), so straight rays in that frame match projectX.
import { type CameraX, unprojectDirX, type Vec3 } from "../core";
import type { GeomBuffer, RayHit } from "./types";

/** Scene-frame z at ENU (e, n); d = horizontal distance from the eye (for DEM level choice). NaN ⇒ no data. */
export type HeightFn = (e: number, n: number, d: number) => number;

export type CastOpts = {
	/** Azimuth bin (deg). Default 0.025°. */
	azStepDeg?: number;
	/** First / last sample distance (m). Defaults 15 m / 150 km. */
	minD?: number;
	maxD?: number;
	/** Sample spacing = max(minStep, growth·d). Defaults 3 m, 0.0035. */
	minStep?: number;
	growth?: number;
	/** Absolute-altitude convention of the frame (copied to GeomBuffer.frame). */
	frame?: { alt0: number; rEff: number };
};

type Profile = { t: Float32Array; pm: Float32Array };

/** Cast one ray per pixel of a w×h grid at `cam`. */
export function buildGeomBuffer(
	cam: CameraX,
	w: number,
	h: number,
	height: HeightFn,
	opts: CastOpts = {},
): GeomBuffer & { stats: { bins: number; samples: number; ms: number } } {
	const t0 = Date.now();
	const step = ((opts.azStepDeg ?? 0.025) * Math.PI) / 180;
	const minD = opts.minD ?? 15;
	const maxD = opts.maxD ?? 150_000;
	const minStep = opts.minStep ?? 3;
	const growth = opts.growth ?? 0.0035;
	const ds: number[] = [];
	for (let d = minD; d < maxD; d += Math.max(minStep, d * growth)) ds.push(d);
	const nd = ds.length;
	const eye = cam.eye;
	const yaw = (cam.pose.yaw * Math.PI) / 180;
	const wrap = (a: number) => {
		let r = (a - yaw) % (2 * Math.PI);
		if (r > Math.PI) r -= 2 * Math.PI;
		if (r <= -Math.PI) r += 2 * Math.PI;
		return r;
	};

	// ray directions → relative azimuth + tan(elevation)
	const N = w * h;
	const rel = new Float64Array(N);
	const tanEl = new Float64Array(N);
	let relMin = Infinity;
	let relMax = -Infinity;
	for (let j = 0; j < h; j++)
		for (let i = 0; i < w; i++) {
			const k = j * w + i;
			const d = unprojectDirX(cam, (i + 0.5) / w, (j + 0.5) / h);
			const hn = Math.hypot(d[0], d[1]);
			rel[k] = wrap(Math.atan2(d[0], d[1]));
			tanEl[k] = hn > 1e-9 ? d[2] / hn : Math.sign(d[2]) * 1e9;
			if (rel[k] < relMin) relMin = rel[k];
			if (rel[k] > relMax) relMax = rel[k];
		}
	// margin so cast() can refine slightly outside the frame
	relMin -= 4 * step;
	relMax += 4 * step;
	const nb = Math.max(1, Math.ceil((relMax - relMin) / step) + 1);
	const profiles: (Profile | null)[] = new Array(nb).fill(null);
	let samples = 0;
	const profile = (b: number): Profile => {
		let p = profiles[b];
		if (p) return p;
		const az = yaw + relMin + b * step;
		const s = Math.sin(az);
		const c = Math.cos(az);
		const t = new Float32Array(nd);
		const pm = new Float32Array(nd);
		let m = -Infinity;
		for (let q = 0; q < nd; q++) {
			const d = ds[q];
			const z = height(eye[0] + d * s, eye[1] + d * c, d);
			const tv = Number.isFinite(z) ? (z - eye[2]) / d : -Infinity;
			t[q] = tv;
			if (tv > m) m = tv;
			pm[q] = m;
		}
		samples += nd;
		p = { t, pm };
		profiles[b] = p;
		return p;
	};
	const binOf = (r: number) =>
		Math.min(nb - 1, Math.max(0, Math.round((r - relMin) / step)));

	/** Horizontal hit distance along bin b for elevation tangent te; NaN ⇒ sky. */
	const hitD = (b: number, te: number): number => {
		const { t, pm } = profile(b);
		if (!(pm[nd - 1] >= te)) return Number.NaN;
		let lo = 0;
		let hi = nd - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (pm[mid] >= te) hi = mid;
			else lo = mid + 1;
		}
		if (lo === 0) return ds[0];
		const d0 = ds[lo - 1];
		const d1 = ds[lo];
		const f0 = (t[lo - 1] - te) * d0;
		const f1 = (t[lo] - te) * d1;
		if (!Number.isFinite(f0) || f1 - f0 <= 0) return d1;
		return d0 + ((d1 - d0) * -f0) / (f1 - f0);
	};

	const xyz = new Float32Array(N * 3);
	const range = new Float32Array(N);
	const sky = new Uint8Array(N);
	for (let k = 0; k < N; k++) {
		const d = hitD(binOf(rel[k]), tanEl[k]);
		if (Number.isNaN(d)) {
			sky[k] = 1;
			range[k] = Infinity;
			xyz[3 * k] = xyz[3 * k + 1] = xyz[3 * k + 2] = Number.NaN;
			continue;
		}
		const az = yaw + rel[k];
		xyz[3 * k] = eye[0] + d * Math.sin(az);
		xyz[3 * k + 1] = eye[1] + d * Math.cos(az);
		xyz[3 * k + 2] = eye[2] + d * tanEl[k];
		range[k] = d * Math.sqrt(1 + tanEl[k] * tanEl[k]);
	}

	const cast = (u: number, v: number): RayHit | null => {
		const dir = unprojectDirX(cam, u, v);
		const hn = Math.hypot(dir[0], dir[1]);
		if (hn < 1e-9) return null;
		const r = wrap(Math.atan2(dir[0], dir[1]));
		const te = dir[2] / hn;
		const d = hitD(binOf(r), te);
		if (Number.isNaN(d)) return null;
		const az = yaw + r;
		const world: Vec3 = [
			eye[0] + d * Math.sin(az),
			eye[1] + d * Math.cos(az),
			eye[2] + d * te,
		];
		return { d, range: d * Math.sqrt(1 + te * te), world };
	};

	return {
		w,
		h,
		xyz,
		range,
		sky,
		eye: [eye[0], eye[1], eye[2]],
		frame: opts.frame,
		cast,
		stats: { bins: nb, samples, ms: Date.now() - t0 },
	};
}

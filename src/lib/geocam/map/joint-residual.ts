// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Cue residual primitives the MAP solver's factors are built on. Moved verbatim from the concord joint
// solver (src/lib/concord/solve/joint.ts, WP-D), which was removed on 2026-09-30 as a negative result
// (reports/negative-results.md); only the pieces geocam uses are kept. JOINT_DEFAULTS keeps the joint
// solver's values for the fields the factors read.

import { wrap360 } from "#/lib/geodesy";
import {
	type CameraX,
	type Cue,
	projectX,
	unprojectDirX,
	type Vec3,
} from "../../concord/core";
import { DEG as D } from "../../geodesy";
import type { EyeHorizon } from "../../pose6dof/eye";

/**
 * A cue as the factors consume it. `residualPx` (WP-C MatchedCue) is only read for "edge" cues: their
 * (u, v) is the PREDICTED contour point at extraction and the observed edge is (u, v) − residualPx·n
 * (px @1600). Point, level and shore cues carry the OBSERVED pixel in (u, v). `world` is read for level
 * and shore cues when present (WP-C WaterCue: the lake-level shore point, scene frame).
 */
export type JointCue = Cue & {
	residualPx?: number;
	conf?: number;
	world?: Vec3;
};

/** The joint solver's defaults for the fields the MAP factors read. */
export const JOINT_DEFAULTS = {
	cueScale: 2.5,
	skylineSigmaPx: 2,
	skylineEff: 60,
	groupEff: {
		edge: 40,
		level: 20,
		shore: 20,
		point: 60,
		"point:pin": Number.POSITIVE_INFINITY,
		"level:pin": Number.POSITIVE_INFINITY,
	} as Record<string, number>,
	defaultEff: 40,
	groundSigmaM: 2,
	groundBelowSigmaM: 0.5,
};

export const basisPx = (aspect: number) =>
	aspect >= 1 ? { W: 1600, H: 1600 / aspect } : { W: 1600 * aspect, H: 1600 };

/** Focal (px @1600, long side 1600) of a CameraX, including fScale. */
export function focalPx1600(cam: CameraX): number {
	const { H } = basisPx(cam.aspect);
	return (H / 2 / Math.tan((cam.pose.vfov * D) / 2)) * cam.intr.fScale;
}

const azEl = (d: ArrayLike<number>): [number, number] => [
	wrap360(Math.atan2(d[0], d[1]) / D),
	Math.asin(Math.max(-1, Math.min(1, d[2]))) / D,
];

/** Horizon elevation at an azimuth (linear interpolation; NaN on no-data ≤ −89). */
export function horizonEl(h: EyeHorizon, az: number): number {
	const n = h.elevation.length;
	const t = wrap360(az) / h.step;
	const i = Math.floor(t);
	const f = t - i;
	const a = h.elevation[i % n];
	const b = h.elevation[(i + 1) % n];
	if (!(a > -89) || !(b > -89)) return Number.NaN;
	return a * (1 - f) + b * f;
}

/**
 * Pixel residual(s) of one cue under `cam` (px @1600, predicted − observed). point: [dx, dy];
 * edge: [along-normal − edgeBias]; level: [dy]; shore: [signed px distance to the predicted shore].
 * NaN when the cue cannot be evaluated (behind the camera, ray misses the lake plane).
 */
export function cueResidualPx(
	cam: CameraX,
	c: JointCue,
	edgeBias = 0,
	frame?: { alt0: number; rEff: number },
): number[] {
	const { W, H } = basisPx(cam.aspect);
	switch (c.kind) {
		case "point": {
			const q = projectX(cam, c.world);
			if (!q) return [Number.NaN, Number.NaN];
			return [(q.u - c.u) * W, (q.v - c.v) * H];
		}
		case "edge": {
			const q = projectX(cam, c.world);
			if (!q) return [Number.NaN];
			const r0 = c.residualPx ?? 0;
			const ox = c.u * W - r0 * c.nu;
			const oy = c.v * H - r0 * c.nv;
			return [(q.u * W - ox) * c.nu + (q.v * H - oy) * c.nv - edgeBias];
		}
		case "level": {
			const [, elObs] = azEl(unprojectDirX(cam, c.u, c.v));
			let elT = c.el;
			if (c.world) {
				const dx = c.world[0] - cam.eye[0];
				const dy = c.world[1] - cam.eye[1];
				elT = Math.atan2(c.world[2] - cam.eye[2], Math.hypot(dx, dy)) / D;
			}
			return [focalPx1600(cam) * (elObs - elT) * D];
		}
		case "shore": {
			let lz: number;
			if (c.world) lz = c.world[2];
			else if (frame) {
				// shore distance ~ depth; the curvature drop at the cue's depth
				lz = c.lakeM - frame.alt0 - (c.depthM * c.depthM) / (2 * frame.rEff);
			} else return [Number.NaN];
			const sd = (u: number, v: number) => {
				const d = unprojectDirX(cam, u, v);
				if (d[2] > -1e-6) return Number.NaN;
				const t = (lz - cam.eye[2]) / d[2];
				if (!(t > 0)) return Number.NaN;
				return c.shoreDist(cam.eye[0] + t * d[0], cam.eye[1] + t * d[1]);
			};
			const s0 = sd(c.u, c.v);
			const gu = sd(c.u + 1 / W, c.v) - s0;
			const gv = sd(c.u, c.v + 1 / H) - s0;
			const g = Math.hypot(gu, gv);
			if (!Number.isFinite(s0) || !(g > 1e-9)) return [Number.NaN];
			return [s0 / g];
		}
	}
}

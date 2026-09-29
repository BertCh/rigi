// Viewpoint consistency: photos taken from one spot (a roll viewpoint) within minutes of each other
// share the phone's compass error, which is dominated by a slowly varying bias (hard-iron /
// calibration state, the way the phone is held). So once one photo at a spot is anchored to the
// terrain, its (pose − EXIF prior) yaw offset is an estimate of that bias for its neighbours.
//
// This only ever produces a better *starting prior*; whether a pose is accepted stays the cascade's
// decision (alignRoll never accepts on consistency alone).

import type { Pose } from "../../camera";
import type { PhotoMeta } from "../../photos";

/** Anchors further apart in time than this (s) don't inform each other: compass drift, recalibration. */
export const BIAS_WINDOW_S = 45 * 60;
/**
 * A bias estimate larger than this (deg) is not applied: past it the compass says nothing about the
 * heading anyway. Large biases are allowed on purpose: a badly calibrated phone can be 45°+ off for a
 * whole session (region-0 with +45° injected: 2 photos only accept from the shifted prior), and
 * anchors are cascade-accepted poses, so a wrong one is as rare as a false accept.
 */
export const MAX_BIAS_DEG = 90;
/** Offsets below this (deg) are noise next to the cascade's own ±25° yaw search: leave the prior alone. */
export const MIN_BIAS_DEG = 1;
/** An accepted photo whose offset differs from its neighbours' by more than this (deg) is flagged. */
export const OUTLIER_DEG = 8;

/** Signed smallest difference a − b in degrees, in (−180, 180]. */
export const angDiff = (a: number, b: number) =>
	((((a - b) % 360) + 540) % 360) - 180;

/** A photo whose pose is trusted (saved, ground truth, solved or accepted in this run). */
export type Anchor = {
	id: string;
	viewpoint: number;
	t: number;
	yawOffset: number;
};

/** Photos whose compass heading is known (the only ones a yaw bias applies to or can come from). */
export function hasCompass(meta: PhotoMeta) {
	const l = (meta as PhotoMeta & { local?: { yawUnknown?: boolean } }).local;
	return meta.heading != null && !l?.yawUnknown;
}

/** The anchor for a trusted pose, or null when the photo has no compass to compare against. */
export function anchorOf(
	meta: PhotoMeta,
	viewpoint: number,
	t: number,
	pose: Pose,
): Anchor | null {
	if (!hasCompass(meta)) return null;
	return {
		id: meta.id,
		viewpoint,
		t,
		yawOffset: angDiff(pose.yaw, meta.heading as number),
	};
}

function median(xs: number[]) {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The compass-bias estimate for a photo from the other anchors at its viewpoint, or null. */
export function viewpointBias(
	anchors: Anchor[],
	viewpoint: number,
	t: number,
	excludeId?: string,
): { biasDeg: number; n: number } | null {
	const near = anchors.filter(
		(a) =>
			a.viewpoint === viewpoint &&
			a.id !== excludeId &&
			Math.abs(a.t - t) <= BIAS_WINDOW_S,
	);
	if (!near.length) return null;
	// median, not mean: one wrong anchor (a saved pose off by a peak) must not drag the rest
	const biasDeg = median(near.map((a) => a.yawOffset));
	if (Math.abs(biasDeg) > MAX_BIAS_DEG) return null;
	return { biasDeg, n: near.length };
}

/** The EXIF prior shifted by a compass bias (small biases are ignored, see MIN_BIAS_DEG). */
export function biasedPrior(prior: Pose, biasDeg: number | null): Pose {
	if (biasDeg == null || Math.abs(biasDeg) < MIN_BIAS_DEG) return prior;
	return { ...prior, yaw: (((prior.yaw + biasDeg) % 360) + 360) % 360 };
}

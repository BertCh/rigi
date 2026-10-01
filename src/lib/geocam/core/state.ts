// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GeoState ↔ CameraX (frozen API). logf maps onto intr.fScale = exp(logf) relative to `base`, so concord's
// projectX / unprojectDirX work unchanged; the eye is absolute in base's frame.
import type { CameraX } from "../../concord/core";
import { type GeoState, IDX, NP } from "./types";

export function stateFromCameraX(cam: CameraX, base: CameraX = cam): GeoState {
	const x = new Float64Array(NP);
	x[IDX.yaw] = cam.pose.yaw;
	x[IDX.pitch] = cam.pose.pitch;
	x[IDX.roll] = cam.pose.roll;
	x[IDX.logf] =
		Math.log(cam.intr.fScale / base.intr.fScale) + logVfovRatio(base, cam);
	x[IDX.E] = cam.eye[0];
	x[IDX.N] = cam.eye[1];
	x[IDX.U] = cam.eye[2];
	return x;
}

export function cameraXFromState(base: CameraX, x: GeoState): CameraX {
	return {
		pose: {
			...base.pose,
			yaw: x[IDX.yaw],
			pitch: x[IDX.pitch],
			roll: x[IDX.roll],
		},
		eye: [x[IDX.E], x[IDX.N], x[IDX.U]],
		aspect: base.aspect,
		intr: { ...base.intr, fScale: base.intr.fScale * Math.exp(x[IDX.logf]) },
	};
}

/** ln(f_cam / f_base) from a vfov difference (both at fScale 1). */
function logVfovRatio(base: CameraX, cam: CameraX): number {
	if (cam.pose.vfov === base.pose.vfov) return 0;
	const t = (v: number) => Math.tan((v * Math.PI) / 360);
	return Math.log(t(base.pose.vfov) / t(cam.pose.vfov));
}

/** f (px at the long-side-1600 basis) of a state, given the problem's f0. */
export const focalPx1600 = (f0Px1600: number, x: GeoState) =>
	f0Px1600 * Math.exp(x[IDX.logf]);

/** Wrap an angle difference to (−180, 180]. */
export const dAngle = (a: number, b: number) => {
	let d = (a - b) % 360;
	if (d > 180) d -= 360;
	if (d <= -180) d += 360;
	return d;
};

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

const RAD = Math.PI / 180;

export type TafelCamera = {
	yaw: number;
	pitch: number;
	roll: number;
	/** Focal length in working px. */
	f: number;
};

/**
 * The pinhole projector validated against solvedRows (roll sign -1): azimuth and elevation (deg) to
 * a point in the working frame (w x h px, principal point at the centre).
 */
export function projectAzEl(
	cam: TafelCamera,
	w: number,
	h: number,
	az: number,
	el: number,
): [number, number] {
	const cx = w / 2;
	const cy = h / 2;
	const dAz = (((az - cam.yaw + 540) % 360) - 180) * RAD;
	const e = el * RAD;
	const p = cam.pitch * RAD;
	const r = -cam.roll * RAD;
	const x = Math.cos(e) * Math.sin(dAz);
	const z = Math.cos(e) * Math.cos(dAz);
	const y = Math.sin(e);
	const z2 = z * Math.cos(p) + y * Math.sin(p);
	const y2 = y * Math.cos(p) - z * Math.sin(p);
	const u = (cam.f * x) / z2;
	const v = (-cam.f * y2) / z2;
	return [
		cx + u * Math.cos(r) - v * Math.sin(r),
		cy + u * Math.sin(r) + v * Math.cos(r),
	];
}

/** Azimuth (deg) under working-frame column `x` on the horizon line (ignores pitch and roll). */
export function azAtX(cam: TafelCamera, w: number, x: number): number {
	return cam.yaw + Math.atan((x - w / 2) / cam.f) / RAD;
}

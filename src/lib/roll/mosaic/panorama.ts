// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Panorama math: warp a photo through its camera model onto a cylindrical azimuth × elevation
// canvas (x = true azimuth, y = elevation, both degrees, equal scale). Each photo becomes a
// subdivided mesh whose vertices are the rays of a (u, v) grid, so roll rotates the image about
// its centre and wide lenses bend correctly. Azimuths inside one mesh are unwrapped around the
// photo's yaw (continuous across 0/360); the renderer repeats meshes every 360° for wraparound.
import { type Pose, projectPoint, unprojectDir } from "../../camera";
import { DEG as D2R, wrap180, wrap360 } from "../../geodesy";

const R2D = 180 / Math.PI;

export type PanoMesh = {
	/** (az, el) per vertex, degrees; az unwrapped around the photo's yaw. */
	pos: Float32Array;
	/** (u, v) per vertex, image coords 0..1, v down. */
	uv: Float32Array;
	idx: Uint16Array;
	/** Closed border polyline (az, el) pairs. */
	outline: Float32Array;
	azMin: number;
	azMax: number;
	elMin: number;
	elMax: number;
};

function azElOf(d: ArrayLike<number>): [number, number] {
	return [
		Math.atan2(d[0], d[1]) * R2D,
		Math.asin(Math.max(-1, Math.min(1, d[2]))) * R2D,
	];
}

export function dirOf(az: number, el: number): [number, number, number] {
	const ce = Math.cos(el * D2R);
	return [Math.sin(az * D2R) * ce, Math.cos(az * D2R) * ce, Math.sin(el * D2R)];
}

/** Photo mesh on the (az, el) canvas: nx × ny quads. */
export function buildMesh(
	pose: Pose,
	aspect: number,
	nx = 24,
	ny = 18,
): PanoMesh {
	const yaw = wrap360(pose.yaw);
	const azEl = (u: number, v: number) => {
		const [az, el] = azElOf(unprojectDir(pose, aspect, u, v));
		return [yaw + wrap180(az - yaw), el] as const;
	};
	const pos = new Float32Array((nx + 1) * (ny + 1) * 2);
	const uv = new Float32Array(pos.length);
	let azMin = Infinity;
	let azMax = -Infinity;
	let elMin = Infinity;
	let elMax = -Infinity;
	for (let j = 0, k = 0; j <= ny; j++)
		for (let i = 0; i <= nx; i++, k += 2) {
			const u = i / nx;
			const v = j / ny;
			const [az, el] = azEl(u, v);
			pos[k] = az;
			pos[k + 1] = el;
			uv[k] = u;
			uv[k + 1] = v;
			azMin = Math.min(azMin, az);
			azMax = Math.max(azMax, az);
			elMin = Math.min(elMin, el);
			elMax = Math.max(elMax, el);
		}
	const idx = new Uint16Array(nx * ny * 6);
	for (let j = 0, k = 0; j < ny; j++)
		for (let i = 0; i < nx; i++) {
			const a = j * (nx + 1) + i;
			const b = a + 1;
			const c = a + nx + 1;
			const d = c + 1;
			idx.set([a, c, b, b, c, d], k);
			k += 6;
		}
	// border: top → right → bottom → left
	const n = 32;
	const border: number[] = [];
	for (let s = 0; s < n; s++) border.push(...azEl(s / n, 0));
	for (let s = 0; s < n; s++) border.push(...azEl(1, s / n));
	for (let s = 0; s < n; s++) border.push(...azEl(1 - s / n, 1));
	for (let s = 0; s < n; s++) border.push(...azEl(0, 1 - s / n));
	return {
		pos,
		uv,
		idx,
		outline: new Float32Array(border),
		azMin,
		azMax,
		elMin,
		elMax,
	};
}

/** Is the ray at (az, el) inside the photo's frame? */
export function hitsPhoto(pose: Pose, aspect: number, az: number, el: number) {
	const q = projectPoint(pose, aspect, [0, 0, 0], dirOf(az, el));
	return !!q && q.u >= 0 && q.u <= 1 && q.v >= 0 && q.v <= 1;
}

/** Multiples of 360 at which a mesh spanning [azMin, azMax] intersects the view [a0, a1]. */
export function wrapOffsets(
	azMin: number,
	azMax: number,
	a0: number,
	a1: number,
) {
	const out: number[] = [];
	for (
		let k = Math.ceil((a0 - azMax) / 360);
		k <= Math.floor((a1 - azMin) / 360);
		k++
	)
		out.push(k * 360);
	return out;
}

/**
 * Smallest azimuth window covering all meshes: start just after the largest uncovered gap on
 * the circle. Returns [start, span] in degrees (span 360 when the photos go all the way round).
 */
export function azExtent(meshes: PanoMesh[]): [number, number] {
	if (!meshes.length) return [0, 360];
	const cover = new Uint8Array(360);
	for (const m of meshes)
		for (let a = Math.floor(m.azMin); a < Math.ceil(m.azMax); a++)
			cover[((a % 360) + 360) % 360] = 1;
	// longest run of zeros, circularly
	let best = 0;
	let bestEnd = 0;
	let run = 0;
	for (let i = 0; i < 720; i++) {
		if (cover[i % 360]) run = 0;
		else if (++run > best && run <= 360) {
			best = run;
			bestEnd = i;
		}
	}
	if (best === 0) return [0, 360];
	return [(bestEnd + 1) % 360, 360 - best];
}

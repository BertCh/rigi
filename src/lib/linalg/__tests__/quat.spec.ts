// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// mat3ToQuat against the two old copies (export/camera: w >= 0; nearfield/lift: branch sign).

import { describe, expect, it } from "vitest";
import { camToEnu, type Pose } from "../../camera";
import { mat3ToQuat } from "../index";

function old(
	m: ArrayLike<number>,
	positiveW: boolean,
): [number, number, number, number] {
	const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m as number[];
	const tr = m00 + m11 + m22;
	let w: number;
	let x: number;
	let y: number;
	let z: number;
	if (tr > 0) {
		const s = Math.sqrt(tr + 1) * 2;
		w = 0.25 * s;
		x = (m21 - m12) / s;
		y = (m02 - m20) / s;
		z = (m10 - m01) / s;
	} else if (m00 > m11 && m00 > m22) {
		const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
		w = (m21 - m12) / s;
		x = 0.25 * s;
		y = (m01 + m10) / s;
		z = (m02 + m20) / s;
	} else if (m11 > m22) {
		const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
		w = (m02 - m20) / s;
		x = (m01 + m10) / s;
		y = 0.25 * s;
		z = (m12 + m21) / s;
	} else {
		const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
		w = (m10 - m01) / s;
		x = (m02 + m20) / s;
		y = (m12 + m21) / s;
		z = 0.25 * s;
	}
	if (positiveW) {
		const n = Math.hypot(w, x, y, z) * (w < 0 ? -1 : 1);
		return [w / n, x / n, y / n, z / n];
	}
	const l = Math.hypot(w, x, y, z);
	return [w / l, x / l, y / l, z / l];
}

const poses: Pose[] = [];
for (const yaw of [-170, -90, 0, 45, 135, 200, 300])
	for (const pitch of [-88, -45, 0, 30, 80])
		for (const roll of [-180, -120, -30, 0, 60, 120, 180])
			poses.push({ yaw, pitch, roll, vfov: 50 });

describe("mat3ToQuat", () => {
	it("matches the old implementations on cam->ENU matrices of a pose grid (all four branches)", () => {
		for (const p of poses) {
			const m = camToEnu(p);
			for (const flag of [true, false]) {
				const a = mat3ToQuat(m, flag);
				const b = old(m, flag);
				for (let i = 0; i < 4; i++)
					expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(1e-12);
			}
			expect(mat3ToQuat(m, true)[0]).toBeGreaterThanOrEqual(0);
		}
	});
	it("exercises the non-trace branches (180 degree turns about each axis)", () => {
		const turns = [
			[1, 0, 0, 0, -1, 0, 0, 0, -1],
			[-1, 0, 0, 0, 1, 0, 0, 0, -1],
			[-1, 0, 0, 0, -1, 0, 0, 0, 1],
		];
		for (const m of turns)
			for (const flag of [true, false]) {
				const a = mat3ToQuat(m, flag);
				const b = old(m, flag);
				for (let i = 0; i < 4; i++) expect(a[i]).toBeCloseTo(b[i], 12);
			}
	});
});

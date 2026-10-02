// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { poseBasis } from "../../pose";
import { makeXyzRay, xyzPixel } from "../geometry-pass";

/** The full-array rebuild GpuGeometrySource.unpack did before xyz went lazy (verbatim arithmetic). */
function oldFullXyz(
	range: Float32Array,
	w: number,
	h: number,
	pose: { yaw: number; pitch: number; roll: number; vfov: number },
	eye: [number, number, number],
) {
	const xyz = new Float32Array(w * h * 3).fill(Number.NaN);
	const { forward: f, right: rt, up } = poseBasis(pose);
	const t = Math.tan((pose.vfov * Math.PI) / 360);
	const aspect = w / h;
	const [ex, ey, ez] = eye;
	for (let y = 0; y < h; y++) {
		const sy = (1 - (2 * (y + 0.5)) / h) * t;
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const r = range[i];
			if (!Number.isFinite(r)) {
				xyz[i * 3] = xyz[i * 3 + 1] = xyz[i * 3 + 2] = Number.NaN;
				continue;
			}
			const sx = ((2 * (x + 0.5)) / w - 1) * t * aspect;
			const dx = f.x + rt.x * sx + up.x * sy;
			const dy = f.y + rt.y * sx + up.y * sy;
			const dz = f.z + rt.z * sx + up.z * sy;
			const k = r / Math.hypot(dx, dy, dz);
			xyz[i * 3] = ex + dx * k;
			xyz[i * 3 + 1] = ey + dy * k;
			xyz[i * 3 + 2] = ez + dz * k;
		}
	}
	return xyz;
}

describe("lazy geometry xyz", () => {
	it("per-pixel and full-array xyzPixel equal the old full rebuild exactly", () => {
		const w = 37;
		const h = 23;
		const pose = { yaw: 123.4, pitch: -7.5, roll: 2.25, vfov: 31.7 };
		const eye: [number, number, number] = [12.5, -300.25, 1850.125];
		const range = new Float32Array(w * h);
		for (let i = 0; i < range.length; i++)
			range[i] =
				i % 11 === 0 ? Number.POSITIVE_INFINITY : 50 + ((i * 7919) % 20000) / 3;
		const want = oldFullXyz(range, w, h, pose, eye);
		const ray = makeXyzRay(pose, w, h, eye);
		const full = new Float32Array(w * h * 3).fill(Number.NaN);
		const one: [number, number, number] = [0, 0, 0];
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const i = y * w + x;
				xyzPixel(full, i * 3, range[i], x, y, ray);
				xyzPixel(one, 0, range[i], x, y, ray);
				for (let c = 0; c < 3; c++) {
					expect(Object.is(full[i * 3 + c], want[i * 3 + c])).toBe(true);
					// sampleAt path: rounded to float32 like the stored array
					expect(Object.is(Math.fround(one[c]), want[i * 3 + c])).toBe(true);
				}
			}
	});
});

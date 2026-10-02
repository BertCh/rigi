// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { rasterDepthRange } from "../raster";
import { boxMesh } from "./synthetic";

const K = { fx: 1, fy: 1, cx: 0.5, cy: 0.5 };

/** Closed cylinder along the camera's y axis, centre (0, 0, zc), radius r, half height hh, n segments. */
function cylinder(zc: number, r: number, hh: number, n: number) {
	const v: number[] = [];
	const f: number[] = [];
	for (let i = 0; i < n; i++) {
		const a = (2 * Math.PI * i) / n;
		v.push(
			r * Math.cos(a),
			-hh,
			zc + r * Math.sin(a),
			r * Math.cos(a),
			hh,
			zc + r * Math.sin(a),
		);
	}
	const top = v.length / 3;
	v.push(0, -hh, zc, 0, hh, zc);
	for (let i = 0; i < n; i++) {
		const a = 2 * i;
		const b = 2 * ((i + 1) % n);
		f.push(a, b, a + 1, b, b + 1, a + 1, top, b, a, top + 1, a + 1, b + 1);
	}
	return { vertices: v, faces: f };
}

describe("rasterDepthRange", () => {
	it("returns the front and back faces of a box", () => {
		// a 0.4 m cube from z = 2 to 2.4, centred on the optical axis
		const m = boxMesh([-0.2, -0.2, 2], [0.2, 0.2, 2.4]);
		const r = rasterDepthRange(m.vertices, m.faces, K, 40, 40);
		const centre = 20 * 40 + 20;
		expect(r.near[centre]).toBeCloseTo(2, 6);
		expect(r.far[centre]).toBeCloseTo(2.4, 6);
		// the cube spans |x/z| ≤ 0.1 at its front: cells ±4 around the centre are covered, the corners of the grid not
		expect(Number.isNaN(r.near[0])).toBe(true);
		let covered = 0;
		for (let k = 0; k < 1600; k++) if (Number.isFinite(r.near[k])) covered++;
		expect(covered).toBe(r.covered);
		// covered cells: centres with |u − 0.5| < 0.1 (front face silhouette), 8 × 8
		expect(covered).toBe(64);
	});

	it("gives a cylinder's back surface along each ray", () => {
		const zc = 3;
		const R = 0.3;
		const m = cylinder(zc, R, 0.5, 256);
		const GW = 64;
		const r = rasterDepthRange(m.vertices, m.faces, K, GW, GW);
		const row = 32;
		let checked = 0;
		for (let i = 0; i < GW; i++) {
			const k = row * GW + i;
			if (!Number.isFinite(r.far[k])) continue;
			// ray x = s·z with s = (u − cx) / fx; intersect x² + (z − zc)² = R²
			const s = (i + 0.5) / GW - 0.5;
			const a = 1 + s * s;
			const disc = zc * zc - a * (zc * zc - R * R);
			if (disc < 0.02) continue; // grazing rays: the polygon cuts the silhouette
			const zBack = (zc + Math.sqrt(disc)) / a;
			const zFront = (zc - Math.sqrt(disc)) / a;
			expect(Math.abs(r.far[k] - zBack)).toBeLessThan(2e-3);
			expect(Math.abs(r.near[k] - zFront)).toBeLessThan(2e-3);
			checked++;
		}
		expect(checked).toBeGreaterThan(4);
	});

	it("skips triangles behind the camera", () => {
		const m = boxMesh([-0.2, -0.2, -1], [0.2, 0.2, -0.5]);
		const r = rasterDepthRange(m.vertices, m.faces, K, 16, 16);
		expect(r.covered).toBe(0);
	});
});

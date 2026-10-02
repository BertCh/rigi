// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// enuRotation / ecefToGeodetic against the old per-module copies (export/camera, tiles3d/frame, EnuFrame).

import { describe, expect, it } from "vitest";
import {
	enuToEcefRotation,
	ecefToGeodetic as iterative,
} from "../export/camera";
import { DEG, EnuFrame, ecefToGeodetic, enuRotation, toEcef } from "../geodesy";
import { enuFromEcef } from "../tiles3d/frame";

const grid: [number, number][] = [];
for (let lat = -90; lat <= 90; lat += 7.5)
	for (let lon = -180; lon <= 180; lon += 22.5) grid.push([lat, lon]);

function oldRows(lat: number, lon: number) {
	const sp = Math.sin(lat * DEG);
	const cp = Math.cos(lat * DEG);
	const sl = Math.sin(lon * DEG);
	const cl = Math.cos(lon * DEG);
	return [-sl, cl, 0, -sp * cl, -sp * sl, cp, cp * cl, cp * sl, sp];
}
/** export/camera.ts enuToEcefRotation: columns east, north, up */
function oldEnuToEcef(lat: number, lon: number) {
	const sp = Math.sin(lat * DEG);
	const cp = Math.cos(lat * DEG);
	const sl = Math.sin(lon * DEG);
	const cl = Math.cos(lon * DEG);
	const a = [-sl, cl, 0];
	const b = [-sp * cl, -sp * sl, cp];
	const c = [cp * cl, cp * sl, sp];
	return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
}

describe("enuRotation", () => {
	it("equals the old inline rows and the old export/camera columns (exactly)", () => {
		for (const [lat, lon] of grid) {
			expect(enuRotation(lat, lon)).toEqual(oldRows(lat, lon));
			expect(enuToEcefRotation(lat, lon)).toEqual(oldEnuToEcef(lat, lon));
		}
	});
	it("is orthonormal with rows east, north, up", () => {
		const r = enuRotation(46.9, 8.6);
		for (let i = 0; i < 3; i++)
			for (let j = 0; j < 3; j++) {
				const d =
					r[i * 3] * r[j * 3] +
					r[i * 3 + 1] * r[j * 3 + 1] +
					r[i * 3 + 2] * r[j * 3 + 2];
				expect(d).toBeCloseTo(i === j ? 1 : 0, 12);
			}
	});
	it("tiles3d enuFromEcef keeps its matrix", () => {
		for (const [lat, lon] of [
			[46.7, 7.9],
			[-33, 151.2],
			[0, 0],
		]) {
			const [ox, oy, oz] = toEcef(lat, lon, 0);
			const r = oldRows(lat, lon);
			const t = (k: number) =>
				-(r[k * 3] * ox + r[k * 3 + 1] * oy + r[k * 3 + 2] * oz);
			const m = enuFromEcef(lat, lon, 12.5);
			const want = [
				r[0],
				r[1],
				r[2],
				t(0),
				r[3],
				r[4],
				r[5],
				t(1),
				r[6],
				r[7],
				r[8],
				t(2) - 12.5,
				0,
				0,
				0,
				1,
			];
			// Matrix4 stores column-major
			for (let row = 0; row < 4; row++)
				for (let col = 0; col < 4; col++)
					expect(
						Math.abs(m[col * 4 + row] - want[row * 4 + col]),
					).toBeLessThanOrEqual(1e-12);
		}
	});
});

describe("ecefToGeodetic (Bowring)", () => {
	it("EnuFrame.toGeo round-trips through fromGeo", () => {
		const f = new EnuFrame(46.6, 7.9, 600);
		const g = f.toGeo(1234, -5678, 321);
		const back = f.fromGeo(g.lat, g.lon, g.h);
		expect(Math.hypot(back[0] - 1234, back[1] + 5678)).toBeLessThan(1e-3);
	});
	it("inverts toEcef within 1e-9 deg / 1 mm for terrestrial heights, and agrees with export/camera's iterative solver", () => {
		for (const h of [-400, 0, 500, 4800, 9000])
			for (const [lat, lon] of grid) {
				if (Math.abs(lat) > 89.9) continue;
				const e = toEcef(lat, lon, h);
				const g = ecefToGeodetic(e[0], e[1], e[2]);
				const it = iterative(e[0], e[1], e[2]);
				expect(Math.abs(g.lat - lat)).toBeLessThan(1e-9);
				expect(Math.abs(g.h - h)).toBeLessThan(1e-3);
				expect(Math.abs(g.lat - it.lat)).toBeLessThan(1e-9);
				expect(Math.abs(g.h - it.h)).toBeLessThan(1e-3);
			}
	});
});

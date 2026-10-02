// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { expectArrayClose } from "#/test/helpers";
import { toEcef } from "../../geodesy";
import {
	buildCameraModel,
	colmapLines,
	ecefToGeodetic,
	enuToEcef,
	enuToEcefRotation,
	fixedAzimuth,
	kmlCameraAngles,
	mat3Mul,
	mat3T,
	mat3ToQuat,
	mat3Vec,
	projectEcef,
	wrap360,
} from "../camera";
import { FIXTURE, SOUTH } from "./fixtures";

const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

describe("wrap360 / fixedAzimuth", () => {
	it("normalises into [0, 360)", () => {
		expect(wrap360(-90)).toBe(270);
		expect(wrap360(360)).toBe(0);
		expect(wrap360(725)).toBe(5);
		expect(wrap360(0)).toBe(0);
	});
	it("never prints 360 after rounding", () => {
		expect(fixedAzimuth(359.9999999, 6)).toBe("0");
		expect(fixedAzimuth(-0.0000001, 6)).toBe("0");
		expect(fixedAzimuth(359.5, 2)).toBe("359.5");
		expect(fixedAzimuth(20.84, 6)).toBe("20.84");
	});
});

describe("mat3 helpers", () => {
	it("transpose inverts a rotation", () => {
		const R = enuToEcefRotation(46.9, 8.6);
		expectArrayClose(mat3Mul(R, mat3T(R)), [...I3], 1e-12);
	});
	it("mat3Vec applies the matrix to a column", () => {
		expect(mat3Vec([0, -1, 0, 1, 0, 0, 0, 0, 1], [1, 0, 5])).toEqual([0, 1, 5]);
	});
	it("enuToEcefRotation columns are east, north, up", () => {
		const R = enuToEcefRotation(0, 0);
		// at lat/lon 0: east = +y, north = +z, up = +x (ECEF)
		expectArrayClose(mat3Vec(R, [1, 0, 0]), [0, 1, 0], 1e-15);
		expectArrayClose(mat3Vec(R, [0, 1, 0]), [0, 0, 1], 1e-15);
		expectArrayClose(mat3Vec(R, [0, 0, 1]), [1, 0, 0], 1e-15);
	});
});

describe("ecefToGeodetic", () => {
	it("inverts toEcef at the poles, equator and the Alps", () => {
		for (const [lat, lon, h] of [
			[46.97, 8.67, 1361],
			[0, 0, 0],
			[-33.9, 151.2, 12],
			[89.9, -45, 4000],
			[-60, 179.9, -50],
		]) {
			const e = toEcef(lat, lon, h);
			const g = ecefToGeodetic(e[0], e[1], e[2]);
			expect(g.lat).toBeCloseTo(lat, 9);
			expect(g.lon).toBeCloseTo(lon, 9);
			expect(g.h).toBeCloseTo(h, 4);
		}
	});
});

describe("mat3ToQuat", () => {
	it("maps identity to (1,0,0,0)", () => {
		expect(mat3ToQuat([...I3])).toEqual([1, 0, 0, 0]);
	});
	it("recovers a 90 degree rotation about z with w >= 0", () => {
		const q = mat3ToQuat([0, -1, 0, 1, 0, 0, 0, 0, 1]);
		expectArrayClose(q, [Math.SQRT1_2, 0, 0, Math.SQRT1_2], 1e-12);
	});
	it("covers every branch with unit, w>=0 results", () => {
		const rots: number[][] = [
			[1, 0, 0, 0, -1, 0, 0, 0, -1], // 180 about x (tr<0, m00 largest)
			[-1, 0, 0, 0, 1, 0, 0, 0, -1], // 180 about y
			[-1, 0, 0, 0, -1, 0, 0, 0, 1], // 180 about z
		];
		for (const m of rots) {
			const q = mat3ToQuat(m as never);
			expect(Math.hypot(...q)).toBeCloseTo(1, 12);
			expect(q[0]).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("buildCameraModel", () => {
	const m = buildCameraModel(FIXTURE);
	it("defaults the image name from the photo id", () => {
		expect(m.imageName).toBe("IMG_7131.jpg");
		expect(buildCameraModel({ ...FIXTURE, imageName: "x.png" }).imageName).toBe(
			"x.png",
		);
	});
	it("has square-pixel intrinsics with the principal point at the image centre", () => {
		expect(m.K[0]).toBeCloseTo(m.f, 9);
		expect(m.K[4]).toBeCloseTo(m.f, 9);
		expect(m.K[2]).toBe(2016);
		expect(m.K[5]).toBe(1512);
		expect(m.Kopencv[2]).toBe(2015.5);
		expect(m.Kopencv[5]).toBe(1511.5);
		// vfov = 2 atan(H / 2f)
		expect((2 * Math.atan(3024 / 2 / m.f) * 180) / Math.PI).toBeCloseTo(
			53.06,
			6,
		);
	});
	it("derives hfov < dfov and dfov > both", () => {
		expect(m.hfov).toBeGreaterThan(m.vfov);
		expect(m.dfov).toBeGreaterThan(m.hfov);
		expect(m.f35).toBeGreaterThan(10);
		expect(m.f35).toBeLessThan(60);
	});
	it("puts the camera at the frame origin plus eye, with N applied", () => {
		expect(m.lat).toBeCloseTo(FIXTURE.frame.lat, 9);
		expect(m.lon).toBeCloseTo(FIXTURE.frame.lon, 9);
		expect(m.altMsl).toBeCloseTo(1361.3, 4);
		expect(m.altEllipsoid).toBeCloseTo(1361.3 + 49, 4);
		expect(m.geoidUndulation).toBe(49);
		expect(m.eyeOffset).toBeCloseTo(11.3, 4);
	});
	it("defaults N to 0 and eyeOffset to null", () => {
		const s = buildCameraModel(SOUTH);
		expect(s.geoidUndulation).toBe(0);
		expect(s.altEllipsoid).toBeCloseTo(s.altMsl, 9);
		expect(s.eyeOffset).toBeNull();
	});
	it("has orthonormal rotations and w2c consistent with C", () => {
		for (const R of [m.R_cam2enu, m.R_cam2ecef, m.R_w2c_ecef]) {
			expectArrayClose(mat3Mul(R, mat3T(R)), [...I3], 1e-12);
		}
		// R * C + t = 0: the camera centre is the origin of its own frame
		const c = mat3Vec(m.R_w2c_ecef, m.C_ecef);
		expectArrayClose(
			c.map((v, i) => v + m.t_w2c_ecef[i]),
			[0, 0, 0],
			1e-6,
		);
	});
	it("projects a point on the optical axis to the principal point", () => {
		const fwd = [m.R_cam2ecef[2], m.R_cam2ecef[5], m.R_cam2ecef[8]];
		const X = m.C_ecef.map((v, i) => v + 1000 * fwd[i]);
		const p = projectEcef(m, X);
		expect(p).not.toBeNull();
		expect(p?.x).toBeCloseTo(2016, 5);
		expect(p?.y).toBeCloseTo(1512, 5);
		expect(p?.depth).toBeCloseTo(1000, 6);
	});
	it("returns null behind the camera", () => {
		const fwd = [m.R_cam2ecef[2], m.R_cam2ecef[5], m.R_cam2ecef[8]];
		const X = m.C_ecef.map((v, i) => v - 100 * fwd[i]);
		expect(projectEcef(m, X)).toBeNull();
	});
	it("maps the ENU eye to the ECEF camera centre", () => {
		expectArrayClose(enuToEcef(m, FIXTURE.eye), m.C_ecef, 1e-6);
	});
	it("uses the opencv K when asked", () => {
		const fwd = [m.R_cam2ecef[2], m.R_cam2ecef[5], m.R_cam2ecef[8]];
		const X = m.C_ecef.map((v, i) => v + 500 * fwd[i]);
		expect(projectEcef(m, X, m.Kopencv)?.x).toBeCloseTo(2015.5, 5);
	});
});

describe("kmlCameraAngles", () => {
	it("maps pose to heading, tilt 90+pitch and negated roll", () => {
		expect(kmlCameraAngles({ yaw: -10, pitch: 5, roll: 3, vfov: 40 })).toEqual({
			heading: 350,
			tilt: 95,
			roll: -3,
		});
	});
});

describe("colmapLines", () => {
	const m = buildCameraModel(FIXTURE);
	it("emits a PINHOLE camera line with width, height, f, cx, cy", () => {
		const { camera } = colmapLines(m);
		const t = camera.split(" ");
		expect(t.slice(0, 4)).toEqual(["1", "PINHOLE", "4032", "3024"]);
		expect(Number(t[4])).toBeCloseTo(m.f, 6);
		expect(t[4]).toBe(t[5]);
		expect(t[6]).toBe("2016");
		expect(t[7]).toBe("1512");
	});
	it("emits a unit quaternion + translation + camera id + name", () => {
		const t = colmapLines(m, { imageId: 7, cameraId: 3 }).image.split(" ");
		expect(t[0]).toBe("7");
		expect(Math.hypot(...t.slice(1, 5).map(Number))).toBeCloseTo(1, 12);
		expect(t.slice(5, 8).map(Number)).toEqual(m.t_w2c_ecef);
		expect(t[8]).toBe("3");
		expect(t[9]).toBe("IMG_7131.jpg");
	});
	it("uses the ENU world when asked", () => {
		const t = colmapLines(m, { world: "enu" }).image.split(" ");
		expect(Number(t[5])).toBeCloseTo(m.t_w2c_enu[0], 9);
	});
});

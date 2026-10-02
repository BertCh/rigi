// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	angleDiffDeg,
	expectArrayClose,
	seededRandom,
	uniform,
} from "#/test/helpers";
import {
	azimuthElevation,
	cameraFromAngles,
	cameraFromGravity,
	cameraFromMeta,
	cameraParams,
	directionENU,
	displaySize,
	focalPx,
	gravityInDisplayFrame,
	perturbCamera,
	project,
	resizeCamera,
	unproject,
} from "../camera";
import type { ExifPhotoMeta } from "../photo-meta";

const base = { width: 4000, height: 3000, f: 3000 };

describe("directionENU / azimuthElevation", () => {
	it("cardinal directions", () => {
		expectArrayClose(directionENU(0, 0), [0, 1, 0], 1e-12);
		expectArrayClose(directionENU(90, 0), [1, 0, 0], 1e-12);
		expectArrayClose(directionENU(0, 90), [0, 0, 1], 1e-12);
	});
	it("round trips and wraps azimuth to [0, 360)", () => {
		const rand = seededRandom(1);
		for (let i = 0; i < 40; i++) {
			const az = uniform(rand, 0, 360);
			const el = uniform(rand, -85, 85);
			const [a, e] = azimuthElevation(directionENU(az, el));
			expect(angleDiffDeg(a, az)).toBeLessThan(1e-9);
			expect(e).toBeCloseTo(el, 9);
			expect(a).toBeGreaterThanOrEqual(0);
			expect(a).toBeLessThan(360);
		}
	});
	it("azimuthElevation accepts non-unit vectors", () => {
		const [a, e] = azimuthElevation([0, 10, 10]);
		expect(a).toBeCloseTo(0, 12);
		expect(e).toBeCloseTo(45, 12);
	});
});

describe("cameraFromAngles", () => {
	it("stores the requested yaw/pitch/roll back", () => {
		const rand = seededRandom(2);
		for (let i = 0; i < 40; i++) {
			const yaw = uniform(rand, 0, 360);
			const pitch = uniform(rand, -70, 70);
			const roll = uniform(rand, -40, 40);
			const c = cameraFromAngles({ ...base, yaw, pitch, roll });
			expect(c.yaw).toBe(yaw);
			expect(c.pitch).toBeCloseTo(pitch, 9);
			expect(c.roll).toBeCloseTo(roll, 9);
			expect(c.cx).toBe(2000);
			expect(c.cy).toBe(1500);
		}
	});
	it("world axes form an orthonormal right-handed frame", () => {
		const c = cameraFromAngles({ ...base, yaw: 123, pitch: 20, roll: -7 });
		const dot = (a: number[], b: number[]) =>
			a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
		for (const v of [c.east, c.north, c.up])
			expect(dot(v, v)).toBeCloseTo(1, 12);
		expect(dot(c.east, c.north)).toBeCloseTo(0, 12);
		expect(dot(c.east, c.up)).toBeCloseTo(0, 12);
		expect(dot(c.north, c.up)).toBeCloseTo(0, 12);
	});
	it("level camera facing north: the centre pixel sees azimuth 0, elevation 0", () => {
		const c = cameraFromAngles({ ...base, yaw: 0, pitch: 0, roll: 0 });
		expectArrayClose(
			project(c, directionENU(0, 0)) as number[],
			[2000, 1500],
			1e-9,
		);
	});
	it("pitching up moves the horizon down the image", () => {
		const c = cameraFromAngles({ ...base, yaw: 0, pitch: 10, roll: 0 });
		const p = project(c, directionENU(0, 0)) as number[];
		expect(p[1]).toBeCloseTo(1500 + 3000 * Math.tan((10 * Math.PI) / 180), 6);
	});
	it("a peak to the right of the heading lands right of centre", () => {
		const c = cameraFromAngles({ ...base, yaw: 0, pitch: 0, roll: 0 });
		const p = project(c, directionENU(10, 0)) as number[];
		expect(p[0]).toBeGreaterThan(2000);
	});
	it("positive roll tilts the horizon: a level point on the right goes down", () => {
		const c = cameraFromAngles({ ...base, yaw: 0, pitch: 0, roll: 5 });
		const right = project(c, directionENU(10, 0)) as number[];
		const left = project(c, directionENU(-10, 0)) as number[];
		expect(right[1]).not.toBeCloseTo(left[1], 3);
		// roll is the (signed) tilt of the horizon line in the image
		const slope =
			(Math.atan2(right[1] - left[1], right[0] - left[0]) * 180) / Math.PI;
		expect(Math.abs(slope)).toBeGreaterThan(3);
		expect(Math.abs(slope)).toBeLessThan(6);
	});
});

describe("project / unproject", () => {
	it("returns null for directions behind the camera", () => {
		const c = cameraFromAngles({ ...base, yaw: 0, pitch: 0, roll: 0 });
		expect(project(c, directionENU(180, 0))).toBeNull();
		expect(project(c, directionENU(90, 0))).toBeNull();
	});
	it("unproject inverts project for random cameras", () => {
		const rand = seededRandom(3);
		for (let i = 0; i < 50; i++) {
			const c = cameraFromAngles({
				...base,
				yaw: uniform(rand, 0, 360),
				pitch: uniform(rand, -40, 40),
				roll: uniform(rand, -20, 20),
			});
			const x = uniform(rand, 0, 4000);
			const y = uniform(rand, 0, 3000);
			const d = unproject(c, x, y);
			expect(Math.hypot(...d)).toBeCloseTo(1, 12);
			expectArrayClose(project(c, d) as number[], [x, y], 1e-6);
		}
	});
	it("the principal point unprojects to the forward axis (camera z in world)", () => {
		const c = cameraFromAngles({ ...base, yaw: 40, pitch: 15, roll: 0 });
		const d = unproject(c, c.cx, c.cy);
		const [az, el] = azimuthElevation(d);
		expect(az).toBeCloseTo(40, 9);
		expect(el).toBeCloseTo(15, 9);
	});
});

describe("cameraFromGravity", () => {
	it("level phone (gravity along +y) gives pitch 0 and roll 0", () => {
		const c = cameraFromGravity({ ...base, gravity: [0, 1, 0], heading: 77 });
		expect(c.pitch).toBeCloseTo(0, 12);
		expect(c.roll).toBeCloseTo(0, 12);
		expect(c.yaw).toBe(77);
	});
	it("gravity tilted toward the forward axis (z>0) pitches the camera down", () => {
		const c = cameraFromGravity({ ...base, gravity: [0, 1, 0.2], heading: 0 });
		expect(c.pitch).toBeLessThan(0);
	});
	it("gravity magnitude does not matter", () => {
		const a = cameraFromGravity({
			...base,
			gravity: [0.1, 1, 0.2],
			heading: 10,
		});
		const b = cameraFromGravity({ ...base, gravity: [0.5, 5, 1], heading: 10 });
		expectArrayClose(a.up, b.up, 1e-12);
		expect(a.pitch).toBeCloseTo(b.pitch, 12);
	});
});

describe("gravityInDisplayFrame", () => {
	it("a level landscape phone reads straight down in the display frame", () => {
		expectArrayClose(gravityInDisplayFrame([-1, 0, 0], 1), [0, 1, 0], 1e-12);
	});
	it("a level portrait phone with orientation 6 reads straight down", () => {
		expectArrayClose(gravityInDisplayFrame([0, -1, 0], 6), [0, 1, 0], 1e-12);
	});
	it("orientation 8 and 3 rotate the other ways", () => {
		expectArrayClose(gravityInDisplayFrame([0, 1, 0], 8), [0, 1, 0], 1e-12);
		expectArrayClose(gravityInDisplayFrame([1, 0, 0], 3), [0, 1, 0], 1e-12);
	});
	it("output is unit length", () => {
		for (const o of [1, 3, 6, 8])
			expect(
				Math.hypot(...gravityInDisplayFrame([0.3, -0.8, -0.2], o)),
			).toBeCloseTo(1, 12);
	});
	it("negative g.z (pitched down per the comment) pitches the camera down", () => {
		const g = gravityInDisplayFrame([-0.98, 0, -0.2], 1);
		const c = cameraFromGravity({ ...base, gravity: g, heading: 0 });
		expect(c.pitch).toBeLessThan(0);
	});
});

describe("displaySize / focalPx / cameraFromMeta", () => {
	const meta: ExifPhotoMeta = {
		width: 4000,
		height: 3000,
		orientation: 1,
		heading: 90,
		focal35: 26,
		gravity: [-1, 0, 0],
	};
	it("swaps width and height for orientations >= 5", () => {
		expect(displaySize(meta)).toEqual({ width: 4000, height: 3000 });
		expect(displaySize({ ...meta, orientation: 6 })).toEqual({
			width: 3000,
			height: 4000,
		});
		expect(displaySize({ ...meta, orientation: 8 })).toEqual({
			width: 3000,
			height: 4000,
		});
		expect(displaySize({ ...meta, orientation: 3 })).toEqual({
			width: 4000,
			height: 3000,
		});
	});
	it("focalPx = f35 * diagonal / 43.27", () => {
		expect(focalPx(26, 4000, 3000)).toBeCloseTo((26 * 5000) / 43.2666, 6);
	});
	it("cameraFromMeta builds a level, correctly headed camera", () => {
		const c = cameraFromMeta(meta);
		expect(c.yaw).toBe(90);
		expect(c.pitch).toBeCloseTo(0, 9);
		expect(c.roll).toBeCloseTo(0, 9);
		expect(c.f).toBeCloseTo(focalPx(26, 4000, 3000), 6);
	});
	it("cameraFromMeta throws without gravity, heading or focal", () => {
		expect(() => cameraFromMeta({ ...meta, gravity: undefined })).toThrow();
		expect(() => cameraFromMeta({ ...meta, heading: undefined })).toThrow();
		expect(() => cameraFromMeta({ ...meta, focal35: undefined })).toThrow();
		expect(() => cameraFromMeta({ ...meta, focal35: 0 })).toThrow();
	});
	it("heading 0 is a valid heading", () => {
		expect(cameraFromMeta({ ...meta, heading: 0 }).yaw).toBe(0);
	});
});

describe("cameraParams / perturbCamera / resizeCamera", () => {
	const cam = cameraFromAngles({ ...base, yaw: 100, pitch: 5, roll: 2 });
	it("cameraParams -> cameraFromAngles round trips", () => {
		const back = cameraFromAngles(cameraParams(cam));
		expectArrayClose(back.east, cam.east, 1e-12);
		expectArrayClose(back.up, cam.up, 1e-12);
	});
	it("perturbCamera offsets the angles and scales f", () => {
		const p = perturbCamera(cam, 3, -1, 0.5, 1.1);
		expect(p.yaw).toBeCloseTo(103, 12);
		expect(p.pitch).toBeCloseTo(4, 9);
		expect(p.roll).toBeCloseTo(2.5, 9);
		expect(p.f).toBeCloseTo(3300, 9);
		const same = perturbCamera(cam, 0);
		expect(same.yaw).toBe(cam.yaw);
		expect(same.f).toBe(cam.f);
	});
	it("resizeCamera scales pixel quantities and keeps the pose", () => {
		const r = resizeCamera(cam, 1000);
		expect(r.width).toBe(1000);
		expect(r.height).toBe(750);
		expect(r.f).toBeCloseTo(750, 9);
		expect(r.cx).toBe(500);
		expect(r.yaw).toBe(cam.yaw);
		const d = directionENU(103, 6);
		const a = project(cam, d) as number[];
		const b = project(r, d) as number[];
		expectArrayClose(
			b,
			a.map((v) => v / 4),
			1e-9,
		);
	});
});

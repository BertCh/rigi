// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "../../../test/helpers";
import { poseBasis } from "../../camera";
import { DEG } from "../../geodesy";
import {
	eulerToRotation,
	poseFromEuler,
	quaternionToRotation,
	type RotationMatrix,
	rotationToPose,
	sampleFromOrientation,
	sampleFromQuaternion,
	yawDifference,
} from "../sensors";

/** Device → ENU rotation for a camera pose shown at a screen angle (columns: device x, y, z). */
function deviceRotation(
	pose: { yaw: number; pitch: number; roll: number },
	screenAngle: number,
): RotationMatrix {
	const { forward, right, up } = poseBasis({ ...pose, vfov: 50 });
	const s = Math.sin(screenAngle * DEG);
	const c = Math.cos(screenAngle * DEG);
	const x = [0, 1, 2].map((i) => c * right[i] + s * up[i]);
	const y = [0, 1, 2].map((i) => -s * right[i] + c * up[i]);
	const z = forward.map((v) => -v);
	return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

describe("eulerToRotation", () => {
	it("is the identity for a flat phone facing north", () => {
		const r = eulerToRotation(0, 0, 0);
		for (const [i, v] of [1, 0, 0, 0, 1, 0, 0, 0, 1].entries())
			expect(r[i]).toBeCloseTo(v, 12);
	});

	it("is orthonormal", () => {
		const random = seededRandom(7);
		for (let i = 0; i < 50; i++) {
			const r = eulerToRotation(
				random() * 360,
				random() * 360 - 180,
				random() * 180 - 90,
			);
			for (let a = 0; a < 3; a++)
				for (let b = 0; b < 3; b++) {
					const dot = r[a] * r[b] + r[3 + a] * r[3 + b] + r[6 + a] * r[6 + b];
					expect(dot).toBeCloseTo(a === b ? 1 : 0, 10);
				}
		}
	});
});

describe("rotationToPose", () => {
	it("round-trips random poses at every screen angle", () => {
		const random = seededRandom(11);
		for (const angle of [0, 90, 180, 270]) {
			for (let i = 0; i < 40; i++) {
				const pose = {
					yaw: random() * 360,
					pitch: random() * 120 - 60,
					roll: random() * 120 - 60,
				};
				const got = rotationToPose(deviceRotation(pose, angle), angle);
				expect(yawDifference(got.yaw, pose.yaw)).toBeCloseTo(0, 6);
				expect(got.pitch).toBeCloseTo(pose.pitch, 6);
				expect(got.roll).toBeCloseTo(pose.roll, 6);
			}
		}
	});

	it("upright portrait at alpha 0 looks north, level", () => {
		const p = poseFromEuler(0, 90, 0);
		expect(p.yaw).toBeCloseTo(0, 9);
		expect(p.pitch).toBeCloseTo(0, 9);
		expect(p.roll).toBeCloseTo(0, 9);
	});

	it("alpha counts counter-clockwise, so alpha 90 faces west", () => {
		expect(poseFromEuler(90, 90, 0).yaw).toBeCloseTo(270, 9);
		expect(poseFromEuler(270, 90, 0).yaw).toBeCloseTo(90, 9);
	});

	it("beta above 90 tilts the camera up", () => {
		expect(poseFromEuler(0, 100, 0).pitch).toBeCloseTo(10, 9);
		expect(poseFromEuler(0, 80, 0).pitch).toBeCloseTo(-10, 9);
	});

	it("landscape keeps the heading of the camera, not of the device top", () => {
		// a phone upright facing east, turned to landscape-left: the camera still faces east
		const portrait = rotationToPose(
			deviceRotation({ yaw: 90, pitch: 5, roll: 0 }, 0),
			0,
		);
		const landscape = rotationToPose(
			deviceRotation({ yaw: 90, pitch: 5, roll: 0 }, 90),
			90,
		);
		expect(landscape.yaw).toBeCloseTo(portrait.yaw, 6);
		expect(landscape.roll).toBeCloseTo(0, 6);
	});

	it("rolling right side down is positive roll", () => {
		const { roll } = rotationToPose(
			deviceRotation({ yaw: 30, pitch: 0, roll: 12 }, 0),
			0,
		);
		expect(roll).toBeCloseTo(12, 6);
	});
});

describe("quaternionToRotation", () => {
	it("a 90 degree turn about up equals Euler alpha 90", () => {
		const h = Math.SQRT1_2;
		const q = quaternionToRotation([0, 0, h, h]);
		const e = eulerToRotation(90, 0, 0);
		for (const [i, v] of q.entries()) expect(v).toBeCloseTo(e[i], 12);
	});

	it("normalises a non-unit quaternion", () => {
		const q = quaternionToRotation([0, 0, 2, 2]);
		const e = eulerToRotation(90, 0, 0);
		for (const [i, v] of q.entries()) expect(v).toBeCloseTo(e[i], 12);
	});
});

describe("samples", () => {
	const base = { time: 5, screenAngle: 0, declination: 3 };

	it("applies declination to an absolute heading", () => {
		const s = sampleFromOrientation(
			{ alpha: 350, beta: 90, gamma: 0, absolute: true },
			base,
		);
		// alpha 350 faces 10 deg east of magnetic north; plus 3 deg east declination
		expect(s?.yaw).toBeCloseTo(13, 9);
		expect(s?.pitch).toBeCloseTo(0, 9);
	});

	it("wraps yaw into 0..360", () => {
		const s = sampleFromOrientation(
			{ alpha: 5, beta: 90, gamma: 0, absolute: true },
			{ ...base, declination: 0 },
		);
		expect(s?.yaw).toBeCloseTo(355, 9);
	});

	it("uses the iOS compass heading in place of the relative alpha", () => {
		const s = sampleFromOrientation(
			{
				alpha: 123,
				beta: 90,
				gamma: 0,
				webkitCompassHeading: 80,
				webkitCompassAccuracy: 15,
			},
			base,
		);
		expect(s?.yaw).toBeCloseTo(83, 9);
		expect(s?.yawAccuracy).toBe(15);
	});

	it("ignores a negative iOS accuracy (uncalibrated)", () => {
		const s = sampleFromOrientation(
			{
				alpha: 0,
				beta: 90,
				gamma: 0,
				webkitCompassHeading: 10,
				webkitCompassAccuracy: -1,
			},
			base,
		);
		expect(s?.yawAccuracy).toBeUndefined();
	});

	it("keeps a relative heading apart from true north", () => {
		const s = sampleFromOrientation({ alpha: 40, beta: 90, gamma: 0 }, base);
		expect(s?.yaw).toBeNull();
		expect(s?.yawRelative).toBeCloseTo(320, 9);
	});

	it("drops an event without angles", () => {
		expect(
			sampleFromOrientation({ alpha: null, beta: null, gamma: null }, base),
		).toBeNull();
	});

	it("converts a quaternion with declination", () => {
		const h = Math.SQRT1_2;
		// device flat then rotated: use the upright quaternion = Rx(90) = [sin45, 0, 0, cos45]
		const s = sampleFromQuaternion([h, 0, 0, h], base);
		expect(s.yaw).toBeCloseTo(3, 9);
		expect(s.pitch).toBeCloseTo(0, 9);
	});
});

describe("yawDifference", () => {
	it("takes the short way round", () => {
		expect(yawDifference(5, 355)).toBe(10);
		expect(yawDifference(355, 5)).toBe(-10);
	});
});

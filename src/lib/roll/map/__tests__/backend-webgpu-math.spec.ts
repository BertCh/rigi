// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	diffIds,
	gizmoProps,
	projectRollPoint,
	ROLL_NEAR_M,
	rollViewPose,
} from "../backend-webgpu-math";

const VIEW = {
	eye: [0, 0, 100] as [number, number, number],
	forward: [0, 1, 0] as [number, number, number],
	up: [0, 0, 1] as [number, number, number],
	camFov: 60,
	focalDistance: 1000,
};

describe("rollViewPose", () => {
	it("keeps the orbit camera and uses the roll near plane", () => {
		const p = rollViewPose(VIEW);
		expect(p.eye).toEqual([0, 0, 100]);
		expect(p.vfov).toBe(60);
		expect(p.near).toBe(ROLL_NEAR_M);
		expect(p.forward[1]).toBeCloseTo(1);
	});
	it("re-orthogonalises a skewed up vector", () => {
		const p = rollViewPose({ ...VIEW, up: [0, 0.3, 1] });
		const dot =
			p.up[0] * p.forward[0] + p.up[1] * p.forward[1] + p.up[2] * p.forward[2];
		expect(dot).toBeCloseTo(0);
	});
});

describe("projectRollPoint", () => {
	const pose = rollViewPose(VIEW);
	it("puts the point ahead of the camera at the canvas centre, in front", () => {
		const [x, y, d] = projectRollPoint(pose, 800, 600, [0, 1000, 100]);
		expect(x).toBeCloseTo(400);
		expect(y).toBeCloseTo(300);
		expect(d).toBeLessThan(1);
	});
	it("maps up to smaller y and right to larger x", () => {
		const up = projectRollPoint(pose, 800, 600, [0, 1000, 300]);
		const right = projectRollPoint(pose, 800, 600, [200, 1000, 100]);
		expect(up[1]).toBeLessThan(300);
		expect(right[0]).toBeGreaterThan(400);
	});
	it("reports a point behind the camera as not in front", () => {
		const [x, , d] = projectRollPoint(pose, 800, 600, [0, -500, 100]);
		expect(Number.isNaN(x)).toBe(true);
		expect(d).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("diffIds", () => {
	it("lists the ids to add and to drop", () => {
		expect(diffIds(["a", "b"], [{ id: "b" }, { id: "c" }])).toEqual({
			add: ["c"],
			remove: ["a"],
		});
		expect(diffIds([], [])).toEqual({ add: [], remove: [] });
	});
});

describe("gizmoProps", () => {
	const g = {
		id: "x",
		pose: { yaw: 1, pitch: 2, roll: 0, vfov: 40 },
		eye: [1, 2, 3] as [number, number, number],
		aspect: 1.5,
		image: null,
		planeOpacity: 0.5,
		lineColor: [1, 2, 3, 4] as [number, number, number, number],
		pinColor: [5, 6, 7, 8] as [number, number, number, number],
		pinRadiusM: 12,
	};
	it("includes the image key only when asked", () => {
		expect("image" in gizmoProps(g, 2, false)).toBe(false);
		expect("image" in gizmoProps(g, 2, true)).toBe(true);
		expect(gizmoProps(g, 2, false).pixelRatio).toBe(2);
		expect(gizmoProps(g, 2, false).view).toBe("world");
	});
});

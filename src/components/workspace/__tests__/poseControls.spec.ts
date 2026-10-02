// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { hfovFromAspect, type Pose } from "#/lib/camera";
import { dragPose, WHEEL_VFOV, wheelVfov } from "../poseControls";

const pose: Pose = { yaw: 120, pitch: 2, roll: -1, vfov: 40 };

describe("dragPose", () => {
	const stage = { width: 800, height: 600 };
	it("moves yaw and pitch by the dragged fraction of the field of view", () => {
		const p = dragPose(pose, 80, -60, stage, 4 / 3, false);
		expect(p.yaw).toBeCloseTo(120 - 0.1 * hfovFromAspect(40, 4 / 3), 12);
		expect(p.pitch).toBeCloseTo(2 - 0.1 * 40, 12);
		expect(p.roll).toBe(pose.roll);
		expect(p.vfov).toBe(pose.vfov);
	});
	it("shift-drag rolls only", () => {
		expect(dragPose(pose, 20, 300, stage, 4 / 3, true)).toEqual({
			...pose,
			roll: -1 + 1,
		});
	});
	it("a zero-size stage never yields NaN", () => {
		const p = dragPose(pose, 5, 5, { width: 0, height: 0 }, 1.5, false);
		expect(Number.isFinite(p.yaw) && Number.isFinite(p.pitch)).toBe(true);
	});
	it("does not mutate the start pose", () => {
		const start = { ...pose };
		dragPose(start, 10, 10, stage, 1, false);
		expect(start).toEqual(pose);
	});
});

describe("wheelVfov", () => {
	it("scales with the wheel delta", () => {
		expect(wheelVfov(40, 100)).toBeCloseTo(40 * 1.06, 12);
		expect(wheelVfov(40, -100)).toBeCloseTo(40 * 0.94, 12);
		expect(wheelVfov(40, 0)).toBe(40);
	});
	it("clamps to the wheel limits", () => {
		expect(wheelVfov(99, 1e4)).toBe(WHEEL_VFOV.max);
		expect(wheelVfov(6, -1e4)).toBe(WHEEL_VFOV.min);
	});
});

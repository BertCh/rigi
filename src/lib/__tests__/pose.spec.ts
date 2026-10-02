// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Vector3 } from "@math.gl/core";
import { describe, expect, it } from "vitest";
import * as camera from "../camera";
import { ViewCamera } from "../camera/view-camera";
import { applyPose, poseBasis, poseQuaternion, unprojectDir } from "../pose";

const pose = { yaw: 37, pitch: 12, roll: -6, vfov: 42 };

describe("pose.ts math.gl adapter", () => {
	it("poseBasis equals the pure camera basis", () => {
		const b = poseBasis(pose);
		const c = camera.poseBasis(pose);
		expect(b.forward.toArray()).toEqual(c.forward);
		expect(b.right.toArray()).toEqual(c.right);
		expect(b.up.toArray()).toEqual(c.up);
	});
	it("unprojectDir returns a Vector3 matching the pure function", () => {
		const d = unprojectDir(pose, 1.5, 0.3, 0.7);
		expect(d).toBeInstanceOf(Vector3);
		expect(d.toArray()).toEqual(camera.unprojectDir(pose, 1.5, 0.3, 0.7));
	});
	it("poseQuaternion rotates camera −z onto the pose forward and +y onto its up", () => {
		const q = poseQuaternion(pose);
		const b = poseBasis(pose);
		const f = new Vector3(0, 0, -1).transformByQuaternion(q);
		const u = new Vector3(0, 1, 0).transformByQuaternion(q);
		const r = new Vector3(1, 0, 0).transformByQuaternion(q);
		expect(f.distanceTo(b.forward)).toBeLessThan(1e-12);
		expect(u.distanceTo(b.up)).toBeLessThan(1e-12);
		expect(r.distanceTo(b.right)).toBeLessThan(1e-12);
	});
	it("applyPose makes a camera whose view direction and projection agree", () => {
		const cam = new ViewCamera();
		const eye: [number, number, number] = [5, -3, 2];
		applyPose(cam, pose, 1.5, eye);
		expect(cam.fov).toBe(42);
		expect(cam.aspect).toBe(1.5);
		expect([...cam.position]).toEqual(eye);
		const f = poseBasis(pose).forward;
		expect(cam.forward().distanceTo(f)).toBeLessThan(1e-9);
		// a point along a pixel's ray lands on that pixel (NDC = 2·uv − 1, y flipped) through
		// projection × view
		const d = unprojectDir(pose, 1.5, 0.8, 0.2);
		const world = new Vector3(eye).addScaledVector(d, 100);
		const clip = new Vector3(world)
			.transformAsPoint(cam.viewMatrix())
			.transformAsPoint(cam.projectionMatrix());
		const r = camera.projectPoint(pose, 1.5, eye, [...world]);
		expect(clip.x).toBeCloseTo((r?.u ?? 0) * 2 - 1, 7);
		expect(clip.y).toBeCloseTo(1 - (r?.v ?? 0) * 2, 7);
	});
});

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import * as camera from "./../camera";
import { applyPose, poseBasis, projectPoint, unprojectDir } from "../pose";

const pose = { yaw: 37, pitch: 12, roll: -6, vfov: 42 };

describe("pose.ts three.js adapter", () => {
	it("poseBasis equals the pure camera basis", () => {
		const b = poseBasis(pose);
		const c = camera.poseBasis(pose);
		expect(b.forward.toArray()).toEqual(c.forward);
		expect(b.right.toArray()).toEqual(c.right);
		expect(b.up.toArray()).toEqual(c.up);
	});
	it("projectPoint accepts Vector3 and arrays alike", () => {
		const eye = new THREE.Vector3(1, 2, 3);
		const pt = new THREE.Vector3(1, 2, 3).addScaledVector(
			poseBasis(pose).forward,
			50,
		);
		const a = projectPoint(pose, 1.5, eye, pt);
		const b = projectPoint(pose, 1.5, eye, pt.toArray());
		expect(a).toEqual(b);
		expect(a?.u).toBeCloseTo(0.5, 9);
	});
	it("unprojectDir returns a Vector3 matching the pure function", () => {
		const d = unprojectDir(pose, 1.5, 0.3, 0.7);
		expect(d).toBeInstanceOf(THREE.Vector3);
		expect(d.toArray()).toEqual(camera.unprojectDir(pose, 1.5, 0.3, 0.7));
	});
	it("applyPose makes a three camera whose view direction and projection agree", () => {
		const cam = new THREE.PerspectiveCamera();
		const eye = new THREE.Vector3(5, -3, 2);
		applyPose(cam, pose, 1.5, eye);
		expect(cam.fov).toBe(42);
		expect(cam.aspect).toBe(1.5);
		expect(cam.position.toArray()).toEqual([5, -3, 2]);
		const dir = new THREE.Vector3();
		cam.getWorldDirection(dir);
		const f = poseBasis(pose).forward;
		expect(dir.distanceTo(f)).toBeLessThan(1e-9);
		const d = unprojectDir(pose, 1.5, 0.8, 0.2);
		const world = eye.clone().addScaledVector(d, 100);
		const ndc = world.clone().project(cam);
		const r = projectPoint(pose, 1.5, eye, world);
		expect(ndc.x).toBeCloseTo((r?.u ?? 0) * 2 - 1, 7);
		expect(ndc.y).toBeCloseTo(1 - (r?.v ?? 0) * 2, 7);
	});
});

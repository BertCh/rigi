// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { poseBasis } from "../../camera";
import { PhotoView, PhotoViewport, photoViewProjection } from "../photo-view";

const ndc = (m: { transform: (v: number[]) => number[] }, p: number[]) => {
	const [x, y, z, w] = m.transform([p[0], p[1], p[2], 1]);
	return [x / w, y / w, z / w];
};

const pose = { yaw: 35, pitch: 12, roll: 0, vfov: 40 };
const eye: [number, number, number] = [100, -200, 300];
const add = (a: number[], b: ArrayLike<number>, s: number) => [
	a[0] + b[0] * s,
	a[1] + b[1] * s,
	a[2] + b[2] * s,
];

describe("photoViewProjection", () => {
	const m = photoViewProjection(pose, eye, 1.5);
	const { forward, up, right } = poseBasis(pose);

	it("projects the optical axis to the NDC centre", () => {
		const [x, y] = ndc(m as never, add(eye, forward, 500));
		expect(x).toBeCloseTo(0, 6);
		expect(y).toBeCloseTo(0, 6);
	});

	it("puts the top of the vertical field of view at NDC y = 1, and scales x by aspect", () => {
		const t = Math.tan((pose.vfov * Math.PI) / 360);
		const top = add(add(eye, forward, 100), up, 100 * t);
		expect(ndc(m as never, top)[1]).toBeCloseTo(1, 6);
		const rightEdge = add(add(eye, forward, 100), right, 100 * t * 1.5);
		expect(ndc(m as never, rightEdge)[0]).toBeCloseTo(1, 6);
	});

	it("maps depth to [-1, 1] between near and far", () => {
		const near = ndc(m as never, add(eye, forward, 1))[2];
		const far = ndc(m as never, add(eye, forward, 400_000))[2];
		expect(near).toBeCloseTo(-1, 4);
		expect(far).toBeCloseTo(1, 4);
	});

	it("honours custom near / far", () => {
		const m2 = photoViewProjection(pose, eye, 1, 10, 1000);
		expect(ndc(m2 as never, add(eye, forward, 10))[2]).toBeCloseTo(-1, 6);
		expect(ndc(m2 as never, add(eye, forward, 1000))[2]).toBeCloseTo(1, 6);
	});
});

describe("PhotoViewport / PhotoView", () => {
	it("keeps the pose and eye and looks along the pose", () => {
		const vp = new PhotoViewport({ ...pose, eye, width: 600, height: 400 });
		expect(vp.pose).toEqual(pose);
		expect(vp.eye).toBe(eye);
		const { forward } = poseBasis(pose);
		const [px, py] = vp.project(
			add(eye, forward, 250) as [number, number, number],
		);
		expect(px).toBeCloseTo(300, 3);
		expect(py).toBeCloseTo(200, 3);
	});

	it("view type is the viewport and has no controller", () => {
		const v = new PhotoView();
		expect(v.getViewportType()).toBe(PhotoViewport);
		expect(() => v.ControllerType).toThrow(/no controller/);
	});
});

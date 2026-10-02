// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Matrix4, Vector3 } from "@math.gl/core";
import { describe, expect, it } from "vitest";
import { toEcef } from "../../geodesy";
import { enuFromEcef } from "../frame";
import { EnuViewport, frustumPlanes, type StepView } from "../viewport";

const LAT = 46.7;
const LON = 7.7;

/** View matrix of a camera at `eye` looking at `target` (z up), ENU world -> camera. */
function lookAt(eye: number[], target: number[]): number[] {
	return Array.from(
		new Matrix4().lookAt({ eye, center: target, up: [0, 0, 1] }),
	) as number[];
}
const stepView = (eye = [0, 0, 1500], target = [0, 2000, 1500]): StepView => ({
	position: eye as [number, number, number],
	viewMatrix: lookAt(eye, target),
	projectionMatrix: new Array(16).fill(0),
	fovY: 60,
	aspect: 1.5,
});
const viewport = (view: StepView, n = 0, far = 3000) =>
	new EnuViewport({
		id: "step",
		view,
		width: 900,
		height: 600,
		enuFromEcef: enuFromEcef(LAT, LON, n),
		far,
		origin: { lat: LAT, lon: LON },
	});

describe("EnuViewport camera", () => {
	it("recovers position, forward and up from the view matrix", () => {
		const v = viewport(stepView());
		expect(v.cameraPosition).toEqual([0, 0, 1500]);
		expect(v.cameraDirection[0]).toBeCloseTo(0, 6);
		expect(v.cameraDirection[1]).toBeCloseTo(1, 6);
		expect(v.cameraDirection[2]).toBeCloseTo(0, 6);
		expect(v.cameraUp[2]).toBeCloseTo(1, 6);
		expect(v.fovy).toBe(60);
		expect(v.center).toEqual([0, 0, 0]);
		expect(v.distanceScales.metersPerUnit).toEqual([1, 1, 1]);
	});
	it("looks along any heading", () => {
		const v = viewport(stepView([0, 0, 100], [1000, 1000, 100]));
		expect(v.cameraDirection[0]).toBeCloseTo(Math.SQRT1_2, 6);
		expect(v.cameraDirection[1]).toBeCloseTo(Math.SQRT1_2, 6);
	});
});

describe("EnuViewport.unprojectPosition", () => {
	it("maps the ENU origin to the photo's lat/lon at height 0", () => {
		const [lon, lat, h] = viewport(stepView()).unprojectPosition([0, 0, 0]);
		expect(lon).toBeCloseTo(LON, 8);
		expect(lat).toBeCloseTo(LAT, 8);
		expect(h).toBeCloseTo(0, 4);
	});
	it("a point up in ENU is up in height; a geoid shift lifts the ellipsoidal height by N", () => {
		const up = viewport(stepView()).unprojectPosition([0, 0, 800]);
		expect(up[2]).toBeCloseTo(800, 4);
		const withN = viewport(stepView(), 50.4).unprojectPosition([0, 0, 800]);
		expect(withN[2]).toBeCloseTo(850.4, 4);
	});
	it("inverts enuFromEcef: an ECEF point lands where it should", () => {
		const m = enuFromEcef(LAT, LON, 0);
		const ecef = toEcef(LAT + 0.01, LON + 0.01, 900);
		const enu = m.transformAsPoint(ecef) as number[];
		const [lon, lat, h] = viewport(stepView()).unprojectPosition(enu);
		expect(lon).toBeCloseTo(LON + 0.01, 7);
		expect(lat).toBeCloseTo(LAT + 0.01, 7);
		expect(h).toBeCloseTo(900, 3);
	});
});

describe("frustum planes", () => {
	const planes = (v: EnuViewport) => v.getFrustumPlanes();
	it("has the six planes with unit normals", () => {
		const p = planes(viewport(stepView()));
		expect(Object.keys(p).sort()).toEqual([
			"bottom",
			"far",
			"left",
			"near",
			"right",
			"top",
		]);
		for (const k of Object.keys(p)) expect(p[k].normal.len()).toBeCloseTo(1, 9);
	});
	it("puts the far plane `far` metres ahead of the camera", () => {
		const v = viewport(stepView(), 0, 2500);
		const { far } = planes(v);
		const ahead = new Vector3(0, 0, 1500).add(new Vector3(0, 2500, 0));
		expect(far.normal.dot(ahead)).toBeCloseTo(far.distance, 6);
		expect(far.normal.y).toBeCloseTo(-1, 9); // faces the camera
	});
	it("contains a point on the view axis and excludes ones outside the frustum", () => {
		const v = viewport(stepView());
		const inside = (pt: number[]) =>
			Object.values(planes(v)).every(
				(pl) => pl.normal.dot(pt) >= pl.distance - 1e-9,
			);
		expect(inside([0, 1000, 1500])).toBe(true);
		expect(inside([0, -1000, 1500])).toBe(false); // behind
		expect(inside([0, 4000, 1500])).toBe(false); // beyond far
		// 60 deg vertical fov: 1000 m ahead the half-height is ~577 m
		expect(inside([0, 1000, 1500 + 500])).toBe(true);
		expect(inside([0, 1000, 1500 + 700])).toBe(false);
		// aspect 1.5: half-width ~866 m
		expect(inside([800, 1000, 1500])).toBe(true);
		expect(inside([950, 1000, 1500])).toBe(false);
	});
	it("frustumPlanes is pose-only", () => {
		const p = frustumPlanes(
			[0, 0, 0],
			new Vector3(1, 0, 0),
			new Vector3(0, 0, 1),
			new Vector3(0, 1, 0),
			90,
			1,
			10,
		);
		expect(p.left.normal.x).toBeCloseTo(Math.SQRT1_2, 9);
		expect(p.far.distance).toBeCloseTo(-10, 9);
	});
});

describe("topDown clone", () => {
	it("accepts the bag Tileset3D builds for its top-down viewport", () => {
		const v = new EnuViewport({
			longitude: 1,
			latitude: 2,
			height: 3,
			width: 4,
			bearing: 0,
			zoom: 0,
			position: [0, 0, 0],
			pitch: 0,
		});
		expect(v.longitude).toBe(1);
		expect(v.latitude).toBe(2);
		expect(v.getFrustumPlanes()).toEqual({});
	});
});

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// DeckMapCamera: deck's web-mercator map camera expressed as the ENU step camera. Pure math (no GL).
import { Vector3 } from "@math.gl/core";
import { describe, expect, it, vi } from "vitest";
import { ViewCamera } from "../../camera/view-camera";
import { EnuFrame } from "../../geodesy";
import { DeckMapCamera, MAP_VIEW_ID } from "../deck-map-camera";

const frame = new EnuFrame(46.58, 8.0, 2000);

function make(groundAt: (x: number, y: number) => number | null = () => null) {
	const onChange = vi.fn();
	const cam = new DeckMapCamera(frame, groundAt, onChange);
	cam.setSize(1000, 600);
	return { cam, onChange };
}
const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

describe("DeckMapCamera", () => {
	it("exposes its hidden MapView under the stable id", () => {
		const { cam } = make();
		expect(cam.view.id).toBe(MAP_VIEW_ID);
	});

	it("setActive notifies the engine once per change of the view list", () => {
		const { cam, onChange } = make();
		cam.setActive(false);
		expect(onChange).not.toHaveBeenCalled();
		cam.setActive(true);
		cam.setActive(true);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(true);
		expect(cam.active).toBe(true);
	});

	it("start looks straight down on the pivot from the requested distance, keeping the heading", () => {
		const { cam } = make();
		const pivot = v(300, -200, 2100);
		cam.start(pivot, 1500, 0.7);
		const s = cam.state();
		expect(s.pivot.distanceTo(pivot)).toBeLessThan(0.5);
		expect(s.dist).toBeGreaterThan(1500 * 0.97);
		expect(s.dist).toBeLessThan(1500 * 1.03);
		expect(s.yaw).toBeCloseTo(0.7, 6);
		expect(s.pitch).toBeCloseTo(-Math.PI / 2, 9);
		expect(cam.viewState.pitch).toBe(0);
		expect(cam.takeDirty()).toBe(true);
		expect(cam.takeDirty()).toBe(false);
	});

	it("clamps the start zoom into the controller's range for absurd distances", () => {
		const { cam } = make();
		cam.start(v(0, 0, 2000), 1e9, 0);
		expect(cam.viewState.zoom).toBeGreaterThanOrEqual(6);
		cam.start(v(0, 0, 2000), 0.001, 0);
		expect(cam.viewState.zoom).toBeLessThanOrEqual(21);
	});

	it("apply writes a camera above the pivot looking at it, screen-up toward the heading", () => {
		const { cam } = make();
		const pivot = v(0, 0, 2000);
		cam.start(pivot, 2000, 0);
		const out = new ViewCamera();
		cam.apply(out);
		const f = new Vector3(0, 0, -1).transformByQuaternion(out.quaternion);
		const toPivot = pivot.clone().subtract(out.position).normalize();
		expect(f.angle(toPivot)).toBeLessThan(1e-6);
		expect(f.z).toBeLessThan(-0.999); // straight down
		expect(out.position.z).toBeGreaterThan(pivot.z + 1500);
		expect(out.fov).toBeGreaterThan(0);
		const up = new Vector3(0, 1, 0).transformByQuaternion(out.quaternion);
		expect(up.y).toBeGreaterThan(0.999); // bearing 0: north up
	});

	it("a tilted map camera sits on the opposite side of the bearing it looks toward", () => {
		const { cam } = make();
		cam.start(v(0, 0, 2000), 3000, 0);
		cam.onViewStateChange({ ...cam.viewState, pitch: 60, bearing: 90 });
		const out = new ViewCamera();
		cam.apply(out);
		// bearing 90 (east): the camera looks east, so it stands west of the centre, above it
		expect(out.position.x).toBeLessThan(-1000);
		expect(out.position.z).toBeGreaterThan(2000);
		const s = cam.state();
		expect(s.yaw).toBeCloseTo(Math.PI / 2, 6);
		expect(s.pitch).toBeCloseTo(((60 - 90) * Math.PI) / 180, 9);
	});

	it("onViewStateChange stores the change, forces roll 0 and the zoom/pitch limits, and notifies", () => {
		const { cam, onChange } = make();
		cam.start(v(0, 0, 2000), 2000, 0);
		cam.takeDirty();
		cam.onViewStateChange({ ...cam.viewState, bearing: 30, roll: 12 } as never);
		expect(cam.viewState.bearing).toBe(30);
		expect((cam.viewState as { roll: number }).roll).toBe(0);
		expect(cam.viewState.maxPitch).toBe(80);
		expect(cam.takeDirty()).toBe(true);
		expect(onChange).toHaveBeenCalledWith(false);
	});

	it("refuses a move that would put the camera under the terrain, keeping zoom and pitch", () => {
		// terrain above the plane the camera would hover over once zoomed in (~190 m up at zoom +4)
		const { cam } = make(() => 3000);
		cam.start(v(0, 0, 2800), 3000, 0);
		const before = { zoom: cam.viewState.zoom, pitch: cam.viewState.pitch };
		cam.onViewStateChange({ ...cam.viewState, zoom: 18, pitch: 60 });
		expect(cam.viewState.zoom).toBe(before.zoom);
		expect(cam.viewState.pitch).toBe(before.pitch);
	});

	it("settle re-anchors the map plane to the ground without moving the camera", () => {
		let ground = 2000;
		const { cam } = make(() => ground);
		cam.start(v(0, 0, 2000), 4000, 0);
		cam.onViewStateChange({ ...cam.viewState, pitch: 45 });
		const a = new ViewCamera();
		cam.apply(a);
		const posBefore = a.position.clone();
		ground = 2300; // terrain under the view centre is 300 m higher than the plane
		cam.takeDirty();
		cam.settle();
		const b = new ViewCamera();
		cam.apply(b);
		expect(b.position.distanceTo(posBefore)).toBeLessThan(1);
		expect(cam.takeDirty()).toBe(true);
		// a second settle with the plane already at the ground changes nothing
		cam.settle();
		expect(cam.takeDirty()).toBe(false);
	});

	it("settle does nothing off the DEM or when the plane is already within 1 m", () => {
		const off = make(() => null);
		off.cam.start(v(0, 0, 2000), 2000, 0);
		off.cam.takeDirty();
		off.cam.settle();
		expect(off.cam.takeDirty()).toBe(false);
		const near = make(() => 2000.4);
		near.cam.start(v(0, 0, 2000), 2000, 0);
		near.cam.takeDirty();
		near.cam.settle();
		expect(near.cam.takeDirty()).toBe(false);
	});

	it("setSize never goes below 1 px", () => {
		const { cam } = make();
		cam.setSize(0, -5);
		cam.start(v(0, 0, 2000), 2000, 0);
		expect(Number.isFinite(cam.state().dist)).toBe(true);
	});
});

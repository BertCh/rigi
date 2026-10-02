// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// StepCamera's navigation math without a DOM: the photo-mode clamps, the free-mode terrain rules and
// the mode switches, driven through the public programmatic API (orbit/pan/dollyBy/setMode/update).
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
	StepCamera,
	type StepCameraOpts,
	type StepMapDriver,
} from "../step-camera";

// photo camera at the origin-ish eye, looking due north and slightly down (three: camera looks -z)
function photoQuat(yawDeg = 0, pitchDeg = 0) {
	const y = (yawDeg * Math.PI) / 180;
	const p = (pitchDeg * Math.PI) / 180;
	return new THREE.Quaternion()
		.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -y)
		.multiply(
			new THREE.Quaternion().setFromAxisAngle(
				new THREE.Vector3(1, 0, 0),
				Math.PI / 2 + p,
			),
		);
}

function make(o: Partial<StepCameraOpts> = {}) {
	const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1e6);
	const sc = new StepCamera(cam, null, {
		eye: new THREE.Vector3(100, 200, 1500),
		quaternion: photoQuat(30, 5),
		vfov: 40,
		aspect: 4 / 3,
		radius: 40,
		pivotDist: 30,
		...o,
	});
	return { cam, sc };
}

const fwd = (q: THREE.Quaternion) =>
	new THREE.Vector3(0, 0, -1).applyQuaternion(q);

describe("StepCamera photo mode", () => {
	it("starts exactly on the photo camera", () => {
		const { cam, sc } = make();
		expect(cam.position.distanceTo(sc.eye)).toBeLessThan(1e-9);
		expect(fwd(cam.quaternion).angleTo(fwd(sc.baseQ))).toBeLessThan(1e-9);
		expect(sc.atPhoto).toBe(true);
		expect(sc.offsetM).toBeLessThan(1e-9);
		expect(sc.mode).toBe("photo");
	});

	it("widens the vertical FOV so a wide photo still fits a narrow viewport, never narrower than the photo", () => {
		const wide = new THREE.PerspectiveCamera(50, 16 / 9);
		new StepCamera(wide, null, {
			eye: new THREE.Vector3(),
			quaternion: photoQuat(),
			vfov: 40,
			aspect: 4 / 3,
			radius: 40,
		});
		expect(wide.fov).toBeCloseTo(40, 6); // 16:9 viewport is wider than the 4:3 photo
		const narrow = new THREE.PerspectiveCamera(50, 0.5);
		new StepCamera(narrow, null, {
			eye: new THREE.Vector3(),
			quaternion: photoQuat(),
			vfov: 40,
			aspect: 4 / 3,
			radius: 40,
		});
		expect(narrow.fov).toBeGreaterThan(40);
	});

	it("orbit moves the camera but stays within the confidence radius and the angle caps", () => {
		const { cam, sc } = make();
		sc.orbit(1000, 1000);
		sc.snap();
		expect(sc.offsetM).toBeLessThanOrEqual(40 + 1e-9);
		expect(sc.offsetM).toBeGreaterThan(1);
		expect(sc.atPhoto).toBe(false);
		// the capped rotation: yaw <= 45 deg, pitch <= 25 deg relative to the photo
		const rel = fwd(cam.quaternion).angleTo(fwd(sc.baseQ));
		expect(rel).toBeLessThan((60 * Math.PI) / 180);
	});

	it("a small orbit keeps the pivot ahead of the eye in view (pivot stays near the image centre)", () => {
		const { cam, sc } = make({ radius: 100 });
		sc.orbit(5, 0);
		sc.snap();
		const pivot = sc.eye.clone().addScaledVector(fwd(sc.baseQ), 30);
		const toPivot = pivot.clone().sub(cam.position).normalize();
		expect(toPivot.angleTo(fwd(cam.quaternion))).toBeLessThan(0.01);
	});

	it("pan and dolly are clamped to the radius", () => {
		const { sc } = make();
		sc.pan(500, 500, 500);
		sc.snap();
		expect(sc.offsetM).toBeLessThanOrEqual(40 + 1e-9);
		const b = make();
		b.sc.dollyBy(-1e6);
		b.sc.snap();
		expect(b.sc.offsetM).toBeCloseTo(40, 6);
	});

	it("a tiny radius still allows at least 0.5 m", () => {
		const { sc } = make({ radius: 0 });
		expect(sc.radius).toBe(0.5);
	});

	it("easing converges and update() reports when it has settled", () => {
		const { sc } = make();
		sc.orbit(5, 3);
		let t = 1000;
		let busy = true;
		let n = 0;
		while (busy && n++ < 500) {
			t += 16;
			busy = sc.update(t);
		}
		expect(busy).toBe(false);
		expect(sc.atPhoto).toBe(false);
		sc.backToPhoto();
		n = 0;
		busy = true;
		while (busy && n++ < 500) {
			t += 16;
			busy = sc.update(t);
		}
		expect(sc.atPhoto).toBe(true);
	});

	it("backToPhoto fires onBack exactly once after arriving, also when already on the photo", () => {
		const onBack = vi.fn();
		const { sc } = make({ onBack });
		sc.backToPhoto();
		sc.update(1000);
		sc.update(1016);
		expect(onBack).toHaveBeenCalledTimes(1);
		sc.orbit(10, 0);
		sc.backToPhoto();
		let t = 2000;
		for (let i = 0; i < 400; i++) {
			t += 16;
			sc.update(t);
		}
		expect(onBack).toHaveBeenCalledTimes(2);
	});

	it("notifies the host on every move request", () => {
		const onChange = vi.fn();
		const { sc } = make({ onChange });
		sc.orbit(1, 1);
		sc.pan(1, 1);
		sc.dollyBy(1);
		expect(onChange).toHaveBeenCalledTimes(3);
		sc.dispose();
		sc.orbit(1, 1);
		expect(onChange).toHaveBeenCalledTimes(3);
	});
});

describe("StepCamera modes", () => {
	const flat = (z: number) => () => z;

	it("orbit starts where the camera is and pivots about the photo pivot", () => {
		const { cam, sc } = make();
		const modes: string[] = [];
		sc.onModeChange((m) => modes.push(m));
		sc.setMode("orbit");
		sc.snap();
		expect(modes).toEqual(["orbit"]);
		expect(cam.position.distanceTo(sc.eye)).toBeLessThan(1e-6);
		expect(cam.fov).toBeCloseTo(55, 6);
		// orbiting changes the camera position but keeps the pivot 30 m ahead fixed
		const pivot = sc.eye.clone().addScaledVector(fwd(sc.baseQ), 30);
		expect(cam.position.distanceTo(pivot)).toBeCloseTo(30, 5);
	});

	it("setMode to the current mode is a no-op, and a disposed camera ignores it", () => {
		const { sc } = make();
		const cb = vi.fn();
		sc.onModeChange(cb);
		sc.setMode("photo");
		expect(cb).not.toHaveBeenCalled();
		sc.dispose();
		sc.setMode("fly");
		expect(sc.mode).toBe("photo");
	});

	it("unsubscribed mode listeners are not called", () => {
		const { sc } = make();
		const cb = vi.fn();
		const off = sc.onModeChange(cb);
		off();
		sc.setMode("fly");
		expect(cb).not.toHaveBeenCalled();
	});

	it("fly keeps the camera above the terrain, even over a rising DEM", () => {
		const { cam, sc } = make({ groundAt: flat(1499) });
		sc.setMode("fly");
		sc.snap();
		expect(cam.fov).toBeCloseTo(60, 6);
		expect(cam.position.z).toBeGreaterThanOrEqual(1499 + 0.75 - 1e-9);
	});

	it("orbit lifts a camera that would end up under the terrain", () => {
		const { cam, sc } = make({ groundAt: flat(1400) });
		sc.setMode("orbit");
		sc.snap();
		expect(cam.position.z).toBeGreaterThanOrEqual(1400);
	});

	it("map mode is north-up and top-down on the ground ahead", () => {
		const { cam, sc } = make({ groundAt: flat(1000) });
		sc.setMode("map");
		sc.snap();
		const f = fwd(cam.quaternion);
		expect(f.z).toBeCloseTo(-1, 6);
		// screen-up points north
		const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
		expect(up.y).toBeGreaterThan(0.999);
		expect(cam.fov).toBeCloseTo(40, 6);
		// camera is far above the map plane (near-field close-up at least 250 m)
		expect(cam.position.z - 1000).toBeGreaterThanOrEqual(250 - 1e-6);
	});

	it("opened from the overview (easeIn style 'none') the map is centred on the eye at 5 km", () => {
		const { cam, sc } = make({ mode: "map", groundAt: flat(0) });
		sc.snap();
		expect(cam.position.x).toBeCloseTo(100, 6);
		expect(cam.position.y).toBeCloseTo(200, 6);
		expect(cam.position.z).toBeCloseTo(5000, 6);
	});

	it("a map driver takes over: start/setActive on entry, setActive(false) and orbit hand-over on exit", () => {
		const driver = {
			start: vi.fn(),
			setActive: vi.fn(),
			apply: vi.fn(),
			state: vi.fn(() => ({
				pivot: new THREE.Vector3(7, 8, 9),
				dist: 777,
				yaw: 0.3,
				pitch: -1.2,
			})),
			takeDirty: vi.fn(() => false),
		} satisfies StepMapDriver;
		const { cam, sc } = make({ mapDriver: driver });
		sc.setMode("map");
		expect(driver.start).toHaveBeenCalledTimes(1);
		expect(driver.setActive).toHaveBeenLastCalledWith(true);
		sc.update(1000);
		expect(driver.apply).toHaveBeenCalledWith(cam);
		sc.setMode("orbit");
		expect(driver.setActive).toHaveBeenLastCalledWith(false);
		sc.snap();
		// orbit continues from the driver's centre and distance
		const pivotDist = cam.position.distanceTo(new THREE.Vector3(7, 8, 9));
		expect(pivotDist).toBeCloseTo(777, 3);
	});

	it("leaving the driven map for the photo deactivates the driver", () => {
		const driver = {
			start: vi.fn(),
			setActive: vi.fn(),
			apply: vi.fn(),
			state: () => ({
				pivot: new THREE.Vector3(),
				dist: 100,
				yaw: 0,
				pitch: -1,
			}),
			takeDirty: () => false,
		};
		const { sc } = make({ mapDriver: driver });
		sc.setMode("map");
		sc.backToPhoto();
		expect(driver.setActive).toHaveBeenLastCalledWith(false);
		expect(sc.mode).toBe("photo");
	});
});

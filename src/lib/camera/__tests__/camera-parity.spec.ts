// @vitest-environment happy-dom
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The ENU view camera maths (ViewCamera, OrbitController, StepCamera, WorldCamera, DeckMapCamera,
// pose.ts) against values captured from the three.js code they replaced (camera-parity-reference.ts):
// same fixtures, same numbers.
import { Vector3 } from "@math.gl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorldCamera } from "#/lib/deck/world-view";
import { EnuFrame } from "#/lib/geodesy";
import { DeckMapCamera } from "#/lib/nearfield/deck-map-camera";
import { StepCamera, type StepCameraOpts } from "#/lib/nearfield/step-camera";
import { applyPose, poseQuaternion, unprojectDir } from "#/lib/pose";
import { ViewCamera } from "../view-camera";
import { THREE_REFERENCE as REF } from "./camera-parity-reference";

const near = (got: ArrayLike<number>, want: number[], tol = 1e-6) => {
	expect(got.length).toBeGreaterThanOrEqual(want.length);
	want.forEach((w, i) => {
		expect(Math.abs(got[i] - w), `[${i}] ${got[i]} vs ${w}`).toBeLessThan(tol);
	});
};
/** Quaternions double-cover rotations: compare orientation, not sign. */
const sameQuaternion = (got: ArrayLike<number>, want: number[]) => {
	const d =
		got[0] * want[0] + got[1] * want[1] + got[2] * want[2] + got[3] * want[3];
	expect(Math.abs(d)).toBeGreaterThan(1 - 1e-9);
};
/** A camera row: position, orientation, fov, and any extras that follow. */
const cameraRow = (c: ViewCamera, ...extra: number[]) => [
	c.position.x,
	c.position.y,
	c.position.z,
	c.quaternion.x,
	c.quaternion.y,
	c.quaternion.z,
	c.quaternion.w,
	c.fov,
	...extra,
];
const expectRow = (c: ViewCamera, key: string, tol = 1e-6) => {
	const want = REF[key];
	const row = cameraRow(c);
	near(row.slice(0, 3), want.slice(0, 3), tol);
	sameQuaternion(row.slice(3, 7), want.slice(3, 7));
	near([row[7]], [want[7]], tol);
};

const POSES = [
	{ yaw: 37, pitch: 12, roll: -6, vfov: 42 },
	{ yaw: 200, pitch: -25, roll: 10, vfov: 60 },
	{ yaw: 0, pitch: 0, roll: 0, vfov: 30 },
];

describe("pose.ts and ViewCamera vs the three.js camera", () => {
	POSES.forEach((pose, i) => {
		it(`pose ${i}: orientation, view and projection matrices`, () => {
			const cam = new ViewCamera(50, 1, 0.1, 2000);
			applyPose(cam, pose, 1.5, [5, -3, 2]);
			const want = REF[`pose${i}`];
			near(cameraRow(cam).slice(0, 3), want.slice(0, 3), 1e-9);
			sameQuaternion(cameraRow(cam).slice(3, 7), want.slice(3, 7));
			expect(cam.fov).toBe(pose.vfov);
			expect(cam.aspect).toBe(1.5);
			near(cam.projectionMatrix(), want.slice(8, 24), 1e-9);
			near(cam.viewMatrix(), want.slice(24, 40), 1e-9);
			sameQuaternion([...poseQuaternion(pose)], REF[`poseQ${i}`]);
			near(unprojectDir(pose, 1.5, 0.3, 0.8), REF[`unproj${i}`], 1e-9);
		});
	});

	it("view() hands the tiles view numbers: position, column-major matrices, fov, aspect", () => {
		const cam = new ViewCamera(42, 1.5, 0.1, 2000);
		applyPose(cam, POSES[0], 1.5, [5, -3, 2]);
		const v = cam.view();
		expect(v.position).toEqual([5, -3, 2]);
		expect(v.fovY).toBe(42);
		expect(v.aspect).toBe(1.5);
		near(v.viewMatrix, REF.pose0.slice(24, 40), 1e-9);
		near(v.projectionMatrix, REF.pose0.slice(8, 24), 1e-9);
	});
});

describe("StepCamera vs the three.js camera", () => {
	let now = 1000;
	beforeEach(() => {
		now = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
	});
	afterEach(() => vi.restoreAllMocks());

	const photoQuat = (yaw: number, pitch: number) =>
		poseQuaternion({ yaw, pitch, roll: 3, vfov: 40 });
	const make = (o: Partial<StepCameraOpts> = {}) => {
		const cam = new ViewCamera(50, 16 / 9, 0.1, 1e6);
		const sc = new StepCamera(cam, null, {
			eye: [100, 200, 1500],
			quaternion: photoQuat(30, 5),
			vfov: 40,
			aspect: 4 / 3,
			radius: 40,
			pivotDist: 30,
			groundAt: () => 1000,
			...o,
		});
		return { cam, sc };
	};
	// the private input handlers, called as the pointer / wheel / key listeners do
	type Inputs = {
		dragFree(dx: number, dy: number, alt: boolean, h: number): void;
		wheelFree(dy: number): void;
		keyFree(key: string): boolean;
		flyStep(dt: number): void;
		keys: Set<string>;
	};
	const inputs = (sc: StepCamera) => sc as unknown as Inputs;

	it("photo mode: start, orbit + pan + dolly, clamps, easing", () => {
		const { cam, sc } = make();
		expectRow(cam, "step_init");
		sc.orbit(7, -4);
		sc.pan(3, 2, 1);
		sc.dollyBy(5);
		sc.snap();
		expectRow(cam, "step_photo");
		sc.orbit(1000, 1000);
		sc.snap();
		expectRow(cam, "step_photo_clamped");
		const b = make();
		b.sc.orbit(5, 3);
		let t = 1000;
		for (let i = 0; i < 10; i++) {
			t += 16;
			b.sc.update(t);
		}
		expectRow(b.cam, "step_ease");
	});

	it("orbit, fly and map modes: drag, wheel, keys, transitions", () => {
		const { cam, sc } = make();
		now = 5000;
		sc.setMode("orbit");
		sc.update(5300);
		expectRow(cam, "step_orbit_trans");
		sc.snap();
		expectRow(cam, "step_orbit");
		inputs(sc).dragFree(40, -25, false, 600);
		inputs(sc).wheelFree(120);
		sc.snap();
		expectRow(cam, "step_orbit_drag");
		inputs(sc).dragFree(40, -25, true, 600);
		sc.snap();
		expectRow(cam, "step_orbit_pan");
		inputs(sc).keyFree("e");
		inputs(sc).keyFree("+");
		sc.snap();
		expectRow(cam, "step_orbit_keys");
		sc.setMode("fly");
		sc.snap();
		expectRow(cam, "step_fly");
		inputs(sc).dragFree(30, 10, false, 600);
		inputs(sc).keys.add("f");
		inputs(sc).keys.add("r");
		inputs(sc).flyStep(500);
		inputs(sc).wheelFree(-100);
		sc.snap();
		expectRow(cam, "step_fly_move");
		sc.setMode("map");
		sc.snap();
		expectRow(cam, "step_map");
		inputs(sc).dragFree(30, 10, true, 600);
		inputs(sc).keyFree("q");
		sc.snap();
		expectRow(cam, "step_map_rot");
		sc.setMode("orbit");
		sc.snap();
		expectRow(cam, "step_map_to_orbit");
	});

	it("opening in map mode, and the terrain clearance of orbit and fly", () => {
		const map = make({ mode: "map" });
		map.sc.snap();
		expectRow(map.cam, "step_map_open");
		const orbit = make({ groundAt: () => 1400 });
		orbit.sc.setMode("orbit");
		orbit.sc.snap();
		expectRow(orbit.cam, "step_orbit_ground");
		const fly = make({ groundAt: () => 1499 });
		fly.sc.setMode("fly");
		fly.sc.snap();
		expectRow(fly.cam, "step_fly_ground");
	});
});

describe("DeckMapCamera vs the three.js camera", () => {
	it("apply and state of a top-down and a tilted map camera", () => {
		const m = new DeckMapCamera(
			new EnuFrame(46.58, 8.0, 2000),
			() => null,
			() => {},
		);
		m.setSize(1000, 600);
		m.start(new Vector3(300, -200, 2100), 1500, 0.7);
		const cam = new ViewCamera();
		m.apply(cam);
		expectRow(cam, "map0", 1e-5);
		m.onViewStateChange({ ...m.viewState, pitch: 60, bearing: 90 });
		m.apply(cam);
		expectRow(cam, "map1", 1e-5);
		const s = m.state();
		near(
			[s.pivot.x, s.pivot.y, s.pivot.z, s.dist, s.yaw, s.pitch],
			REF.map_state,
			1e-5,
		);
	});
});

describe("WorldCamera and OrbitController vs three's OrbitControls", () => {
	let now = 1000;
	let canvas: HTMLCanvasElement;
	beforeEach(() => {
		now = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		canvas = document.createElement("canvas");
		Object.defineProperty(canvas, "clientHeight", { value: 600 });
		Object.assign(canvas, {
			setPointerCapture: () => {},
			releasePointerCapture: () => {},
		});
		document.body.append(canvas);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.innerHTML = "";
	});

	const send = (
		type: string,
		props: Record<string, unknown>,
		to: EventTarget,
	) => {
		const e = new Event(type, { bubbles: true, cancelable: true });
		Object.assign(e, {
			pointerId: 1,
			pointerType: "mouse",
			button: 0,
			clientX: 0,
			clientY: 0,
			pageX: 0,
			pageY: 0,
			shiftKey: false,
			ctrlKey: false,
			metaKey: false,
			...props,
		});
		to.dispatchEvent(e);
	};

	it("framing, drag rotate / pan / dolly, polar limit, wheel, touch, autorotate and the fly-in", () => {
		const pose = POSES[0];
		const eye: [number, number, number] = [10, 20, 1500];
		let changes = 0;
		const w = new WorldCamera(canvas, () => changes++);
		w.setAspect(1.6);
		w.enter(pose, eye);
		w.tick(pose, eye, 1.5);
		const c = w.controls;
		if (!c) throw new Error("no controls");
		expect(changes).toBeGreaterThan(0);
		const snap = () => [
			...cameraRow(w.cam),
			c.target.x,
			c.target.y,
			c.target.z,
		];
		const check = (key: string, tol = 1e-5) => {
			const row = snap();
			const want = REF[key];
			near(row.slice(0, 3), want.slice(0, 3), tol);
			sameQuaternion(row.slice(3, 7), want.slice(3, 7));
			near(row.slice(7), want.slice(7, 11), tol);
		};
		// the damped deltas decay as 0.95^n: 400 frames leave ~1e-9 of an input
		const settle = () => {
			for (let i = 0; i < 400; i++) w.tick(pose, eye, 1.5);
		};
		const drag = (props: Record<string, unknown>, dx: number, dy: number) => {
			send("pointerdown", { clientX: 300, clientY: 300, ...props }, canvas);
			send(
				"pointermove",
				{ clientX: 300 + dx, clientY: 300 + dy, ...props },
				document,
			);
			send("pointerup", props, document);
		};
		check("w_enter");
		drag({}, 80, -50);
		w.tick(pose, eye, 1.5);
		check("w_rot_1");
		settle();
		check("w_rot");
		drag({ button: 2 }, -60, 40);
		settle();
		check("w_pan");
		drag({ button: 0, shiftKey: true }, 30, 30);
		settle();
		check("w_pan_shift");
		drag({}, 0, 900);
		settle();
		check("w_polar_limit");
		drag({ button: 1 }, 0, -80);
		settle();
		check("w_mid_dolly");
		send("wheel", { deltaY: 200, deltaMode: 0 }, canvas);
		settle();
		check("w_wheel");
		send("wheel", { deltaY: -3, deltaMode: 1 }, canvas);
		settle();
		check("w_wheel_line");
		const touch = (
			type: string,
			id: number,
			x: number,
			y: number,
			to: EventTarget,
		) =>
			send(
				type,
				{
					pointerId: id,
					pointerType: "touch",
					pageX: x,
					pageY: y,
					clientX: x,
					clientY: y,
				},
				to,
			);
		touch("pointerdown", 1, 200, 300, canvas);
		touch("pointerdown", 2, 400, 300, canvas);
		touch("pointermove", 1, 150, 320, document);
		touch("pointermove", 2, 450, 320, document);
		touch("pointerup", 1, 0, 0, document);
		touch("pointerup", 2, 0, 0, document);
		settle();
		check("w_touch2");
		touch("pointerdown", 3, 200, 300, canvas);
		touch("pointermove", 3, 230, 280, document);
		touch("pointerup", 3, 0, 0, document);
		settle();
		check("w_touch1");
		c.autoRotate = true;
		c.autoRotateSpeed = 2;
		for (let i = 0; i < 30; i++) w.tick(pose, eye, 1.5);
		check("w_auto");
		c.autoRotate = false;
		settle();
		now = 20000;
		w.flyTo(pose, 1500);
		for (const t of [20300, 20750, 21100, 21600]) {
			now = t;
			w.tick(pose, eye, 1.5);
			const want = REF[`w_fly_${t}`];
			const row = cameraRow(w.cam, w.photoPlaneOpacity);
			near(row.slice(0, 3), want.slice(0, 3), 1e-5);
			sameQuaternion(row.slice(3, 7), want.slice(3, 7));
			near(row.slice(7), want.slice(7), 1e-7);
		}
		const v = w.viewState(eye);
		near(
			[...v.eye, ...v.forward, ...v.up, v.camFov, v.focalDistance],
			REF.w_viewState,
			1e-5,
		);
	});

	it("a disabled controller ignores input; dispose detaches the listeners", () => {
		const pose = POSES[0];
		const eye: [number, number, number] = [0, 0, 1000];
		const w = new WorldCamera(canvas, () => {});
		w.enter(pose, eye);
		const c = w.controls;
		if (!c) throw new Error("no controls");
		const before = [...w.cam.position];
		c.enabled = false;
		send("pointerdown", { clientX: 300, clientY: 300 }, canvas);
		send("pointermove", { clientX: 400, clientY: 300 }, document);
		w.tick(pose, eye, 1);
		near([...w.cam.position], before, 1e-9);
		w.dispose();
		expect(w.controls).toBeUndefined();
		expect(canvas.style.touchAction).toBe("");
	});
});

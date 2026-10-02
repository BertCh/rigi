// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Orbit / pan / dolly controller for a ViewCamera in the ENU world (z up), driven by pointer and
// wheel events on one element. The camera orbits `target` at a spherical offset (azimuth about z,
// polar angle from +z), with damping: input accumulates a delta that `update()` applies a fraction
// of per call and decays.
//
//   mouse   left drag = orbit; right drag, or shift / ctrl / meta + left drag = pan (in the horizontal
//           plane, never lifting the target); middle drag and the wheel = dolly.
//   touch   one finger = orbit; two fingers = dolly (pinch) + pan (their midpoint).
//
// `update()` runs once per frame (the world camera's tick): it applies the damped deltas, writes the
// camera position and orientation (looking at the target, screen-up toward +z), and emits "change"
// when the camera moved. "start" / "end" bracket an interaction (a drag, a touch, one wheel step).
import { Quaternion, Vector3 } from "@math.gl/core";
import { lookAtQuaternion, type ViewCamera } from "./view-camera";

export type OrbitEvent = "start" | "change" | "end";

type State =
	| "none"
	| "rotate"
	| "dolly"
	| "pan"
	| "touchRotate"
	| "touchDollyPan";

const TWO_PI = Math.PI * 2;
/** Polar angle margin that keeps the camera off the poles. */
const POLE_EPS = 1e-6;
/** Camera movement (m² / rad²-ish) below which "change" is not emitted. */
const MOVE_EPS = 1e-6;
const WORLD_UP = new Vector3(0, 0, 1);

export type OrbitOptions = {
	/** Damping (inertia) factor per update, 0..1. Default 0.05; 1 applies input at once. */
	dampingFactor?: number;
	/** Largest polar angle (rad from straight up). Default just under the horizon, 0.495 π. */
	maxPolarAngle?: number;
	minDistance?: number;
	maxDistance?: number;
};

export class OrbitController {
	/** The point the camera orbits. Set it, then call update(). */
	readonly target = new Vector3();
	enabled = true;
	/** Slow azimuth drift while idle (≈ 30 s per turn at 60 fps for speed 2, no deltaTime). */
	autoRotate = false;
	autoRotateSpeed = 2;
	dampingFactor: number;
	maxPolarAngle: number;
	minDistance: number;
	maxDistance: number;
	private state: State = "none";
	private listeners: Record<OrbitEvent, Set<() => void>> = {
		start: new Set(),
		change: new Set(),
		end: new Set(),
	};
	// accumulated input, applied (damped) by update()
	private dTheta = 0;
	private dPhi = 0;
	private scale = 1;
	private readonly panOffset = new Vector3();
	// pointer tracking
	private pointers: number[] = [];
	private positions = new Map<number, [number, number]>();
	private start: [number, number] = [0, 0];
	private dollyStart = 0;
	private controlHeld = false;
	// last emitted camera state
	private emitted = false;
	private lastPosition = new Vector3();
	private lastQuaternion = new Quaternion();
	private lastTarget = new Vector3();
	private disposeDom: () => void;

	constructor(
		readonly camera: ViewCamera,
		private readonly dom: HTMLElement,
		options: OrbitOptions = {},
	) {
		this.dampingFactor = options.dampingFactor ?? 0.05;
		this.maxPolarAngle = options.maxPolarAngle ?? Math.PI * 0.495;
		this.minDistance = options.minDistance ?? 0;
		this.maxDistance = options.maxDistance ?? Number.POSITIVE_INFINITY;
		this.disposeDom = this.connect();
	}

	/** Subscribe to "start" | "change" | "end"; returns the unsubscribe. */
	on(type: OrbitEvent, fn: () => void) {
		this.listeners[type].add(fn);
		return () => this.listeners[type].delete(fn);
	}

	/** Distance from the camera to the target. */
	get distance() {
		return this.camera.position.distanceTo(this.target);
	}

	dispose() {
		this.disposeDom();
		for (const set of Object.values(this.listeners)) set.clear();
	}

	/**
	 * Apply the damped input to the camera. Call once per frame, and after moving the camera or the
	 * target by hand. Returns true (and emits "change") when the camera moved.
	 */
	update(deltaTime: number | null = null) {
		const cam = this.camera;
		const offset = cam.position.clone().subtract(this.target);
		const radius0 = offset.len();
		// spherical about +z: azimuth theta = atan2(x, −y) (0 looks north from the south side)
		let theta = radius0 === 0 ? 0 : Math.atan2(offset.x, -offset.y);
		let phi =
			radius0 === 0
				? 0
				: Math.acos(Math.max(-1, Math.min(1, offset.z / radius0)));
		if (this.autoRotate && this.state === "none")
			this.dTheta -=
				deltaTime === null
					? (TWO_PI / 60 / 60) * this.autoRotateSpeed
					: (TWO_PI / 60) * this.autoRotateSpeed * deltaTime;
		const damp = this.dampingFactor;
		theta += this.dTheta * damp;
		phi += this.dPhi * damp;
		phi = Math.max(0, Math.min(this.maxPolarAngle, phi));
		phi = Math.max(POLE_EPS, Math.min(Math.PI - POLE_EPS, phi));
		this.target.addScaledVector(this.panOffset, damp);
		const radius = Math.max(
			this.minDistance,
			Math.min(this.maxDistance, radius0 * this.scale),
		);
		const zoomChanged = radius !== radius0;
		const sinPhi = Math.sin(phi);
		cam.position.set(
			this.target.x + radius * sinPhi * Math.sin(theta),
			this.target.y - radius * sinPhi * Math.cos(theta),
			this.target.z + radius * Math.cos(phi),
		);
		lookAtQuaternion(cam.quaternion, cam.position, this.target, WORLD_UP);
		this.dTheta *= 1 - damp;
		this.dPhi *= 1 - damp;
		this.panOffset.scale(1 - damp);
		this.scale = 1;
		if (
			!this.emitted ||
			zoomChanged ||
			this.lastPosition.distanceToSquared(cam.position) > MOVE_EPS ||
			8 * (1 - this.lastQuaternion.dot(cam.quaternion)) > MOVE_EPS ||
			this.lastTarget.distanceToSquared(this.target) > MOVE_EPS
		) {
			this.emit("change");
			this.lastPosition.copy(cam.position);
			this.lastQuaternion.copy(cam.quaternion);
			this.lastTarget.copy(this.target);
			this.emitted = true;
			return true;
		}
		return false;
	}

	private emit(type: OrbitEvent) {
		for (const fn of this.listeners[type]) fn();
	}

	// ---- input accumulation ----

	private rotateBy(dxPx: number, dyPx: number) {
		const h = this.dom.clientHeight || 1; // height for both axes: a full viewport height = one turn
		this.dTheta -= (TWO_PI * dxPx) / h;
		this.dPhi -= (TWO_PI * dyPx) / h;
	}

	/** Pan by a pointer delta in pixels (right and down positive) on the horizontal plane. */
	private panBy(dxPx: number, dyPx: number) {
		const cam = this.camera;
		const reach =
			cam.position.distanceTo(this.target) *
			Math.tan((cam.fov / 2) * (Math.PI / 180));
		const k = (2 * reach) / (this.dom.clientHeight || 1);
		const right = cam.right();
		this.panOffset.addScaledVector(right, -dxPx * k);
		// forward along the ground: up × right
		this.panOffset.addScaledVector(WORLD_UP.clone().cross(right), dyPx * k);
	}

	/** Move toward the target: the orbit radius shrinks by `scale` (< 1). */
	private dollyIn(scale: number) {
		this.scale *= scale;
	}

	/** Move away from the target: the orbit radius grows by 1 / `scale` (`scale` < 1). */
	private dollyOut(scale: number) {
		this.scale /= scale;
	}

	private static zoomScale(delta: number) {
		return 0.95 ** Math.abs(delta * 0.01);
	}

	// ---- DOM wiring ----

	private connect() {
		const dom = this.dom;
		const doc = dom.ownerDocument;
		const root = dom.getRootNode() as Document;
		const onDown = (e: PointerEvent) => this.pointerDown(e, doc);
		const onWheel = (e: WheelEvent) => this.wheel(e);
		const onMenu = (e: Event) => {
			if (this.enabled) e.preventDefault();
		};
		const onUp = (e: PointerEvent) => this.pointerUp(e, doc);
		const onMove = (e: PointerEvent) => this.pointerMove(e);
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Control") this.controlHeld = e.type === "keydown";
		};
		this.docMove = onMove;
		this.docUp = onUp;
		dom.addEventListener("pointerdown", onDown);
		dom.addEventListener("pointercancel", onUp);
		dom.addEventListener("contextmenu", onMenu);
		dom.addEventListener("wheel", onWheel, { passive: false });
		root.addEventListener("keydown", onKey, { passive: true, capture: true });
		root.addEventListener("keyup", onKey, { passive: true, capture: true });
		dom.style.touchAction = "none"; // no browser scroll or zoom on the canvas
		return () => {
			this.state = "none";
			dom.removeEventListener("pointerdown", onDown);
			dom.removeEventListener("pointercancel", onUp);
			dom.removeEventListener("contextmenu", onMenu);
			dom.removeEventListener("wheel", onWheel);
			doc.removeEventListener("pointermove", onMove);
			doc.removeEventListener("pointerup", onUp);
			root.removeEventListener("keydown", onKey, { capture: true });
			root.removeEventListener("keyup", onKey, { capture: true });
			this.pointers.length = 0;
			this.positions.clear();
			dom.style.touchAction = "";
		};
	}

	private docMove?: (e: PointerEvent) => void;
	private docUp?: (e: PointerEvent) => void;

	private pointerDown(e: PointerEvent, doc: Document) {
		if (!this.enabled) return;
		if (this.pointers.length === 0) {
			this.dom.setPointerCapture(e.pointerId);
			if (this.docMove) doc.addEventListener("pointermove", this.docMove);
			if (this.docUp) doc.addEventListener("pointerup", this.docUp);
		}
		if (this.pointers.includes(e.pointerId)) return;
		this.pointers.push(e.pointerId);
		if (e.pointerType === "touch") this.touchStart(e);
		else this.mouseDown(e);
	}

	private pointerMove(e: PointerEvent) {
		if (!this.enabled) return;
		if (e.pointerType === "touch") this.touchMove(e);
		else this.mouseMove(e);
	}

	private pointerUp(e: PointerEvent, doc: Document) {
		this.positions.delete(e.pointerId);
		const i = this.pointers.indexOf(e.pointerId);
		if (i >= 0) this.pointers.splice(i, 1);
		if (this.pointers.length === 0) {
			this.dom.releasePointerCapture(e.pointerId);
			if (this.docMove) doc.removeEventListener("pointermove", this.docMove);
			if (this.docUp) doc.removeEventListener("pointerup", this.docUp);
			this.emit("end");
			this.state = "none";
		} else if (this.pointers.length === 1) {
			// one finger left: restart as a rotate from where it is
			const id = this.pointers[0];
			const p = this.positions.get(id);
			if (p) this.touchStart({ pointerId: id, pageX: p[0], pageY: p[1] });
		}
	}

	private mouseDown(e: PointerEvent) {
		const modifier = e.ctrlKey || e.metaKey || e.shiftKey;
		this.start = [e.clientX, e.clientY];
		if (e.button === 0) this.state = modifier ? "pan" : "rotate";
		else if (e.button === 1) {
			this.dollyStart = e.clientY;
			this.state = "dolly";
		} else if (e.button === 2) this.state = modifier ? "rotate" : "pan";
		else this.state = "none";
		if (this.state !== "none") this.emit("start");
	}

	private mouseMove(e: PointerEvent) {
		const dx = e.clientX - this.start[0];
		const dy = e.clientY - this.start[1];
		switch (this.state) {
			case "rotate":
				this.rotateBy(dx, dy);
				this.start = [e.clientX, e.clientY];
				break;
			case "pan":
				this.panBy(dx, dy);
				this.start = [e.clientX, e.clientY];
				break;
			case "dolly": {
				const d = e.clientY - this.dollyStart;
				if (d > 0) this.dollyOut(OrbitController.zoomScale(d));
				else if (d < 0) this.dollyIn(OrbitController.zoomScale(d));
				this.dollyStart = e.clientY;
				break;
			}
			default:
				return;
		}
		this.update();
	}

	private wheel(e: WheelEvent) {
		if (!this.enabled || this.state !== "none") return;
		e.preventDefault();
		let delta = e.deltaY;
		if (e.deltaMode === 1)
			delta *= 16; // lines
		else if (e.deltaMode === 2) delta *= 100; // pages
		if (e.ctrlKey && !this.controlHeld) delta *= 10; // a trackpad pinch arrives as ctrl + wheel
		this.emit("start");
		if (delta < 0) this.dollyIn(OrbitController.zoomScale(delta));
		else if (delta > 0) this.dollyOut(OrbitController.zoomScale(delta));
		this.update();
		this.emit("end");
	}

	/** The centre of the touch points (one or two) and, for two, their spacing. */
	private touchCentre(e: { pointerId: number; pageX: number; pageY: number }) {
		if (this.pointers.length === 1) return { x: e.pageX, y: e.pageY, gap: 0 };
		const otherId =
			e.pointerId === this.pointers[0] ? this.pointers[1] : this.pointers[0];
		const o = this.positions.get(otherId) ?? [e.pageX, e.pageY];
		return {
			x: 0.5 * (e.pageX + o[0]),
			y: 0.5 * (e.pageY + o[1]),
			gap: Math.hypot(e.pageX - o[0], e.pageY - o[1]),
		};
	}

	private touchStart(e: { pointerId: number; pageX: number; pageY: number }) {
		this.positions.set(e.pointerId, [e.pageX, e.pageY]);
		if (this.pointers.length === 1) {
			const c = this.touchCentre(e);
			this.start = [c.x, c.y];
			this.state = "touchRotate";
		} else if (this.pointers.length === 2) {
			const c = this.touchCentre(e);
			this.dollyStart = c.gap;
			this.start = [c.x, c.y];
			this.state = "touchDollyPan";
		} else this.state = "none";
		if (this.state !== "none") this.emit("start");
	}

	private touchMove(e: PointerEvent) {
		this.positions.set(e.pointerId, [e.pageX, e.pageY]);
		const c = this.touchCentre(e);
		const dx = c.x - this.start[0];
		const dy = c.y - this.start[1];
		if (this.state === "touchRotate") {
			this.rotateBy(dx, dy);
		} else if (this.state === "touchDollyPan") {
			// pinch: the ratio of finger spacings is a dolly out; the midpoint drags the ground
			this.dollyOut(c.gap / this.dollyStart);
			this.dollyStart = c.gap;
			this.panBy(dx, dy);
		} else {
			this.state = "none";
			return;
		}
		this.start = [c.x, c.y];
		this.update();
	}
}

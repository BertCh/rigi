// The deck step camera's map mode ("Top-down"): deck's own map camera. A hidden MapView (MAP_VIEW_ID;
// the engine's layerFilter draws nothing in it) carries deck's MapController: drag pans the ground
// under the pointer, the wheel zooms about the pointer, right / ctrl drag rotates and tilts, two-finger
// touch rotates, inertia, arrows / +/- keys. Its web-mercator camera is converted into the ENU world
// camera each frame, so every layer stays CARTESIAN ENU and the world view draws as before.
//
// Like deck's TerrainController, the map plane (the controller's z = 0) sits at the ground under the
// view centre (absolute height h0). It is re-anchored when an interaction ends, without moving the
// camera, and the camera is kept above the terrain.

import { MapView, type MapViewState, WebMercatorViewport } from "@deck.gl/core";
import * as THREE from "three";
import { DEG, type EnuFrame } from "../geodesy";
import type { StepMapDriver } from "./step-camera";

export const MAP_VIEW_ID = "stepmap";

/** Metres kept between the map camera and the terrain. */
const CLEARANCE = 5;
const LIMITS = { minZoom: 6, maxZoom: 21, minPitch: 0, maxPitch: 80 };

type VS = MapViewState & typeof LIMITS;

export class DeckMapCamera implements StepMapDriver {
	/** Add to the deck's views while active (the engine switches it with setActive). */
	readonly view = new MapView({
		id: MAP_VIEW_ID,
		controller: {
			dragRotate: true,
			touchRotate: true,
			keyboard: true,
			doubleClickZoom: true,
			inertia: 300,
		},
	});
	active = false;
	private vs: VS = {
		longitude: 0,
		latitude: 0,
		zoom: 12,
		pitch: 0,
		bearing: 0,
		...LIMITS,
	};
	/** Absolute height (m) of the map plane. */
	private h0 = 0;
	private dirty = false;
	private size = { w: 1, h: 1 };

	constructor(
		private frame: EnuFrame,
		/** Terrain height (ENU z) under ENU (x, y), or null off the DEM. */
		private groundAt: (x: number, y: number) => number | null,
		/** The engine's hook: the view list changed (setActive) or the view state moved. */
		private onChange: (views: boolean) => void,
	) {}

	/** The canvas' CSS size (the MapView's viewport size). */
	setSize(w: number, h: number) {
		this.size = { w: Math.max(1, w), h: Math.max(1, h) };
	}

	/** The deck view state for MAP_VIEW_ID. */
	get viewState(): VS {
		return this.vs;
	}

	setActive(on: boolean) {
		if (on === this.active) return;
		this.active = on;
		this.onChange(true);
	}

	start(pivot: THREE.Vector3, dist: number, yaw: number) {
		const g = this.frame.toGeo(pivot.x, pivot.y, pivot.z);
		this.h0 = g.h;
		this.vs = {
			...this.vs,
			longitude: g.lon,
			latitude: g.lat,
			pitch: 0,
			bearing: yaw / DEG,
			zoom: 12,
		};
		this.vs.zoom = this.zoomFor(this.vs, dist);
		this.dirty = true;
	}

	/**
	 * deck onViewStateChange for MAP_VIEW_ID. A move that would put the camera under the terrain keeps
	 * the previous zoom and pitch (and then the previous centre).
	 */
	onViewStateChange(next: MapViewState) {
		let vs: VS = { ...this.vs, ...next, ...LIMITS };
		if (this.underground(vs))
			vs = { ...vs, zoom: this.vs.zoom, pitch: this.vs.pitch };
		if (this.underground(vs)) vs = { ...this.vs, bearing: vs.bearing };
		this.vs = vs;
		this.dirty = true;
		this.onChange(false);
	}

	/** deck onInteractionStateChange, once nothing moves: re-anchor the map plane. */
	settle() {
		if (!this.reanchor()) return;
		this.dirty = true;
		this.onChange(false);
	}

	takeDirty() {
		const d = this.dirty;
		this.dirty = false;
		return d;
	}

	apply(cam: THREE.PerspectiveCamera) {
		const { pos, target, fovy } = this.pose(this.vs);
		const f = target.clone().sub(pos).normalize();
		const b = (this.vs.bearing ?? 0) * DEG;
		const h = new THREE.Vector3(Math.sin(b), Math.cos(b), 0);
		const up = h.addScaledVector(f, -h.dot(f)).normalize();
		const right = new THREE.Vector3().crossVectors(f, up);
		cam.position.copy(pos);
		cam.quaternion.setFromRotationMatrix(
			new THREE.Matrix4().makeBasis(right, up, f.negate()),
		);
		cam.fov = fovy;
	}

	state() {
		const { pos, target } = this.pose(this.vs);
		return {
			pivot: target,
			dist: pos.distanceTo(target),
			yaw: (this.vs.bearing ?? 0) * DEG,
			pitch: ((this.vs.pitch ?? 0) - 90) * DEG,
		};
	}

	private viewport(vs: MapViewState) {
		return new WebMercatorViewport({
			...vs,
			width: this.size.w,
			height: this.size.h,
		});
	}

	/** The map camera in ENU: its position, the view centre on the map plane, and the vertical FOV. */
	private pose(vs: MapViewState) {
		const vp = this.viewport(vs);
		const [lon, lat, z] = vp.unprojectPosition(vp.cameraPosition);
		const pos = new THREE.Vector3(
			...(this.frame.fromGeo(lat, lon, z + this.h0) as [
				number,
				number,
				number,
			]),
		);
		const target = new THREE.Vector3(
			...(this.frame.fromGeo(vs.latitude, vs.longitude, this.h0) as [
				number,
				number,
				number,
			]),
		);
		return { pos, target, fovy: vp.fovy };
	}

	/** Zoom at which the camera stands `dist` metres from the view centre (distance ∝ 2^−zoom). */
	private zoomFor(vs: MapViewState, dist: number) {
		const { pos, target } = this.pose(vs);
		const d = pos.distanceTo(target);
		return Math.min(
			LIMITS.maxZoom,
			Math.max(LIMITS.minZoom, vs.zoom + Math.log2(d / Math.max(1, dist))),
		);
	}

	private underground(vs: MapViewState) {
		const { pos } = this.pose(vs);
		const g = this.groundAt(pos.x, pos.y);
		return g != null && pos.z < g + CLEARANCE;
	}

	/**
	 * Move the map plane to the ground under the view centre, keeping the camera where it is: the new
	 * centre is where the view ray meets the new plane, the zoom keeps the camera distance.
	 */
	private reanchor(): boolean {
		const { pos, target } = this.pose(this.vs);
		const g = this.groundAt(target.x, target.y);
		if (g == null) return false;
		const gh = this.frame.toGeo(target.x, target.y, g).h;
		if (Math.abs(gh - this.h0) < 1) return false;
		const f = target.clone().sub(pos).normalize();
		// the camera must stay above the new plane, looking down onto it
		if (f.z > -1e-3) return false;
		const t = (g - pos.z) / f.z;
		if (!(t > 1)) return false;
		const c = pos.clone().addScaledVector(f, t);
		const cg = this.frame.toGeo(c.x, c.y, c.z);
		const h0 = this.h0;
		this.h0 = cg.h;
		const vs = { ...this.vs, longitude: cg.lon, latitude: cg.lat };
		vs.zoom = this.zoomFor(vs, t);
		if (vs.zoom <= LIMITS.minZoom || vs.zoom >= LIMITS.maxZoom) {
			this.h0 = h0;
			return false;
		}
		this.vs = vs;
		return true;
	}
}

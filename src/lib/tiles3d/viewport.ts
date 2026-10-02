// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The Step Inside world camera as the structural geospatial viewport @loaders.gl/tiles' Tileset3D
// traverses with (deck's WebMercatorViewport contract, @loaders.gl/tiles frame-state.ts). Our world is
// a plain ENU frame (frame.ts) with no Web Mercator, so this class answers the few things traversal asks:
//   · unprojectPosition: an ENU point (m) → [lon°, lat°, height m] via the tileset's own ENU←ECEF matrix
//     (so a source's geoid lowering is inside it: swisstopo N = 0, Google N applied)
//   · cameraPosition / cameraUp / cameraDirection, in ENU metres (`center` = the ENU origin, so
//     loaders' east-north-up frame at the viewport centre IS ours)
//   · getFrustumPlanes: from the pose, fovY and aspect, with the far plane at `far` (the near-field radius:
//     tiles beyond it are culled by traversal, so they never download)
// Convention: view matrices are ENU world → camera, column-major, looking down -Z (GL / three).

import { Matrix4, Vector3 } from "@math.gl/core";
import { Ellipsoid } from "@math.gl/geospatial";
import type { Vec3 } from "#/lib/ontology/core/geometry";

/** What the camera agent hands update(): see DeckTiles3D. */
export type StepView = {
	position: Vec3;
	/** 16 floats, column-major, ENU world → camera. */
	viewMatrix: ArrayLike<number>;
	/** 16 floats, column-major (unused by traversal: fovY / aspect describe the frustum). */
	projectionMatrix: ArrayLike<number>;
	/** Vertical field of view in degrees. */
	fovY: number;
	aspect: number;
};

export type FrustumPlane = { normal: Vector3; distance: number };

export type EnuViewportProps = {
	id: string;
	view: StepView;
	width: number;
	height: number;
	/** ENU ← ECEF placement of the tileset (frame.ts); geoid already inside. */
	enuFromEcef: Matrix4;
	/** Far plane distance from the camera, m. */
	far: number;
	origin: { lat: number; lon: number };
};

const NEAR = 0.5;

export class EnuViewport {
	readonly id: string;
	readonly width: number;
	readonly height: number;
	readonly zoom = 0;
	readonly fovy: number;
	readonly orthographic = false;
	readonly longitude: number;
	readonly latitude: number;
	readonly bearing = 0;
	readonly position = [0, 0, 0];
	readonly center = [0, 0, 0];
	readonly cameraPosition: number[];
	readonly cameraUp: [number, number, number];
	readonly cameraDirection: [number, number, number];
	readonly distanceScales = {
		unitsPerMeter: [1, 1, 1],
		metersPerUnit: [1, 1, 1],
	};
	private readonly ecefFromEnu: Matrix4;
	private readonly planes: Record<string, FrustumPlane>;

	/** Tileset3D builds its top-down viewport with `new viewport.constructor(props)`: any bag works. */
	constructor(props: EnuViewportProps | Record<string, unknown>) {
		const p = props as Partial<EnuViewportProps> & Record<string, unknown>;
		this.id = p.id ?? "step";
		this.width = (p.width as number) ?? 1;
		this.height = (p.height as number) ?? 1;
		this.longitude = p.origin?.lon ?? (p.longitude as number) ?? 0;
		this.latitude = p.origin?.lat ?? (p.latitude as number) ?? 0;
		const view = p.view;
		const enuFromEcef = p.enuFromEcef;
		if (!view || !enuFromEcef) {
			// the unused top-down clone
			this.fovy = 60;
			this.cameraPosition = [0, 0, 0];
			this.cameraUp = [0, 0, 1];
			this.cameraDirection = [0, 1, 0];
			this.ecefFromEnu = new Matrix4();
			this.planes = {};
			return;
		}
		this.fovy = view.fovY;
		this.ecefFromEnu = new Matrix4(enuFromEcef).invert();
		const m = view.viewMatrix;
		// camera basis in world = rows of the rotation block (column-major storage)
		const right = new Vector3(m[0], m[4], m[8]).normalize();
		const up = new Vector3(m[1], m[5], m[9]).normalize();
		const forward = new Vector3(-m[2], -m[6], -m[10]).normalize();
		this.cameraPosition = [...view.position];
		this.cameraUp = [up.x, up.y, up.z];
		this.cameraDirection = [forward.x, forward.y, forward.z];
		this.planes = frustumPlanes(
			view.position,
			right,
			up,
			forward,
			view.fovY,
			view.aspect,
			p.far ?? 3000,
		);
	}

	/** ENU metres → [lon°, lat°, h m] (WGS84, through the tileset's own placement). */
	unprojectPosition(position: ArrayLike<number>): [number, number, number] {
		const ecef = this.ecefFromEnu.transformAsPoint([
			position[0],
			position[1],
			position[2] ?? 0,
		]) as number[];
		return Ellipsoid.WGS84.cartesianToCartographic(
			ecef,
			new Vector3(),
		) as unknown as [number, number, number];
	}

	/** Not used by traversal; ENU is not projected here. */
	project(coordinates: ArrayLike<number>): number[] {
		return [coordinates[0], coordinates[1], coordinates[2] ?? 0];
	}

	/** Planes as deck's viewport returns them (normal · x = distance); loaders re-orients them. */
	getFrustumPlanes(): Record<string, FrustumPlane> {
		return this.planes;
	}
}

/** Inward-facing frustum planes in ENU for a perspective camera at `pos`. */
export function frustumPlanes(
	pos: ArrayLike<number>,
	right: Vector3,
	up: Vector3,
	forward: Vector3,
	fovYDeg: number,
	aspect: number,
	far: number,
): Record<string, FrustumPlane> {
	const tanY = Math.tan((fovYDeg * Math.PI) / 360);
	const tanX = tanY * aspect;
	const p = new Vector3(pos[0], pos[1], pos[2]);
	const make = (n: Vector3, offset = 0): FrustumPlane => {
		const normal = n.normalize();
		return { normal, distance: normal.dot(p) + offset };
	};
	const along = (axis: Vector3, scale: number, sign: number) =>
		new Vector3(axis).scale(sign).add(new Vector3(forward).scale(scale));
	return {
		left: make(along(right, tanX, 1)),
		right: make(along(right, tanX, -1)),
		bottom: make(along(up, tanY, 1)),
		top: make(along(up, tanY, -1)),
		near: make(new Vector3(forward), NEAR),
		// inward-facing like the others: points back at the camera
		far: make(new Vector3(forward).scale(-1), -far),
	};
}

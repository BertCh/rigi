// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The renderer-side perspective camera: a position and an orientation in the ENU world (x = East,
// y = North, z = Up), a vertical FOV and an aspect. It carries no scene graph and draws nothing; the
// world view, the Step Inside camera and the 3D Tiles view read it. Conventions: the camera looks
// down its own −z, camera y is up, vfov is in degrees, matrices are column-major (WebGL clip, −1..1
// depth). `quaternion` rotates camera space into the ENU world.
import { Matrix4, Quaternion, Vector3 } from "@math.gl/core";
import type { Vec3 } from "#/lib/ontology/core/geometry";

const WORLD_UP: Vec3 = [0, 0, 1];
const DEG = Math.PI / 180;

/** What a view consumer (3D Tiles selection, a deck viewport) needs of a camera, as plain numbers. */
export type CameraView = {
	position: Vec3;
	/** ENU world → camera, 16 numbers, column-major. */
	viewMatrix: number[];
	/** Camera → WebGL clip, 16 numbers, column-major. */
	projectionMatrix: number[];
	/** Vertical FOV, degrees. */
	fovY: number;
	aspect: number;
};

export class ViewCamera {
	readonly position = new Vector3();
	readonly quaternion = new Quaternion();

	constructor(
		public fov = 55,
		public aspect = 1,
		public near = 5,
		public far = 600_000,
	) {}

	/** The position as a plain tuple. */
	get eye(): Vec3 {
		return [this.position.x, this.position.y, this.position.z];
	}

	/** World direction the camera looks along. */
	forward(out = new Vector3()) {
		return out.set(0, 0, -1).transformByQuaternion(this.quaternion);
	}

	/** World direction of the screen's up edge. */
	up(out = new Vector3()) {
		return out.set(0, 1, 0).transformByQuaternion(this.quaternion);
	}

	/** World direction of the screen's right edge. */
	right(out = new Vector3()) {
		return out.set(1, 0, 0).transformByQuaternion(this.quaternion);
	}

	/** ENU world → camera space (the inverse of the camera's rigid transform). */
	viewMatrix(): Matrix4 {
		const r = this.right();
		const u = this.up();
		const b = new Vector3(0, 0, 1).transformByQuaternion(this.quaternion);
		const p = this.position;
		// rows of the view rotation are the camera axes; the translation is −R·p
		return new Matrix4([
			r.x,
			u.x,
			b.x,
			0,
			r.y,
			u.y,
			b.y,
			0,
			r.z,
			u.z,
			b.z,
			0,
			-r.dot(p),
			-u.dot(p),
			-b.dot(p),
			1,
		]); // prettier-ignore
	}

	projectionMatrix(): Matrix4 {
		return new Matrix4().perspective({
			fovy: this.fov * DEG,
			aspect: this.aspect,
			near: this.near,
			far: this.far,
		});
	}

	view(): CameraView {
		return {
			position: this.eye,
			viewMatrix: [...this.viewMatrix()],
			projectionMatrix: [...this.projectionMatrix()],
			fovY: this.fov,
			aspect: this.aspect,
		};
	}
}

/** Camera orientation from its axes expressed in the world: right (+x), up (+y), back (+z = −forward). */
export function quaternionFromBasis(
	out: Quaternion,
	right: ArrayLike<number>,
	up: ArrayLike<number>,
	back: ArrayLike<number>,
) {
	// column-major 3×3 whose columns are the camera axes
	return out.fromMatrix3([
		right[0],
		right[1],
		right[2],
		up[0],
		up[1],
		up[2],
		back[0],
		back[1],
		back[2],
	]); // prettier-ignore
}

/** Orientation of a camera at `eye` looking at `target` with screen-up as close to `up` as possible. */
export function lookAtQuaternion(
	out: Quaternion,
	eye: ArrayLike<number>,
	target: ArrayLike<number>,
	up: ArrayLike<number> = WORLD_UP,
) {
	const back = new Vector3(eye[0], eye[1], eye[2]).subtract(target as Vec3);
	if (back.lengthSquared() === 0) back.z = 1;
	back.normalize();
	const right = new Vector3(up[0], up[1], up[2]).cross(back);
	if (right.lengthSquared() === 0) {
		// looking along `up`: any perpendicular will do
		if (Math.abs(up[2]) === 1) back.x += 1e-4;
		else back.z += 1e-4;
		back.normalize();
		right.set(up[0], up[1], up[2]).cross(back);
	}
	right.normalize();
	const screenUp = back.clone().cross(right);
	return quaternionFromBasis(out, right, screenUp, back);
}

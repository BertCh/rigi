// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The camera model in ./camera (Pose conventions are documented there) as math.gl vectors and as a
// ViewCamera orientation.
import { Quaternion, Vector3 } from "@math.gl/core";
import type { Pose } from "./camera";
import * as camera from "./camera";
import { quaternionFromBasis, type ViewCamera } from "./camera/view-camera";

const vec3 = (a: ArrayLike<number>) => new Vector3(a[0], a[1], a[2]);

export function poseBasis(p: Pose) {
	const { forward, right, up } = camera.poseBasis(p);
	return { forward: vec3(forward), right: vec3(right), up: vec3(up) };
}

/** The ViewCamera orientation of a photo pose (camera looks along the pose's forward, −z). */
export function poseQuaternion(p: Pose, out = new Quaternion()) {
	const { forward, right, up } = camera.poseBasis(p);
	return quaternionFromBasis(out, right, up, [
		-forward[0],
		-forward[1],
		-forward[2],
	]);
}

/** Put `cam` at `eye` looking as the photo of pose `p` does, with `aspect` as its viewport aspect. */
export function applyPose(
	cam: ViewCamera,
	p: Pose,
	aspect: number,
	eye: ArrayLike<number> = [0, 0, 0],
) {
	cam.position.set(eye[0], eye[1], eye[2]);
	poseQuaternion(p, cam.quaternion);
	cam.fov = p.vfov;
	cam.aspect = aspect;
}

/** camera.unprojectDir as a math.gl Vector3. */
export const unprojectDir = (p: Pose, aspect: number, u: number, v: number) =>
	vec3(camera.unprojectDir(p, aspect, u, v));

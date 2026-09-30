// three.js adapter for the camera model in ./camera (Pose conventions are documented there).
import * as THREE from "three";
import type { Pose } from "./camera";
import * as camera from "./camera";

const vec3 = (a: ArrayLike<number>) => new THREE.Vector3(a[0], a[1], a[2]);

export function poseBasis(p: Pose) {
	const { forward, right, up } = camera.poseBasis(p);
	return { forward: vec3(forward), right: vec3(right), up: vec3(up) };
}

export function applyPose(
	cam: THREE.PerspectiveCamera,
	p: Pose,
	aspect: number,
	eye = new THREE.Vector3(),
) {
	const { forward, right, up } = poseBasis(p);
	const m = new THREE.Matrix4().makeBasis(right, up, forward.clone().negate());
	cam.position.copy(eye);
	cam.up.set(0, 0, 1);
	cam.quaternion.setFromRotationMatrix(m);
	cam.fov = p.vfov;
	cam.aspect = aspect;
	cam.updateProjectionMatrix();
	cam.updateMatrixWorld(true);
}

/** camera.projectPoint for three.js vectors. */
export const projectPoint = (
	p: Pose,
	aspect: number,
	eye: THREE.Vector3,
	pt: THREE.Vector3 | number[],
) =>
	camera.projectPoint(
		p,
		aspect,
		[eye.x, eye.y, eye.z],
		Array.isArray(pt) ? pt : [pt.x, pt.y, pt.z],
	);

/** camera.unprojectDir as a THREE.Vector3. */
export const unprojectDir = (p: Pose, aspect: number, u: number, v: number) =>
	vec3(camera.unprojectDir(p, aspect, u, v));

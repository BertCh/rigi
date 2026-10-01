// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// deck.gl view that looks through the photo's camera. World = camera-anchored ENU metres
// (x east, y north, z up), rendered with COORDINATE_SYSTEM.CARTESIAN. Same pose convention
// as ../pose.ts so both renderers agree on yaw/pitch/roll/vfov.
import { View, Viewport } from "@deck.gl/core";
import { Matrix4 } from "@math.gl/core";
import type { Pose } from "../camera";
import { poseBasis } from "../pose";

export type PhotoViewState = Pose & {
	/** Camera position in ENU metres. */
	eye: [number, number, number];
};

type PhotoViewportProps = PhotoViewState & {
	id?: string;
	x?: number;
	y?: number;
	width: number;
	height: number;
	near?: number;
	far?: number;
};

export class PhotoViewport extends Viewport {
	static displayName = "PhotoViewport";
	readonly pose: Pose;
	readonly eye: [number, number, number];

	constructor(props: PhotoViewportProps) {
		const { yaw, pitch, roll, vfov, eye, near = 1, far = 400_000 } = props;
		const { forward, up } = poseBasis({ yaw, pitch, roll, vfov });
		// Rotation only; Viewport translates by -position itself.
		const viewMatrix = new Matrix4().lookAt({
			eye: [0, 0, 0],
			center: [forward.x, forward.y, forward.z],
			up: [up.x, up.y, up.z],
		});
		super({ ...props, position: eye, viewMatrix, fovy: vfov, near, far });
		this.pose = { yaw, pitch, roll, vfov };
		this.eye = eye;
	}
}

// View's generics assume a controller-driven, TransitionProps-shaped view state; this view is
// driven entirely by the app (pose sliders / drag), so it opts out of both.
// biome-ignore lint/suspicious/noExplicitAny: see above
export class PhotoView extends View<any, any> {
	static displayName = "PhotoView";

	constructor(props: { id?: string; near?: number; far?: number } = {}) {
		super(props);
	}

	getViewportType() {
		return PhotoViewport as never;
	}

	get ControllerType(): never {
		throw new Error("PhotoView has no controller");
	}
}

/** View-projection matrix of the photo camera (for projective texturing in the terrain shader). */
export function photoViewProjection(
	pose: Pose,
	eye: [number, number, number],
	aspect: number,
	near = 1,
	far = 400_000,
) {
	const { forward, up } = poseBasis(pose);
	const view = new Matrix4().lookAt({
		eye,
		center: [eye[0] + forward.x, eye[1] + forward.y, eye[2] + forward.z],
		up: [up.x, up.y, up.z],
	});
	const proj = new Matrix4().perspective({
		fovy: (pose.vfov * Math.PI) / 180,
		aspect,
		near,
		far,
	});
	return proj.multiplyRight(view);
}

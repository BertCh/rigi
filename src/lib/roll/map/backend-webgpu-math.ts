// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure helpers of the WebGPU roll-map backend (./backend-webgpu.ts): no device, no DOM.
import type { WorldViewState } from "#/lib/deck/world-view";
import {
	cameraUniforms,
	projectToPixel,
	worldCamera,
} from "../../deck-webgpu/camera";
import type { CameraPose } from "../../deck-webgpu/hosts/passes";
import type { GizmoProps } from "../../deck-webgpu/layers/gizmo";
import type { RollGizmo } from "./backend";

/** The orbit camera's near plane (m), as the WebGL roll map's WorldView (near 0.5, far 600 km;
 * the far plane is infinite in reversed-Z). */
export const ROLL_NEAR_M = 0.5;

/** WorldCamera.viewState(target) as the colour pass camera (engine.ts viewPose, roll near). */
export function rollViewPose(
	vs: WorldViewState,
	near = ROLL_NEAR_M,
): CameraPose {
	const c = worldCamera({
		eye: vs.eye,
		forward: vs.forward,
		up: vs.up,
		camFov: vs.camFov,
		width: 1,
		height: 1,
		near,
	});
	return {
		eye: c.eye,
		forward: c.forward,
		up: c.up,
		vfov: c.vfov,
		near: c.near,
	};
}

/**
 * A roll-frame point to canvas CSS px [x, y, depth] through `pose`, like deck's
 * viewport.project: depth < 1 = in front of the near plane's depth (reversed-Z: near / viewDepth),
 * so a point behind the camera gets [NaN, NaN, Infinity].
 */
export function projectRollPoint(
	pose: CameraPose,
	cssWidth: number,
	cssHeight: number,
	p: readonly [number, number, number],
): [number, number, number] {
	const u = cameraUniforms({
		...pose,
		width: Math.max(1, cssWidth),
		height: Math.max(1, cssHeight),
	});
	const r = projectToPixel(u, [p[0], p[1], p[2]]);
	return r
		? [r.x, r.y, r.depth]
		: [Number.NaN, Number.NaN, Number.POSITIVE_INFINITY];
}

/** Ids to create and to drop so a keyed set of things matches `want` (order of `want` kept). */
export function diffIds(
	have: Iterable<string>,
	want: readonly { id: string }[],
): { add: string[]; remove: string[] } {
	const wanted = new Set(want.map((w) => w.id));
	const had = new Set(have);
	return {
		add: [...wanted].filter((id) => !had.has(id)),
		remove: [...had].filter((id) => !wanted.has(id)),
	};
}

/**
 * GizmoCore props of one RollGizmo. `image` is included only when `withImage` (GizmoCore uploads
 * the thumbnail, with mips, whenever the key is present: keep it to changes).
 */
export function gizmoProps(
	g: RollGizmo,
	pixelRatio: number,
	withImage: boolean,
): Partial<GizmoProps> {
	return {
		view: "world",
		pose: g.pose,
		eye: g.eye,
		aspect: g.aspect,
		planeOpacity: g.planeOpacity,
		lineColor: g.lineColor,
		pinColor: g.pinColor,
		pinRadiusM: g.pinRadiusM,
		pixelRatio,
		...(withImage ? { image: g.image } : {}),
	};
}

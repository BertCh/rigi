// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure pose arithmetic behind the /photo workspace's hand controls (src/components/PhotoWorkspace.tsx):
// the Drag tool and the field-of-view wheel. Kept out of the component so their edge cases have specs.
// The Heading slider's window is geocam/priors/heading.ts headingControlWindow.

import { hfovFromAspect, type Pose } from "#/lib/camera";

/**
 * The Drag tool: the pose under a pointer moved by (dx, dy) CSS px from where the drag started, on a
 * stage of width × height px. Plain drag moves the terrain with the pointer (yaw and pitch scale with
 * the field of view); shift-drag rolls 0.05° per px.
 */
export function dragPose(
	start: Pose,
	dx: number,
	dy: number,
	stage: { width: number; height: number },
	aspect: number,
	roll: boolean,
): Pose {
	if (roll) return { ...start, roll: start.roll + dx * 0.05 };
	const hfov = hfovFromAspect(start.vfov, aspect);
	return {
		...start,
		yaw: start.yaw - (dx / (stage.width || 1)) * hfov,
		pitch: start.pitch + (dy / (stage.height || 1)) * start.vfov,
	};
}

/** Field-of-view limits of the wheel, degrees (vertical). */
export const WHEEL_VFOV = { min: 5, max: 100 } as const;

/** The wheel in the Drag tool: vertical field of view scaled by the wheel delta, clamped. */
export function wheelVfov(vfov: number, deltaY: number): number {
	return Math.min(
		WHEEL_VFOV.max,
		Math.max(WHEEL_VFOV.min, vfov * (1 + deltaY * 0.0006)),
	);
}

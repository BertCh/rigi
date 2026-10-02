// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The roll map's overlay specs, pure: the frustum gizmos and selection pins RollMapEngine
// (./roll-map.ts) hands to its GPU backend (./backend.ts) as RollFrame.gizmos / .pins, from the
// placed photos and the selection / hover / fly-in state. No GPU, no deck.

import { BRAND } from "#/brand/khipu";
import type { Pose } from "#/lib/camera";
import { hexToRgb255 } from "../mosaic/cvd";
import { vpColor } from "../mosaic/style";
import type { RollGizmo, RollPin } from "./backend";

type Rgba = [number, number, number, number];

/** The selected pin's ring: the brand orange, reserved for selection (viewpoints never use it). */
export const SELECTION_RGBA: Rgba = [
	...(hexToRgb255(BRAND.glow) as unknown as [number, number, number]),
	255,
];

/** The mosaic's viewpoint colour (#/lib/roll/mosaic/style) as 0..255 sRGB. */
export const viewpointColor = (i: number): [number, number, number] => {
	const h = vpColor(i);
	return [1, 3, 5].map((k) => Number.parseInt(h.slice(k, k + 2), 16)) as [
		number,
		number,
		number,
	];
};

/** Another photographer's frustum this close (m) to the viewpoint being flown into is dropped. */
const FLY_SKIP_M = 500;
/** A pin this close (m) to the viewpoint the camera is in would sit on the lens. */
const AT_CAMERA_M = 30;

export type OverlayPhoto = {
	id: string;
	pose: Pose;
	eye: [number, number, number];
	aspect: number;
	/** RollPhoto.viewpoint (index into the viewpoint palette). */
	viewpoint: number;
};

export type OverlayState = {
	placed: readonly OverlayPhoto[];
	/** Per-photo gain: 0 = hidden (no frustum, no pin). */
	gain: (id: string) => number;
	selected: string | null;
	hoverId: string | null;
	/** The photo the camera is at or flying into. */
	flyingId: string | null;
	/** A flight is in progress (WorldCamera.flight set). */
	flightActive: boolean;
	/** WorldCamera.photoPlaneOpacity (the flown-into frustum's plane fade). */
	photoPlaneOpacity: number;
	thumbs: ReadonlyMap<string, ImageBitmap>;
	/** settings.gizmos */
	gizmos: boolean;
};

const dist3 = (a: readonly number[], b: readonly number[]) =>
	Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Gizmo and pin specs for one frame. */
export function rollOverlays(s: OverlayState): {
	gizmos: RollGizmo[];
	pins: RollPin[];
} {
	const flying = s.flyingId
		? (s.placed.find((p) => p.id === s.flyingId) ?? null)
		: null;
	const flyingIn = flying && s.flightActive;
	const atCamera = (p: OverlayPhoto) =>
		!!flying && dist3(p.eye, flying.eye) < AT_CAMERA_M;
	const gizmos: RollGizmo[] = [];
	if (s.gizmos)
		for (const p of s.placed) {
			const g = s.gain(p.id);
			if (g === 0) continue;
			// the photo being flown into fades out like the single-photo world view; its neighbours'
			// frustums would fill the frame from inside the viewpoint
			if (flyingIn && p === flying && s.photoPlaneOpacity < 0.02) continue;
			if (flyingIn && p !== flying && dist3(p.eye, flying.eye) < FLY_SKIP_M)
				continue;
			const col = viewpointColor(p.viewpoint);
			const sel = p.id === s.selected;
			gizmos.push({
				id: p.id,
				pose: p.pose,
				eye: p.eye,
				aspect: p.aspect,
				// small thumbnails: a full-size texture per frustum would cost ~16 MB each
				image: sel || !s.selected ? (s.thumbs.get(p.id) ?? null) : null,
				planeOpacity: p === flying ? s.photoPlaneOpacity : sel ? 0.95 : 0.8,
				lineColor: [...col, sel ? 255 : g < 1 ? 90 : 200],
				pinColor: [...col, 255],
				pinRadiusM: sel ? 26 : 16,
			});
		}
	// selection targets: always on top, sized in pixels
	const pins: RollPin[] = s.placed
		.filter((p) => s.gain(p.id) > 0 && !atCamera(p))
		.map((p) => {
			const sel = p.id === s.selected;
			const hot = sel || p.id === s.hoverId;
			return {
				id: p.id,
				position: p.eye,
				radiusPx: sel ? 8 : p.id === s.hoverId ? 7 : 5,
				fill: [...viewpointColor(p.viewpoint), 255],
				// the selected pin carries the brand orange (selection only); hover stays white
				line: sel ? SELECTION_RGBA : [255, 255, 255, 230],
				lineWidthPx: hot ? 2.5 : 1.2,
			};
		});
	return { gizmos, pins };
}

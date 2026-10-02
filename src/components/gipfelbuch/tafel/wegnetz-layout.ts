// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Point } from "../notebook/sketch";

// The Wegnetz: the 19 sheets as a hand-laid trail map (the old atlas CoreMap's lanes, redrawn as a
// Swiss hiking map). Each chapter is a valley; its hub sheet is the valley name, every other sheet a
// waymarked station; trails are the curated data flow. Layout is deliberate, not simulated: left to
// right is the order the pipeline runs. Coordinates are px in a 960 × 600 viewBox.

export const WEGNETZ_WIDTH = 960;
export const WEGNETZ_HEIGHT = 600;

export interface WegnetzValley {
	/** The chapter numeral in CHAPTERS. */
	numeral: "I" | "II" | "III";
	/** The hub sheet the valley name links to. */
	hub: string;
	name: string;
	y0: number;
	y1: number;
}

export const WEGNETZ_VALLEYS: readonly WegnetzValley[] = [
	{
		numeral: "I",
		hub: "viewport-inference",
		name: "Where it points",
		y0: 0,
		y1: 250,
	},
	{
		numeral: "II",
		hub: "terrain-snapping",
		name: "Pinned to the terrain",
		y0: 250,
		y1: 450,
	},
	{ numeral: "III", hub: "rigi", name: "What it is for", y0: 450, y1: 600 },
];

export interface WegnetzStation {
	id: string;
	/** Short map label (sheet titles can be long). */
	label: string;
	at: Point;
	/** Which side of the station the label sits on. */
	labelSide?: "above" | "below";
}

export const WEGNETZ_STATIONS: readonly WegnetzStation[] = [
	// I: prior and observation → horizon match → gate → pose
	{ id: "photo", label: "Photo", at: [110, 140] },
	{ id: "skyline", label: "Photo skyline", at: [270, 95] },
	{
		id: "camera-prior",
		label: "Sensor prior",
		at: [270, 195],
		labelSide: "below",
	},
	{
		id: "dem-horizon",
		label: "DEM horizon",
		at: [440, 205],
		labelSide: "below",
	},
	{ id: "baseline-pipeline", label: "Horizon match", at: [490, 110] },
	{ id: "accept-rule", label: "Accept gate", at: [660, 110] },
	{
		id: "tap-a-peak",
		label: "Tap a peak",
		at: [720, 205],
		labelSide: "below",
	},
	{ id: "pose-estimate", label: "Pose", at: [860, 110] },
	// II: tiles → sampler; the three snaps fan out beneath it
	{ id: "dem-source", label: "Height tiles", at: [110, 320] },
	{ id: "terrain-sampler", label: "Height sampler", at: [300, 320] },
	{
		id: "dem-anchoring",
		label: "Depth on DEM",
		at: [200, 410],
		labelSide: "below",
	},
	{ id: "eye-rule", label: "Eye on ground", at: [470, 330] },
	{
		id: "peak",
		label: "Peak on summit",
		at: [560, 405],
		labelSide: "below",
	},
	// III: the uses of a known camera
	{
		id: "step-inside",
		label: "Step Inside",
		at: [260, 540],
		labelSide: "below",
	},
	{
		id: "photo-workspace",
		label: "Overlay",
		at: [560, 540],
		labelSide: "below",
	},
	{
		id: "camera-roll",
		label: "Camera roll",
		at: [840, 540],
		labelSide: "below",
	},
];

/** flow: within a valley; snap: pinned to the sampler; fallback: the refused branch; cross: valleys meet. */
export type TrailKind = "flow" | "snap" | "fallback" | "cross";

export interface WegnetzTrail {
	from: string;
	to: string;
	kind: TrailKind;
	label?: string;
	/** Sideways bend of the hand-drawn curve (PenArrow `bend`). */
	bend?: number;
}

export const WEGNETZ_TRAILS: readonly WegnetzTrail[] = [
	{ from: "photo", to: "skyline", kind: "flow", bend: 0.12 },
	{
		from: "photo",
		to: "camera-prior",
		kind: "flow",
		label: "compass · tilt · lens",
		bend: -0.12,
	},
	{ from: "skyline", to: "baseline-pipeline", kind: "flow", label: "seen" },
	{
		from: "camera-prior",
		to: "baseline-pipeline",
		kind: "flow",
		label: "seed",
		bend: 0.1,
	},
	{
		from: "dem-horizon",
		to: "baseline-pipeline",
		kind: "flow",
		label: "predicted",
		bend: -0.1,
	},
	{ from: "baseline-pipeline", to: "accept-rule", kind: "flow" },
	{
		from: "accept-rule",
		to: "pose-estimate",
		kind: "flow",
		label: "accepted",
	},
	{
		from: "accept-rule",
		to: "tap-a-peak",
		kind: "fallback",
		label: "refused",
		bend: 0.15,
	},
	{ from: "tap-a-peak", to: "pose-estimate", kind: "fallback", bend: 0.15 },
	{ from: "dem-source", to: "terrain-sampler", kind: "flow" },
	{
		from: "terrain-sampler",
		to: "dem-horizon",
		kind: "cross",
		label: "ground heights",
		bend: -0.12,
	},
	{
		from: "terrain-sampler",
		to: "dem-anchoring",
		kind: "snap",
		label: "depth ↔ DEM",
		bend: 0.15,
	},
	{
		from: "terrain-sampler",
		to: "eye-rule",
		kind: "snap",
		label: "ground + eye",
		bend: 0.1,
	},
	{
		from: "terrain-sampler",
		to: "peak",
		kind: "snap",
		label: "local max",
		bend: -0.12,
	},
	{
		from: "eye-rule",
		to: "dem-horizon",
		kind: "cross",
		label: "ray origin",
		bend: 0.12,
	},
	{ from: "peak", to: "tap-a-peak", kind: "cross", bend: -0.15 },
	{
		from: "pose-estimate",
		to: "photo-workspace",
		kind: "cross",
		label: "pose",
		bend: 0.08,
	},
	{
		from: "peak",
		to: "photo-workspace",
		kind: "cross",
		label: "labels",
		bend: 0.1,
	},
	{ from: "pose-estimate", to: "camera-roll", kind: "cross", bend: -0.06 },
	{ from: "dem-anchoring", to: "step-inside", kind: "cross", bend: 0.1 },
	{ from: "camera-roll", to: "step-inside", kind: "flow", bend: -0.18 },
];

/** Every sheet the trail map shows: the stations plus the three valley hubs. */
export const WEGNETZ_SHEET_IDS: readonly string[] = [
	...WEGNETZ_VALLEYS.map((v) => v.hub),
	...WEGNETZ_STATIONS.map((s) => s.id),
];

export const trailKey = (t: WegnetzTrail) => `${t.from}>${t.to}`;

/** The trails upstream and downstream of a station, walking the trail network both ways. */
export function trailLineage(id: string): Set<string> {
	const keys = new Set<string>();
	const walk = (forward: boolean) => {
		const seen = new Set([id]);
		const stack = [id];
		while (stack.length) {
			const current = stack.pop() as string;
			for (const t of WEGNETZ_TRAILS) {
				const [a, b] = forward ? [t.from, t.to] : [t.to, t.from];
				if (a !== current) continue;
				keys.add(trailKey(t));
				if (!seen.has(b)) {
					seen.add(b);
					stack.push(b);
				}
			}
		}
	};
	walk(true);
	walk(false);
	return keys;
}

/**
 * The route one photo took: through the accept gate straight to the pose, or (refused) by way of
 * Tap a peak, then on to the overlay.
 */
export function photoRoute(accepted: boolean): Set<string> {
	return new Set([
		"photo>skyline",
		"photo>camera-prior",
		"skyline>baseline-pipeline",
		"camera-prior>baseline-pipeline",
		"dem-horizon>baseline-pipeline",
		"baseline-pipeline>accept-rule",
		...(accepted
			? ["accept-rule>pose-estimate"]
			: ["accept-rule>tap-a-peak", "tap-a-peak>pose-estimate"]),
		"pose-estimate>photo-workspace",
	]);
}

/** Pull a trail's ends back from the station centres so the line stops short of the blaze. */
export function trailEnds(from: Point, to: Point, gap = 14): [Point, Point] {
	const dx = to[0] - from[0];
	const dy = to[1] - from[1];
	const length = Math.hypot(dx, dy) || 1;
	const ux = (dx / length) * gap;
	const uy = (dy / length) * gap;
	return [
		[from[0] + ux, from[1] + uy],
		[to[0] - ux, to[1] - uy],
	];
}

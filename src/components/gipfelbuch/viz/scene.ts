// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { projectAzEl, type TafelCamera } from "../tafel/project";
import SCENE_JSON from "./diagram-scene.json";

// The real ground of the synthetic diagrams (pod D spec, D-diagrams.md §1). A mechanism figure keeps its
// synthetic sensor (an invented compass error, a chosen tap, a schematic camera) but draws one real photo's
// mountains: its DEM horizon, named summits and terrain section, baked by
// scripts/gipfelbuch/bake-diagram-scene.ts. demo-09 is the landing page's how-it-works photo (Niederhorn
// towards Eiger, Mönch and Jungfrau), so the reader meets the same skyline on the landing, the sheet's
// photos and every diagram, and the margins can carry it on past the frame in the same ink.

export interface ScenePose {
	yaw: number;
	pitch: number;
	roll: number;
	/** Focal length in working px (photo width `scene.photo.width`). */
	f: number;
	hfov: number;
}

export interface ScenePeak {
	name: string;
	/** Summit height, m. */
	ele: number;
	/** Bearing from the eye, deg. */
	az: number;
	/** Apparent elevation from the eye (curvature and refraction applied), deg. */
	el: number;
	km: number;
}

export interface DiagramScene {
	id: string;
	photo: { width: number; height: number };
	eye: { lat: number; lon: number; m: number; ground: number };
	/** The phone's sensor pose. */
	prior: ScenePose;
	/** The pose the solve found. */
	solved: ScenePose;
	horizon: { az0: number; step: number; el: number[] };
	horizonDistance: { az0: number; step: number; d: number[] };
	section: { azimuth: number; points: [number, number][] };
	peaks: ScenePeak[];
}

// JSON imports widen tuples to number[]; the bake writes [distance, height] pairs
export const SCENE = SCENE_JSON as unknown as DiagramScene;

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Linear interpolation in a regular table (`az0 + i·step`); null outside it. */
function sampleRow(
	az: number,
	az0: number,
	step: number,
	row: readonly number[],
): number | null {
	const k = wrap180(az - az0) / step;
	if (k < 0 || k > row.length - 1) return null;
	const i = Math.min(row.length - 2, Math.floor(k));
	const f = k - i;
	return row[i] * (1 - f) + row[i + 1] * f;
}

/** The scene's DEM horizon elevation (deg) at bearing `az`, or null outside the baked 170°. */
export function horizonEl(az: number, scene: DiagramScene = SCENE) {
	return sampleRow(az, scene.horizon.az0, scene.horizon.step, scene.horizon.el);
}

/** Distance (m) of the horizon point at bearing `az`, or null outside the photo's view. */
export function horizonDistance(az: number, scene: DiagramScene = SCENE) {
	const h = scene.horizonDistance;
	return sampleRow(az, h.az0, h.step, h.d);
}

/** The baked bearing range [from, to] of the horizon. */
export function horizonSpan(scene: DiagramScene = SCENE): [number, number] {
	const h = scene.horizon;
	return [h.az0, h.az0 + h.step * (h.el.length - 1)];
}

/** Ground height (m) along the solved view axis at distance `d` (m), clamped to the section. */
export function sectionHeight(d: number, scene: DiagramScene = SCENE) {
	const p = scene.section.points;
	if (d <= p[0][0]) return p[0][1];
	for (let i = 1; i < p.length; i++)
		if (p[i][0] >= d) {
			const [d0, h0] = p[i - 1];
			const [d1, h1] = p[i];
			return h0 + ((h1 - h0) * (d - d0)) / (d1 - d0 || 1);
		}
	return p[p.length - 1][1];
}

/** Summits whose bearing lies in [from, to] (deg, wrapping), west to east. */
export function peaksBetween(
	from: number,
	to: number,
	scene: DiagramScene = SCENE,
): ScenePeak[] {
	const span = wrap180(to - from);
	return scene.peaks.filter((p) => {
		const k = wrap180(p.az - from);
		return k >= 0 && k <= span;
	});
}

/** A summit by name; throws on a typo (the bake's names are fixed). */
export function peak(name: string, scene: DiagramScene = SCENE): ScenePeak {
	const p = scene.peaks.find((q) => q.name === name);
	if (!p) throw new Error(`diagram scene ${scene.id}: no summit "${name}"`);
	return p;
}

/**
 * Projects a bearing and elevation through a scene pose into a frame of `w` × `h` px whose focal length
 * scales with the width (the bake's 800-px working frame scaled to `w`). Same projector as the Tafel spill.
 */
export function projectScene(
	pose: Pick<ScenePose, "yaw" | "pitch" | "roll" | "f">,
	w: number,
	h: number,
	az: number,
	el: number,
	scene: DiagramScene = SCENE,
): [number, number] {
	const cam: TafelCamera = {
		yaw: pose.yaw,
		pitch: pose.pitch,
		roll: pose.roll,
		f: (pose.f * w) / scene.photo.width,
	};
	return projectAzEl(cam, w, h, az, el);
}

/**
 * The scene's horizon as a row function for `SketchSpill` / a figure: for column u (0..1 across a frame
 * `w` px wide, outside 0..1 in the margins) the row (0 = top, 1 = bottom) where the horizon projects
 * under `pose`, or null where the bake has no horizon. Accurate for roll near 0 (it inverts the
 * column → bearing map on the horizon line, as `azAtX`).
 */
export function horizonRowAt(
	pose: Pick<ScenePose, "yaw" | "pitch" | "roll" | "f">,
	w: number,
	h: number,
	scene: DiagramScene = SCENE,
	exaggerate = 1,
): (u: number) => number | null {
	const f = (pose.f * w) / scene.photo.width;
	return (u) => {
		const az = pose.yaw + (Math.atan((u * w - w / 2) / f) * 180) / Math.PI;
		const el = horizonEl(az, scene);
		if (el == null) return null;
		return projectScene(pose, w, h, az, el * exaggerate, scene)[1] / h;
	};
}

/**
 * Where a summit's mark sits on the drawn horizon. The bake's DEM horizon (terrarium, 0.25° steps) runs
 * 0.1–0.35° under the named summit heights, so a mark at the summit's own elevation would float above
 * the line the figure draws. A summit within 0.5° of the skyline takes the highest horizon point within
 * ±0.4° of its bearing; a foreground summit under the skyline keeps its own elevation.
 */
export function summitOnSkyline(
	p: ScenePeak,
	scene: DiagramScene = SCENE,
): { az: number; el: number; onSkyline: boolean } {
	let best: { az: number; el: number } | null = null;
	for (let k = -0.4; k <= 0.4 + 1e-9; k += 0.05) {
		const el = horizonEl(p.az + k, scene);
		if (el != null && (!best || el > best.el)) best = { az: p.az + k, el };
	}
	if (best && Math.abs(best.el - p.el) <= 0.5)
		return { ...best, onSkyline: true };
	return { az: p.az, el: p.el, onSkyline: false };
}

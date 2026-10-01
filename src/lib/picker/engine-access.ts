// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Read-only access to what the picker needs from either renderer (PhotoEngine / DeckEngine) without
// widening the shared Renderer interface (other sessions own engine.ts / deck/engine.ts). Both engines
// keep, under the same private names:
//   horizonDirs: Float32Array  unit ENU directions of the traced 360° horizon (xyz triples)
//   edge: EdgeMap              the photo's edge / sky model that autoAlign scores against
// and their peaks as either `peaks: {world: Vector3}[]` (three, snapped up front) or, on deck, the
// lazily snapped set from `snapped(pose)` ({position: [x,y,z]}). Every accessor degrades to null / []
// when a field is missing, so a renamed field turns a feature off instead of throwing.
import { type EdgeMap, scorePose } from "#/lib/align";
import { type Pose, poseBasis } from "#/lib/camera";
import type { Renderer } from "#/lib/renderer";
import type { PoolPeak } from "./candidates";

type Internals = {
	horizonDirs?: Float32Array;
	edge?: EdgeMap;
	peaks?: unknown[];
	snapped?: (pose: Pose) => unknown[];
};

const internals = (e: Renderer) => e as unknown as Internals;

export const eyeOf = (e: Renderer): [number, number, number] => [
	e.eye.x,
	e.eye.y,
	e.eye.z,
];

/** align.ts scorePose (fine) at `pose`, the same measure autoAlign ranks by; null when unavailable. */
export function skylineScore(e: Renderer, pose: Pose): number | null {
	const { horizonDirs, edge } = internals(e);
	if (!horizonDirs || !edge) return null;
	try {
		return scorePose(pose, e.aspect, horizonDirs, edge, true, 1);
	} catch {
		return null;
	}
}

/**
 * The predicted skyline of `pose` as `cols` values of v (0 = top, fraction of the height; NaN where the
 * horizon is outside the frame): the highest projected horizon point per column. Pure CPU, the same
 * projection as align.ts skylineRows, so both renderers draw identical thumbnails.
 */
export function skylineOf(
	e: Renderer,
	pose: Pose,
	cols = 160,
): Float32Array | null {
	const dirs = internals(e).horizonDirs;
	if (!dirs) return null;
	const out = new Float32Array(cols).fill(Number.NaN);
	const { forward: f, right: r, up } = poseBasis(pose);
	const t = Math.tan((pose.vfov * Math.PI) / 360);
	const a = e.aspect;
	for (let i = 0; i < dirs.length; i += 3) {
		const dx = dirs[i];
		const dy = dirs[i + 1];
		const dz = dirs[i + 2];
		const z = dx * f[0] + dy * f[1] + dz * f[2];
		if (z <= 0) continue;
		const x = (dx * r[0] + dy * r[1] + dz * r[2]) / z / (t * a);
		const y = (dx * up[0] + dy * up[1] + dz * up[2]) / z / t;
		const u = 0.5 + x / 2;
		const v = 0.5 - y / 2;
		if (u < 0 || u >= 1) continue;
		const c = Math.floor(u * cols);
		if (!(out[c] <= v)) out[c] = v;
	}
	return out;
}

const asTriple = (w: unknown): [number, number, number] | null => {
	if (Array.isArray(w) && w.length >= 3) return [+w[0], +w[1], +w[2]];
	const o = w as { x?: number; y?: number; z?: number } | null;
	if (o && typeof o.x === "number") return [o.x, o.y as number, o.z as number];
	return null;
};

/**
 * Named summits around the given poses in the engine frame. three: every snapped region peak. deck:
 * the lazily snapped set, first widened around each pose (its snap only covers peaks near a frame).
 */
export function peakPool(e: Renderer, around: Pose[]): PoolPeak[] {
	const it = internals(e);
	const raw: unknown[] = [];
	if (typeof it.snapped === "function") {
		for (const p of around) {
			try {
				raw.push(
					...it.snapped.call(e, { ...p, vfov: Math.min(120, p.vfov * 1.6) }),
				);
			} catch {
				/* terrain not ready */
			}
		}
	} else if (Array.isArray(it.peaks)) raw.push(...it.peaks);
	const out: PoolPeak[] = [];
	for (const r of raw) {
		const pk = r as {
			name?: string;
			ele?: number | null;
			prominence?: number | null;
			world?: unknown;
			position?: unknown;
		};
		const w = asTriple(pk.world ?? pk.position);
		if (!pk.name || !w) continue;
		out.push({
			name: pk.name,
			ele: pk.ele ?? null,
			prominence: pk.prominence ?? null,
			world: w,
		});
	}
	return out;
}

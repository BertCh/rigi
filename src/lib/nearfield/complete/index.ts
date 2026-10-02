// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside completion, P0 (research_notes/completion_integration_2026-09.md §3; roadmap S2), behind
// ?nearfield=complete. `complete` behaves like `on` (the service gate, readout, exports) plus these steps:
//   1. slab diagnosis + reclassification of near-camera ground wrongly classed Object (slab.ts);
//   2. mixed-depth edge snap and soft rim alpha, applied by lift.liftToGaussians (edge-snap.ts) when the client
//      depth-lift builds the cloud (the controller passes the LiftOpts);
//   3. (not built) the behind layer, see completeBehindLayer.
//
// DISPLAY-ONLY CONTRACT. Anything this module ADDS is invented and must never be measurable: it passes
// through appendCompletionSplats, which asserts it. Steps 1 and 2 only drop or move OBSERVED data and invent
// nothing, so what survives keeps its provenance unchanged. isMeasurable's semantics are untouched.
import { getFlag } from "#/lib/flags";
import type { Pose } from "../../camera";
import { anchoredRange } from "../anchor";
import { type IntrinsicsNorm, type MaskLike, maskSampler } from "../geom";
import { camToEnuMatrix } from "../lift";
import { isMeasurable, selectSplats } from "../provenance";
import {
	type GaussianCloud,
	type NearFieldDepth,
	type NearFieldScene,
	PROVENANCE_CODE,
} from "../types";
import type { EdgeSnapOpts, RimAlphaOpts } from "./edge-snap";
import {
	diagnoseGroundSlabs,
	reclassifySlabs,
	type SlabDiagnosis,
	type SlabParams,
} from "./slab";

export { computeRimAlpha, snapMixedDepthEdges } from "./edge-snap";
export { diagnoseGroundSlabs, reclassifySlabs } from "./slab";

/** True under ?nearfield=complete (the one place that interprets the value for completion). */
export function completionEnabled(): boolean {
	return getFlag("nearfield") === "complete";
}

/** LiftOpts additions for the client depth-lift under `complete` (lift.ts reads them). */
export function completionLiftOpts(peopleMask: MaskLike | null): {
	edgeSnap: EdgeSnapOpts;
	rimAlpha: RimAlphaOpts & { mask: MaskLike | null };
} {
	return { edgeSnap: {}, rimAlpha: { mask: peopleMask } };
}

/**
 * Throws unless every splat of `cloud` (or of `range` = [start, start + count)) is non-measurable. Stricter
 * than isMeasurable alone: it also requires the `generated` code, because measure.ts buildMeasureGrid only
 * skips `=== generated` (an unknown code would pass isMeasurable's deny-list yet still be binned there).
 * // Invariant (status.md decision 6 pending): completion output reuses `generated` until a new code is chosen.
 */
export function assertCompletionNotMeasurable(
	cloud: GaussianCloud,
	range?: { start: number; count: number },
): void {
	const start = range?.start ?? 0;
	const end = range ? start + range.count : cloud.count;
	if (start < 0 || end > cloud.count)
		throw new Error("assertCompletionNotMeasurable: range outside the cloud");
	for (let i = start; i < end; i++) {
		const code = cloud.provenance[i];
		if (isMeasurable(code) || code !== PROVENANCE_CODE.generated)
			throw new Error(
				`completion splat ${i} has measurable provenance code ${code}: added content must be generated`,
			);
	}
}

/**
 * The only sanctioned way for completion to ADD splats: asserts `extra` is non-measurable, then appends it
 * after the observed ones. Returns the new scene and the added index range. `extra` must be in ENU like
 * the scene's cloud.
 */
export function appendCompletionSplats(
	scene: NearFieldScene,
	extra: GaussianCloud,
): { scene: NearFieldScene; range: { start: number; count: number } } {
	if (extra.frame !== "enu" || scene.splats.frame !== "enu")
		throw new Error("appendCompletionSplats: ENU clouds only");
	assertCompletionNotMeasurable(extra);
	const a = scene.splats;
	const n = a.count + extra.count;
	const cat = <T extends Float32Array | Uint8Array>(x: T, y: T): T => {
		const out = new (x.constructor as new (n: number) => T)(
			x.length + y.length,
		);
		out.set(x, 0);
		out.set(y, x.length);
		return out;
	};
	const splats: GaussianCloud = {
		count: n,
		frame: "enu",
		positions: cat(a.positions, extra.positions),
		scales: cat(a.scales, extra.scales),
		rotations: cat(a.rotations, extra.rotations),
		colors: cat(a.colors, extra.colors),
		provenance: cat(a.provenance, extra.provenance),
	};
	if (a.source || extra.source) {
		const s = new Uint16Array(n);
		if (a.source) s.set(a.source, 0);
		if (extra.source) s.set(extra.source, a.count);
		splats.source = s;
	}
	const range = { start: a.count, count: extra.count };
	assertCompletionNotMeasurable(splats, range);
	return { scene: { ...scene, splats }, range };
}

/**
 * Behind layer (LaMa on the photo, lifted on the DEM as generated splats; §2.5 option i). NOT IMPLEMENTED.
 * TODO(status.md decision 6: completion provenance, reuse `generated` vs a new code): the output provenance and
 * the tint tables depend on that decision. When built it must add its splats through appendCompletionSplats.
 */
export function completeBehindLayer(): never {
	throw new Error(
		"completeBehindLayer: not implemented (blocked on status.md decision 6, completion provenance)",
	);
}

export type CompleteContext = {
	depth: NearFieldDepth;
	/** DEM ray length per depth cell (geom.sampleDemGrid), NaN = none. */
	demGrid: ArrayLike<number>;
	K: IntrinsicsNorm;
	pose: Pose;
	eye: { x: number; y: number; z: number };
	/** Soft people mask: its cells are never reclassified. */
	peopleMask?: MaskLike | null;
};

export type CompleteOpts = {
	slab?: SlabParams | false;
	/** Reserved: throws (see completeBehindLayer). */
	behindLayer?: boolean;
};

export type CompleteResult = {
	scene: NearFieldScene;
	slab: SlabDiagnosis | null;
	/** Observed splats dropped because their cell was reclassified to Terrain. */
	removedSplats: number;
	/** Splats added by completion (always 0 until the behind layer exists); all non-measurable. */
	addedSplats: number;
};

/**
 * Synchronous P0 heuristics on a built scene (call after buildNearFieldScene, before buildMeasureGrid).
 * `modelRange` per cell is the anchored ray length of the model depth. Returns a new scene; the input is
 * not modified.
 */
export function completeScene(
	scene: NearFieldScene,
	ctx: CompleteContext,
	opts: CompleteOpts = {},
): CompleteResult {
	if (opts.behindLayer) completeBehindLayer();
	let out = scene;
	let slab: SlabDiagnosis | null = null;
	let removed = 0;
	if (opts.slab !== false) {
		const { width: W, height: H } = scene.split;
		if (ctx.depth.width !== W || ctx.depth.height !== H)
			throw new Error("completeScene: depth and split grids differ");
		const modelRange = new Float32Array(W * H).fill(Number.NaN);
		for (let k = 0; k < W * H; k++) {
			const z = ctx.depth.depth[k];
			if (!ctx.depth.valid[k] || !(z > 0) || !Number.isFinite(z)) continue;
			const u = ((k % W) + 0.5) / W;
			const v = (Math.floor(k / W) + 0.5) / H;
			const cx = (u - ctx.K.cx) / ctx.K.fx;
			const cy = (v - ctx.K.cy) / ctx.K.fy;
			modelRange[k] = anchoredRange(
				scene.anchor,
				z * Math.sqrt(1 + cx * cx + cy * cy),
			);
		}
		const people = maskSampler(ctx.peopleMask);
		let protect: Uint8Array | undefined;
		if (people) {
			protect = new Uint8Array(W * H);
			for (let k = 0; k < W * H; k++)
				protect[k] = people(((k % W) + 0.5) / W, (Math.floor(k / W) + 0.5) / H)
					? 1
					: 0;
		}
		const m = camToEnuMatrix(ctx.pose);
		slab = diagnoseGroundSlabs(
			{
				split: scene.split,
				demGrid: ctx.demGrid,
				modelRange,
				normals: ctx.depth.normal,
				camToEnu: m,
				K: ctx.K,
				protect,
			},
			opts.slab || {},
		);
		if (slab.count > 0) {
			const split = reclassifySlabs(scene.split, slab.mask);
			const keep = splatsOutsideMask(scene.splats, slab.mask, W, H, ctx, m);
			removed = scene.splats.count - keep.length;
			out = {
				...scene,
				split,
				splats: removed ? selectSplats(scene.splats, keep) : scene.splats,
			};
		}
	}
	return { scene: out, slab, removedSplats: removed, addedSplats: 0 };
}

/** Indices of the splats whose photo-camera cell is NOT in `mask` (off-image splats are kept). */
function splatsOutsideMask(
	s: GaussianCloud,
	mask: ArrayLike<number>,
	W: number,
	H: number,
	ctx: CompleteContext,
	m: ArrayLike<number>,
): number[] {
	const keep: number[] = [];
	for (let i = 0; i < s.count; i++) {
		const dx = s.positions[3 * i] - ctx.eye.x;
		const dy = s.positions[3 * i + 1] - ctx.eye.y;
		const dz = s.positions[3 * i + 2] - ctx.eye.z;
		const x = m[0] * dx + m[3] * dy + m[6] * dz;
		const y = m[1] * dx + m[4] * dy + m[7] * dz;
		const z = m[2] * dx + m[5] * dy + m[8] * dz;
		if (z > 0) {
			const u = ctx.K.cx + (ctx.K.fx * x) / z;
			const v = ctx.K.cy + (ctx.K.fy * y) / z;
			if (u >= 0 && u < 1 && v >= 0 && v < 1) {
				const k = Math.floor(v * H) * W + Math.floor(u * W);
				if (mask[k]) continue;
			}
		}
		keep.push(i);
	}
	return keep;
}

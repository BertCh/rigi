// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Roadmap S3 "3D Tiles T2": the nDSM half of the object prior's evidence (object-prior.ts). For every depth-grid
// cell it takes the DEM hit point of the cell's ray and reads the nDSM height (swissSURFACE3D minus
// swissALTI3D, concord/occl/ndsm.ts) there. Pure part: buildObjectHeightGrid (fake sampler in specs). Fetch
// part: prepareObjectPrior (flag ?tiles3dObjects=on only, called by the controller); every failure resolves
// null so Step Inside carries on with the unchanged split.
import type { Pose } from "../camera";
import type { NearDsm } from "../concord/occl/ndsm";
import { type IntrinsicsNorm, rayFactor } from "./geom";
import { camToEnuMatrix } from "./lift";
import type { ObjectPriorInput } from "./object-prior";

/** nDSM height (m, above terrain) at ENU (e, n) of the photo's frame; NaN = no data. */
export type ObjectHeightAt = (e: number, n: number) => number;

export type ObjectHeightGridInput = {
	width: number;
	height: number;
	/** DEM ray range per cell (NaN = none), depth-grid size (geom.sampleDemGrid). */
	demGrid: ArrayLike<number>;
	K: IntrinsicsNorm;
	pose: Pose;
	eye: { readonly x: number; readonly y: number; readonly z: number };
	heightAt: ObjectHeightAt;
};

/**
 * nDSM height at each cell's DEM hit point (eye + range * unit ray, ENU), NaN where the cell has no DEM
 * range or the sampler has no data. demGrid ranges are ray lengths, so the unit ray is the camera ray over
 * rayFactor (|ray| / z).
 */
export function buildObjectHeightGrid(
	input: ObjectHeightGridInput,
): Float32Array {
	const { width, height, demGrid, K, eye, heightAt } = input;
	const out = new Float32Array(width * height).fill(Number.NaN);
	const m = camToEnuMatrix(input.pose);
	for (let j = 0; j < height; j++) {
		const v = (j + 0.5) / height;
		for (let i = 0; i < width; i++) {
			const k = j * width + i;
			const r = demGrid[k];
			if (!(r > 0) || !Number.isFinite(r)) continue;
			const u = (i + 0.5) / width;
			const x = (u - K.cx) / K.fx;
			const y = (v - K.cy) / K.fy;
			const s = r / rayFactor(K, u, v); // z of the hit in the camera frame
			const e = eye.x + s * (m[0] * x + m[1] * y + m[2]);
			const n = eye.y + s * (m[3] * x + m[4] * y + m[5]);
			const h = heightAt(e, n);
			if (Number.isFinite(h)) out[k] = h;
		}
	}
	return out;
}

/** The slice of a loaded nDSM the sampler needs (concord/occl NearDsm satisfies it). */
export type NdsmLike = NearDsm;

/** nDSM sampler over a loaded surface model whose frame origin is the eye (e, n relative to the eye). */
export function ndsmHeightAt(
	dsm: NdsmLike,
	nearHeightAt: (
		g: NdsmLike,
		which: "dsm" | "dtm",
		e: number,
		n: number,
	) => number,
	eye: { readonly x: number; readonly y: number },
): ObjectHeightAt {
	return (e, n) => {
		const a = nearHeightAt(dsm, "dsm", e - eye.x, n - eye.y);
		const b = nearHeightAt(dsm, "dtm", e - eye.x, n - eye.y);
		return a - b; // NaN when either is missing
	};
}

export type PrepareObjectPriorInput = Omit<
	ObjectHeightGridInput,
	"heightAt"
> & {
	/** Photo eye as geodesy (frame.toGeo of the eye ENU). */
	frame: {
		toGeo(e: number, n: number, u: number): { lat: number; lon: number };
	};
	signal?: AbortSignal;
};

/**
 * Load the nDSM around the eye (Switzerland, 500 m, view wedge) and grid it onto the depth cells. Resolves
 * null (console.debug) on no coverage, outside CH, abort or any error: the caller then builds without a prior.
 * The concord/occl loader is imported lazily so the flag-off path never touches it.
 */
export async function prepareObjectPrior(
	input: PrepareObjectPriorInput,
): Promise<Pick<ObjectPriorInput, "objectHeight" | "sources"> | null> {
	try {
		const { eye, pose, signal } = input;
		const g = input.frame.toGeo(eye.x, eye.y, eye.z);
		const { loadNearDsm, nearHeightAt } = await import("../concord/occl/ndsm");
		const aspect = input.K.fy / input.K.fx;
		const hfov =
			(2 * Math.atan(aspect * Math.tan((pose.vfov * Math.PI) / 360)) * 180) /
			Math.PI;
		const dsm = await loadNearDsm(g.lat, g.lon, 500, 2, {
			wedge: { yawDeg: pose.yaw, halfDeg: hfov / 2 + 10 },
			signal,
		});
		if (signal?.aborted) return null;
		if (!dsm) {
			console.debug("[nearfield] object prior: no nDSM here");
			return null;
		}
		const objectHeight = buildObjectHeightGrid({
			...input,
			heightAt: ndsmHeightAt(dsm, nearHeightAt, eye),
		});
		// tileRange (swisstopo building / vegetation tile ray casting) stays unset for now; the prior then
		// checks the nDSM height against the DEM range and the anchored model range only.
		return { objectHeight, sources: ["ndsm"] };
	} catch (e) {
		console.debug("[nearfield] object prior unavailable", e);
		return null;
	}
}

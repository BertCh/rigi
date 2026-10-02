// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The relative-rotation estimator, in the browser. It replaces the Python service
// (tools/nearfield/propagate/service.py, :8769) with the same pipeline and the same outputs:
//   decode (EXIF orientation applied) → long side 1024 → ALIKED (2048 keypoints) + LightGlue
//   (src/lib/features/client: a worker; the compute graph under WebGPU) → bearings with K from the vfov
//   (anchor: accepted vfov; target: EXIF vfov) → pure-rotation RANSAC (src/lib/pose6dof rotationRansac:
//   4 px chord at f_B, 2000 hypotheses, seed 0, 3 Kabsch re-fits; GPU-scored when large) → the backward
//   B → A estimate for the fwd/bwd check. Like the service it returns a relative rotation and its
//   evidence only: composing the pose and the gate stay in plan.ts, and the result is a suggestion.
// Never throws: errors come back as a message string (as the HTTP client did).
import {
	rotationDistanceDeg,
	rotationRansacAsync,
	transpose3,
} from "../../pose6dof";
import type { RelRotResult } from "./plan";

/** Structural copies of src/lib/features' frozen types (only what this module reads). */
export type Features = {
	width: number;
	height: number;
	keypoints: Float32Array;
	count: number;
};
export type Matches = {
	indices0: Uint32Array;
	indices1: Uint32Array;
	count: number;
};
export type FeatureBackend = {
	available: () => Promise<boolean>;
	extract: (
		image: ImageBitmap,
		opts: { maxKeypoints: number; longSide: number; signal?: AbortSignal },
	) => Promise<Features>;
	match: (
		a: Features,
		b: Features,
		opts: { signal?: AbortSignal },
	) => Promise<Matches>;
};

/** The service's settings (run_propagate.py: MAXS, ALIKED max_num_keypoints, rot_ransac defaults). */
export const ESTIMATOR = {
	longSide: 1024,
	maxKeypoints: 2048,
	thresholdPx: 4,
	iterations: 2000,
	seed: 0,
} as const;

let backend: Promise<FeatureBackend> | null = null;
/** Tests: swap the feature backend (null = the real src/lib/features). Clears the caches. */
export function setFeatureBackend(b: FeatureBackend | null) {
	backend = b ? Promise.resolve(b) : null;
	feats.clear();
	results.clear();
	availability = null;
}
function featureBackend(): Promise<FeatureBackend> {
	backend ??= import("#/lib/features/client").then(
		(f): FeatureBackend => ({
			available: f.featuresAvailable,
			extract: (image, opts) => f.extractFeatures(image, opts),
			match: (a, b, opts) =>
				f.matchFeatures(
					a as Parameters<typeof f.matchFeatures>[0],
					b as Parameters<typeof f.matchFeatures>[1],
					opts,
				),
		}),
	);
	return backend;
}

let availability: { ok: boolean; at: number } | null = null;
/**
 * "Available" = the feature models load here (the first call downloads the weights once). A failure
 * is retried after 10 s, as the service health check was.
 */
export async function relRotAvailable(force = false): Promise<boolean> {
	if (
		!force &&
		availability &&
		(availability.ok || Date.now() - availability.at < 10_000)
	)
		return availability.ok;
	let ok = false;
	try {
		ok = await (await featureBackend()).available();
	} catch {
		ok = false;
	}
	availability = { ok, at: Date.now() };
	return ok;
}

// ---------- pure core ----------

/** K of run_propagate.K_of: square pixels, principal point at the centre. */
export const focalOf = (vfov: number, height: number) =>
	height / 2 / Math.tan((vfov * Math.PI) / 360);

/** Unit bearings (OpenCV axes) of matched keypoints, +0.5 px as rot_ransac (lightglue pixel centres). */
export function bearingsOf(
	f: Features,
	idx: Uint32Array,
	count: number,
	vfov: number,
): Float64Array {
	const fl = focalOf(vfov, f.height);
	const cx = f.width / 2;
	const cy = f.height / 2;
	const out = new Float64Array(count * 3);
	for (let j = 0; j < count; j++) {
		const i = idx[j];
		const x = (f.keypoints[i * 2] + 0.5 - cx) / fl;
		const y = (f.keypoints[i * 2 + 1] + 0.5 - cy) / fl;
		const l = Math.hypot(x, y, 1);
		out[j * 3] = x / l;
		out[j * 3 + 1] = y / l;
		out[j * 3 + 2] = 1 / l;
	}
	return out;
}

type Rot = { R: Float64Array; inliers: number; rmsPx: number | null };

/** rot_ransac on one directed match set (A → B): null below 3 matches. */
export async function rotFromMatches(
	fa: Features,
	fb: Features,
	m: Matches,
	vfovA: number,
	vfovB: number,
	opts: { gpu?: "auto" | "on" | "off" } = {},
): Promise<Rot | null> {
	if (m.count < 3) return null;
	const b0 = bearingsOf(fa, m.indices0, m.count, vfovA);
	const b1 = bearingsOf(fb, m.indices1, m.count, vfovB);
	const fB = focalOf(vfovB, fb.height);
	const r = await rotationRansacAsync(b0, b1, {
		maxChord: ESTIMATOR.thresholdPx / fB,
		maxIterations: ESTIMATOR.iterations,
		seed: ESTIMATOR.seed,
		gpu: opts.gpu,
	});
	if (!r) return null;
	return {
		R: r.R,
		inliers: r.inlierCount,
		rmsPx: r.rmsChord == null ? null : r.rmsChord * fB,
	};
}

/** The service's /relrot body from features and the two directed match sets. */
export async function relRotFromFeatures(
	fa: Features,
	fb: Features,
	fwd: Matches,
	bwd: Matches,
	vfovA: number,
	vfovB: number,
	opts: { gpu?: "auto" | "on" | "off"; t0?: number } = {},
): Promise<RelRotResult> {
	const t0 = opts.t0 ?? performance.now();
	const r = await rotFromMatches(fa, fb, fwd, vfovA, vfovB, opts);
	const rb = await rotFromMatches(fb, fa, bwd, vfovB, vfovA, opts);
	// rot_angle(Rb @ R): the angle between R and Rbᵀ
	const fwdBwdDeg = r && rb ? rotationDistanceDeg(r.R, transpose3(rb.R)) : null;
	return {
		method: "rot",
		relR: r ? Array.from(r.R) : null,
		inliers: r ? r.inliers : 0,
		n: fwd.count,
		rmsPx: r ? r.rmsPx : null,
		bwd: rb
			? { relR: Array.from(rb.R), inliers: rb.inliers, rmsPx: rb.rmsPx }
			: null,
		fwdBwdDeg,
		sizeA: [fa.width, fa.height],
		sizeB: [fb.width, fb.height],
		seconds: Math.round(performance.now() - t0) / 1000,
	};
}

// ---------- images, caches ----------

/** Decode with EXIF orientation applied and fit the long side to `longSide` (never upscaled). */
export async function loadBitmap(
	src: string,
	longSide: number,
	signal?: AbortSignal,
): Promise<ImageBitmap> {
	const r = await fetch(src, { signal });
	if (!r.ok) throw new Error(`image ${r.status}`);
	const full = await createImageBitmap(await r.blob(), {
		imageOrientation: "from-image",
	});
	const s = longSide / Math.max(full.width, full.height);
	if (!(s < 1)) return full;
	const out = await createImageBitmap(full, {
		resizeWidth: Math.round(full.width * s),
		resizeHeight: Math.round(full.height * s),
		resizeQuality: "high",
	});
	full.close();
	return out;
}

const feats = new Map<string, Promise<Features>>();
const results = new Map<string, RelRotResult>();
const N_FEATS = 24;
const N_RESULTS = 256;

function featuresFor(src: string, signal?: AbortSignal): Promise<Features> {
	let p = feats.get(src);
	if (p) {
		feats.delete(src);
		feats.set(src, p);
		return p;
	}
	p = (async () => {
		const be = await featureBackend();
		const bmp = await loadBitmap(src, ESTIMATOR.longSide, signal);
		try {
			return await be.extract(bmp, {
				maxKeypoints: ESTIMATOR.maxKeypoints,
				longSide: ESTIMATOR.longSide,
				signal,
			});
		} finally {
			bmp.close();
		}
	})();
	p.catch(() => feats.delete(src));
	feats.set(src, p);
	while (feats.size > N_FEATS)
		feats.delete(feats.keys().next().value as string);
	return p;
}

/**
 * Relative rotation A-camera → B-camera (OpenCV axes, row-major). vfovA = the anchor's ACCEPTED vfov,
 * vfovB = the target's EXIF vfov. Same contract as the former HTTP client: an error string instead of throwing.
 */
export async function relRot(
	a: { src: string; vfov: number },
	b: { src: string; vfov: number },
	signal?: AbortSignal,
): Promise<RelRotResult | string> {
	if (!(a.vfov > 5 && a.vfov < 170 && b.vfov > 5 && b.vfov < 170))
		return "vfov out of range";
	const key = `${a.src}\n${b.src}\n${a.vfov.toFixed(4)}\n${b.vfov.toFixed(4)}`;
	const hit = results.get(key);
	if (hit) return hit;
	try {
		const t0 = performance.now();
		const be = await featureBackend();
		const [fa, fb] = await Promise.all([
			featuresFor(a.src, signal),
			featuresFor(b.src, signal),
		]);
		const fwd = await be.match(fa, fb, { signal });
		const bwd = await be.match(fb, fa, { signal });
		if (signal?.aborted) return "aborted";
		const out = await relRotFromFeatures(fa, fb, fwd, bwd, a.vfov, b.vfov, {
			t0,
		});
		results.set(key, out);
		while (results.size > N_RESULTS)
			results.delete(results.keys().next().value as string);
		return out;
	} catch (e) {
		if (signal?.aborted) return "aborted";
		return `estimator failed (${(e as Error)?.message ?? e})`;
	}
}

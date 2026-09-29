// Step Inside: the hover readout's splat pick, measurable content only. A `generated` Gaussian (P3 hole
// fill) is never a measurement: the ray passes through it to the first observed / reconstructed / DEM
// splat behind it, or to nothing (the caller then falls back to Renderer.sampleAt, i.e. the DEM).
// Pure TS; ENU clouds in the engine frame.
import { isMeasurable } from "../provenance";
import type { GaussianCloud } from "../types";

export type SplatHit = {
	index: number;
	/** Distance (m) along the ray to the splat centre's foot point. */
	t: number;
	/** Splat centre, ENU (m). */
	point: [number, number, number];
	provenance: number;
	/** Generated splats the ray passed through before this hit (they are skipped, never measured). */
	skippedGenerated: number;
};

export type ReadoutOpts = {
	/** A splat is hit when the ray passes within `sigmas`·(largest std-dev) of its centre. Default 2. */
	sigmas?: number;
	/** Minimum hit radius (m). Default 0.05. */
	minRadius?: number;
	/** Ignore hits nearer than this (m). Default 0. */
	near?: number;
};

/**
 * Nearest MEASURABLE splat along the ray origin + t·dir (dir need not be unit). null when the ray meets no
 * measurable splat. Generated (and unknown-code) splats never hit; the ones in front are counted.
 */
export function readoutHit(
	cloud: GaussianCloud,
	origin: ArrayLike<number>,
	dir: ArrayLike<number>,
	opts: ReadoutOpts = {},
): SplatHit | null {
	if (cloud.frame !== "enu")
		throw new Error("readoutHit: expects an ENU cloud");
	const k = opts.sigmas ?? 2;
	const minR = opts.minRadius ?? 0.05;
	const near = opts.near ?? 0;
	const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
	const d = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
	const P = cloud.positions;
	const S = cloud.scales;
	let best = -1;
	let bestT = Number.POSITIVE_INFINITY;
	const genT: number[] = [];
	for (let i = 0; i < cloud.count; i++) {
		const vx = P[3 * i] - origin[0];
		const vy = P[3 * i + 1] - origin[1];
		const vz = P[3 * i + 2] - origin[2];
		const t = vx * d[0] + vy * d[1] + vz * d[2];
		if (!(t > near)) continue;
		const px = vx - t * d[0];
		const py = vy - t * d[1];
		const pz = vz - t * d[2];
		const r = Math.max(
			minR,
			k * Math.max(S[3 * i], S[3 * i + 1], S[3 * i + 2]),
		);
		if (px * px + py * py + pz * pz > r * r) continue;
		if (!isMeasurable(cloud.provenance[i])) {
			genT.push(t);
			continue;
		}
		if (t >= bestT) continue;
		best = i;
		bestT = t;
	}
	if (best < 0) return null;
	return {
		index: best,
		t: bestT,
		point: [P[3 * best], P[3 * best + 1], P[3 * best + 2]],
		provenance: cloud.provenance[best],
		skippedGenerated: genT.filter((t) => t < bestT).length,
	};
}

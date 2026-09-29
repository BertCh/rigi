/**
 * Skyline clean-up for occluder-prone skylines (e.g. a sky-model mask, which
 * treats lamp posts, buildings and trees on the crest as skyline):
 *
 * - `rejectSpikes`: narrow upward excursions (row jumps up abruptly and comes
 *   back within < 2% of the width, typical of posts, poles and people's heads)
 *   get zero weight.
 * - `fuseSkylines`: cross-checks a primary skyline against a second detector
 *   column by column. By default only columns where both agree within a
 *   few px survive, with weight w_primary·w_secondary; disagreement (e.g. the
 *   primary on a tree or chalet the other detector down-weighted) or a missing
 *   secondary boundary zeroes the column. On IMG_7130 this strict rule was
 *   what fixed the sky-model variant; softer factors let the tree back in.
 *
 * Pure functions on {rows, weight, width, height}; no DOM.
 */

export interface SkylineLike {
	width: number;
	height: number;
	rows: ArrayLike<number>;
	weight: ArrayLike<number>;
}

export interface CleanSkyline {
	width: number;
	height: number;
	rows: Float32Array;
	weight: Float32Array;
}

const valid = (s: SkylineLike, x: number) =>
	Number.isFinite(s.rows[x]) && s.weight[x] > 0.05;

function median(v: number[]) {
	if (!v.length) return Number.NaN;
	const s = [...v].sort((a, b) => a - b);
	return s[s.length >> 1];
}

export interface SpikeOptions {
	/** Max excursion width as a fraction of the image width (default 0.02). */
	maxWidth?: number;
	/** Min rise above the local baseline, px (default max(3, 1% of height)). */
	minRise?: number;
	/** Baseline window half-width as a fraction of the width (default 0.04). */
	window?: number;
}

/** Zeroes narrow upward spikes (posts, poles, heads). Returns a copy. */
export function rejectSpikes(
	s: SkylineLike,
	o: SpikeOptions = {},
): CleanSkyline {
	const w = s.width;
	const maxW = Math.max(2, Math.round((o.maxWidth ?? 0.02) * w));
	const rise = o.minRise ?? Math.max(3, 0.01 * s.height);
	const win = Math.max(maxW * 2, Math.round((o.window ?? 0.04) * w));
	const rows = Float32Array.from(s.rows as ArrayLike<number>);
	const weight = Float32Array.from(s.weight as ArrayLike<number>);
	const base = new Float32Array(w).fill(Number.NaN);
	for (let x = 0; x < w; x++) {
		const v: number[] = [];
		for (let j = Math.max(0, x - win); j <= Math.min(w - 1, x + win); j++)
			if (valid(s, j)) v.push(s.rows[j]);
		base[x] = median(v);
	}
	let x = 0;
	while (x < w) {
		const up = valid(s, x) && base[x] - s.rows[x] > rise;
		if (!up) {
			x++;
			continue;
		}
		let e = x;
		while (e < w && valid(s, e) && base[e] - s.rows[e] > rise) e++;
		if (e - x <= maxW) for (let k = x; k < e; k++) weight[k] = 0;
		x = e;
	}
	return { width: w, height: s.height, rows, weight };
}

export interface FuseOptions {
	/** Agreement tolerance as a fraction of the width (default 0.004 ≈ 4 px at 1024). */
	tol?: number;
	/** Weight factor when the primary is above the secondary (default 0). */
	aboveFactor?: number;
	/** Weight factor when the primary is below the secondary (default 0). */
	belowFactor?: number;
	/** Weight factor when the secondary has no boundary (default 0). */
	missingFactor?: number;
	/** Secondary weight at which agreement counts fully (default 1). */
	confidentWeight?: number;
	/** Weight factor for agreement with a zero-confidence secondary (default 0). */
	agreeFloor?: number;
}

/**
 * Per-column fusion of a primary skyline with a secondary one (any width;
 * resampled to the primary's). Rows stay the primary's; only weights change.
 */
export function fuseSkylines(
	primary: SkylineLike,
	secondary: SkylineLike,
	o: FuseOptions = {},
): CleanSkyline {
	const w = primary.width;
	const sx = secondary.width / w;
	const sy = secondary.height / primary.height;
	const tol = (o.tol ?? 0.004) * w;
	const rows = Float32Array.from(primary.rows as ArrayLike<number>);
	const weight = Float32Array.from(primary.weight as ArrayLike<number>);
	for (let x = 0; x < w; x++) {
		if (!valid(primary, x)) continue;
		const xs = Math.min(secondary.width - 1, Math.floor((x + 0.5) * sx));
		if (!valid(secondary, xs)) {
			weight[x] *= o.missingFactor ?? 0;
			continue;
		}
		const d = primary.rows[x] - secondary.rows[xs] / sy;
		if (d < -tol) weight[x] *= o.aboveFactor ?? 0;
		else if (d > tol) weight[x] *= o.belowFactor ?? 0;
		else {
			// Agreement counts only as much as the secondary believes it.
			const conf = Math.min(1, secondary.weight[xs] / (o.confidentWeight ?? 1));
			weight[x] *= (o.agreeFloor ?? 0) + (1 - (o.agreeFloor ?? 0)) * conf;
		}
	}
	return { width: w, height: primary.height, rows, weight };
}

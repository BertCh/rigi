// The classic peak label ranking and declutter, shared by both engines (engine.ts peakLabels,
// deck/engine.ts peakLabels). Order, tie-breaks and thresholds are the original ones: changing
// them changes which labels classic shows (look/__tests__/labels.check.ts pins the output).

export type Rankable = {
	name: string;
	ele: number | null;
	prominence?: number | null;
	u: number;
	v: number;
	rank: number;
};

/** prominence·3 + elevation − range·0.012 (range in metres). */
export const peakRank = (
	prominence: number | null,
	ele: number | null,
	rangeM: number,
) => (prominence ?? 0) * 3 + (ele ?? 0) - rangeM * 0.012;

/** Sorts (in place) by rank; ties by prominence, elevation, name, then u. */
export function rankPeaks<T extends Rankable>(peaks: T[]): T[] {
	return peaks.sort(
		(a, b) =>
			b.rank - a.rank ||
			(b.prominence ?? 0) - (a.prominence ?? 0) ||
			(b.ele ?? 0) - (a.ele ?? 0) ||
			(a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
			a.u - b.u,
	);
}

/** Greedy declutter in frame units (≈7 px per character on a ~1100 px stage), at most `max` labels. */
export function declutterClassic<T extends Rankable>(
	ranked: T[],
	max: number,
): T[] {
	const half = (l: T) => Math.max(l.name.length, 12) * 0.0034;
	const placed: T[] = [];
	for (const l of ranked) {
		if (
			placed.some(
				(q) =>
					Math.abs(q.u - l.u) < half(q) + half(l) &&
					Math.abs(q.v - l.v) < 0.075,
			)
		)
			continue;
		placed.push(l);
		if (placed.length >= max) break;
	}
	return placed;
}

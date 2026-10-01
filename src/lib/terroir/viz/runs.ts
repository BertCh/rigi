// Split a projected polyline into drawable runs: a run breaks at points that are behind the camera,
// absurdly far off-screen, or flagged hidden (terrain in front). Closed rings merge the run across
// the seam.
export type RunPt = { x: number; y: number; dist: number; ok: boolean };

export function splitRuns<T extends RunPt>(pts: T[], closed: boolean): T[][] {
	const runs: T[][] = [];
	let cur: T[] = [];
	for (const p of pts) {
		if (p.ok) cur.push(p);
		else if (cur.length) {
			runs.push(cur);
			cur = [];
		}
	}
	if (cur.length) {
		if (closed && runs.length && pts[0].ok && pts[pts.length - 1].ok)
			runs[0] = [...cur, ...runs[0]];
		else runs.push(cur);
	}
	return runs;
}

export const pathD = (run: { x: number; y: number }[]) =>
	run
		.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
		.join("");

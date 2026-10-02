// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TafelBake } from "../tafel/useTafelBake";
import { horizonPoints } from "../viz/GeoSpill";
import type { GipfelbuchPhotoData } from "../viz/real";
import { poseAt } from "../viz/story";

const DEMO = path.resolve(__dirname, "../../../../public/demo/gipfelbuch");
const read = <T>(file: string) =>
	JSON.parse(fs.readFileSync(path.join(DEMO, file), "utf8")) as T;

const EDGE_COLUMNS = 5;
const TOLERANCE_PX = 0.5;

/**
 * Photos whose echoed DEM horizon does not yet meet the measured solved rows within TOLERANCE_PX
 * at the frame edges (the table printed by this spec has the medians). Known gap, not a pass:
 * the spill and the photo disagree there by more than the data-on-its-pixels budget.
 */
const KNOWN_GAP = new Set<string>([]);

const median = (v: number[]) => {
	const s = [...v].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : Number.NaN;
};

/** The polyline's y at column x (linear between neighbours), or null outside its span. */
function yAt(pts: [number, number][], x: number): number | null {
	for (let i = 0; i + 1 < pts.length; i++) {
		const [ax, ay] = pts[i];
		const [bx, by] = pts[i + 1];
		if ((ax - x) * (bx - x) <= 0 && ax !== bx)
			return ay + ((by - ay) * (x - ax)) / (bx - ax);
	}
	return null;
}

const ids = fs
	.readdirSync(DEMO)
	.filter((f) => /^demo-\d+\.json$/.test(f))
	.map((f) => f.replace(".json", ""))
	.filter((id) => fs.existsSync(path.join(DEMO, "tafel", `${id}.json`)));

const rows = ids.map((id) => {
	const data = read<GipfelbuchPhotoData>(`${id}.json`);
	const bake = read<TafelBake>(`tafel/${id}.json`);
	const pts = bake.horizon ? horizonPoints(bake, data, poseAt(data, 1)) : null;
	if (!pts) return { id, median: null as number | null, n: 0 };
	const W = data.photo.width;
	// solvedRows holds one row per working-px column
	if (data.solvedRows.length !== W)
		throw new Error(
			`${id}: solvedRows has ${data.solvedRows.length} columns, not ${W}`,
		);
	const cols = [
		...Array.from({ length: EDGE_COLUMNS }, (_, i) => i + 0.5),
		...Array.from(
			{ length: EDGE_COLUMNS },
			(_, i) => W - EDGE_COLUMNS + i + 0.5,
		),
	];
	const diffs: number[] = [];
	for (const x of cols) {
		const solved = data.solvedRows[Math.floor(x)];
		const y = yAt(pts, x);
		if (solved == null || y == null) continue;
		diffs.push(Math.abs(y - solved));
	}
	return { id, median: diffs.length ? median(diffs) : null, n: diffs.length };
});

describe("spill registration", () => {
	it("prints the edge registration table", () => {
		console.log(
			`spill registration, median |dy| px over edge columns\n${rows
				.map((r) => `${r.id}\t${r.median?.toFixed(2) ?? "n/a"}\t(n=${r.n})`)
				.join("\n")}`,
		);
		expect(rows.length).toBeGreaterThan(0);
	});

	for (const r of rows) {
		const known = KNOWN_GAP.has(r.id);
		it(`${r.id}: the echoed horizon meets the solved rows at the frame edges${known ? " (known gap)" : ""}`, () => {
			if (known) return;
			// a bake without a wide horizon, or edges with no rows, is a failure, not a pass
			expect(r.median).not.toBeNull();
			expect(r.n).toBeGreaterThanOrEqual(EDGE_COLUMNS);
			expect(r.median as number).toBeLessThanOrEqual(TOLERANCE_PX);
		});
	}
});

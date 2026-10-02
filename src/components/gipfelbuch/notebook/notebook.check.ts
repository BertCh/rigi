// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The notebook must cover the curated Gipfelbuch exactly once, every `needs` note must point at a
// real step, and every node group must have a `#group-<id>` anchor (concept-page breadcrumbs link
// there). Run: npx tsx src/components/gipfelbuch/notebook/notebook.check.ts

import { GIPFELBUCH_NODES } from "#/lib/gipfelbuch/graph";
import { NOTEBOOK_ENTRIES, NOTEBOOK_NODE_IDS, STEP_NUMBER } from "./entries";
import { splitPrintRuns } from "./Ink";
import {
	createRandom,
	flattenStroke,
	inkBlob,
	type Point,
	sketchArrow,
	sketchCircle,
	sketchLine,
	taperedOutline,
} from "./sketch";
import {
	hachureFill,
	parsePath,
	screeFill,
	sketchify,
	sketchPolyline,
	stippleFill,
} from "./sketchify";

const failures: string[] = [];
const nodeIds = new Set(GIPFELBUCH_NODES.map((node) => node.id));

for (const id of NOTEBOOK_NODE_IDS) {
	if (!nodeIds.has(id)) failures.push(`notebook names unknown node "${id}"`);
}
const seen = new Map<string, number>();
for (const id of NOTEBOOK_NODE_IDS) seen.set(id, (seen.get(id) ?? 0) + 1);
for (const [id, count] of seen) {
	if (count > 1) failures.push(`node "${id}" appears ${count} times`);
}
for (const node of GIPFELBUCH_NODES) {
	if (!seen.has(node.id))
		failures.push(`node "${node.id}" is missing from the notebook`);
}

const anchored = new Set(NOTEBOOK_ENTRIES.flatMap((entry) => entry.groups));
const anchorCount = NOTEBOOK_ENTRIES.flatMap((entry) => entry.groups).length;
if (anchored.size !== anchorCount)
	failures.push("a #group-<id> anchor is declared twice");
for (const node of GIPFELBUCH_NODES) {
	if (!anchored.has(node.group))
		failures.push(`group "${node.group}" (of ${node.id}) has no #group anchor`);
}

for (const entry of NOTEBOOK_ENTRIES) {
	for (const step of entry.steps) {
		for (const need of step.needs ?? []) {
			if (!STEP_NUMBER.has(need.id))
				failures.push(`${step.id} needs "${need.id}", which is not a step`);
		}
	}
}

// Seeded strokes are deterministic and stay finite.
const first = sketchLine([0, 0], [100, 40], 7);
if (first !== sketchLine([0, 0], [100, 40], 7))
	failures.push("sketchLine is not deterministic");
for (const path of [
	first,
	sketchCircle([10, 10], 8, 6, 3),
	sketchArrow([0, 0], [50, 50], 9).shaft,
	sketchArrow([0, 0], [50, 50], 9).head,
]) {
	if (/NaN|Infinity/.test(path))
		failures.push(`non-finite path: ${path.slice(0, 60)}`);
}
const random = createRandom(42);
const draws = Array.from({ length: 1000 }, random);
if (draws.some((value) => value < 0 || value >= 1))
	failures.push("createRandom left [0, 1)");

// Sketched data stays on the data: every vertex of a sketched series lies within tolerance (plus the
// end overshoot) of the true polyline.
const distanceToPolyline = ([px, py]: Point, line: Point[]) => {
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i + 1 < line.length; i++) {
		const [ax, ay] = line[i];
		const [bx, by] = line[i + 1];
		const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
		const t = Math.max(
			0,
			Math.min(
				1,
				((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / lengthSquared,
			),
		);
		best = Math.min(
			best,
			Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))),
		);
	}
	return best;
};
const series: Point[] = Array.from({ length: 800 }, (_, x) => [
	x,
	300 + 80 * Math.sin(x / 37) + 12 * Math.sin(x / 5),
]);
for (const tolerance of [0.6, 0.9, 1.5]) {
	for (const stroke of sketchPolyline(series, "series", {
		tolerance,
		overshoot: 0,
	})) {
		const worst = Math.max(
			...parsePath(stroke)[0].points.map((point) =>
				distanceToPolyline(point, series),
			),
		);
		if (worst > tolerance + 0.15)
			failures.push(
				`sketchPolyline strays ${worst.toFixed(2)} px at tolerance ${tolerance}`,
			);
	}
}
const firstSketch = sketchPolyline(series, 5).join();
const secondSketch = sketchPolyline(series, 5).join();
if (firstSketch !== secondSketch)
	failures.push("sketchPolyline is not deterministic");
// Path parsing: relative commands, curves and arcs end where the browser would end them.
const parsed = parsePath(
	"M10 10 h20 v20 q10 10 20 0 a10 10 0 0 1 20 0 c0 10 10 10 10 0 z m100 0 l10 10",
);
const last = parsed[0].points[parsed[0].points.length - 1];
if (parsed.length !== 2 || Math.hypot(last[0] - 80, last[1] - 30) > 0.01)
	failures.push(
		`parsePath ended at ${last} (want 80,30) with ${parsed.length} subpaths`,
	);
if (sketchify("M0 0L100 0", 1).some((d) => /NaN|Infinity/.test(d)))
	failures.push("sketchify produced NaN");
// Fills stay inside their shape.
const square: Point[] = [
	[0, 0],
	[100, 0],
	[100, 60],
	[0, 60],
];
for (const subpath of parsePath(hachureFill([square], 3, { gap: 5 })))
	for (const [x, y] of subpath.points)
		if (x < -1 || x > 101 || y < -1 || y > 61)
			failures.push(`hachure left the square at ${x},${y}`);
if (!stippleFill([square], 4).includes("M"))
	failures.push("stipple drew nothing");

// Tapered pen outlines.
{
	const line: Point[] = [
		[0, 0],
		[100, 0],
	];
	const outline = taperedOutline(line, 5, { width: 1.4 });
	if (outline !== taperedOutline(line, 5, { width: 1.4 }))
		failures.push("taperedOutline is not deterministic");
	if (
		/NaN|Infinity/.test(outline) ||
		!outline.startsWith("M") ||
		!outline.endsWith("Z")
	)
		failures.push("taperedOutline is not a finite closed path");
	const ring = parsePath(outline)[0].points;
	const halfWidthAt = (low: number, high: number) =>
		Math.max(
			0,
			...ring
				.filter(([x]) => x >= low && x <= high)
				.map(([, y]) => Math.abs(y)),
		);
	const middle = halfWidthAt(40, 60);
	const ends = Math.max(halfWidthAt(0, 2), halfWidthAt(98, 100));
	if (middle > 1.4 || middle < 0.4)
		failures.push(
			`taperedOutline middle half-width ${middle} outside 0.4..1.4`,
		);
	if (!(ends < middle))
		failures.push(
			`taperedOutline ends (${ends}) are not thinner than the middle (${middle})`,
		);
	const curve = flattenStroke(sketchCircle([50, 50], 20, 18, 3))[0];
	if (/NaN|Infinity/.test(taperedOutline(curve, 3, { closed: true })))
		failures.push("taperedOutline on a loop is not finite");
	if (
		/NaN|Infinity/.test(inkBlob([3, 4], 1.4, 9)) ||
		!inkBlob([3, 4], 1.4, 9).endsWith("Z")
	)
		failures.push("inkBlob is not finite");
}
// Numbers are set in print.
{
	const accept = splitPrintRuns("accept ≥ 0.5");
	if (!accept.some((run) => run.print && run.text.includes("0.5")))
		failures.push(`splitPrintRuns("accept ≥ 0.5") has no print run with 0.5`);
	const plain = splitPrintRuns("cloud edge");
	if (plain.length !== 1 || plain[0].print)
		failures.push("splitPrintRuns of plain words is not one non-print run");
	const peaks = splitPrintRuns("Mapterhorn peaks at 1 963 m");
	if (!peaks.some((run) => run.print && run.text === "1 963 m"))
		failures.push(`splitPrintRuns peaks run is ${JSON.stringify(peaks)}`);
	const photos = splitPrintRuns("2 of 12 photos");
	if (
		photos.map((run) => run.text).join("") !== "2 of 12 photos" ||
		photos.filter((run) => run.print).length !== 2
	)
		failures.push(`splitPrintRuns photos is ${JSON.stringify(photos)}`);
}
// Scree stones are deterministic and stay in the ring's box.
{
	const first = screeFill([square], 8).d;
	if (!first || first !== screeFill([square], 8).d)
		failures.push("screeFill is empty or not deterministic");
	for (const subpath of parsePath(first))
		for (const [x, y] of subpath.points)
			if (x < -1.6 || x > 101.6 || y < -1.6 || y > 61.6)
				failures.push(`scree stone left the box at ${x},${y}`);
}

if (failures.length) {
	console.error(
		`notebook: ${failures.length} failure(s)\n  ${failures.join("\n  ")}`,
	);
	process.exit(1);
}
console.log(
	`notebook: ok (${NOTEBOOK_NODE_IDS.length} nodes, ${anchored.size} group anchors, ${STEP_NUMBER.size} steps)`,
);

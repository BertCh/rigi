// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The notebook must cover the curated Gipfelbuch exactly once, every `needs` note must point at a
// real step, and every node group must have a `#group-<id>` anchor (concept-page breadcrumbs link
// there). Run: npx tsx src/components/gipfelbuch/notebook/notebook.check.ts

import { GIPFELBUCH_NODES } from "#/lib/gipfelbuch/graph";
import {
	contourScribbleLoops,
	layoutPeakLeaders,
	rockHachureStrokes,
} from "./carto";
import { NOTEBOOK_ENTRIES, NOTEBOOK_NODE_IDS, STEP_NUMBER } from "./entries";
import { splitPrintRuns } from "./Ink";
import { washPolygons } from "./marks";
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

// Cartographic kit (carto.tsx, marks.tsx): seeded, finite, and the layout rules hold.
{
	// Peak leaders: no two labels in a row overlap and no leader runs through a lower label.
	const random = createRandom(11);
	const peaks = Array.from({ length: 9 }, (_, i) => ({
		x: 40 + i * 82 + random() * 20,
		y: 200 + random() * 40,
		label: ["Niesen", "Eiger", "Jungfrau", "Mönch", "Schreckhorn"][i % 5],
		h: 2000 + Math.round(random() * 2000),
	}));
	const placed = layoutPeakLeaders(peaks, { rows: 4, pad: 4 });
	if (
		JSON.stringify(placed) !==
		JSON.stringify(layoutPeakLeaders(peaks, { rows: 4, pad: 4 }))
	)
		failures.push("layoutPeakLeaders is not deterministic");
	const conflicted = placed.filter((peak) => peak.conflict).length;
	if (conflicted)
		failures.push(
			`layoutPeakLeaders left ${conflicted} conflicts in 4 rows (9 peaks)`,
		);
	for (const a of placed)
		for (const b of placed) {
			if (a === b || a.conflict || b.conflict) continue;
			if (
				a.row === b.row &&
				a.extent[0] < b.extent[1] &&
				b.extent[0] < a.extent[1]
			)
				failures.push(
					`peak labels ${a.label}@${a.x.toFixed(0)} and ${b.label}@${b.x.toFixed(0)} overlap in row ${a.row}`,
				);
			if (b.row < a.row && a.x > b.extent[0] && a.x < b.extent[1])
				failures.push(
					`leader of ${a.label}@${a.x.toFixed(0)} crosses label ${b.label}`,
				);
			if (a.labelY >= Math.min(...peaks.map((peak) => peak.y)))
				failures.push(`peak label ${a.label} sits below a summit`);
		}
	// Rock hachure: shaded strokes only on the face turned from a NW light, starting at the ridge.
	const descending: Point[] = Array.from({ length: 60 }, (_, i) => [
		i * 2,
		100 + i * 1.2,
	]);
	const ascending: Point[] = descending.map(([x, y]) => [x, 200 - y]);
	const down = rockHachureStrokes(descending, "rock");
	const up = rockHachureStrokes(ascending, "rock");
	if (down.shaded !== rockHachureStrokes(descending, "rock").shaded)
		failures.push("rockHachureStrokes is not deterministic");
	if (/NaN|Infinity/.test(down.shaded + down.lit + up.shaded + up.lit))
		failures.push("rockHachureStrokes produced NaN");
	if (!down.shaded || up.shaded)
		failures.push("rockHachureStrokes shades the wrong face (light 315)");
	if (!up.lit) failures.push("rockHachureStrokes drew no lit strokes");
	for (const subpath of parsePath(down.shaded)) {
		const [x, y] = subpath.points[0];
		const onRidge = 100 + (x / 2) * 1.2;
		if (Math.abs(y - onRidge) > 1.5)
			failures.push(
				`rock stroke starts ${(y - onRidge).toFixed(2)} px off the ridge`,
			);
	}
	// Contour scribble: nested, open loops.
	const loops = contourScribbleLoops([100, 100], "summit", {
		count: 5,
		radius: 50,
		steep: 90,
	});
	if (loops.length !== 5) failures.push("contourScribbleLoops count");
	let previous = 0;
	for (const loop of loops) {
		const mean =
			loop.reduce((sum, [x, y]) => sum + Math.hypot(x - 100, y - 100), 0) /
			loop.length;
		if (!(mean > previous)) failures.push("contour loops are not nested");
		previous = mean;
		const [x0, y0] = loop[0];
		const [x1, y1] = loop[loop.length - 1];
		if (Math.hypot(x1 - x0, y1 - y0) < 2)
			failures.push("contour loop is closed");
	}
	// Wash layers: one path per layer, finite, deterministic.
	const wash = washPolygons("M0 0L100 0L100 60L0 60Z", "lake", { layers: 6 });
	if (wash.length !== 6 || wash.some((d) => /NaN|Infinity/.test(d)))
		failures.push("washPolygons is not 6 finite layers");
	if (
		wash.join() !==
		washPolygons("M0 0L100 0L100 60L0 60Z", "lake", { layers: 6 }).join()
	)
		failures.push("washPolygons is not deterministic");
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

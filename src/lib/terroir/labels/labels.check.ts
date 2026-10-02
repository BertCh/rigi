// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check for the terroir label helpers: `npx tsx src/lib/terroir/labels/labels.check.ts`
//  - declutter, reach filter, dedupe against the engine's peaks, typography per class, peakTier
//  - peak tiers: pack backfill, tier hints reach the panorama layout and the classic layout
//  - uncertainty softening, text-on-path geometry
import { layoutClassic } from "../../look/labels/classic.ts";
import { type LabelCandidate, layoutLabels } from "../../look/labels/layout.ts";
import { MINI_PACK } from "../__fixtures__/mini-pack.ts";
import { NAME_TYPO, peakTier } from "../classes.ts";
import {
	declutterNames,
	displayText,
	dupOfPeak,
	nameType,
	reachOk,
	rectsHit,
	textPath,
	textWidth,
	uncertainOpacity,
	uncertainPrefix,
} from "./names.ts";
import {
	buildTierIndex,
	classicTier,
	decorateCandidates,
	resolvePeakClass,
	tierHint,
} from "./peakTiers.ts";
import {
	SWISSTOPO_LABELS,
	SWISSTOPO_NAME_TYPO,
	SWISSTOPO_WATER,
} from "./swisstopo.ts";

let fails = 0;
const ok = (c: unknown, msg: string) => {
	if (!c) {
		fails++;
		console.error(`FAIL ${msg}`);
	}
};

// ---- peakTier
ok(peakTier(800, 3000) === "peak-major", "prominence 800 -> major");
ok(peakTier(300, 2000) === "peak", "prominence 300 -> peak");
ok(peakTier(40, 2000) === "peak-minor", "prominence 40 -> minor");
ok(peakTier(null, 4100) === "peak-major", "no prominence, 4100 m -> major");
ok(peakTier(null, 2000) === "peak", "no prominence, 2000 m -> peak");

// ---- reach
ok(reachOk("field", 2000, "near"), "field inside 3 km");
ok(!reachOk("field", 5000, "near"), "field beyond 3 km under near");
ok(reachOk("field", 50000, "all"), "reach all ignores the limit");
ok(reachOk("lake", 90000, "near"), "lake has no limit");
ok(!reachOk("hut", 13000, "near"), "hut beyond 12 km");

// ---- dedupe vs engine peaks
const peaks: { name: string; world: [number, number, number] }[] = [
	{ name: "Niesen", world: [1000, 2000, 2300] },
];
ok(dupOfPeak("Niesen", [1100, 2050, 0], peaks), "same name, 110 m");
ok(dupOfPeak("Other", [1100, 2050, 0], peaks), "any name within 300 m");
ok(dupOfPeak("Niesen", [1900, 2000, 0], peaks), "same name within 2 km");
ok(
	!dupOfPeak("Other", [1900, 2000, 0], peaks),
	"other name at 900 m is not a dup",
);
ok(
	!dupOfPeak("Niesen", [9000, 2000, 0], peaks),
	"same name far away is not a dup",
);
ok(
	dupOfPeak(
		"Zürich Höhe",
		[1000, 2000, 0],
		[{ name: "Zurich Hohe", world: [1000, 2100, 0] }],
	),
	"accents ignored",
);

// ---- typography
const lake = nameType("lake", 12);
ok(lake.italic && lake.color === NAME_TYPO.lake.color, "lake italic blue");
ok(Math.abs(lake.px - 12 * 1.05) < 1e-9, "lake size relative to base");
const massif = nameType("massif", 12);
ok(massif.upper && massif.trackPx > 2, "massif spaced caps");
ok(displayText("Eiger", massif) === "EIGER", "uppercase");
ok(displayText("Eiger", lake) === "Eiger", "no uppercase for lakes");
const meas = (s: string) => s.length * 7;
ok(
	textWidth("Eiger", massif, "x", meas) === 35 + massif.trackPx * 5,
	"tracking adds per glyph",
);
ok(
	nameType("glacier", 12).italic && nameType("glacier", 12).trackPx > 0,
	"glacier spaced italic",
);

// ---- declutter
const R = (x: number, y: number, w = 60, h = 14) => ({
	x0: x,
	y0: y,
	x1: x + w,
	y1: y + h,
});
const items = [
	{ id: "a", score: 10, rects: [R(100, 100)], data: 1 },
	{ id: "b", score: 20, rects: [R(110, 105), R(110, 140)], data: 2 },
	{ id: "c", score: 5, rects: [R(300, 300)], data: 3 },
	{ id: "d", score: 1, rects: [R(-50, 10)], data: 4 },
	{ id: "e", score: 4, rects: [R(500, 20)], data: 5 },
];
const got = declutterNames(items, [R(290, 295, 80, 30)], {
	width: 800,
	height: 600,
	max: 10,
});
const ids = got
	.map((g) => g.item.id)
	.sort()
	.join("");
ok(ids === "abe" || ids === "be", `declutter winners (${ids})`);
const b = got.find((g) => g.item.id === "b");
ok(b && b.alt === 0, "highest score keeps its first spot");
ok(!got.find((g) => g.item.id === "a"), "a loses to b");
ok(!got.find((g) => g.item.id === "c"), "c blocked by an obstacle");
ok(!got.find((g) => g.item.id === "d"), "d outside the stage");
for (let i = 0; i < got.length; i++)
	for (let j = i + 1; j < got.length; j++)
		ok(!rectsHit(got[i].rect, got[j].rect), "no overlaps among winners");
const alt = declutterNames(
	[
		{ id: "x", score: 9, rects: [R(100, 100)], data: 0 },
		{ id: "y", score: 8, rects: [R(100, 100), R(100, 200)], data: 0 },
	],
	[],
	{ width: 800, height: 600, max: 10 },
);
ok(
	alt.find((g) => g.item.id === "y")?.alt === 1,
	"falls to the second alternative",
);
ok(
	declutterNames(items, [], { width: 800, height: 600, max: 2 }).length === 2,
	"maxLabels cap",
);

// ---- uncertainty
ok(uncertainOpacity(1) === 0.75, "near stays 0.75");
ok(Math.abs(uncertainOpacity(100) - 0.4) < 1e-9, "far falls to 0.40");
ok(uncertainOpacity(30) < uncertainOpacity(10), "far first");
ok(
	uncertainPrefix(25) === "≈ " && uncertainPrefix(10) === "",
	"≈ prefix beyond 20 km",
);

// ---- text path
const flat = Array.from({ length: 10 }, (_, i) => ({
	x: 100 + i * 30,
	y: 200 + (i % 2),
}));
const tp = textPath(flat, 120);
ok(tp && tp[0].x < tp[tp.length - 1].x, "path runs left to right");
ok(
	textPath(
		[
			{ x: 0, y: 0 },
			{ x: 40, y: 0 },
		],
		30,
	) === null,
	"too short (< 60 px)",
);
ok(
	textPath(
		[
			{ x: 0, y: 0 },
			{ x: 60, y: 0 },
			{ x: 60, y: 60 },
			{ x: 0, y: 60 },
			{ x: 0, y: 120 },
		],
		300,
	) === null,
	"too curved",
);
const rev = textPath(
	[
		{ x: 200, y: 50 },
		{ x: 100, y: 50 },
	],
	80,
);
ok(rev && rev[0].x < rev[1].x, "right-to-left is reversed");

// ---- peak tiers: pack backfill
const idx = buildTierIndex(MINI_PACK);
ok(idx?.has("jungfrau"), "tier index has Jungfrau");
ok(
	resolvePeakClass(
		idx,
		{ name: "Jungfrau", ele: 4158 },
		{ lat: 46.5372, lon: 7.9621 },
	) === "peak-major",
	"backfill by name + distance",
);
ok(
	resolvePeakClass(idx, { name: "Niesen", ele: 2362, prominence: 40 }, null) ===
		"peak-minor",
	"known prominence wins",
);
ok(
	resolvePeakClass(
		idx,
		{ name: "Niesen", ele: 2362 },
		{ lat: 47.5, lon: 7.65 },
	) === "peak",
	"too far from the pack's Niesen: elevation fallback",
);
ok(
	resolvePeakClass(null, { name: "X", ele: 3950 }, null) === "peak-major",
	"no pack: elevation fallback",
);
const th = tierHint("peak-major");
ok(
	th.tier === 0 && Math.abs(th.sizeMul * 1.14 - 1.25) < 1e-9,
	"major size 1.25",
);
ok(
	Math.abs(tierHint("peak-minor").sizeMul * 0.88 - 0.86) < 1e-9,
	"minor size 0.86",
);
ok(
	classicTier("peak-major").weight === 700 && classicTier("peak").scale === 1,
	"classic tier",
);

// ---- tier hints reach the layouts
const cand = (id: string, x: number): LabelCandidate => ({
	id,
	name: id,
	ele: 2000,
	prominence: 100,
	distKm: 10,
	x,
	y: 400,
	visible: true,
});
const measure = (s: string) => s.length * 7;
const base = layoutLabels([cand("A", 200), cand("B", 600)], {
	width: 1000,
	height: 800,
	fontPx: 14,
	style: "inline",
	measure,
});
const dec = layoutLabels(
	decorateCandidates(
		[cand("A", 200), cand("B", 600)],
		[0, 1],
		(i) => (i === 0 ? "peak-major" : "peak-minor"),
		false,
	),
	{ width: 1000, height: 800, fontPx: 14, style: "inline", measure },
);
const A = dec.find((l) => l.id === "A");
const B = dec.find((l) => l.id === "B");
ok(A && B && A.tier === 0 && B.tier === 2, "tier hints force the tier");
ok(A && B && A.textH > B.textH * 1.4, "major label is ~1.45x the minor");
ok(
	base.every((l) => l.sizeMul === undefined),
	"off: no sizeMul on candidates",
);
const far = decorateCandidates(
	[{ ...cand("F", 1), distKm: 30 }],
	[0],
	null,
	true,
);
ok(far[0].name === "≈ F" && far[0].id === "F", "≈ on a far name, id unchanged");

const cl = (scale?: number) =>
	layoutClassic(
		[
			{
				id: "k",
				name: "Piz Bernina",
				sub: "4,049 m · 30.0 km",
				x: 500,
				y: 400,
				scale,
			},
		],
		{
			width: 1000,
			height: 800,
			nameFont: "600 12px x",
			subFont: "400 10px x",
			nameLineH: 15,
			subLineH: 12,
			leadPx: 20,
			dotPx: 6,
			measure,
		},
	)[0];
const c1 = cl();
const c2 = cl(1.25);
ok(
	c1 &&
		c2 &&
		c2.box.x1 - c2.box.x0 > c1.box.x1 - c1.box.x0 &&
		c2.box.y1 - c2.box.y0 > c1.box.y1 - c1.box.y0,
	"classic scale grows the block",
);
const c0 = cl(1);
ok(
	JSON.stringify(c0) === JSON.stringify(c1),
	"scale 1 is identical to no scale",
);

// ---- swisstopo preset: only self-hosted faces (upright 300/400/500/600, italic 400)
const SELF_HOSTED_UPRIGHT = new Set([300, 400, 500, 600]);
for (const [cls, t] of Object.entries(SWISSTOPO_NAME_TYPO)) {
	ok(
		t.italic ? t.weight === 400 : SELF_HOSTED_UPRIGHT.has(t.weight),
		`swisstopo ${cls} uses a self-hosted weight/style`,
	);
}
ok(
	SWISSTOPO_NAME_TYPO.lake.italic &&
		SWISSTOPO_NAME_TYPO.lake.color === SWISSTOPO_WATER,
	"swisstopo hydrography blue italic",
);
ok(
	SWISSTOPO_NAME_TYPO.region.upper && SWISSTOPO_NAME_TYPO.region.tracking > 0.2,
	"swisstopo regions letter-spaced capitals",
);
ok(
	!SWISSTOPO_NAME_TYPO.peak.italic && !SWISSTOPO_NAME_TYPO.peak.upper,
	"swisstopo peaks upright",
);
ok(
	(SWISSTOPO_LABELS.sub?.weight ?? 400) < (SWISSTOPO_LABELS.name?.weight ?? 0),
	"swisstopo elevation lighter than the name",
);
ok(
	Object.keys(SWISSTOPO_NAME_TYPO).length === Object.keys(NAME_TYPO).length,
	"swisstopo covers every name class",
);

if (fails) {
	console.error(`${fails} failure(s)`);
	process.exit(1);
}
console.log("terroir labels check ok");

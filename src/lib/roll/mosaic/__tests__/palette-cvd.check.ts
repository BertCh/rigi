// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Colour grammar check: the viewpoint palette stays separable under simulated colour-vision
// deficiency (Machado 2009 matrices, CIEDE2000), and stays clear of the selection orange.
// Run: npx tsx src/lib/roll/mosaic/__tests__/palette-cvd.check.ts
import { BRAND } from "../../../../brand/khipu.ts";
import {
	CVD_KINDS,
	deltaE2000,
	deltaEUnder,
	hexToRgb255,
	minPairwiseDeltaE,
	rgbToLab,
	simulateCvd,
} from "../cvd.ts";
import { VIEWPOINT_COLORS, vpColor } from "../style.ts";

let fails = 0;
const ok = (cond: boolean, msg: string) => {
	if (!cond) {
		fails++;
		console.error(`FAIL ${msg}`);
	}
};

/** Minimum pairwise separation between viewpoint colours, any vision type. */
const MIN_PAIR_DELTA_E = 7;
/** Minimum separation of every viewpoint colour from the selection orange, any vision type. */
const MIN_FROM_SELECTION_DELTA_E = 8;

// ---- CIEDE2000 against Sharma, Wu & Dalal 2005 reference pairs
const lab = (L: number, a: number, b: number) => [L, a, b] as const;
const refs: [
	readonly [number, number, number],
	readonly [number, number, number],
	number,
][] = [
	[lab(50, 2.6772, -79.7751), lab(50, 0, -82.7485), 2.0425],
	[lab(50, 3.1571, -77.2803), lab(50, 0, -82.7485), 2.8615],
	[lab(50, 2.5, 0), lab(73, 25, -18), 27.1492],
	[lab(60.2574, -34.0099, 36.2677), lab(60.4626, -34.1751, 39.4387), 1.2644],
];
for (const [x, y, want] of refs)
	ok(
		Math.abs(deltaE2000(x, y) - want) < 1e-3,
		`deltaE2000 reference ${want}, got ${deltaE2000(x, y).toFixed(4)}`,
	);

// ---- simulation sanity: white and black are fixed points, deuteranopia merges red and green
for (const kind of CVD_KINDS) {
	const w = simulateCvd([255, 255, 255], kind);
	ok(
		w.every((c) => Math.abs(c - 255) < 2),
		`${kind} keeps white`,
	);
	const k = simulateCvd([0, 0, 0], kind);
	ok(
		k.every((c) => c < 1),
		`${kind} keeps black`,
	);
}
const redGreen = deltaE2000(
	rgbToLab(simulateCvd([200, 60, 60], "deuteranopia")),
	rgbToLab(simulateCvd([60, 150, 60], "deuteranopia")),
);
const redGreenNormal = deltaE2000(
	rgbToLab([200, 60, 60]),
	rgbToLab([60, 150, 60]),
);
ok(redGreen < redGreenNormal, "deuteranopia reduces red/green separation");

// ---- the palette
ok(VIEWPOINT_COLORS.length >= 6, "at least six viewpoint colours");
ok(
	new Set(VIEWPOINT_COLORS).size === VIEWPOINT_COLORS.length,
	"viewpoint colours are unique",
);
ok(vpColor(0) === VIEWPOINT_COLORS[0], "vpColor(0) is the first colour");
ok(
	vpColor(-1) === VIEWPOINT_COLORS[VIEWPOINT_COLORS.length - 1],
	"vpColor wraps negatives",
);

for (const kind of CVD_KINDS) {
	const { min, pair } = minPairwiseDeltaE(VIEWPOINT_COLORS, kind);
	console.log(
		`${kind.padEnd(13)} min pairwise dE00 ${min.toFixed(2)} (${VIEWPOINT_COLORS[pair[0]]} vs ${VIEWPOINT_COLORS[pair[1]]})`,
	);
	ok(
		min >= MIN_PAIR_DELTA_E,
		`${kind}: min pairwise ${min.toFixed(2)} >= ${MIN_PAIR_DELTA_E}`,
	);
	for (const c of VIEWPOINT_COLORS) {
		const d = deltaEUnder(c, BRAND.glow, kind);
		ok(
			d >= MIN_FROM_SELECTION_DELTA_E,
			`${kind}: ${c} vs selection orange ${d.toFixed(2)} >= ${MIN_FROM_SELECTION_DELTA_E}`,
		);
	}
}

// the old set, kept as the regression the new one fixes: its vp0 and vp5 collided under deuteranopia
const OLD = [
	BRAND.glow,
	"#6cc3d5",
	"#9ad07a",
	"#d58bd8",
	"#e9d267",
	"#ef8a7a",
	"#7aa2ef",
	"#7fd6b0",
];
const oldMin = minPairwiseDeltaE(OLD, "deuteranopia").min;
console.log(
	`old eight-colour set under deuteranopia: min dE00 ${oldMin.toFixed(2)}`,
);
ok(oldMin < MIN_PAIR_DELTA_E, "old palette would fail the threshold (the bug)");
ok(hexToRgb255(vpColor(0)).length === 3, "vpColor returns a hex colour");

if (fails) {
	console.error(`${fails} failure(s)`);
	process.exit(1);
}
console.log("palette-cvd check ok");

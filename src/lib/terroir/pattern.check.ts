// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { fs } from "../deck/terrain-layer";
import { CLASSIC } from "../style/defaults";
import { presetStyle } from "../style/presets";
import { terroirTerrainFs } from "./glsl/terrain";
// Terroir pattern fills (./pattern.ts): the CPU mirror's mean coverage (hatch width fraction, dot
// pi r^2 per cell) across footprints 0.01..10 cells, range [0, 1], the fade, and that the GLSL / WGSL
// twins carry the same constants and the splice is off by default.
import {
	PATTERN_GLSL,
	PATTERN_WGSL,
	patternCoverage,
	TERROIR_PATTERN_PARAMS,
} from "./pattern";
import { terroirWGSL } from "./wgsl/terrain";

let failed = 0;
const check = (ok: boolean, msg: string) => {
	if (!ok) {
		failed++;
		console.error(`FAIL ${msg}`);
	}
};

const N = 64;
const FOOTPRINTS = [0.01, 0.03, 0.1, 0.3, 0.5, 1, 2, 5, 10];

// sample one period (spacing 1 m, angle 0; the footprint in metres = cells) on an N x N lattice
function stats(
	kind: "hatch" | "dots",
	f: number,
	width: number,
	angle: number,
) {
	let sum = 0;
	let sum2 = 0;
	let lo = Infinity;
	let hi = -Infinity;
	for (let i = 0; i < N; i++)
		for (let j = 0; j < N; j++) {
			const v = patternCoverage(
				kind,
				[(i + 0.5) / N, (j + 0.5) / N],
				[f, f],
				1,
				width,
				angle,
			);
			check(
				v >= 0 && v <= 1 && Number.isFinite(v),
				`${kind} f=${f} in [0,1]: ${v}`,
			);
			sum += v;
			sum2 += v * v;
			lo = Math.min(lo, v);
			hi = Math.max(hi, v);
		}
	const mean = sum / (N * N);
	return {
		mean,
		std: Math.sqrt(Math.max(sum2 / (N * N) - mean * mean, 0)),
		range: hi - lo,
	};
}

// hatch: mean coverage = width at every footprint (the filter preserves it)
for (const width of [0.1, 0.4]) {
	let prevStd = Infinity;
	for (const f of FOOTPRINTS) {
		const s = stats("hatch", f, width, 0);
		check(
			Math.abs(s.mean - width) < 0.02,
			`hatch w=${width} f=${f} mean ${s.mean.toFixed(4)} != ${width}`,
		);
		// the fade: contrast falls with the footprint up to one cell, then stays under the 1/f envelope
		if (f <= 1) {
			check(
				s.std <= prevStd + 1e-6,
				`hatch w=${width} f=${f} std ${s.std} rose from ${prevStd}`,
			);
			prevStd = s.std;
		} else
			check(
				s.range <= 1 / f + 0.02,
				`hatch w=${width} f=${f} range ${s.range} > 1/f`,
			);
	}
	check(
		stats("hatch", 1, width, 0).range < 0.02,
		"hatch is flat at footprint = one period",
	);
}

// the rotated hatch keeps its mean (spacing 1 m, 45 deg: a lattice over many periods)
{
	let sum = 0;
	const M = 96;
	for (let i = 0; i < M; i++)
		for (let j = 0; j < M; j++)
			sum += patternCoverage(
				"hatch",
				[((i + 0.5) / M) * 7, ((j + 0.5) / M) * 7],
				[0.5, 0.5],
				1,
				0.25,
				0.7854,
			);
	check(
		Math.abs(sum / (M * M) - 0.25) < 0.02,
		`rotated hatch mean ${sum / (M * M)}`,
	);
}

// dots: pi r^2 per cell for a small footprint (sharp) and large footprint (faded), faded to flat
for (const width of [0.35, 0.6]) {
	const mean = Math.PI * (width / 2) ** 2;
	let prevStd = Infinity;
	for (const f of FOOTPRINTS) {
		const s = stats("dots", f, width, 0);
		// upstream's edge ramp (length(footprint) wide) inflates a disc's area in the 0.1..1 band: bounded, not exact
		const tol = f <= 0.1 ? 0.08 * mean : f >= 1 ? 1e-6 : 1.5 * mean;
		check(
			Math.abs(s.mean - mean) <= tol,
			`dots w=${width} f=${f} mean ${s.mean.toFixed(4)} vs ${mean.toFixed(4)} (tol ${tol.toFixed(4)})`,
		);
		check(
			s.std <= prevStd + 0.02,
			`dots w=${width} f=${f} std ${s.std} rose from ${prevStd}`,
		);
		prevStd = s.std;
	}
	check(
		stats("dots", 1, width, 0).range < 1e-6,
		"dots are flat at footprint >= 1 cell",
	);
}

// zero width draws nothing
check(
	patternCoverage("hatch", [0.1, 0.2], [0.1, 0.1], 5, 0, 0.3) === 0,
	"width 0 hatch",
);
check(
	patternCoverage("dots", [0.1, 0.2], [0.1, 0.1], 5, 0, 0.3) === 0,
	"width 0 dots",
);

// GLSL / WGSL twins carry the same constants (the splice builds both from TERROIR_PATTERN_PARAMS)
for (const [name, src] of [
	["GLSL", PATTERN_GLSL],
	["WGSL", PATTERN_WGSL],
] as const) {
	for (const k of ["scree", "rock", "glacier"] as const)
		for (const value of Object.values(TERROIR_PATTERN_PARAMS[k]))
			check(
				src.includes(String(value)) || src.includes(value.toFixed(1)),
				`${name} ${k} constant ${value} present`,
			);
	check(src.includes("3.141592653589793"), `${name} dot mean constant`);
	check(src.includes("smoothstep(0.35, 1.0"), `${name} dot fade band`);
}

// splice: the defaults and Classic leave every program alone; the Terroir preset turns the pattern on
check(CLASSIC.terroir.cover.pattern === false, "pattern default off");
check(
	presetStyle("terroir").terroir.cover.pattern === true,
	"Terroir preset pattern on",
);
{
	const ft = { terCover: true };
	check(
		!terroirWGSL(ft, { relief: false, water: false }).includes("ter_pat"),
		"WGSL off has no pattern",
	);
	check(
		terroirWGSL(
			{ ...ft, terPattern: true },
			{ relief: false, water: false },
		).includes("ter_pattern_cover(c, xy,"),
		"WGSL on splices the pattern",
	);
}
{
	const off = terroirTerrainFs(fs, ["TERROIR_COVER"]);
	const on = terroirTerrainFs(fs, ["TERROIR_COVER", "TERROIR_PATTERN"]);
	check(!off.includes("terPat"), "GLSL off has no pattern");
	check(
		on.includes(
			"terPatternCover(c, xy, terCoverAlbedo(c, xy, px), terFw, terLit)",
		),
		"GLSL on splices the pattern",
	);
	check(
		on.includes("vec2 terFw = fwidth(xy);"),
		"GLSL footprint taken before class branching",
	);
}

if (failed) {
	console.error(`${failed} failure(s)`);
	process.exit(1);
}
console.log("terroir pattern check: ok");

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check for the opt-in stroke looks: `npx tsx src/lib/look/__tests__/strokes.check.ts`
//  - ridge sketch: sketch 0 is the exact identity (no displacement, gain 1), bounded, deterministic
//  - trail strokes: solid = full coverage and no quad padding; pencil / glow stay in 0..1, glow is
//    brightest at the centre, the quad padding covers the stroke
//  - the GLSL / WGSL text carries the same constants as the TS reference
import { RIDGES_WGSL } from "../../deck-webgpu/layers/ridges.ts";
import { TRAIL_WGSL } from "../../deck-webgpu/layers/trail.ts";
import {
	SKETCH_JITTER,
	SKETCH_RIDGES_GLSL,
	SKETCH_RIDGES_WGSL,
	sketchRidgeFactors,
} from "../sketch-ridges.ts";
import {
	GLOW_REACH,
	PENCIL_JITTER,
	strokeCoverage,
	strokeKind,
	strokePadPx,
	TRAIL_STROKE_GLSL,
	TRAIL_STROKE_MODE,
	TRAIL_STROKE_WGSL,
} from "../trail-stroke.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`);
}

// ---- ridge sketch -----------------------------------------------------------------------------
{
	let identity = true;
	let bounded = true;
	let gainLo = 9;
	let gainHi = 0;
	for (let i = 0; i < 4000; i++) {
		const x = (i * 37.3) % 1900;
		const y = (i * 91.7) % 1300;
		const off = sketchRidgeFactors(x, y, 0);
		if (off.dx !== 0 || off.dy !== 0 || off.gain !== 1) identity = false;
		const on = sketchRidgeFactors(x, y, 1);
		if (Math.abs(on.dx) > SKETCH_JITTER || Math.abs(on.dy) > SKETCH_JITTER)
			bounded = false;
		gainLo = Math.min(gainLo, on.gain);
		gainHi = Math.max(gainHi, on.gain);
	}
	check("sketch 0 is the identity", identity);
	check("sketch 1 displacement within the jitter", bounded);
	check(
		"sketch 1 gain stays in (0, 1.2)",
		gainLo > 0 && gainHi < 1.2,
		`[${gainLo.toFixed(2)}, ${gainHi.toFixed(2)}]`,
	);
	const a = sketchRidgeFactors(10.5, 20.25, 0.7);
	const b = sketchRidgeFactors(10.5, 20.25, 0.7);
	check("sketch is deterministic", a.dx === b.dx && a.gain === b.gain);
	check(
		"engine text uses the same function names",
		SKETCH_RIDGES_GLSL.includes("vec3 ridgeSketch") &&
			SKETCH_RIDGES_WGSL.includes("fn ridge_sketch") &&
			RIDGES_WGSL.includes("fn ridge_sketch") &&
			RIDGES_WGSL.includes(`* ${SKETCH_JITTER.toFixed(4)} * sketch`),
	);
}

// ---- trail strokes ----------------------------------------------------------------------------
{
	check("unknown stroke falls back to solid", strokeKind("x") === "solid");
	check("absent stroke is solid", strokeKind(undefined) === "solid");
	check(
		"solid: no padding, full coverage",
		strokePadPx("solid", 2.2) === 0 &&
			strokeCoverage("solid", 0.3, 5, 2.2).coverage === 1,
	);
	let inRange = true;
	for (const kind of ["pencil", "glow"] as const) {
		for (let i = 0; i < 2000; i++) {
			const side = ((i * 7.31) % 20) - 10;
			const along = (i * 13.7) % 3000;
			const { coverage, core } = strokeCoverage(kind, side, along, 2.2, 1, 1);
			if (!(coverage >= 0 && coverage <= 1 && core >= 0 && core <= 1))
				inRange = false;
		}
	}
	check("pencil / glow coverage within 0..1", inRange);
	const glowCentre = strokeCoverage("glow", 0, 0, 2.2);
	const glowEdge = strokeCoverage("glow", 3, 0, 2.2);
	const glowFar = strokeCoverage("glow", 2.2 * GLOW_REACH * 2 + 1, 0, 2.2);
	check(
		"glow: bright core, falling halo",
		glowCentre.coverage === 1 &&
			glowEdge.coverage < 1 &&
			glowEdge.coverage > glowFar.coverage &&
			glowFar.coverage < 0.02,
		`${glowCentre.coverage.toFixed(2)} ${glowEdge.coverage.toFixed(2)} ${glowFar.coverage.toFixed(3)}`,
	);
	// padding covers everything that can be drawn
	let covered = true;
	for (const kind of ["pencil", "glow"] as const) {
		const w = 2.2;
		const pad = strokePadPx(kind, w);
		const edge = w * 0.5 + pad;
		for (let i = 0; i < 400; i++) {
			const along = i * 3.3;
			const c = strokeCoverage(kind, edge, along, w, 0.7, 0).coverage;
			if (c > 0.03) covered = false;
		}
	}
	check("padding contains the stroke (alpha at the quad edge ≈ 0)", covered);
	// pencil wanders: the centre of coverage moves along the path
	const centres = new Set<number>();
	for (let i = 0; i < 40; i++) {
		let best = 0;
		let bestC = -1;
		for (let s = -4; s <= 4; s += 0.1) {
			const c = strokeCoverage("pencil", s, i * 9, 2.2, 0.7, 0).coverage;
			if (c > bestC) {
				bestC = c;
				best = s;
			}
		}
		centres.add(Math.round(best * 4));
	}
	check("pencil centre wobbles along the path", centres.size > 3);
	check(
		"pencil jitter fits the padding",
		PENCIL_JITTER * 2.2 < strokePadPx("pencil", 2.2),
	);
	check(
		"engine text carries the stroke function and modes",
		TRAIL_STROKE_GLSL.includes("float trailStroke") &&
			TRAIL_STROKE_WGSL.includes("fn trail_stroke") &&
			TRAIL_WGSL.includes("fn trail_stroke") &&
			TRAIL_STROKE_MODE.solid === 0 &&
			TRAIL_STROKE_MODE.pencil === 1 &&
			TRAIL_STROKE_MODE.glow === 2,
	);
}

console.log(failures ? `FAIL (${failures})` : "PASS strokes");
process.exit(failures ? 1 : 0);

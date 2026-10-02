// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The look's shader feature set: which LOOK_* preprocessor defines a style needs. Engines recompile
// only when this changes (a preset or feature toggle, not a slider drag). CLASSIC needs none, so the
// shader sources stay byte-identical to the classic ones. The slope layer's LOOK_SLOPE comes from the
// engine's overlay layer choice (Settings), not from the style.
import type { ViewStyle } from "../style/types";

export type LookDefine =
	| "LOOK_ALPINE"
	| "LOOK_ATMOSPHERE"
	| "LOOK_CLEARAIR"
	| "LOOK_HARMONIZE"
	| "LOOK_INK"
	| "LOOK_OUTPUT"
	| "LOOK_REFINE"
	| "LOOK_RELIEF"
	| "LOOK_SLOPE"
	| "LOOK_TANAKA"
	| "LOOK_WATER"
	| "LOOK_WATER_WAVES";

/** Sorted, duplicate-free define list; `lookKey(s).join()` is a stable cache key ('' = classic). */
export function lookKey(s: ViewStyle): LookDefine[] {
	const on: [boolean, LookDefine][] = [
		[s.terrain.albedo.mode === "alpine", "LOOK_ALPINE"],
		// the world view's atmospheric sky is its own program (no define needed)
		[s.terrain.atmosphere.mode === "physical", "LOOK_ATMOSPHERE"],
		[s.composite.harmonize > 0 || s.world.drapeHarmonize > 0, "LOOK_HARMONIZE"],
		[s.composite.ridges === "ink", "LOOK_INK"],
		[s.composite.output === "neutral", "LOOK_OUTPUT"],
		[s.composite.refine, "LOOK_REFINE"],
		[
			s.terrain.relief.mode === "swiss" || s.terrain.relief.mode === "imhof",
			"LOOK_RELIEF",
		],
		[s.overlay.contours.kind === "tanaka", "LOOK_TANAKA"],
		[
			s.terrain.albedo.mode === "alpine" && s.terrain.albedo.water,
			"LOOK_WATER",
		],
	];
	return on.filter(([b]) => b).map(([, d]) => d);
}

/**
 * The defines the terrain programs need: lookKey without the composite-only features (LOOK_OUTPUT,
 * LOOK_REFINE; LOOK_HARMONIZE unless the world drape harmonises), which would only rebuild them
 * (and cost every terrain pass: deck's uniform blocks are not free on ANGLE/Metal).
 */
export const terrainDefines = (s: ViewStyle, d = lookKey(s)): LookDefine[] =>
	d.filter(
		(k) =>
			k !== "LOOK_OUTPUT" &&
			k !== "LOOK_REFINE" &&
			(k !== "LOOK_HARMONIZE" || s.world.drapeHarmonize > 0),
	);

/** lookKey plus LOOK_SLOPE while the engine draws the slope layer (Settings.overlayStyle 'slope'). */
export const withSlopeLayer = (d: LookDefine[], on: boolean): LookDefine[] =>
	on ? [...d, "LOOK_SLOPE" as const].sort() : d;

/** Whether a style uses the photo's P(sky) (#/lib/sky, a ≈4.5 MB model): never for classic. */
export const needsPhotoSky = (s: ViewStyle) =>
	(s.terrain.atmosphere.mode === "physical" &&
		s.terrain.atmosphere.airlight === "fitted") ||
	s.composite.sky === "photo" ||
	s.composite.refine;

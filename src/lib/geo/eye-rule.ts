// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The eye rule: the camera height (m, the DEM's datum ≈ MSL) before any solve. One source for the
// engines (deck/scene.ts re-exports it), the eye-search worker, the roll and the near field. No imports,
// so workers can take it without pulling in three.js.
//
//   eye = max(GPS altitude, ground + EYE_ABOVE_GROUND)       with a GPS altitude
//   eye = ground + EYE_NO_ALTITUDE_ABOVE_GROUND             without one (pins, no fix)
//
// The engines and the roll use 1.8 m without an altitude; geo/pipeline.ts loadScene (the /baseline and
// unknown-pose workers) uses 1.6 m there. Both are kept bit-identical here until a decision unifies
// them (reports/steps-2026-10-02/eye-rule.md).
//
// checkAltitude only describes the altitude against the ground (for the info panel and diagnostics);
// nothing here changes the eye.

/** Standing eye height above the DEM (m). */
export const EYE_ABOVE_GROUND = 1.6;

/** Eye height above the DEM when the photo has no altitude (m): the engines' and roll's value. */
export const EYE_NO_ALTITUDE_ABOVE_GROUND = 1.8;

/**
 * Eye height (m, DEM datum): the (barometer-aided) GPS altitude unless it is underground; near summits
 * the horizontal fix puts the DEM point down the slope. `noAltitudeAboveGround` is the height above the
 * DEM without an altitude (geo/pipeline.ts passes EYE_ABOVE_GROUND). A NaN `dem` gives NaN: callers
 * check the DEM first.
 */
export function eyeAltitude(
	alt: number | null | undefined,
	dem: number,
	noAltitudeAboveGround = EYE_NO_ALTITUDE_ABOVE_GROUND,
): number {
	return alt != null
		? Math.max(alt, dem + EYE_ABOVE_GROUND)
		: dem + noAltitudeAboveGround;
}

/**
 * Thresholds for checkAltitude (m). Heuristics for diagnostics, not fitted: phone vertical error is
 * about 3–10 m in open sky and 15–30 m with multipath (reports/steps-2026-10-02/eye-rule.md).
 */
export const ALTITUDE_CHECK = {
	/** Above ground + eye by at most this: standing (GPS noise). */
	standingM: 15,
	/** Above ground + eye by more than this: a tower, cable car, aircraft or drone, or a bad fix. */
	highM: 300,
	/** |excess − geoid N| within this on a non-Apple camera: likely an ellipsoidal altitude. */
	datumM: 12,
} as const;

export type AltitudeVerdict =
	/** No altitude: the eye stands on the DEM. */
	| "missing"
	/** The altitude is below ground + eye: the floor wins. */
	| "underground"
	/** Within ALTITUDE_CHECK.standingM above ground + eye. */
	| "standing"
	/** Above that, below ALTITUDE_CHECK.highM. */
	| "raised"
	/** Raised by about the geoid undulation on a non-Apple camera: probably above the ellipsoid. */
	| "ellipsoid-suspect"
	/** More than ALTITUDE_CHECK.highM above ground + eye. */
	| "high";

export type AltitudeCheck = {
	verdict: AltitudeVerdict;
	/** alt − (ground + EYE_ABOVE_GROUND), m; NaN when missing. */
	excessM: number;
	/** The eye the rule gives (eyeAltitude). */
	eye: number;
};

/**
 * How the GPS altitude sits against the ground at the fix. `geoidN` (m, EGM2008 at the fix,
 * tiles3d/geoid.ts) and `model` (EXIF Model) enable the ellipsoid test: Android writes
 * Location.getAltitude(), which is above the WGS84 ellipsoid, about 47–55 m over MSL in Switzerland;
 * iPhones write MSL. Diagnostic only.
 */
export function checkAltitude(
	alt: number | null | undefined,
	ground: number,
	o: { model?: string | null; geoidN?: number | null } = {},
): AltitudeCheck {
	const eye = eyeAltitude(alt, ground);
	if (alt == null || !Number.isFinite(alt))
		return { verdict: "missing", excessM: Number.NaN, eye };
	const excessM = alt - (ground + EYE_ABOVE_GROUND);
	const verdict: AltitudeVerdict =
		excessM < 0
			? "underground"
			: excessM <= ALTITUDE_CHECK.standingM
				? "standing"
				: excessM > ALTITUDE_CHECK.highM
					? "high"
					: o.geoidN != null &&
							o.model != null &&
							!/iphone|ipad/i.test(o.model) &&
							Math.abs(excessM - o.geoidN) <= ALTITUDE_CHECK.datumM
						? "ellipsoid-suspect"
						: "raised";
	return { verdict, excessM, eye };
}

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The Camera panel's eye-height rows: the eye the engine uses and which branch of the eye rule
// (geo/eye-rule.ts) set it. Display only. The ellipsoid test (EGM2008 N at the camera) runs only for a
// raised altitude on a non-Apple camera. Read during render from the engine, like the rest of the
// panel: right after an eye-suggestion Apply it can show the old engine's values for one render.
import {
	type AltitudeCheck,
	checkAltitude,
	EYE_ABOVE_GROUND,
	EYE_NO_ALTITUDE_ABOVE_GROUND,
} from "#/lib/geo/eye-rule";
import { geoidUndulation } from "#/lib/tiles3d/geoid";

/** The engine raised the eye above the rule by more than this (m): a lake level (?geoLakeFloor). */
const RAISED_EPS_M = 0.05;

const isApple = (model: string | null | undefined) =>
	!!model && /iphone|ipad/i.test(model);

/** One line on which branch of the rule set the eye. */
export function eyeRuleNote(c: AltitudeCheck, eyeAlt: number): string {
	if (eyeAlt > c.eye + RAISED_EPS_M) return "raised to the lake level";
	const m = (v: number) => `${Math.round(Math.abs(v))} m`;
	switch (c.verdict) {
		case "no-ground":
			return "no ground height at the camera";
		case "missing":
			return `ground + ${EYE_NO_ALTITUDE_ABOVE_GROUND} m: no GPS altitude`;
		case "underground":
			return `ground + ${EYE_ABOVE_GROUND} m: GPS altitude ${m(c.excessM + EYE_ABOVE_GROUND)} below`;
		case "ellipsoid-suspect":
			return `GPS altitude, ${m(c.excessM)} above standing height: may be above the ellipsoid, not sea level`;
		case "high":
			return `GPS altitude, ${m(c.excessM)} above standing height: a tower, lift or drone?`;
		default:
			return `GPS altitude, ${m(c.excessM)} above standing height`;
	}
}

export function EyeHeightRow({
	alt,
	ground,
	eyeAlt,
	model,
	lat,
	lon,
}: {
	/** The photo's GPS altitude (m), null = none. */
	alt: number | null | undefined;
	/** The engine's DEM height at the camera (m); NaN = no DEM there. */
	ground: number;
	/** The engine's eye height (m); 0 = not placed yet. */
	eyeAlt: number;
	model?: string | null;
	lat: number;
	lon: number;
}) {
	const placed = eyeAlt !== 0;
	let check = placed ? checkAltitude(alt, ground) : null;
	if (check?.verdict === "raised" && model && !isApple(model))
		check = checkAltitude(alt, ground, {
			model,
			geoidN: geoidUndulation(lat, lon),
		});
	const warn =
		check?.verdict === "ellipsoid-suspect" || check?.verdict === "high";
	return (
		<>
			<dt className="text-white/40">Eye</dt>
			<dd className="text-right font-mono text-white/75">
				{placed ? `${Math.round(eyeAlt)} m` : "—"}
			</dd>
			{check && (
				<>
					<dt className="sr-only">Eye rule</dt>
					<dd
						className={`col-span-2 -mt-1 text-right text-[10px] ${warn ? "text-amber-200/80 light:text-[var(--rigi-lesson)]" : "text-white/40"}`}
						data-eye-verdict={check.verdict}
					>
						{eyeRuleNote(check, eyeAlt)}
					</dd>
				</>
			)}
		</>
	);
}

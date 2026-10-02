// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The Camera panel's eye-height rows: the eye the engine uses and which branch of the eye rule
// (geo/eye-rule.ts) set it. Display only. The EGM2008 grid (~200 kB) loads only when a non-Apple
// camera's altitude sits far enough above the ground for the ellipsoid test to matter.
import { useEffect, useState } from "react";
import {
	type AltitudeCheck,
	checkAltitude,
	EYE_ABOVE_GROUND,
	EYE_NO_ALTITUDE_ABOVE_GROUND,
} from "#/lib/geo/eye-rule";

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
	/** The engine's DEM height at the camera (m). */
	ground: number;
	/** The engine's eye height (m); 0 = not placed yet. */
	eyeAlt: number;
	model?: string | null;
	lat: number;
	lon: number;
}) {
	const [geoidN, setGeoidN] = useState<number | null>(null);
	const placed = eyeAlt !== 0 && Number.isFinite(ground);
	const base = placed ? checkAltitude(alt, ground) : null;
	const wantGeoid = base?.verdict === "raised" && !!model && !isApple(model);
	useEffect(() => {
		if (!wantGeoid) return;
		let live = true;
		import("#/lib/tiles3d/geoid")
			.then((g) => {
				if (live) setGeoidN(g.geoidUndulation(lat, lon));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [wantGeoid, lat, lon]);
	const check =
		base && wantGeoid && geoidN != null
			? checkAltitude(alt, ground, { model, geoidN })
			: base;
	return (
		<>
			<dt className="text-white/40">Eye</dt>
			<dd className="text-right font-mono text-white/75">
				{placed ? `${Math.round(eyeAlt)} m` : "—"}
			</dd>
			{check && (
				<dd
					className={`col-span-2 -mt-1 text-right text-[10px] ${check.verdict === "ellipsoid-suspect" || check.verdict === "high" ? "text-amber-300/80" : "text-white/40"}`}
					data-eye-verdict={check.verdict}
				>
					{eyeRuleNote(check, eyeAlt)}
				</dd>
			)}
		</>
	);
}

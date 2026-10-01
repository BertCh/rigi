// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure helpers for the terroir roll/site furniture (no DOM, no deck): sun-band colours, scale-bar
// numbers, pose-source glyphs and the prior-pose uncertainty fan. Checked by roll.check.ts.
// Display-only: nothing here feeds the matcher or any pose.
import type { PoseSource } from "../../roll/types";

// ---- light of day ----------------------------------------------------------------------------------

type Stop = readonly [elevDeg: number, r: number, g: number, b: number];
/** Sun elevation → band colour: night navy, blue hour, golden hour amber, pale day. */
export const SUN_STOPS: readonly Stop[] = [
	[-18, 10, 17, 40], // astronomical night
	[-12, 20, 35, 77], // nautical twilight
	[-6, 47, 79, 143], // blue hour
	[-1, 120, 120, 170], // civil twilight, horizon
	[3, 242, 166, 64], // golden hour
	[7, 246, 201, 122],
	[15, 244, 226, 184],
	[30, 247, 241, 222],
	[60, 251, 248, 238], // high sun
];

/** Colour of the light band at a sun elevation (degrees); clamped at both ends. */
export function sunBandColor(elev: number): [number, number, number] {
	const s = SUN_STOPS;
	if (!(elev > s[0][0])) return [s[0][1], s[0][2], s[0][3]];
	for (let i = 1; i < s.length; i++) {
		if (elev <= s[i][0]) {
			const a = s[i - 1];
			const b = s[i];
			const t = (elev - a[0]) / (b[0] - a[0]);
			return [
				Math.round(a[1] + (b[1] - a[1]) * t),
				Math.round(a[2] + (b[2] - a[2]) * t),
				Math.round(a[3] + (b[3] - a[3]) * t),
			];
		}
	}
	const l = s[s.length - 1];
	return [l[1], l[2], l[3]];
}

/** Relative luminance (sRGB, 0..1) of an 0..255 colour. */
export function luminance([r, g, b]: readonly number[]) {
	const f = (v: number) => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export type LightPhase = "night" | "blue hour" | "golden hour" | "day";
export function lightPhase(elev: number): LightPhase {
	return elev < -6
		? "night"
		: elev < 0
			? "blue hour"
			: elev < 6
				? "golden hour"
				: "day";
}

export type SunEvent = { kind: "sunrise" | "sunset" | "noon"; at: number };

/**
 * Sunrise / sunset / solar-noon marks along a sampled series of sun elevations (one per axis
 * sample, `at` = the sample's axis fraction 0..1). Sunrise and sunset are zero crossings; noon is a
 * local maximum above the horizon that is strictly inside the series.
 */
export function sunEvents(
	elev: readonly number[],
	at: readonly number[],
): SunEvent[] {
	const out: SunEvent[] = [];
	for (let i = 1; i < elev.length; i++) {
		const a = elev[i - 1];
		const b = elev[i];
		if (a < 0 && b >= 0)
			out.push({ kind: "sunrise", at: lerpAt(a, b, at[i - 1], at[i]) });
		else if (a >= 0 && b < 0)
			out.push({ kind: "sunset", at: lerpAt(a, b, at[i - 1], at[i]) });
		if (
			i < elev.length - 1 &&
			elev[i] > 0 &&
			elev[i] > a &&
			elev[i] >= elev[i + 1]
		)
			out.push({ kind: "noon", at: at[i] });
	}
	return out;
}
const lerpAt = (a: number, b: number, x0: number, x1: number) =>
	x0 + ((0 - a) / (b - a || 1)) * (x1 - x0);

// ---- scale bar -------------------------------------------------------------------------------------

/** Largest 1/2/5 × 10^n that is ≤ x (x > 0). */
export function niceFloor(x: number): number {
	if (!(x > 0)) return 0;
	const p = 10 ** Math.floor(Math.log10(x));
	const m = x / p;
	return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

/** "200 m" / "1 km" / "2.5 km" style label for a length in metres. */
export function fmtScale(m: number): string {
	return m >= 1000 ? `${+(m / 1000).toPrecision(3)} km` : `${Math.round(m)} m`;
}

/** A scale bar no longer than `maxPx` for `mPerPx` metres per CSS pixel. */
export function scaleBar(mPerPx: number, maxPx = 96) {
	const m = niceFloor(mPerPx * maxPx);
	return { m, px: m / mPerPx, label: fmtScale(m) };
}

/** Ground resolution (m per CSS px) of web-mercator tiles of 256 px at zoom z and latitude. */
export const mercatorMPerPx = (latDeg: number, z: number, tile = 256) =>
	(40075016.686 * Math.cos((latDeg * Math.PI) / 180)) / (tile * 2 ** z);

/** Latitude (deg) of a web-mercator world-pixel y at zoom z. */
export function mercatorLat(y: number, z: number, tile = 256) {
	const n = Math.PI - (2 * Math.PI * y) / (tile * 2 ** z);
	return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

// ---- pose-source honesty ---------------------------------------------------------------------------

/** A distinct glyph per pose source (shape, not just colour). */
export const POSE_GLYPH: Record<PoseSource, string> = {
	saved: "●",
	"ground-truth": "◆",
	solved: "▲",
	prior: "○",
};
export const POSE_SOURCES_ALL = Object.keys(POSE_GLYPH) as PoseSource[];

/** EXIF-only headings can be off by 10° or more (POSE_SOURCE_HINT.prior). */
export const PRIOR_FAN_DEG = 10;
export const isUncertainPose = (s: PoseSource) => s === "prior";

/** SVG path of the widened ±PRIOR_FAN_DEG fan of a plan-view wedge (compass yaw, hfov in degrees). */
export function priorFanPath(
	cx: number,
	cy: number,
	r: number,
	yaw: number,
	hfov: number,
) {
	const half = Math.min(179, hfov) / 2 + PRIOR_FAN_DEG;
	const a0 = ((yaw - half) * Math.PI) / 180;
	const a1 = ((yaw + half) * Math.PI) / 180;
	const pt = (a: number) => `${cx + r * Math.sin(a)},${cy - r * Math.cos(a)}`;
	const large = half * 2 > 180 ? 1 : 0;
	return `M${cx},${cy} L${pt(a0)} A${r},${r} 0 ${large} 1 ${pt(a1)} Z`;
}

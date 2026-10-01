// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared look and small formatters for the roll mosaic: viewpoint colours, pose-source labels,
// compass names and capture times in the photo's own local time.

import { BRAND } from "#/brand/khipu";
import { rankUnder } from "#/lib/ontology/core/resolution";
import { POSE_SOURCE } from "#/lib/ontology/crosswalk/pose";
import type { PhotoMeta } from "../../photos";
import type { PoseSource, RollPhoto } from "../types";

/** One colour per viewpoint (index mod length); first is the Rigi glow. */
export const VIEWPOINT_COLORS = [
	BRAND.glow,
	"#6cc3d5",
	"#9ad07a",
	"#d58bd8",
	"#e9d267",
	"#ef8a7a",
	"#7aa2ef",
	"#7fd6b0",
];
export const vpColor = (i: number) =>
	VIEWPOINT_COLORS[
		((i % VIEWPOINT_COLORS.length) + VIEWPOINT_COLORS.length) %
			VIEWPOINT_COLORS.length
	];

export const POSE_SOURCES: PoseSource[] = (
	Object.keys(POSE_SOURCE) as PoseSource[]
).sort(
	(a, b) =>
		rankUnder("rollDisplay", POSE_SOURCE[a]) -
		rankUnder("rollDisplay", POSE_SOURCE[b]),
);
export const POSE_SOURCE_LABEL = Object.fromEntries(
	POSE_SOURCES.map((s) => [s, POSE_SOURCE[s].label]),
) as Record<PoseSource, string>;
export const POSE_SOURCE_HINT = Object.fromEntries(
	POSE_SOURCES.map((s) => [s, POSE_SOURCE[s].hint]),
) as Record<PoseSource, string>;
/** Tailwind classes for the badge of each source. */
export const POSE_SOURCE_CLASS: Record<PoseSource, string> = {
	saved: "bg-emerald-400/90 text-emerald-950",
	"ground-truth": "bg-sky-300/90 text-sky-950",
	solved: "bg-violet-300/90 text-violet-950",
	prior: "bg-amber-300/90 text-amber-950",
};
export const POSE_SOURCE_COLOR: Record<PoseSource, string> = {
	saved: "#34d399",
	"ground-truth": "#7dd3fc",
	solved: "#c4b5fd",
	prior: "#fcd34d",
};

const WINDS = [
	"N",
	"NNE",
	"NE",
	"ENE",
	"E",
	"ESE",
	"SE",
	"SSE",
	"S",
	"SSW",
	"SW",
	"WSW",
	"W",
	"WNW",
	"NW",
	"NNW",
];
export const compassPoint = (deg: number) =>
	WINDS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** Minutes east of UTC from "+02:00" (0 when unknown). */
function offsetMin(p: PhotoMeta) {
	const m = p.tzOffset?.match(/([+-])(\d\d):(\d\d)/);
	return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/** A Date whose UTC fields are the photo's local wall-clock time. */
export const localWallClock = (p: PhotoMeta) =>
	new Date(Date.parse(p.takenAt) + offsetMin(p) * 60000);

export const fmtTime = (p: PhotoMeta) =>
	localWallClock(p).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		timeZone: "UTC",
	});
export const fmtDay = (p: PhotoMeta) =>
	localWallClock(p).toLocaleDateString(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
		timeZone: "UTC",
	});
export const dayKey = (p: PhotoMeta) =>
	localWallClock(p).toISOString().slice(0, 10);

/** "7 Sep 2026" or "6–7 Sep 2026" style span of a roll's capture days. */
export function fmtDateSpan(ps: RollPhoto[]) {
	if (!ps.length) return "";
	const a = localWallClock(ps[0].meta);
	const b = localWallClock(ps[ps.length - 1].meta);
	const f = (d: Date, o: Intl.DateTimeFormatOptions) =>
		d.toLocaleDateString(undefined, { ...o, timeZone: "UTC" });
	if (dayKey(ps[0].meta) === dayKey(ps[ps.length - 1].meta))
		return f(a, { day: "numeric", month: "short", year: "numeric" });
	return `${f(a, { day: "numeric", month: "short" })} – ${f(b, { day: "numeric", month: "short", year: "numeric" })}`;
}

export const fmtDistance = (m: number) =>
	m < 1000
		? `${Math.round(m)} m`
		: `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;

export const aspectOf = (p: RollPhoto) => p.meta.width / p.meta.height;

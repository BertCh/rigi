// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Compass prior with magnetic declination (GEO GA0, reports/geometry-first-pose.md §2 "apply magnetic
// declination when the heading is magnetic").
//
// EXIF GPSImgDirection is relative to GPSImgDirectionRef: "T" true north (iPhone default) or "M" magnetic
// north. Uploads keep the ref in `local.headingRef` (upload/exif.ts); bundled photos (photos.json) carry
// no ref and are left unchanged. The correction is applied where the heading is USED as a prior (engine
// constructors, unknown-pose), never where it is stored: IndexedDB keeps the EXIF value whatever the flag.
//
// Flag ?geoDecl (default off): off ⇒ photo.heading unchanged (bit-identical to the pre-GEO app).
import { getFlag } from "../../flags";
import { wrap180, wrap360 } from "../../geodesy";
import type { PhotoMeta } from "../../photos";
import { declination } from "./wmm";

type HeadingRefPhoto = Pick<
	PhotoMeta,
	"heading" | "lat" | "lon" | "alt" | "takenAt" | "takenAtUtc"
> & { local?: { headingRef?: string | null } };

/** "M" / "m" / "magnetic…" → true (exifr with translateValues:false gives the raw "M"). */
export const isMagneticRef = (ref: string | null | undefined) =>
	typeof ref === "string" && /^m/i.test(ref.trim());

/**
 * The heading to use as the yaw prior (deg, true north, [0, 360)), or null when the photo has none.
 * `enabled` defaults to the geoDecl flag; pass it explicitly in tests and offline tools.
 */
export function priorHeading(
	photo: HeadingRefPhoto,
	enabled: boolean = getFlag("geoDecl") === "on",
): number | null {
	const h = photo.heading;
	if (h == null || !enabled) return h;
	if (!isMagneticRef(photo.local?.headingRef)) return h;
	const d = headingDeclination(photo);
	if (d == null) return h;
	return (((h + d) % 360) + 360) % 360;
}

/** Declination at the photo (deg, east +), or null without a usable position. */
export function headingDeclination(
	photo: Pick<PhotoMeta, "lat" | "lon" | "alt" | "takenAt" | "takenAtUtc">,
): number | null {
	if (!Number.isFinite(photo.lat) || !Number.isFinite(photo.lon)) return null;
	const t = Date.parse(photo.takenAtUtc ?? photo.takenAt ?? "");
	const date = Number.isFinite(t) ? new Date(t) : new Date();
	const d = declination(photo.lat, photo.lon, photo.alt ?? 0, date);
	return Number.isFinite(d) ? d : null;
}

/**
 * Range and value for a manual heading control (deg). With a prior heading the control spans
 * prior ± halfWidth and the yaw is unwrapped next to the prior, so a solved yaw of 2° under a
 * 358° compass shows as 362° instead of being clamped to the range's low end. A yaw farther than
 * halfWidth from the prior widens the range to include it, so it is never clamped either (a clamped
 * value jumps the pose to the range edge on the first touch). Without one
 * (`prior` null: heading unknown) it spans the full circle and shows yaw in [0, 360).
 */
export function headingControlWindow(
	prior: number | null,
	yaw: number,
	halfWidth = 40,
): { min: number; max: number; value: number } {
	if (prior == null) return { min: 0, max: 360, value: wrap360(yaw) };
	const value = prior + wrap180(yaw - prior);
	return {
		min: Math.min(prior - halfWidth, value),
		max: Math.max(prior + halfWidth, value),
		value,
	};
}

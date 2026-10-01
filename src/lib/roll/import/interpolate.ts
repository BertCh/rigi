// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Fill in missing GPS from capture time: a photo without a position that was taken between two
// GPS'd photos (each within MAX_GAP_MS of it) gets the linearly interpolated position. Pure (no
// DOM), so it runs in node for tests.
import { distanceM } from "../../geodesy";

/** A neighbour further away in time than this (ms) is not used. */
export const MAX_GAP_MS = 20 * 60_000;
/** With only one usable neighbour, it is used as-is when it is this close in time (ms). */
export const NEAREST_GAP_MS = 5 * 60_000;
/** Assumed worst-case walking speed away from the straight line between anchors, m/s. */
export const DRIFT_SPEED = 1.0;
/** Floor for any estimated accuracy, m (GPS itself is rarely better than this). */
export const MIN_ACCURACY_M = 25;

export type TimedItem = {
	key: string;
	/** Capture time, ms since epoch (UTC). */
	t: number;
	/** Known position, or null when the photo has none. */
	pos: { lat: number; lon: number } | null;
	/** GPS accuracy of a known position, m. */
	accuracyM?: number | null;
};

export type EstimatedPosition = {
	lat: number;
	lon: number;
	method: "interpolated" | "nearest";
	/** 1-sigma-ish horizontal accuracy estimate, m. */
	accuracyM: number;
	/** Keys of the photos the estimate came from. */
	from: string[];
	/** Time to the nearest anchor, s. */
	gapS: number;
};

/**
 * Estimate positions for the items without one. Accuracy grows with the time to the nearest
 * anchor (the photographer may have wandered off the straight line at DRIFT_SPEED), plus the
 * anchors' own GPS error. Items with no usable neighbours map to null ("needs a position").
 */
export function interpolatePositions(
	items: TimedItem[],
	opts: { maxGapMs?: number; nearestGapMs?: number } = {},
): Map<string, EstimatedPosition | null> {
	const maxGap = opts.maxGapMs ?? MAX_GAP_MS;
	const nearGap = opts.nearestGapMs ?? NEAREST_GAP_MS;
	const anchors = items
		.filter((i) => i.pos && Number.isFinite(i.t))
		.sort((a, b) => a.t - b.t);
	const out = new Map<string, EstimatedPosition | null>();
	for (const it of items) {
		if (it.pos) continue;
		if (!Number.isFinite(it.t)) {
			out.set(it.key, null);
			continue;
		}
		// last anchor at or before t, first anchor at or after t (binary search)
		let lo = 0;
		let hi = anchors.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (anchors[mid].t <= it.t) lo = mid + 1;
			else hi = mid;
		}
		const a = lo > 0 ? anchors[lo - 1] : null;
		const b = lo < anchors.length ? anchors[lo] : null;
		const da = a ? it.t - a.t : Number.POSITIVE_INFINITY;
		const db = b ? b.t - it.t : Number.POSITIVE_INFINITY;
		const anchorErr = (x: TimedItem | null) => x?.accuracyM ?? 10;
		if (a?.pos && b?.pos && da <= maxGap && db <= maxGap) {
			const span = b.t - a.t;
			const f = span > 0 ? da / span : 0.5;
			const lat = a.pos.lat + f * (b.pos.lat - a.pos.lat);
			const lon = a.pos.lon + f * (b.pos.lon - a.pos.lon);
			// how far one could stray from the chord and still be at both anchors on time
			const chord = distanceM(a.pos, b.pos);
			// (moving faster than DRIFT_SPEED between the anchors: assume a 25 % detour budget at that pace)
			const speed = Math.max(
				DRIFT_SPEED,
				span > 0 ? (1.25 * chord) / (span / 1000) : 0,
			);
			const slack = Math.max(0, (speed * span) / 1000 - chord) / 2;
			const drift = Math.min(slack, (speed * Math.min(da, db)) / 1000);
			const accuracyM = Math.round(
				Math.max(MIN_ACCURACY_M, drift + Math.max(anchorErr(a), anchorErr(b))),
			);
			out.set(it.key, {
				lat,
				lon,
				method: "interpolated",
				accuracyM,
				from: [a.key, b.key],
				gapS: Math.round(Math.min(da, db) / 1000),
			});
			continue;
		}
		const near = da <= db ? a : b;
		const dn = Math.min(da, db);
		if (near?.pos && dn <= nearGap) {
			const accuracyM = Math.round(
				Math.max(MIN_ACCURACY_M, (DRIFT_SPEED * dn) / 1000 + anchorErr(near)),
			);
			out.set(it.key, {
				...near.pos,
				method: "nearest",
				accuracyM,
				from: [near.key],
				gapS: Math.round(dn / 1000),
			});
			continue;
		}
		out.set(it.key, null);
	}
	return out;
}

/** Hours of a '+01:00' / '-05:30' offset string, or null. */
export function offsetHours(tz: string | null | undefined): number | null {
	const m = tz?.match(/^([+-])(\d{2}):?(\d{2})$/);
	if (!m) return null;
	return (m[1] === "-" ? -1 : 1) * (Number(m[2]) + Number(m[3]) / 60);
}

/** Most common value (ties: first seen), or null. */
export function mode<T>(xs: T[]): T | null {
	const n = new Map<T, number>();
	let best: T | null = null;
	let bn = 0;
	for (const x of xs) {
		const c = (n.get(x) ?? 0) + 1;
		n.set(x, c);
		if (c > bn) {
			best = x;
			bn = c;
		}
	}
	return best;
}

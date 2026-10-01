// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The sun's day arc at a place: samples every 10 local minutes, rise / set crossings, hour ticks.
// Pure (look/sun.ts only). Directions are ENU unit vectors (x east, y north, z up).
import { sunPosition } from "../../look/sun";

export type ArcPt = {
	/** UTC ms */
	t: number;
	az: number;
	el: number;
	dir: [number, number, number];
	/** local clock hour when this sample is on the hour, else null */
	hour: number | null;
};

export type SunArc = {
	pts: ArcPt[];
	/** horizon crossings (el = 0) with the UTC ms of the crossing; null in polar day / night */
	rise: { t: number; az: number } | null;
	set: { t: number; az: number } | null;
};

/** Arc for the local day containing `at`; `offMin` = local UTC offset (0 when unknown). */
export function sunArc(
	at: Date,
	lat: number,
	lon: number,
	offMin: number,
	stepMin = 10,
): SunArc {
	const DAY = 86400000;
	const local = at.getTime() + offMin * 60000;
	const midnight = Math.floor(local / DAY) * DAY - offMin * 60000;
	const all: ArcPt[] = [];
	for (let k = 0; k <= 1440 / stepMin; k++) {
		const t = midnight + k * stepMin * 60000;
		const s = sunPosition(new Date(t), lat, lon);
		all.push({
			t,
			az: s.azimuth,
			el: s.elevation,
			dir: s.dir,
			hour: (k * stepMin) % 60 === 0 ? (k * stepMin) / 60 : null,
		});
	}
	let rise: SunArc["rise"] = null;
	let set: SunArc["set"] = null;
	for (let i = 1; i < all.length; i++) {
		const a = all[i - 1];
		const b = all[i];
		if (a.el < 0 === b.el < 0) continue;
		const f = (0 - a.el) / (b.el - a.el);
		const t = a.t + f * (b.t - a.t);
		const s = sunPosition(new Date(t), lat, lon);
		if (b.el >= 0) rise = { t, az: s.azimuth };
		else set = { t, az: s.azimuth };
	}
	return { pts: all.filter((p) => p.el >= 0), rise, set };
}

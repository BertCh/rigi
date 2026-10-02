// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Lake levels (m above sea level) for the eye floor and the waterline factors.
//
// Source order (lakeLevelOf):
//   1. OSM `ele` on the water polygon (most large lakes carry it; integer metres are common, ±0.5 m);
//   2. SWISS_LAKE_LEVELS below, by name, for the major Swiss lakes;
//   3. the DEM median inside the polygon (concord water.ts lakeLevel), which reads 0.7–3.6 m LOW on
//      Terrarium (reports/geometry-first-pose.md plan §0). Low is the safe direction for a floor.
//
// SWISS_LAKE_LEVELS: mean water levels, m a.s.l. (LN02 ≈ MSL at the metre level). Values are the
// swisstopo national-map lake-level annotations refined to the BAFU hydrological-yearbook long-term means
// where known (hydrodaten.admin.ch station pages). They were compiled from reference knowledge on
// 2026-09-30 and NOT re-downloaded: treat each as ±0.5 m, and the regulated seasonal range (≈ ±0.5 m;
// Bodensee, unregulated, ≈ ±1 m) comes on top. Reservoirs are deliberately absent: their level varies by
// tens of metres (floor.ts also skips water=reservoir).
import { parseOsmMetres } from "../../osm/metres";
import type { LakeGeo } from "./compact";

export type LakeLevelRow = { names: string[]; levelM: number; note?: string };

export const SWISS_LAKE_LEVELS: readonly LakeLevelRow[] = [
	{
		names: ["lac leman", "genfersee", "lake geneva", "lac de geneve"],
		levelM: 372.0,
	},
	{
		names: ["bodensee", "lake constance", "lac de constance"],
		levelM: 395.3,
		note: "Obersee, unregulated ±1 m",
	},
	{ names: ["lago maggiore", "langensee"], levelM: 193.5 },
	{ names: ["lago di lugano", "ceresio", "luganersee"], levelM: 270.5 },
	{ names: ["lac de neuchatel", "neuenburgersee"], levelM: 429.3 },
	{ names: ["bielersee", "lac de bienne"], levelM: 429.1 },
	{ names: ["murtensee", "lac de morat"], levelM: 429.3 },
	{
		names: ["vierwaldstattersee", "lake lucerne", "lac des quatre-cantons"],
		levelM: 433.6,
	},
	{ names: ["zurichsee", "lake zurich", "lac de zurich"], levelM: 405.9 },
	{ names: ["walensee"], levelM: 419.0 },
	{ names: ["thunersee", "lac de thoune", "lake thun"], levelM: 557.8 },
	{ names: ["brienzersee", "lac de brienz", "lake brienz"], levelM: 563.7 },
	{ names: ["zugersee", "lac de zoug"], levelM: 413.6 },
	{ names: ["sempachersee"], levelM: 503.8 },
	{ names: ["hallwilersee"], levelM: 448.7 },
	{ names: ["baldeggersee"], levelM: 463.4 },
	{ names: ["greifensee"], levelM: 435.1 },
	{ names: ["pfaffikersee"], levelM: 536.8 },
	{ names: ["agerisee"], levelM: 723.9 },
	{ names: ["sarnersee"], levelM: 468.5 },
	{ names: ["lauerzersee"], levelM: 447.1 },
	{ names: ["lac de joux"], levelM: 1004.0 },
	{ names: ["silsersee", "lej da segl"], levelM: 1797.0 },
	{ names: ["silvaplanersee", "lej da silvaplauna"], levelM: 1790.5 },
	{ names: ["oeschinensee"], levelM: 1578.0 },
];

/** A lake `ele` in metres (a number, or an OSM tag via osm/metres.ts parseOsmMetres); null if unusable. */
export function parseEle(v: unknown): number | null {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	return parseOsmMetres(v) ?? null;
}

/** Lower-case, diacritics stripped, whitespace collapsed ("Vierwaldstättersee" → "vierwaldstattersee"). */
export const normName = (s: string) =>
	s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();

/** The table level for a lake name (bilingual "A / B" and "A;B" names split), or null. */
export function tableLevel(name: string | undefined): LakeLevelRow | null {
	if (!name) return null;
	const parts = normName(name)
		.split(/\s*[/;]\s*/)
		.filter(Boolean);
	for (const row of SWISS_LAKE_LEVELS)
		for (const p of parts) if (row.names.includes(p)) return row;
	return null;
}

export type LakeLevel = { levelM: number; source: "osm" | "table" | "dem" };

/**
 * A lake's level: OSM ele, then the Swiss table, then `demMedian` (a number, or a thunk evaluated only
 * when needed, e.g. () => lakeLevel(sceneLake, absHeight).levelM). Null when none is finite.
 */
export function lakeLevelOf(
	lake: Pick<LakeGeo, "ele" | "name">,
	demMedian?: number | null | (() => number | null | undefined),
): LakeLevel | null {
	if (lake.ele != null && Number.isFinite(lake.ele))
		return { levelM: lake.ele, source: "osm" };
	const row = tableLevel(lake.name);
	if (row) return { levelM: row.levelM, source: "table" };
	const d = typeof demMedian === "function" ? demMedian() : demMedian;
	if (d != null && Number.isFinite(d)) return { levelM: d, source: "dem" };
	return null;
}

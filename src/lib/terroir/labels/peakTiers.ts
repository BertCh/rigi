// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Peak label hierarchy by prominence class (style.terroir.peakTiers, reports/terroir-cartography.md
// T0.4): major ×1.25 / 700, peak ×1 / 600, minor ×0.86 / 500 (classes.ts NAME_TYPO). Prominence the
// OSM extract lacks is backfilled from the terroir pack's swissNAMES3D peak class (name + distance).
// Pure TS (no DOM, no React) so the label layouts and the node check can use it.
import { equirectangularM } from "#/lib/geodesy";
import { NAME_TYPO, peakTier } from "../classes";
import type { NameClass, TerroirPack } from "../types";
import { uncertainPrefix } from "./names";

export type PeakTierClass = Extract<
	NameClass,
	"peak-major" | "peak" | "peak-minor"
>;

const norm = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

type Entry = { lat: number; lon: number; cls: PeakTierClass };
export type TierIndex = Map<string, Entry[]>;

/** Index the pack's peak-class names by normalised name. */
export function buildTierIndex(pack: TerroirPack | null): TierIndex | null {
	if (!pack) return null;
	const m: TierIndex = new Map();
	for (const n of pack.names) {
		if (n.cls !== "peak-major" && n.cls !== "peak" && n.cls !== "peak-minor")
			continue;
		const k = norm(n.name);
		const a = m.get(k);
		const e = { lat: n.lat, lon: n.lon, cls: n.cls };
		if (a) a.push(e);
		else m.set(k, [e]);
	}
	return m;
}

/** Rounded Earth radius the peak-name match distances (and their 600 m gate) were tuned with; not EARTH_R. */
const NAME_MATCH_EARTH_R = 6371000;
const hav = (lat1: number, lon1: number, lat2: number, lon2: number) =>
	equirectangularM(lat1, lon1, lat2, lon2, NAME_MATCH_EARTH_R);

/**
 * The prominence class of a peak: from its prominence when known, else the pack's class for the same
 * name within `maxM` (needs `geo`; with no geo a unique name match counts), else the elevation fallback.
 */
export function resolvePeakClass(
	idx: TierIndex | null,
	p: { name: string; ele: number | null; prominence?: number | null },
	geo: { lat: number; lon: number } | null,
	maxM = 600,
): PeakTierClass {
	if (p.prominence != null && Number.isFinite(p.prominence))
		return peakTier(p.prominence, p.ele) as PeakTierClass;
	const hits = idx?.get(norm(p.name));
	if (hits?.length) {
		if (geo) {
			let best: Entry | null = null;
			let bd = maxM;
			for (const h of hits) {
				const d = hav(geo.lat, geo.lon, h.lat, h.lon);
				if (d <= bd) {
					bd = d;
					best = h;
				}
			}
			if (best) return best.cls;
		} else if (hits.length === 1) return hits[0].cls;
	}
	return peakTier(null, p.ele) as PeakTierClass;
}

/** Layout tier (0 major, 1 peak, 2 minor) and the size factor relative to the tier's built-in size. */
const TIER_BASE = { 0: 1.14, 1: 1, 2: 0.88 } as const;
export function tierHint(cls: PeakTierClass): {
	tier: 0 | 1 | 2;
	sizeMul: number;
} {
	const tier = cls === "peak-major" ? 0 : cls === "peak" ? 1 : 2;
	return { tier, sizeMul: NAME_TYPO[cls].size / TIER_BASE[tier] };
}

/** CSS-side size and weight of a class for the classic DOM labels (× --lbl-name-px). */
export const classicTier = (cls: PeakTierClass) => ({
	scale: NAME_TYPO[cls].size,
	weight: NAME_TYPO[cls].weight,
});

const hintOf = (cls: PeakTierClass) => {
	const t = tierHint(cls);
	return { tierHint: t.tier, sizeMul: t.sizeMul };
};

/**
 * Layout candidates (candidatesFrom, 1:1 with `labels`) with the terroir label options applied:
 * a prominence tier + size per peak (peakTiers) and a "≈" on far names (uncertainty). Ids stay as
 * they were, so hysteresis and reveal keys are unaffected.
 */
export function decorateCandidates<
	C extends { name: string; distKm: number },
	L,
>(
	cands: C[],
	labels: L[],
	classOf: ((l: L) => PeakTierClass) | null,
	uncertain: boolean,
): (C & { tierHint?: 0 | 1 | 2; sizeMul?: number })[] {
	return cands.map((c, i) => ({
		...c,
		...(classOf ? hintOf(classOf(labels[i])) : null),
		...(uncertain ? { name: uncertainPrefix(c.distKm) + c.name } : null),
	}));
}

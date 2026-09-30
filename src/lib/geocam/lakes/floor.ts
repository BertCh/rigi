// Eye floor from lakes (GEO GA0: "eye ≥ lake level"; reports/geometry-first-pose.md §2 — would have caught
// the 6958 GT-eye-under-lake error). A veto-style LOWER BOUND on the eye height, never a pull.
//
// The rule (frozen in tools/research/geo/PROTOCOL.txt, section "GA0 Agent A", before any dev scoring):
// the eye cannot be below the surface of a still lake it stands on or next to. For every lake with a
// level (levels.ts: OSM ele → Swiss table → DEM median) that is not a reservoir / basin (their level
// varies by tens of metres):
//   (a) the GPS fix lies inside the lake outline (even-odd with islands)            → eligible;
//   (b) the fix lies within radiusM of the outline AND the DEM at the fix is at most maxDropM below the
//       level                                                                        → eligible.
//   floor = max over eligible lakes of (level + marginM); null when none is eligible.
// radiusM = clamp(hAcc, 5, 100) + 30 m (hAcc default 20): the fix is ~1σ from where the photographer
// stood, and the shore strip (+30 m) is where a DEM under the lake surface is an artefact (lake-edge
// smoothing, bathymetry blending, Terrarium's low lake reads). Why not the plan's 500 m + hAcc: land
// lower than a lake a few hundred metres away is real (dam feet, dyked polders, outlet valleys) — there
// a floor would put a correct eye in the air. (b)'s drop guard carries the same argument at shore scale:
// more than maxDropM (3 m) below the lake next to it means a barrier (dam, dyke) lies between, so the
// fix is not "on the water". Without a DEM at the fix only (a) applies.
// marginM 0.3: the eye of someone on a jetty or a boat is at least that far above the water.
import type { SceneLake } from "./compact";

export const LAKE_FLOOR_DEFAULTS = {
	marginM: 0.3,
	/** radiusM = clamp(hAcc) + radiusExtraM. */
	radiusExtraM: 30,
	maxDropM: 3,
	hAccDefault: 20,
	hAccMin: 5,
	hAccMax: 100,
	/** water=* values whose level is not stable enough for a floor. */
	skipWater: ["reservoir", "basin"] as readonly string[],
};

export type LakeFloorOpts = {
	/** GPS horizontal accuracy (m); null/undefined → hAccDefault. */
	hAccM?: number | null;
	/** Explicit radius (m); overrides the hAcc rule. */
	radiusM?: number;
	marginM?: number;
	maxDropM?: number;
	/** Absolute DEM height at the fix (m); NaN/undefined disables rule (b). */
	demAtFix?: number | null;
};

export type LakeFloor = {
	floorM: number;
	levelM: number;
	lake: string;
	levelSource: SceneLake["levelSource"];
	/** Unsigned distance of the fix to the outline (m); 0 < d when outside. */
	distM: number;
	inside: boolean;
	radiusM: number;
};

/** Floor radius (m) for a GPS accuracy. */
export function floorRadius(hAccM?: number | null): number {
	const D = LAKE_FLOOR_DEFAULTS;
	const h =
		hAccM != null && Number.isFinite(hAccM) && hAccM > 0
			? hAccM
			: D.hAccDefault;
	return Math.min(D.hAccMax, Math.max(D.hAccMin, h)) + D.radiusExtraM;
}

/** Even-odd point in (polygon ∪ holes). */
export function insideLake(
	lake: Pick<SceneLake, "polygon" | "holes">,
	e: number,
	n: number,
): boolean {
	let c = false;
	for (const r of [lake.polygon, ...(lake.holes ?? [])])
		for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
			const [ei, ni] = r[i];
			const [ej, nj] = r[j];
			if (ni > n !== nj > n && e < ei + ((n - ni) * (ej - ei)) / (nj - ni))
				c = !c;
		}
	return c;
}

/** Unsigned distance (m) from (e, n) to the lake outline (all rings). */
export function outlineDistance(
	lake: Pick<SceneLake, "polygon" | "holes">,
	e: number,
	n: number,
): number {
	let best = Number.POSITIVE_INFINITY;
	for (const r of [lake.polygon, ...(lake.holes ?? [])])
		for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
			const [ax, ay] = r[j];
			const dx = r[i][0] - ax;
			const dy = r[i][1] - ay;
			const L2 = dx * dx + dy * dy;
			const t =
				L2 > 0
					? Math.max(0, Math.min(1, ((e - ax) * dx + (n - ay) * dy) / L2))
					: 0;
			const d = Math.hypot(e - ax - t * dx, n - ay - t * dy);
			if (d < best) best = d;
		}
	return best;
}

/** The binding lake floor with its reason, or null (see the rule above). */
export function lakeFloorDetail(
	lakes: readonly SceneLake[],
	fixEN: [number, number],
	opts: LakeFloorOpts = {},
): LakeFloor | null {
	const D = LAKE_FLOOR_DEFAULTS;
	const radiusM = opts.radiusM ?? floorRadius(opts.hAccM);
	const marginM = opts.marginM ?? D.marginM;
	const maxDropM = opts.maxDropM ?? D.maxDropM;
	const dem = opts.demAtFix;
	const [e, n] = fixEN;
	let best: LakeFloor | null = null;
	for (const l of lakes) {
		if (!Number.isFinite(l.levelM) || l.polygon.length < 3) continue;
		if (l.water && D.skipWater.includes(l.water)) continue;
		const inside = insideLake(l, e, n);
		const distM = outlineDistance(l, e, n);
		const near =
			!inside &&
			distM <= radiusM &&
			dem != null &&
			Number.isFinite(dem) &&
			l.levelM - dem <= maxDropM;
		if (!inside && !near) continue;
		const floorM = l.levelM + marginM;
		if (!best || floorM > best.floorM)
			best = {
				floorM,
				levelM: l.levelM,
				lake: l.name ?? l.id ?? "?",
				levelSource: l.levelSource,
				distM,
				inside,
				radiusM,
			};
	}
	return best;
}

/** Plan API: the floor (m, absolute) or null. */
export function lakeFloor(
	lakes: readonly SceneLake[],
	fixEN: [number, number],
	opts: LakeFloorOpts = {},
): number | null {
	return lakeFloorDetail(lakes, fixEN, opts)?.floorM ?? null;
}

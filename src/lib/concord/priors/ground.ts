// Near ground around the photo fix (WP-B): DEM height at a horizontal ENU offset (dE, dN) in metres
// from the GPS fix, the `ground` callback that pose6dof/eye.ts (refineEyeFromSkyline) and the eye
// priors in ./altitude.ts take. Same vertical datum as the DEM (Mapterhorn: metres above mean sea level).
//
// nearGround() reads the shared near DEM (nearfield/near-dem.ts loadNearDem: Mapterhorn at NEAR_DEM_ZOOM,
// the one both engines use), so the prior sees exactly the ground the renderers stand the eye on. It is
// imported lazily: near-dem.ts pulls in the deck CPU geometry, which node checks don't need.
import { EARTH_R } from "../../geodesy";

/** DEM height (m) at a horizontal offset (dE east, dN north, metres) from the fix; NaN = no data. */
export type GroundFn = (dE: number, dN: number) => number;

const DEG = Math.PI / 180;

/**
 * (dE, dN) → (lat, lon) on the local tangent plane at the fix. Offsets here are ≤ a few hundred metres,
 * where the flat approximation errs by < 1 mm.
 */
export function offsetLatLon(
	lat: number,
	lon: number,
	dE: number,
	dN: number,
): { lat: number; lon: number } {
	return {
		lat: lat + dN / EARTH_R / DEG,
		lon: lon + dE / (EARTH_R * Math.cos(lat * DEG)) / DEG,
	};
}

/** Wrap any (lat, lon) → height sampler as a GroundFn centred on the fix. Missing → NaN. */
export function groundFromHeightAt(
	lat: number,
	lon: number,
	heightAt: (lat: number, lon: number) => number | null | undefined,
): GroundFn {
	return (dE, dN) => {
		const p = offsetLatLon(lat, lon, dE, dN);
		const h = heightAt(p.lat, p.lon);
		return h == null || !Number.isFinite(h) ? Number.NaN : h;
	};
}

/**
 * Mapterhorn z16/17 ground around (lat, lon) via nearfield/near-dem.ts loadNearDem (shared with both
 * engines; browser DEM loader). Resolves to a GroundFn that is NaN everywhere when the DEM has no data
 * at the fix (callers then fall back to the old eye rule). Never throws.
 */
export async function nearGround(
	lat: number,
	lon: number,
	opts: { radiusM?: number; zoom?: number; signal?: AbortSignal } = {},
): Promise<GroundFn> {
	try {
		const { loadNearDem } = await import("../../nearfield/near-dem");
		const dem = await loadNearDem(lat, lon, null, opts);
		if (!dem) return () => Number.NaN;
		return groundFromHeightAt(lat, lon, dem.heightAt);
	} catch {
		return () => Number.NaN;
	}
}

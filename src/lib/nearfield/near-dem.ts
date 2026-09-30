// Step Inside's terrain range near the camera, ONE source for both renderers (three + deck).
//
// The anchor fit, the depth split and object grounding all compare the model's depth with the DEM range per
// pixel, and the nearest terrain (the ground a person stands on, a few metres from the eye) weighs the most.
// The two engines' GPU range buffers disagree exactly there: deck's photo-camera passes discard terrain within
// nearDiscard / 2 of the eye (and see through to the slope behind), three's mesh LOD / near plane shape the
// first metres differently, and their DEMs differ too (three meshes z14, deck streams z17 near the camera, so
// even the eye height, DEM + 1.6 m, differs by decimetres). So within NEAR_DEM_CPU_MAX both use the same CPU
// terrain profiles (deck/cpu-geometry.ts TerrainProfiles: exact per-pixel rays, marched from 3 m) over the
// same DEM, loadNearDem (Mapterhorn at NEAR_DEM_ZOOM around the photo, via the shared dem loader), from the
// same eye (eyeAltitude over that DEM). Beyond it (or where the profiles see no terrain) the engine's own
// sampleAt answers, where the two agree.
import type { Pose } from "../camera";
import {
	CpuGeometrySource,
	type ProfileTerrain,
	TerrainProfiles,
} from "../deck/cpu-geometry";
import { eyeAltitude } from "../deck/scene";
import {
	latToTileY,
	loadDemTile,
	lonToTileX,
	sampleGrid,
	type TileKey,
} from "../dem";
import { EARTH_R } from "../geodesy";

/** Ranges (m) up to this come from the CPU profiles in both engines. */
export const NEAR_DEM_CPU_MAX = 400;
/** Zoom of the shared near DEM (≈ 0.8 m / px at 512 px tiles, 46° N). */
export const NEAR_DEM_ZOOM = 16;

/** The shared near-camera DEM: heights around the photo (frame origin = the photo, h = 0, as both engines). */
export type NearDem = ProfileTerrain & {
	/** DEM height (m MSL) at the photo. */
	readonly ground: number;
	/** Eye altitude over this DEM (deck/scene.ts eyeAltitude: GPS altitude unless underground). */
	readonly eyeZ: number;
	readonly zoom: number;
};

const NEAR_DEM_CACHE = new Map<string, Promise<NearDem | null>>();

/**
 * Load the shared near DEM: every NEAR_DEM_ZOOM tile within `radiusM` of the photo (a missing tile = its
 * nearest ancestor, upsampled: dem/loadDemTile), bilinear as deck's TerrainSet.heightAt. Cached per photo
 * position + altitude; null when the photo point has no DEM. Never throws.
 */
export function loadNearDem(
	lat: number,
	lon: number,
	alt: number | null | undefined,
	opts: { radiusM?: number; zoom?: number; signal?: AbortSignal } = {},
): Promise<NearDem | null> {
	const z = opts.zoom ?? NEAR_DEM_ZOOM;
	const radius = opts.radiusM ?? NEAR_DEM_CPU_MAX * 1.1;
	const key = `${lat.toFixed(7)},${lon.toFixed(7)},${alt ?? "-"},${z},${radius}`;
	let p = NEAR_DEM_CACHE.get(key);
	if (!p) {
		// a DEM missing tiles (aborted load, network error) is served but not cached: the next call retries
		let complete = false;
		p = (async (): Promise<NearDem | null> => {
			const dLat = (radius / EARTH_R) * (180 / Math.PI);
			const dLon = dLat / Math.cos((lat * Math.PI) / 180);
			const x0 = Math.floor(lonToTileX(lon - dLon, z));
			const x1 = Math.floor(lonToTileX(lon + dLon, z));
			const y0 = Math.floor(latToTileY(lat + dLat, z));
			const y1 = Math.floor(latToTileY(lat - dLat, z));
			const keys: TileKey[] = [];
			for (let y = y0; y <= y1; y++)
				for (let x = x0; x <= x1; x++) keys.push({ z, x, y });
			const tiles = new Map<string, { size: number; h: Float32Array }>();
			await Promise.all(
				keys.map(async (k) => {
					const r = await loadDemTile(k, { signal: opts.signal }).catch(
						() => null,
					);
					if (r) tiles.set(`${k.x}/${k.y}`, { size: r.size, h: r.heights });
				}),
			);
			const heightAt = (la: number, lo: number): number | null => {
				const fx = lonToTileX(lo, z);
				const fy = latToTileY(la, z);
				const x = Math.floor(fx);
				const y = Math.floor(fy);
				const t = tiles.get(`${x}/${y}`);
				return t
					? sampleGrid(t.h, t.size, (fx - x) * t.size, (fy - y) * t.size)
					: null;
			};
			if (opts.signal?.aborted) return null;
			complete = tiles.size === keys.length;
			const ground = heightAt(lat, lon);
			if (ground == null || !Number.isFinite(ground)) return null;
			return {
				frame: { lat, lon, h: 0 },
				heightAt,
				ground,
				eyeZ: eyeAltitude(alt, ground),
				zoom: z,
			};
		})().catch(() => null);
		NEAR_DEM_CACHE.set(key, p);
		p.then((d) => {
			if ((!d || !complete) && NEAR_DEM_CACHE.get(key) === p)
				NEAR_DEM_CACHE.delete(key);
		});
		while (NEAR_DEM_CACHE.size > 4) {
			const first = NEAR_DEM_CACHE.keys().next().value;
			if (first === undefined) break;
			NEAR_DEM_CACHE.delete(first);
		}
	}
	return p;
}

export type NearDemView = {
	readonly pose: Pose;
	readonly aspect: number;
	/** Eye in the ENU frame; the profiles march from the frame origin, so x = y = 0 (both engines). */
	readonly eye: { readonly x: number; readonly y: number; readonly z: number };
};

/**
 * Terrain range lookup (normalised photo coords u right, v down → metres | null) on a width × height grid for
 * the current pose: the CPU profiles within `cpuMax`, else `fallback` (the engine's sampleAt range).
 * `terrain`: the shared NearDem (its own eyeZ is used), else an engine terrain (from `view.eye`); null → the
 * fallback alone.
 */
export function nearFieldDemRangeFrom(
	terrain: NearDem | ProfileTerrain | null | undefined,
	view: NearDemView,
	width: number,
	height: number,
	fallback: (u: number, v: number) => number | null,
	cpuMax = NEAR_DEM_CPU_MAX,
): (u: number, v: number) => number | null {
	let cpu: CpuGeometrySource | null = null;
	if (terrain && cpuMax > 0 && width > 0 && height > 0) {
		// maxRange just past cpuMax: a ray whose first hit is farther is Infinity here (→ fallback)
		const eyeZ = "eyeZ" in terrain ? terrain.eyeZ : view.eye.z;
		const prof = new TerrainProfiles(terrain, eyeZ, {
			maxRange: cpuMax * 1.02,
		});
		cpu = new CpuGeometrySource(
			prof,
			[view.eye.x, view.eye.y, eyeZ],
			view.aspect,
			width,
			height,
		);
		cpu.renderSync(view.pose);
	}
	return (u, v) => {
		if (cpu) {
			const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
			const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
			const r = cpu.range[y * width + x];
			if (Number.isFinite(r) && r > 0 && r <= cpuMax) return r;
		}
		return fallback(u, v);
	};
}

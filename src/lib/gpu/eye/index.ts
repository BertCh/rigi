/**
 * Batched horizon provider for pose6dof's eye search (refineEyeFromSkyline, src/lib/pose6dof/eye.ts),
 * on the GPU horizon (../horizon, computeHorizonsAuto: WebGPU when available, else the CPU march).
 *
 *   const mosaics = await loadEyeMosaics(lat, lon, { sector });          // once per photo
 *   const hp = createEyeHorizonProvider({ lat, lon, mosaics, sector });
 *   const res = await refineEyeFromSkyline(samples, pose0, [0, 0, eyeAlt], null, {
 *     ...opts, horizonsAtEyes: hp.horizonsAtEyes, ground: hp.ground });
 *   hp.release();
 *
 * Conventions (what EyeHorizon means in eye.ts):
 * - Eyes are local ENU metres [E, N, U] around the origin (lat, lon): E/N on the local tangent plane
 *   (spherical, EARTH_R; offsets are ≤ ~100 m so the flat approximation is < 1 mm), U = height above
 *   MSL (the DEM's datum), i.e. horizon-fast's Eye.h. Put eye0 = [0, 0, eyeAlt] at the GPS fix.
 * - EyeHorizon.elevation is a full 360° array (index i ↔ azimuth i·step, clockwise from true north,
 *   degrees above the horizontal incl. curvature + refraction), −90 (≤ −89 = no data) outside the
 *   marched sector. distance is metres to the skyline point.
 * - ground(dE, dN) is the finest mosaic's bilinear DEM height at eye0 + (dE, dN) with eye0 at the
 *   origin (NaN outside the mosaic / no data), the same heights the horizon marches over.
 *
 * Mosaics are built once around the photo and shared by every eye (the eye moves ≤ ~100 m; sector
 * windows are padded by `padMeters`, default 250). The GPU keeps its copy until release().
 */
import { blobHeights, MAPTERHORN } from "#/lib/dem";
import { EARTH_R } from "#/lib/geodesy";
import type { Eye, FastHorizonOptions } from "#/lib/horizon-fast/march";
import {
	DEFAULT_RINGS,
	loadMosaics,
	type Mosaic,
	mosaicHeight,
	type Ring,
	TileStore,
} from "#/lib/horizon-fast/mosaic";
import type { EyeHorizon, Vec3 } from "#/lib/pose6dof/eye";
import { computeHorizonsAuto, releaseHorizonGpu } from "../horizon";

const DEG = Math.PI / 180;

/** Azimuth sector, degrees clockwise from north (az0 < az1; az1 − az0 ≥ 360 = full circle). */
export interface AzSector {
	az0: number;
	az1: number;
}

/**
 * The sector the eye search needs: the photo's horizontal FOV around the yaw plus a margin (the
 * rotation re-fit moves yaw by a few degrees; default 8°, as in the node experiment).
 */
export function sectorForPose(
	pose: { yaw: number; vfov: number },
	aspect: number,
	marginDeg = 8,
): AzSector {
	const half =
		Math.atan(Math.tan((pose.vfov * DEG) / 2) * aspect) / DEG + marginDeg;
	return { az0: pose.yaw - half, az1: pose.yaw + half };
}

let mapterhornStore: TileStore | null = null;
/** A Mapterhorn TileStore for this realm (the source the eye experiment recommends). */
export function mapterhornTileStore(): TileStore {
	mapterhornStore ??= new TileStore({
		tileSize: MAPTERHORN.tileSize,
		maxZoom: MAPTERHORN.maxZoom,
		async load(k) {
			const r = await fetch(MAPTERHORN.url(k)).catch(() => undefined);
			if (!r) return undefined;
			if (r.status === 404 || r.status === 204) return null;
			if (!r.ok) return undefined;
			return blobHeights(await r.blob());
		},
	});
	return mapterhornStore;
}

export interface EyeMosaicOptions {
	sector?: AzSector;
	/** Default DEFAULT_RINGS (z14/15 near: the eye search needs the fine near field). */
	rings?: Ring[];
	/** Default 120 km (the app worker's reach). */
	maxDistance?: number;
	/** Window padding for eyes off the origin, metres (default 250). */
	padMeters?: number;
	/** Default: mapterhornTileStore(). */
	store?: TileStore;
}

/** Ring mosaics (with max-mips) around (lat, lon), built once for the whole eye search. */
export function loadEyeMosaics(
	lat: number,
	lon: number,
	o: EyeMosaicOptions = {},
): Promise<Mosaic[]> {
	const full = !o.sector || o.sector.az1 - o.sector.az0 >= 360;
	return loadMosaics(lat, lon, o.store ?? mapterhornTileStore(), {
		rings: o.rings ?? DEFAULT_RINGS,
		maxDistance: o.maxDistance ?? 120_000,
		az0: full ? 0 : o.sector?.az0,
		az1: full ? 360 : o.sector?.az1,
		padMeters: o.padMeters ?? 250,
		mips: true,
	});
}

export interface EyeHorizonProviderOptions {
	/** ENU origin (the GPS fix). */
	lat: number;
	lon: number;
	mosaics: Mosaic[];
	/** March only these azimuths (the rest of the EyeHorizon is −90); default full circle. */
	sector?: AzSector;
	/**
	 * horizon-fast options (noRidges is forced on, i0/i1 come from `sector`). Default: the app worker's
	 * step 0.05°, minDistance 2 m, maxDistance 120 km.
	 */
	horizon?: FastHorizonOptions;
}

export interface EyeHorizonProviderStats {
	/** horizonsAtEyes calls, eyes marched, and their total wall time (ms). */
	batches: number;
	eyes: number;
	ms: number;
	maxBatch: number;
}

export interface EyeHorizonProvider {
	/** RefineEyeOptions.horizonsAtEyes. */
	horizonsAtEyes: (eyes: Vec3[]) => Promise<EyeHorizon[]>;
	/** A per-eye HorizonAtEye (a batch of one). */
	horizonAt: (eye: Vec3) => Promise<EyeHorizon>;
	/** RefineEyeOptions.ground for eye0 = [0, 0, ·] (offsets from the origin). */
	ground: (dE: number, dN: number) => number;
	/** ENU eye → horizon-fast Eye. */
	toEye: (e: ArrayLike<number>) => Eye;
	stats: EyeHorizonProviderStats;
	/** Frees the GPU copy of the mosaics. */
	release: () => void;
}

export function createEyeHorizonProvider(
	o: EyeHorizonProviderOptions,
): EyeHorizonProvider {
	const { lat, lon, mosaics } = o;
	const hOpts: FastHorizonOptions = {
		step: 0.05,
		minDistance: 2,
		maxDistance: 120_000,
		...o.horizon,
		noRidges: true,
	};
	const step = hOpts.step ?? 0.05;
	const n = Math.round(360 / step);
	if (o.sector && o.sector.az1 - o.sector.az0 < 360) {
		// +1 so horizonEl can interpolate up to az1
		const i0 = Math.floor(o.sector.az0 / step);
		const i1 = Math.min(i0 + n, Math.ceil(o.sector.az1 / step) + 1);
		hOpts.i0 = i0;
		hOpts.i1 = i1;
	} else {
		hOpts.i0 = undefined;
		hOpts.i1 = undefined;
	}
	const mPerLat = EARTH_R * DEG;
	const mPerLon = mPerLat * Math.cos(lat * DEG);
	const toEye = (e: ArrayLike<number>): Eye => ({
		lat: lat + e[1] / mPerLat,
		lon: lon + e[0] / mPerLon,
		h: e[2],
	});
	const stats: EyeHorizonProviderStats = {
		batches: 0,
		eyes: 0,
		ms: 0,
		maxBatch: 0,
	};
	const horizonsAtEyes = async (eyes: Vec3[]): Promise<EyeHorizon[]> => {
		const t0 = performance.now();
		const profs = await computeHorizonsAuto(mosaics, eyes.map(toEye), hOpts);
		const out = profs.map((p): EyeHorizon => {
			if (p.i0 === 0 && p.elevation.length === n)
				return { step: p.step, elevation: p.elevation, distance: p.distance };
			const elevation = new Float32Array(n).fill(-90);
			const distance = new Float32Array(n);
			for (let j = 0; j < p.elevation.length; j++) {
				const i = (((p.i0 + j) % n) + n) % n;
				elevation[i] = p.elevation[j];
				distance[i] = p.distance[j];
			}
			return { step: p.step, elevation, distance };
		});
		stats.batches++;
		stats.eyes += eyes.length;
		stats.maxBatch = Math.max(stats.maxBatch, eyes.length);
		stats.ms += performance.now() - t0;
		return out;
	};
	const ground = (dE: number, dN: number) => {
		const e = toEye([dE, dN, 0]);
		for (const m of mosaics) {
			const h = mosaicHeight(m, e.lon, e.lat);
			if (Number.isFinite(h)) return h;
		}
		return Number.NaN;
	};
	return {
		horizonsAtEyes,
		horizonAt: async (e) => (await horizonsAtEyes([[e[0], e[1], e[2]]]))[0],
		ground,
		toEye,
		stats,
		release: () => releaseHorizonGpu(mosaics),
	};
}

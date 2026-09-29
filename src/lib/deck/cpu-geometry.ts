// CPU terrain geometry for the deck backend: the GeometrySource fallback (no GPU), hover
// sampling and the fallback 360° horizon, all from one per-azimuth terrain profile.
//
// Every ray from the eye lies in the vertical plane of its azimuth, so the first terrain hit of
// a ray at elevation angle `el` is the nearest profile sample whose elevation angle (seen from the
// eye) reaches `el`. One march per azimuth bin (≈1.6k DEM lookups out to 120 km) then answers
// every pixel of that azimuth with a binary search on the running maximum: a whole 384 px frame
// costs ≈0.4k marches once, then ~10 ms per pose, instead of a ray march per pixel.
// Heights come from TerrainSet.heightAt (the streamed Mapterhorn tiles, bilinear); the curvature
// drop uses the same refraction k (0.13) as the meshes (EnuFrame) and TerrainSet.clearance.

import type { Pose } from "../camera";
import { EARTH_R, REFRACTION_K } from "../geodesy";
import { poseBasis } from "../pose";
import type { GeometrySource } from "./geometry-source";
import type { TerrainSet } from "./terrain-data";

const DEG = Math.PI / 180;

/** March distances (m): 1.5 m steps near the camera, then 0.45 % of the distance. */
function marchDistances(maxRange: number) {
	const out: number[] = [];
	for (let s = 3; s < maxRange; s += Math.max(1.5, s * 0.0045)) out.push(s);
	return Float32Array.from(out);
}

type Bin = {
	/** Raw tan(elevation angle) of the terrain at each march distance (−Inf where no data). */
	tan: Float32Array;
	/** Running maximum of `tan` (monotone: the binary-search key). */
	max: Float32Array;
};

export class TerrainProfiles {
	readonly terrain: TerrainSet;
	readonly eyeZ: number;
	/** Azimuth bin width (deg). */
	readonly azStep: number;
	readonly dist: Float32Array;
	private bins = new Map<number, Bin>();
	private cosLat: number;

	constructor(
		terrain: TerrainSet,
		eyeZ: number,
		{ azStep = 0.1, maxRange = 120_000 } = {},
	) {
		this.terrain = terrain;
		this.eyeZ = eyeZ;
		this.azStep = azStep;
		this.dist = marchDistances(maxRange);
		this.cosLat = Math.cos(terrain.frame.lat * DEG);
	}

	get binCount() {
		return this.bins.size;
	}

	/** Terrain ENU height at horizontal distance s along azimuth (sin, cos); NaN outside coverage. */
	private groundZ(s: number, sa: number, ca: number) {
		const f = this.terrain.frame;
		const e = s * sa;
		const n = s * ca;
		const lat = f.lat + n / (EARTH_R * DEG);
		const lon = f.lon + e / (EARTH_R * DEG * this.cosLat);
		const h = this.terrain.heightAt(lat, lon);
		if (h == null) return Number.NaN;
		return h - f.h - ((1 - REFRACTION_K) * s * s) / (2 * EARTH_R);
	}

	private bin(k: number): Bin {
		const n = Math.round(360 / this.azStep);
		const key = ((k % n) + n) % n;
		let b = this.bins.get(key);
		if (b) return b;
		const az = key * this.azStep * DEG;
		const sa = Math.sin(az);
		const ca = Math.cos(az);
		const d = this.dist;
		const tan = new Float32Array(d.length);
		const max = new Float32Array(d.length);
		let m = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < d.length; i++) {
			const z = this.groundZ(d[i], sa, ca);
			const t = Number.isNaN(z)
				? Number.NEGATIVE_INFINITY
				: (z - this.eyeZ) / d[i];
			tan[i] = t;
			if (t > m) m = t;
			max[i] = m;
		}
		b = { tan, max };
		this.bins.set(key, b);
		return b;
	}

	/**
	 * Range (m) to the first terrain hit along a unit ENU direction, Infinity for sky.
	 * The ray's azimuth snaps to the nearest bin (0.1° by default).
	 */
	rangeAlong(dx: number, dy: number, dz: number): number {
		const horiz = Math.hypot(dx, dy);
		if (horiz < 1e-6) return Number.POSITIVE_INFINITY; // straight up/down
		let az = Math.atan2(dx, dy) / DEG;
		if (az < 0) az += 360;
		const b = this.bin(Math.round(az / this.azStep));
		const t = dz / horiz; // tan(elevation)
		const max = b.max;
		if (!(max[max.length - 1] >= t)) return Number.POSITIVE_INFINITY;
		// first index whose running max reaches t
		let lo = 0;
		let hi = max.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (max[mid] >= t) hi = mid;
			else lo = mid + 1;
		}
		const d = this.dist;
		let s = d[lo];
		if (lo > 0) {
			const t0 = b.tan[lo - 1];
			const t1 = b.tan[lo];
			if (Number.isFinite(t0) && t1 > t0)
				s = d[lo - 1] + ((d[lo] - d[lo - 1]) * (t - t0)) / (t1 - t0);
		}
		return s * Math.hypot(1, t);
	}

	/**
	 * 360° skyline as ENU unit directions (x east, y north, z up), one per `step` degrees: the
	 * CPU stand-in for engine.ts computeHorizon (8 GPU renders). Azimuths with no terrain are
	 * skipped. Heavy (≈1.6k DEM lookups per azimuth); `yieldEvery` bins it awaits a macrotask.
	 */
	async horizonDirs(step = 0.2, yieldEvery = 60, signal?: AbortSignal) {
		const out: number[] = [];
		const every = Math.max(1, Math.round(step / this.azStep));
		const n = Math.round(360 / this.azStep);
		let done = 0;
		for (let k = 0; k < n; k += every) {
			if (signal?.aborted) break;
			const b = this.bin(k);
			const t = b.max[b.max.length - 1];
			if (Number.isFinite(t)) {
				const az = k * this.azStep * DEG;
				const c = 1 / Math.hypot(1, t);
				out.push(Math.sin(az) * c, Math.cos(az) * c, t * c);
			}
			if (++done % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
		}
		return new Float32Array(out);
	}
}

/** GeometrySource on the CPU (TerrainProfiles). Exact per-pixel rays, azimuth snapped to 0.1°. */
export class CpuGeometrySource implements GeometrySource {
	readonly width: number;
	readonly height: number;
	readonly range: Float32Array;
	readonly xyz: Float32Array;
	pose: Pose | null = null;
	private profiles: TerrainProfiles;
	private eye: [number, number, number];
	private aspect: number;

	constructor(
		profiles: TerrainProfiles,
		eye: [number, number, number],
		aspect: number,
		width: number,
		height: number,
	) {
		this.profiles = profiles;
		this.eye = eye;
		this.aspect = aspect;
		this.width = width;
		this.height = height;
		this.range = new Float32Array(width * height);
		this.xyz = new Float32Array(width * height * 3);
	}

	/** Synchronous fill (the Promise form is the GeometrySource contract). */
	renderSync(pose: Pose) {
		const { forward: f, right: r, up: u } = poseBasis(pose);
		const t = Math.tan((pose.vfov * DEG) / 2);
		const W = this.width;
		const H = this.height;
		const [ex, ey, ez] = this.eye;
		for (let y = 0; y < H; y++) {
			const yy = (1 - ((y + 0.5) / H) * 2) * t;
			for (let x = 0; x < W; x++) {
				const xx = (((x + 0.5) / W) * 2 - 1) * t * this.aspect;
				let dx = f.x + r.x * xx + u.x * yy;
				let dy = f.y + r.y * xx + u.y * yy;
				let dz = f.z + r.z * xx + u.z * yy;
				const l = Math.hypot(dx, dy, dz);
				dx /= l;
				dy /= l;
				dz /= l;
				const i = y * W + x;
				const rg = this.profiles.rangeAlong(dx, dy, dz);
				this.range[i] = rg;
				if (Number.isFinite(rg)) {
					this.xyz[i * 3] = ex + dx * rg;
					this.xyz[i * 3 + 1] = ey + dy * rg;
					this.xyz[i * 3 + 2] = ez + dz * rg;
				} else
					this.xyz[i * 3] =
						this.xyz[i * 3 + 1] =
						this.xyz[i * 3 + 2] =
							Number.NaN;
			}
		}
		this.pose = { ...pose };
	}

	render(pose: Pose) {
		this.renderSync(pose);
		return Promise.resolve();
	}
}

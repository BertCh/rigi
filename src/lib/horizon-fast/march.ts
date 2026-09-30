/**
 * Fast CPU horizon: per azimuth, an incremental march in Web-Mercator pixel
 * space over per-ring Float32 mosaics, with max-mipmap block skipping.
 *
 * - The great circle is followed piecewise: exact destination points at
 *   ring boundaries and every few km (chord sagitta < `segmentTolerance`
 *   rad of the distance), linear in Mercator pixels in between.
 * - Step max(cell, stepFactor · d); bilinear samples.
 * - Tracks t = (h − h_o)/d − d/(2R′), R′ = R/(1 − k); one atan per azimuth
 *   (and per recorded ridge). Same geometry as geo/horizon.ts.
 * - Skips a mip block when (Hmax − h_o)/d_near − d_near/2R′ ≤ t_best
 *   (d_far instead of d_near for the first term when Hmax < h_o).
 */
import { MIN_VALID } from "../dem";
import type { HorizonOptions, HorizonProfile, Ridge } from "../geo/horizon";
import { type TerrainSampler, TILE_SIZE } from "../geo/terrain";
import { DEG, EARTH_R, REFRACTION_K } from "../geodesy";
import {
	buildMips,
	buildMosaics,
	type Mosaic,
	type RingSpan,
	type TileSource,
	TileStore,
} from "./mosaic";
import {
	type ClassifyOptions,
	classifyPeak,
	occlusionStop,
	type PeakInput,
	type PeakVisibility,
	type SnappedPeak,
} from "./visibility";

export interface Eye {
	lat: number;
	lon: number;
	/** Eye height above MSL, metres. */
	h: number;
}

export interface FastHorizonOptions extends HorizonOptions {
	/** Refraction coefficient (R′ = R / (1 − k)). */
	k?: number;
	/**
	 * Step = max(stepFactor · d, min(cell · cellSteps, nearFactor · d),
	 * 0.25 m): the cell floor is relaxed near the camera, where a cell is
	 * a large angle (with 13 m cells a skyline at 40 m would be sampled at
	 * 20, 33, 46 m).
	 */
	stepFactor?: number;
	cellSteps?: number;
	nearFactor?: number;
	/** Max-mipmap block skipping (default on). */
	mipSkip?: boolean;
	/** Max chord sagitta / distance for great-circle segments, radians. */
	segmentTolerance?: number;
	/** Only march azimuth indices [i0, i1) (worker sectors). */
	i0?: number;
	i1?: number;
	/** Already snapped peaks (visibility.snapPeaks) to classify. */
	peaks?: SnappedPeak[];
	classify?: ClassifyOptions;
	/** Skip ridge recording (a little faster). */
	noRidges?: boolean;
}

export interface MarchStats {
	azimuths: number;
	samples: number;
	skips: number;
	ms: number;
}

export interface FastHorizonProfile extends HorizonProfile {
	/** First azimuth index held (0 unless a sector was requested). */
	i0: number;
	peaks?: PeakVisibility[];
	stats: MarchStats;
}

interface RingRt {
	data: Float32Array;
	W: number;
	/** Last valid bilinear origin + 1 (u < W1 ⇒ u + 1 in range). */
	W1: number;
	H1: number;
	/** worldPx, and pixel offsets (x0 + 0.5, y0 + 0.5). */
	sx: number;
	ox: number;
	oy: number;
	step: number;
	mips: Float32Array[] | null;
	mipW: Int32Array;
	mipH: Int32Array;
	S0: number;
}

interface Ctx {
	rings: RingRt[];
	/** Breakpoint distances and the ring of each segment [k, k+1]. */
	segD: Float64Array;
	segRing: Int32Array;
	sinD: Float64Array;
	cosD: Float64Array;
	bx: Float64Array;
	by: Float64Array;
	sinP1: number;
	cosP1: number;
	lon0: number;
	h0: number;
	inv2R: number;
	stepFactor: number;
	nearFactor: number;
	minOcc: number;
	samples: number;
	skips: number;
	// Per-ray results.
	tBest: number;
	dBest: number;
	tQ: number;
	dQ: number;
}

function makeCtx(mosaics: Mosaic[], eye: Eye, opts: FastHorizonOptions): Ctx {
	const k = opts.k ?? REFRACTION_K;
	const maxDistance = Math.min(
		opts.maxDistance ?? 150_000,
		mosaics[mosaics.length - 1].maxDistance,
	);
	const minDistance = opts.minDistance ?? 20;
	const mipSkip = opts.mipSkip ?? true;
	const cellSteps = opts.cellSteps ?? 0.5;
	const rings: RingRt[] = mosaics.map((m) => {
		if (mipSkip && !m.mip) m.mip = buildMips(m);
		const mip = mipSkip ? m.mip : undefined;
		return {
			data: m.data,
			W: m.width,
			W1: m.width - 1,
			H1: m.height - 1,
			sx: m.worldPx,
			ox: m.x0 + 0.5,
			oy: m.y0 + 0.5,
			step: m.cellMeters * cellSteps,
			mips: mip ? mip.mips : null,
			mipW: Int32Array.from(mip?.widths ?? []),
			mipH: Int32Array.from(mip?.heights ?? []),
			S0: mip ? 1 << mip.minLevel : 1,
		};
	});
	// Segment breakpoints: ring boundaries plus chords short enough that the
	// great circle (Mercator curvature ≤ tan|φ| / R) stays within tolerance.
	const eps = opts.segmentTolerance ?? 2e-5;
	const kappa =
		Math.max(0.05, Math.tan(Math.min(80, Math.abs(eye.lat) + 3) * DEG)) /
		EARTH_R;
	const segD: number[] = [minDistance];
	const segRing: number[] = [];
	let d = minDistance;
	let ri = 0;
	while (d < maxDistance) {
		while (ri < mosaics.length - 1 && d >= mosaics[ri].maxDistance) ri++;
		const ringEnd =
			ri < mosaics.length - 1 ? mosaics[ri].maxDistance : maxDistance;
		const len = Math.max(200, Math.sqrt((8 * eps * d) / kappa));
		const next = Math.min(d + len, ringEnd, maxDistance);
		segRing.push(ri);
		segD.push(next);
		d = next;
	}
	const n = segD.length;
	const sinD = new Float64Array(n);
	const cosD = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		sinD[i] = Math.sin(segD[i] / EARTH_R);
		cosD[i] = Math.cos(segD[i] / EARTH_R);
	}
	return {
		rings,
		segD: Float64Array.from(segD),
		segRing: Int32Array.from(segRing),
		sinD,
		cosD,
		bx: new Float64Array(n),
		by: new Float64Array(n),
		sinP1: Math.sin(eye.lat * DEG),
		cosP1: Math.cos(eye.lat * DEG),
		lon0: eye.lon * DEG,
		h0: eye.h,
		inv2R: (1 - k) / (2 * EARTH_R),
		stepFactor: opts.stepFactor ?? 3.5e-4,
		nearFactor: opts.nearFactor ?? 0.01,
		minOcc: opts.minOcclusion ?? 0.08,
		samples: 0,
		skips: 0,
		tBest: 0,
		dBest: 0,
		tQ: 0,
		dQ: 0,
	};
}

/**
 * Marches one azimuth (degrees). Writes c.tBest / c.dBest and, when
 * q > 0, the running max before distance q to c.tQ / c.dQ. Appends ridge
 * crests to `ridges` when given.
 */
function marchRay(c: Ctx, az: number, q: number, ridges: Ridge[] | null) {
	const sinA = Math.sin(az * DEG);
	const cosA = Math.cos(az * DEG);
	const { segD, segRing, sinD, cosD, bx, by, sinP1, cosP1, lon0 } = c;
	const nb = segD.length;
	const TWO_PI = 2 * Math.PI;
	for (let k = 0; k < nb; k++) {
		const sinP2 = sinP1 * cosD[k] + cosP1 * sinD[k] * cosA;
		const dl = Math.atan2(sinA * sinD[k] * cosP1, cosD[k] - sinP1 * sinP2);
		bx[k] = (lon0 + dl + Math.PI) / TWO_PI;
		by[k] = 0.5 - Math.atanh(sinP2) / TWO_PI;
	}
	const h0 = c.h0;
	const inv2R = c.inv2R;
	const stepFactor = c.stepFactor;
	const nearFactor = c.nearFactor;
	const minOcc = c.minOcc;
	let tBest = Number.NEGATIVE_INFINITY;
	let dBest = 0;
	let tC = 0;
	let dC = 0;
	let hasCrest = false;
	let prevVisible = false;
	let qDone = !(q > 0);
	let samples = 0;
	let skips = 0;
	let d = segD[0];
	for (let k = 0; k < nb - 1; k++) {
		const r = c.rings[segRing[k]];
		const dA = segD[k];
		const dB = segD[k + 1];
		const sx = r.sx;
		const uA = bx[k] * sx - r.ox;
		const vA = by[k] * sx - r.oy;
		const inv = 1 / (dB - dA);
		const du = (bx[k + 1] * sx - r.ox - uA) * inv;
		const dv = (by[k + 1] * sx - r.oy - vA) * inv;
		const data = r.data;
		const W = r.W;
		const W1 = r.W1;
		const H1 = r.H1;
		const step = r.step;
		const mips = r.mips;
		let noTest = 0;
		while (d < dB) {
			if (!qDone && d >= q) {
				c.tQ = tBest;
				c.dQ = dBest;
				qDone = true;
			}
			const f = d - dA;
			const u = uA + f * du;
			const v = vA + f * dv;
			if (u >= 0 && v >= 0 && u < W1 && v < H1) {
				if (
					mips !== null &&
					d >= noTest &&
					tBest !== Number.NEGATIVE_INFINITY
				) {
					// Bottom-up: finest level first, grow while the block is hidden.
					let S = r.S0;
					let skipTo = -1;
					for (let L = 0; L < mips.length; L++) {
						const cu = Math.floor(u / S);
						const cv = Math.floor(v / S);
						const mw = r.mipW[L];
						const mh = r.mipH[L];
						if (cu >= mw || cv >= mh) break;
						// Exact-partition mips: the bilinear footprint reaches
						// one pixel into the next cells.
						const M = mips[L];
						const o = cv * mw + cu;
						const cu1 = cu + 1 < mw;
						const cv1 = cv + 1 < mh;
						let Hm = M[o];
						if (cu1 && M[o + 1] > Hm) Hm = M[o + 1];
						if (cv1) {
							if (M[o + mw] > Hm) Hm = M[o + mw];
							if (cu1 && M[o + mw + 1] > Hm) Hm = M[o + mw + 1];
						}
						const ex =
							du > 0
								? ((cu + 1) * S - u) / du
								: du < 0
									? (cu * S - u) / du
									: Number.POSITIVE_INFINITY;
						const ey =
							dv > 0
								? ((cv + 1) * S - v) / dv
								: dv < 0
									? (cv * S - v) / dv
									: Number.POSITIVE_INFINITY;
						const far = d + (ex < ey ? ex : ey);
						const a = Hm - h0;
						const bound = (a >= 0 ? a / d : a / far) - d * inv2R;
						if (bound > tBest) {
							if (L === 0) noTest = far;
							break;
						}
						skipTo = far;
						S *= 2;
					}
					if (skipTo >= 0) {
						if (skipTo > dB) skipTo = dB;
						d = skipTo > d + 1e-3 ? skipTo : d + 1e-3;
						prevVisible = false;
						skips++;
						continue;
					}
				}
				const x0 = u | 0;
				const y0 = v | 0;
				const fx = u - x0;
				const fy = v - y0;
				const i = y0 * W + x0;
				const a0 = data[i];
				const a1 = data[i + 1];
				const b0 = data[i + W];
				const b1 = data[i + W + 1];
				const h =
					a0 + (a1 - a0) * fx + (b0 - a0 + (a0 - a1 - b0 + b1) * fx) * fy;
				samples++;
				if (h > MIN_VALID) {
					const t = (h - h0) / d - d * inv2R;
					if (t > tBest) {
						if (
							ridges !== null &&
							!prevVisible &&
							hasCrest &&
							d - dC > minOcc * dC
						)
							ridges.push({ elevation: Math.atan(tC) / DEG, distance: dC });
						tC = t;
						dC = d;
						hasCrest = true;
						tBest = t;
						dBest = d;
						prevVisible = true;
					} else prevVisible = false;
				}
			}
			const s = stepFactor * d;
			let sc = nearFactor * d;
			if (sc > step) sc = step;
			else if (sc < 0.25) sc = 0.25;
			d += s > sc ? s : sc;
		}
	}
	if (!qDone) {
		c.tQ = tBest;
		c.dQ = dBest;
	}
	c.tBest = tBest;
	c.dBest = dBest;
	c.samples += samples;
	c.skips += skips;
}

/**
 * Horizon over prepared mosaics (see mosaic.ts), or over a baseline
 * TerrainSampler (its tiles are copied into mosaics per call; prefer
 * passing mosaics when calling repeatedly).
 */
export function computeHorizonFast(
	src: TerrainSampler | Mosaic[],
	eye: Eye,
	opts: FastHorizonOptions = {},
): FastHorizonProfile {
	const t0 = performance.now();
	const mosaics = Array.isArray(src)
		? src
		: mosaicsFromSampler(src, eye.lat, eye.lon, opts.maxDistance ?? 150_000);
	const step = opts.step ?? 0.05;
	const n = Math.round(360 / step);
	const i0 = opts.i0 ?? 0;
	const i1 = opts.i1 ?? n;
	const c = makeCtx(mosaics, eye, opts);
	const elevation = new Float32Array(i1 - i0);
	const distance = new Float32Array(i1 - i0);
	const ridges: Ridge[][] = [];
	for (let i = i0; i < i1; i++) {
		const found: Ridge[] = [];
		marchRay(c, i * step, 0, opts.noRidges ? null : found);
		elevation[i - i0] =
			c.tBest === Number.NEGATIVE_INFINITY ? -90 : Math.atan(c.tBest) / DEG;
		distance[i - i0] = c.dBest;
		ridges.push(found);
	}
	let peaks: PeakVisibility[] | undefined;
	if (opts.peaks) {
		peaks = [];
		for (const p of opts.peaks) {
			marchRay(c, p.azimuth, occlusionStop(p), null);
			peaks.push(
				classifyPeak(
					p,
					eye.h,
					c.inv2R,
					c.tQ,
					c.dQ,
					c.tBest,
					c.dBest,
					opts.classify,
				),
			);
		}
	}
	return {
		step,
		elevation,
		distance,
		ridges,
		i0,
		peaks,
		stats: {
			azimuths: i1 - i0,
			samples: c.samples,
			skips: c.skips,
			ms: performance.now() - t0,
		},
	};
}

/** Occlusion + skyline for peaks only (no full profile). */
export function peakVisibilityFast<P extends PeakInput>(
	mosaics: Mosaic[],
	eye: Eye,
	peaks: SnappedPeak<P>[],
	opts: FastHorizonOptions = {},
): PeakVisibility<P>[] {
	const c = makeCtx(mosaics, eye, opts);
	return peaks.map((p) => {
		marchRay(c, p.azimuth, occlusionStop(p), null);
		return classifyPeak(
			p,
			eye.h,
			c.inv2R,
			c.tQ,
			c.dQ,
			c.tBest,
			c.dBest,
			opts.classify,
		);
	});
}

/**
 * Drop-in replacement for geo/horizon.ts computeHorizon (same signature
 * and output; finer step, same curvature/refraction model).
 */
export function computeHorizonFastCompat(
	terrain: TerrainSampler,
	lat: number,
	lon: number,
	eyeHeight: number,
	opts: FastHorizonOptions = {},
): FastHorizonProfile {
	return computeHorizonFast(terrain, { lat, lon, h: eyeHeight }, opts);
}

const noSource = (tileSize: number): TileSource => ({
	tileSize,
	maxZoom: 30,
	load: async () => null,
});

/**
 * Mosaics from a baseline TerrainSampler's already-loaded tiles, one per
 * level (ring i spans levels[i − 1].maxDistance .. levels[i].maxDistance).
 */
export function mosaicsFromSampler(
	sampler: TerrainSampler,
	lat: number,
	lon: number,
	maxDistance = 150_000,
): Mosaic[] {
	const tiles = (sampler as unknown as { tiles: Map<string, Float32Array> })
		.tiles;
	const tileSize = (sampler as { tileSize?: number }).tileSize ?? TILE_SIZE;
	const store = new TileStore(noSource(tileSize), false);
	for (const [id, t] of tiles) store.tiles.set(id, t);
	const spans: RingSpan[] = [];
	let lo = 0;
	for (const l of sampler.levels) {
		if (lo >= maxDistance) break;
		spans.push({
			z: l.z,
			minDistance: lo,
			maxDistance: Math.min(l.maxDistance, maxDistance),
		});
		lo = l.maxDistance;
	}
	if (lo < maxDistance) spans[spans.length - 1].maxDistance = maxDistance;
	return buildMosaics(lat, lon, store, spans);
}

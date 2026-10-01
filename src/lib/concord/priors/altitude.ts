// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Eye prior from EXIF GPS (WP-B): the GPS altitude as a MEASUREMENT (the "altitude contour"), not only
// as a floor.
//
// The old rule, eye = max(GPSAltitude, DEM(fix) + 1.6), throws the altitude away whenever the fix lands
// on higher ground than the photographer stood on (summits, cliff lips, slopes: the fix is off by hAcc
// 6–70 m horizontally), and then puts the eye 5–20 m too high. iPhone GPSAltitude is metres above mean
// sea level (EGM2008) and agrees with the DEM to a few metres where the fix is good (see
// tools/concord/priors/RESULT.txt), so the photographer most likely stood where DEM + 1.6 ≈ alt, within
// the horizontal accuracy of the fix: the iso-band.
//
// This is a PRIOR, never a snap: eyePriorFromExif returns a Gaussian GPS term (eye0, σH, σV) plus the
// iso-band term (altitudeContourCost) that a solver adds to its objective, and seeds on the band for a
// coarse eye search (isoBandSeeds). concordEye is the pure hook for the pipelines' eye rule (flag
// ?concord=eye): the MAP of this prior, or null (keep the old rule) when there is no altitude, the photo
// comes from a pin, or the iso-band is empty within 2σH.
//
// Frame: engine ENU at the GPS fix (x = east, y = north, metres), z = altitude in the DEM's datum
// (m MSL). `ground(dE, dN)` is the DEM height at a horizontal offset from the fix (./ground.ts).
import type { Vec3 } from "../core/types";
import { type GroundFn, offsetLatLon } from "./ground";

/** Standing eye height above the DEM (m); the app's EYE_ABOVE_GROUND (geo/pipeline.ts). */
export const EYE_ABOVE_GROUND = 1.6;

export type EyeMeta = {
	lat: number;
	lon: number;
	/** EXIF GPSAltitude, m above mean sea level (iPhone: EGM2008); null = none. */
	alt: number | null;
	/** EXIF GPSHPositioningError, m; null = unknown. */
	hAcc: number | null;
	/** Position typed in / picked on a map (upload/exif.ts nulls alt for these). */
	fromPin?: boolean;
};

export type EyePrior = {
	/** Prior mean for eye.ts posPrior: [0, 0, alt] (GPS fix, GPS altitude), or the old-rule eye on fallback. */
	eye0: Vec3;
	sigmaH: number;
	sigmaV: number;
	isoBand?: {
		alt: number;
		sigmaA: number;
		ground: (dE: number, dN: number) => number;
	};
	source: "gps+alt-contour" | "gps+dem-floor" | "pin";
	// ---- additive (not in the frozen plan type)
	/** DEM height at the fix (NaN = none). */
	g0: number;
	/** MAP eye of the prior (GPS horizontal + iso-band), absolute; absent on fallback. */
	mapEye?: Vec3;
	/** Why this source was chosen (diagnostics). */
	reason: string;
	/** Fraction of the 2σH disk on the iso-band (|DEM + 1.6 − alt| ≤ σA). */
	bandFrac: number;
};

/**
 * Tunables. Values are fitted on the DEV photos only (scripts/concord/priors-study.ts, removed
 * 2026-09-30; the frozen split in tools/concord/pins/PROTOCOL.txt); see tools/concord/priors/RESULT.txt for the derivation.
 */
export const EYE_PRIOR_DEFAULTS = {
	/**
	 * 1σ of GPSAltitude against (true ground + 1.6 + altBias), m, with the horizontal position free within
	 * σH. DEV joint maximum likelihood: (altBias −7, σA 3); with altBias 0 the MLE is σA 8.
	 */
	sigmaA: 3,
	/** σH when EXIF has no GPSHPositioningError, m. */
	hAccDefault: 20,
	/** σH floor / cap, m (iPhones report ≥ ~4.7 m; beyond 100 m the fix is not local evidence). */
	hAccMin: 5,
	hAccMax: 100,
	/** σV of the GPS term when the prior falls back to the floor rule (eye.ts default). */
	sigmaVFloor: 50,
	/** Standing height above the DEM, m. */
	eyeAboveGround: EYE_ABOVE_GROUND,
	/**
	 * Expected GPSAltitude − (true ground + 1.6), m; the altitude is read as alt − altBias. DEV fit: −7 m
	 * (likelihood ratio 7.7 over 0 for one parameter). CAVEAT: 9 of the 10 DEV photos are Swiss, from 4 days
	 * in 1 week; the no-GT US fixes read ≈ 0 (see RESULT.txt). Where no ground at alt − altBias lies
	 * within 2σH the prior falls back to the old rule, which bounds the damage of a wrong bias.
	 */
	altBias: -7,
};
export type EyePriorOptions = Partial<typeof EYE_PRIOR_DEFAULTS>;

/** Old rule (geo/pipeline.ts loadScene): max(alt ?? ground, ground + 1.6). */
export function floorEye(alt: number | null | undefined, g0: number, h = 1.6) {
	return Math.max(alt ?? g0, g0 + h);
}

type Cell = { dE: number; dN: number; g: number; r: number; J: number };

/** Grid of the 2σH disk: DEM, residual r = DEM + h − alt, MAP cost J = |x|²/σH² + (r/σA)². */
function scanDisk(
	ground: GroundFn,
	alt: number,
	sigmaH: number,
	sigmaA: number,
	h: number,
	radius = 2 * sigmaH,
	centre: [number, number] = [0, 0],
	step = Math.min(5, Math.max(1, radius / 40)),
): Cell[] {
	const out: Cell[] = [];
	const m = Math.ceil(radius / step);
	for (let j = -m; j <= m; j++)
		for (let i = -m; i <= m; i++) {
			const dE = centre[0] + i * step;
			const dN = centre[1] + j * step;
			if (Math.hypot(dE, dN) > 2 * sigmaH + 1e-9) continue;
			if (Math.hypot(i, j) * step > radius + 1e-9) continue;
			const g = ground(dE, dN);
			if (!Number.isFinite(g)) continue;
			const r = g + h - alt;
			out.push({
				dE,
				dN,
				g,
				r,
				J: (dE * dE + dN * dN) / (sigmaH * sigmaH) + (r / sigmaA) ** 2,
			});
		}
	return out;
}

/**
 * The eye prior of a photo from its EXIF GPS block and the near ground (./ground.ts nearGround).
 * Falls back to the old floor rule (source "gps+dem-floor" / "pin", no isoBand) when the altitude is
 * missing, the photo comes from a pin, there is no DEM at the fix, or the iso-band is empty within 2σH.
 */
export function eyePriorFromExif(
	meta: EyeMeta,
	ground: GroundFn,
	opts: EyePriorOptions = {},
): EyePrior {
	const o = { ...EYE_PRIOR_DEFAULTS, ...opts };
	const h = o.eyeAboveGround;
	const sigmaH = Math.min(
		o.hAccMax,
		Math.max(o.hAccMin, meta.hAcc ?? o.hAccDefault),
	);
	const g0 = ground(0, 0);
	const fallback = (
		source: EyePrior["source"],
		reason: string,
		bandFrac = 0,
	): EyePrior => ({
		eye0: [
			0,
			0,
			Number.isFinite(g0)
				? floorEye(meta.alt, g0, h)
				: (meta.alt ?? Number.NaN),
		],
		sigmaH,
		sigmaV: o.sigmaVFloor,
		source,
		g0,
		reason,
		bandFrac,
	});
	if (meta.fromPin) return fallback("pin", "position from a pin");
	if (meta.alt == null || !Number.isFinite(meta.alt))
		return fallback("gps+dem-floor", "no GPS altitude");
	if (!Number.isFinite(g0)) return fallback("gps+dem-floor", "no DEM at fix");
	const alt = meta.alt - o.altBias;
	const cells = scanDisk(ground, alt, sigmaH, o.sigmaA, h);
	const band = cells.filter((c) => Math.abs(c.r) <= o.sigmaA);
	const bandFrac = cells.length ? band.length / cells.length : 0;
	if (!band.length)
		return fallback(
			"gps+dem-floor",
			`iso-band empty within 2σH=${(2 * sigmaH).toFixed(0)} m (DEM+${h} − alt ∈ [${Math.min(...cells.map((c) => c.r)).toFixed(1)}, ${Math.max(...cells.map((c) => c.r)).toFixed(1)}] m)`,
			bandFrac,
		);
	// MAP: coarse best cell, then a fine scan around it
	let best = cells.reduce((a, b) => (b.J < a.J ? b : a));
	const coarse = Math.min(5, Math.max(1, sigmaH / 20));
	const fine = scanDisk(
		ground,
		alt,
		sigmaH,
		o.sigmaA,
		h,
		2 * coarse,
		[best.dE, best.dN],
		coarse / 8,
	);
	for (const c of fine) if (c.J < best.J) best = c;
	return {
		eye0: [0, 0, alt],
		sigmaH,
		sigmaV: o.sigmaA,
		isoBand: { alt, sigmaA: o.sigmaA, ground },
		source: "gps+alt-contour",
		g0,
		mapEye: [best.dE, best.dN, best.g + h],
		reason: `iso-band ${(100 * bandFrac).toFixed(1)}% of the 2σH disk`,
		bandFrac,
	};
}

/**
 * Cost term (dimensionless, χ²-like) to add to pose6dof/eye.ts posPrior-style objectives:
 * ((DEM(eye.xy) + 1.6 − alt) / σA)². `eye` is absolute in the prior's frame; 0 without an iso-band.
 * Where the DEM has no data it returns 0 (no evidence), never NaN.
 */
export function altitudeContourCost(
	eye: Vec3,
	p: EyePrior,
	eyeAboveGround = EYE_ABOVE_GROUND,
): number {
	if (!p.isoBand) return 0;
	const g = p.isoBand.ground(eye[0] - p.eye0[0], eye[1] - p.eye0[1]);
	if (!Number.isFinite(g)) return 0;
	return ((g + eyeAboveGround - p.isoBand.alt) / p.isoBand.sigmaA) ** 2;
}

/**
 * Seeds for refineEyeFromSkyline's coarse grid: up to `n` points on the iso-band within 2σH, absolute
 * [E, N, DEM + 1.6], best (lowest prior cost) first and spread out (≥ σH / 4 apart). Empty without an
 * iso-band.
 */
export function isoBandSeeds(
	p: EyePrior,
	n = 12,
	eyeAboveGround = EYE_ABOVE_GROUND,
): Vec3[] {
	if (!p.isoBand) return [];
	const { alt, sigmaA, ground } = p.isoBand;
	const cells = scanDisk(ground, alt, p.sigmaH, sigmaA, eyeAboveGround)
		.filter((c) => Math.abs(c.r) <= sigmaA)
		.sort((a, b) => a.J - b.J);
	const minSep = p.sigmaH / 4;
	const out: Vec3[] = [];
	for (const c of cells) {
		if (out.length >= n) break;
		const x = p.eye0[0] + c.dE;
		const y = p.eye0[1] + c.dN;
		if (out.some((q) => Math.hypot(q[0] - x, q[1] - y) < minSep)) continue;
		out.push([x, y, c.g + eyeAboveGround]);
	}
	return out;
}

/**
 * The prior as refineEyeFromSkyline (pose6dof/eye.ts) options, with no edit to eye.ts: position prior
 * σH / σV around eye0, the ground clamp, and a coarse grid over the iso-band's extent. The iso-band term
 * itself (altitudeContourCost) is for solvers that accept extra cost terms (WP-D).
 */
export function refineEyeOptions(p: EyePrior) {
	return {
		sigmaH: p.sigmaH,
		sigmaV: p.sigmaV,
		ground: p.isoBand?.ground,
		grid: {
			radius: Math.min(60, 2 * p.sigmaH),
			step: Math.max(5, Math.round(p.sigmaH / 3)),
			dz: [0],
		},
	};
}

export type ConcordEyeFlags = {
	/** ?concord=eye is on. Off ⇒ always null (the caller keeps its old expression bit-identically). */
	eye: boolean;
	opts?: EyePriorOptions;
};

export type ConcordEye = {
	/** Eye altitude, m (DEM datum). */
	alt: number;
	/** Eye position (the MAP of the prior) and its offset from the fix, m. */
	lat: number;
	lon: number;
	dE: number;
	dN: number;
	shiftM: number;
	prior: EyePrior;
};

/**
 * Pure hook for the pipelines' eye rule (geo/pipeline.ts loadScene, deck/scene.ts; flag ?concord=eye).
 * Returns the MAP eye of the altitude-contour prior, or null — keep the old rule — when the flag is off,
 * there is no altitude, the photo comes from a pin, or the iso-band is empty within 2σH.
 * `ground` must be the same DEM the caller renders (its `ground` at the fix = ground(0, 0)).
 */
export function concordEye(
	meta: EyeMeta,
	ground: GroundFn,
	flags: ConcordEyeFlags,
): ConcordEye | null {
	if (!flags.eye) return null;
	const prior = eyePriorFromExif(meta, ground, flags.opts);
	if (prior.source !== "gps+alt-contour" || !prior.mapEye) return null;
	const [dE, dN, alt] = prior.mapEye;
	const p = offsetLatLon(meta.lat, meta.lon, dE, dN);
	return {
		alt,
		lat: p.lat,
		lon: p.lon,
		dE,
		dN,
		shiftM: Math.hypot(dE, dN),
		prior,
	};
}

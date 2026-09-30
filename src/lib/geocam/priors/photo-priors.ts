// Photo metadata → MAP prior factors (GEO GA0/GA1). One adapter so every GEO eval builds the same priors:
//   gps      horizontal fix ± σH, σH = EXIF hAcc clamped like concord's EyePrior ([5, 100] m, default 20)
//   alt      GPS altitude (EyePrior altBias / σA), not for pinned positions
//   ground   standing height over the DEM (when a ground function is given)
//   gravity  accelerometer pitch / roll (when the photo has a gravity vector and they are not unknown)
//   compass  EXIF heading made TRUE (priorHeading: + WMM2025 declination when the ref is magnetic),
//            Student-t (map/factors.ts compassFactor)
//   focal    optional (focal-table prior, scaled to the 1600 basis by the caller)
//   lakeFloor optional one-sided floor (lakes/floor.ts level → lakes/factors.ts lakeFloorFactor)
// Frame: the MapProblem frame (eye E, N, U in m). `eye0` is the GPS fix in that frame (usually [0, 0, ·]);
// `zDatum` is the absolute altitude of U = 0 (m), so an absolute altitude a maps to U = a − zDatum.
// "hAcc into the priors" was already true for refine / concord / pose6dof (plan §0); this is the geocam
// adapter only and claims no accuracy gain by itself.
import { EYE_PRIOR_DEFAULTS } from "../../concord/priors/altitude";
import type { PhotoMeta } from "../../photos";
import type { Factor, Vec3 } from "../core";
import { lakeFloorFactor } from "../lakes/factors";
import {
	altFactor,
	compassFactor,
	focalFactor,
	gpsFactor,
	gravityFactor,
	groundFactor,
} from "../map/factors";
import { priorHeading } from "./heading";

type LocalFlags = {
	yawUnknown?: boolean;
	pitchRollUnknown?: boolean;
	positionSource?: string;
	headingRef?: string | null;
};

export type PriorPhoto = Pick<
	PhotoMeta,
	| "lat"
	| "lon"
	| "alt"
	| "hAccuracy"
	| "heading"
	| "pitch"
	| "roll"
	| "gravity"
	| "takenAt"
	| "takenAtUtc"
> & { local?: LocalFlags };

export type PhotoPriorOpts = {
	/** Absolute altitude of U = 0 (m). Default 0 (U absolute). */
	zDatum?: number;
	/** Apply declination to magnetic headings. Default true (the solver wants TRUE north). */
	declination?: boolean;
	/** Families to leave out. */
	skip?: readonly ("gps" | "alt" | "ground" | "gravity" | "compass")[];
	/** Focal prior at the 1600 basis. */
	focal?: { f0Px1600: number; fPx1600: number; sigmaPx1600: number };
	/** Absolute lake floor (lakes/floor.ts lakeFloor), m. */
	lakeFloorM?: number | null;
	compass?: Parameters<typeof compassFactor>[1];
	gravitySigmaDeg?: number;
};

/** EyePrior's σH rule (concord/priors/altitude.ts): clamp(hAcc ?? 20, 5, 100). */
export function sigmaHFromHAcc(hAcc: number | null | undefined): number {
	const D = EYE_PRIOR_DEFAULTS;
	const h =
		hAcc != null && Number.isFinite(hAcc) && hAcc > 0 ? hAcc : D.hAccDefault;
	return Math.min(D.hAccMax, Math.max(D.hAccMin, h));
}

export function mapPriorsFromPhoto(
	photo: PriorPhoto,
	eye0: Vec3,
	ground?: ((e: number, n: number) => number) | null,
	o: PhotoPriorOpts = {},
): Factor[] {
	const skip = new Set(o.skip ?? []);
	const zDatum = o.zDatum ?? 0;
	const pinned = photo.local?.positionSource === "pin";
	const out: Factor[] = [];
	if (!skip.has("gps") && !pinned)
		out.push(gpsFactor(eye0[0], eye0[1], sigmaHFromHAcc(photo.hAccuracy)));
	if (
		!skip.has("alt") &&
		!pinned &&
		photo.alt != null &&
		Number.isFinite(photo.alt)
	)
		out.push(altFactor(photo.alt - zDatum));
	if (!skip.has("ground") && ground)
		out.push(groundFactor((e, n) => ground(e, n) - zDatum));
	if (
		!skip.has("gravity") &&
		photo.gravity != null &&
		!photo.local?.pitchRollUnknown &&
		Number.isFinite(photo.pitch) &&
		Number.isFinite(photo.roll)
	)
		out.push(gravityFactor(photo.pitch, photo.roll, o.gravitySigmaDeg));
	const heading = priorHeading(photo, o.declination ?? true);
	if (!skip.has("compass") && heading != null && !photo.local?.yawUnknown)
		out.push(compassFactor(heading, o.compass));
	if (o.focal)
		out.push(
			focalFactor(o.focal.f0Px1600, o.focal.fPx1600, o.focal.sigmaPx1600),
		);
	if (o.lakeFloorM != null && Number.isFinite(o.lakeFloorM))
		// lakeFloorFactor adds its own margin to a LEVEL: pass the floor with margin 0
		out.push(lakeFloorFactor(o.lakeFloorM - zDatum, { marginM: 0 }));
	return out;
}

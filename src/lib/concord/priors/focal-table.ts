// Per-LensModel focal prior (WP-B): replaces the rounded EXIF FocalLengthIn35mmFormat focal with a
// calibrated mean and a tight σ. The app's convention throughout: f35 over the 35 mm DIAGONAL
// (camera/focal.ts focalPxFromF35, FF35_DIAGONAL_MM), so fScale = f_true / focalPxFromF35(f35, …).
//
// Fitted on DEV photos only (frozen split, tools/concord/pins/PROTOCOL.txt) by
// scripts/concord/priors-study.ts focal (removed 2026-09-30, recoverable from a1845f5); evidence and
// holdout score in tools/concord/priors/RESULT.txt.
import { focalPxFromF35, type PixelSize } from "../../camera/focal";

export type LensEntry = {
	match: RegExp;
	fScale: number;
	sigma: number;
	k1?: { value: number; sigma: number };
	// ---- additive (not in the frozen plan type)
	/** Only for this EXIF FocalLengthIn35mmFormat (e.g. the main lens at its native 26, not digital zoom). */
	f35?: number;
	/** Photos the entry was fitted on (DEV only) and where the numbers come from. */
	evidence?: string;
};

/** Fallback when no entry matches: EXIF focal, ±2 %. */
export const DEFAULT_LENS: LensEntry = {
	match: /.*/,
	fScale: 1,
	sigma: 0.02,
	evidence: "no calibration: EXIF 35 mm focal (rounded to 1 mm) ±2 %",
};

/** First match wins. */
export const LENS_TABLE: LensEntry[] = [
	{
		// iPhone 11 Pro main (wide) camera at its native 26 mm: f solved from pins on 5 DEV photos
		// (IMG_6971 3096.7, 7018 3064.5, 7033 3100.9, 7053 3057.1, 7131 3085.9 px @4032) vs EXIF 3028.7:
		// mean ×1.0173, SD 0.0064 (SE 0.0029). The +1.7 % is not the 26 mm rounding alone (the physical
		// 4.25 mm / 1.4 µm gives 3036): it includes the ISP's distortion-correction crop.
		match: /iPhone 11 Pro back triple camera 4\.25mm/,
		f35: 26,
		fScale: 1.0173,
		sigma: 0.0064,
		evidence:
			"DEV pin solves n=5 (6971, 7018, 7033, 7053, 7131): mean 1.0173, SD 0.0064",
	},
	{
		// The same main camera with digital zoom (EXIF f35 ≠ 26, e.g. 48 on IMG_6958): the crop keeps the
		// ISP bias, but the EXIF f35 is rounded to 1 mm of a zoomed value (≤ ±1 % at 48 mm). No DEV evidence.
		match: /iPhone 11 Pro back triple camera 4\.25mm/,
		fScale: 1.0173,
		sigma: 0.015,
		evidence:
			"no DEV photo; main-lens bias carried over, σ widened for the zoomed f35 rounding",
	},
	{
		// iPhone 11 Pro ultra wide (13 mm): ×1.063 is the free-focal pure-rotation fit of IMG_7059 against
		// IMG_7063 (tools/nearfield/eyes/REPORT.txt; both DEV), and the skyline focal profile of 7059 at the GT
		// eye gives ×1.061 (priors-study focal). Conflicting DEV evidence: a free pin fit on 7059's three
		// 2–5 km summits gives ×0.948 (GPS eye ±37 m moves 2 km summits by ~1°), so σ is wide.
		match: /iPhone 11 Pro back triple camera 1\.54mm/,
		fScale: 1.063,
		sigma: 0.04,
		evidence:
			"DEV IMG_7059 only: ×1.063 (7059/7063 match fit), ×1.061 (skyline profile); pin fit ×0.948 disagrees; σ 4 %",
	},
];

/** The table entry for a lens (first match, honouring `f35` when the entry sets it), else DEFAULT_LENS. */
export function lensEntry(
	lensModel: string | undefined,
	f35?: number,
): LensEntry {
	if (!lensModel) return DEFAULT_LENS;
	for (const e of LENS_TABLE) {
		if (!e.match.test(lensModel)) continue;
		if (e.f35 !== undefined && f35 !== undefined && e.f35 !== f35) continue;
		if (e.f35 !== undefined && f35 === undefined) continue;
		return e;
	}
	return DEFAULT_LENS;
}

/**
 * Focal prior (px of `px`, the image the camera model uses) for a photo: mean = the crop-aware EXIF focal
 * (camera/focal.ts focalPxFromF35) × the table's fScale, 1σ = mean × sigma. `sensor` / `source` are passed
 * through to focalPxFromF35 (crop detection); omitted ⇒ the uncropped expression.
 */
export function focalPrior(
	lensModel: string | undefined,
	f35: number,
	px: PixelSize,
	sensor?: Partial<PixelSize> | null,
	source?: PixelSize,
): { fPx: number; sigmaPx: number; fScale: number; entry: LensEntry } {
	const entry = lensEntry(lensModel, f35);
	const fExif = focalPxFromF35(f35, px, sensor, source);
	const fPx = fExif * entry.fScale;
	return { fPx, sigmaPx: fPx * entry.sigma, fScale: entry.fScale, entry };
}

/**
 * Best-effort LensModel for metadata that has only the camera Model and the 35 mm focal (geo/photo-meta.ts
 * PhotoMeta has `model` and `focal35` but no LensModel). iPhone 11 Pro only; undefined ⇒ DEFAULT_LENS.
 * Prefer the real EXIF LensModel when the ingest provides it.
 */
export function lensModelFromCamera(
	model: string | undefined,
	f35: number | undefined,
): string | undefined {
	if (model !== "iPhone 11 Pro" || !f35) return undefined;
	if (f35 <= 14) return "iPhone 11 Pro back triple camera 1.54mm f/2.4";
	if (f35 >= 50) return undefined; // telephoto 6 mm (or zoom beyond it): no calibration
	return "iPhone 11 Pro back triple camera 4.25mm f/1.8";
}

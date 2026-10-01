// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// L0: quantities. Soft-branded numbers: a plain `number` is assignable to any of them (adoption is free),
// but two different units never mix (`Deg` → `Metres` is a type error). Arithmetic yields `number`, which
// is assignable back, so `const d: Deg = a + b` compiles: the brand documents and guards *interfaces*, it
// does not try to be a units algebra.
//
// Missing values: the canonical "unknown" is `null` (JSON-safe, survives postMessage and storage).
// `undefined` means "field not supplied" (optional input); NaN and sentinels (−89, −32768) are internal
// to the kernels that use them and must not cross a module boundary. See MISSING below.

declare const unit: unique symbol;
/** A number carrying a phantom unit tag `U`. */
export type Quantity<U extends string> = number & { readonly [unit]?: U };

/** Angle in degrees. Rigi's public angles are always degrees. */
export type Deg = Quantity<"deg">;
/** Angle in radians (kernel-internal; convert at the boundary with DEG). */
export type Rad = Quantity<"rad">;
/** Length in metres (a distance; also accepts any datum-tagged Height). */
export type Metres = Quantity<"m" | `m:${HeightDatum}`>;
/** A height above datum `D`. Heights on different datums never mix; a bare distance isn't a height. */
export type Height<D extends HeightDatum = HeightDatum> = Quantity<`m:${D}`>;
/** Pixels on basis `B` (see PixelBasis). Px<"wide1600"> and Px<"long1600"> never mix. */
export type Px<B extends PixelBasis = PixelBasis> = Quantity<`px:${B}`>;
/** Normalised image coordinate 0..1 (u right, v down, origin top-left). */
export type Norm = Quantity<"norm">;
/** Probability / unit score 0..1. */
export type Prob = Quantity<"prob">;
/** Duration in milliseconds. */
export type Millis = Quantity<"ms">;
/** Duration in seconds. */
export type Seconds = Quantity<"s">;
/** ISO-8601 instant, UTC ("2026-09-30T12:00:00Z"). */
export type IsoTime = string & { readonly [unit]?: "iso-time" };

export const DEG = Math.PI / 180;

/** Vertical datum of a height. */
export type HeightDatum =
	/** orthometric, ≈ EGM2008: the DEM (Mapterhorn), OSM `ele`, phone GPS altitude */
	| "msl"
	/** WGS84 ellipsoidal: ECEF, Google 3D Tiles */
	| "ellipsoid"
	/** above the DEM surface (eye height rule: DEM + EYE_ABOVE_GROUND) */
	| "ground";

/** Which pixel grid a pixel coordinate or residual is measured on. */
export type PixelBasis =
	/** normalised 0..1, v down (camera/, pose6dof/, align, Pin, Correspondence) */
	| "norm"
	/** the image's own working size (geo/*, refine) */
	| "work"
	/** 1600 px on the LONG side (geocam, peakfix) */
	| "long1600"
	/** 1600 px WIDE (concord InteriorPin, refine rmsPx1600) */
	| "wide1600"
	/** 1000 px wide (picker tap tolerance) */
	| "wide1000";

export const PIXEL_BASES: Record<
	PixelBasis,
	{ readonly side: "none" | "own" | "long" | "width"; readonly px: number }
> = {
	norm: { side: "none", px: 1 },
	work: { side: "own", px: 0 },
	long1600: { side: "long", px: 1600 },
	wide1600: { side: "width", px: 1600 },
	wide1000: { side: "width", px: 1000 },
};

/** Pixels per normalised unit (horizontal) for `basis` on an image of `size`. */
export function pxPerNorm(
	basis: PixelBasis,
	size: { width: number; height: number },
): number {
	const b = PIXEL_BASES[basis];
	switch (b.side) {
		case "none":
			return 1;
		case "own":
			return size.width;
		case "width":
			return b.px;
		case "long":
			return (b.px * size.width) / Math.max(size.width, size.height);
	}
}

/** Re-express a pixel length (or a horizontal coordinate) measured on basis `from` on basis `to`. */
export function rebasePx(
	v: number,
	from: PixelBasis,
	to: PixelBasis,
	size: { width: number; height: number },
): number {
	return (v / pxPerNorm(from, size)) * pxPerNorm(to, size);
}

/** How "no value" is written, by layer. */
export const MISSING = {
	/** stored / wire / public types */
	public: "null",
	/** optional inputs */
	input: "undefined",
	/** kernel-internal only, never across a module boundary */
	kernel: ["NaN", "-89 horizon el", "-32768 DEM nodata"],
} as const;

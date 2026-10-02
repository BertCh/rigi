// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// L1: geometric primitives and frames. Pure types plus a few converters that make an implicit
// convention explicit (bbox order, lat/lon order). No three.js, no app imports.

import type {
	Deg,
	Height,
	HeightDatum,
	Norm,
	PixelBasis,
	Px,
} from "./quantity";

/** 3-vector. ENU (x=E, y=N, z=Up) unless the owner says otherwise. The one canonical tuple. */
export type Vec3 = [number, number, number];
/** 3×3 matrix, row-major: [r00, r01, r02, r10, ...]. */
export type Mat3 = [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

/** Row-major 3×3 as a Float64Array(9): the typed-array form for hot loops (the tuple type is Mat3). */
export type Mat3F64 = Float64Array;

/** Image size in pixels (always `width`/`height`, never w/h/W/H in public types). */
export type Size = { width: number; height: number };

/**
 * One byte per pixel, row-major, row 0 = TOP of the image. What a byte means (sky, foreground person,
 * occluder) belongs to the field or type that holds the mask, e.g. ForegroundMask (255 = person).
 */
export type ByteMask = Size & { data: Uint8Array };

/** Horizontal WGS84 position. Argument order in Rigi is always (lat, lon) unless a name says lon-first. */
export type LatLon = { lat: Deg; lon: Deg };

/** A geodetic point with an explicit vertical datum. `h: null` = height unknown. */
export type GeoPoint<D extends HeightDatum = HeightDatum> = LatLon & {
	h: Height<D> | null;
	datum: D;
};

/** Local tangent frames used in Rigi. Two ENU frames exist and are NOT interchangeable. */
export type FrameId =
	| "wgs84"
	| "ecef"
	/** engine ENU: origin (photo.lat, photo.lon, h=0); z is absolute MSL height (engine.ts, pose6dof engineFrame) */
	| "enu-engine"
	/** camera ENU: origin at the eye; z is height above the eye (pose6dof cameraFrame, camera/) */
	| "enu-eye"
	/** camera axes: x right, y down, z forward (geo/camera Camera, OpenCV) */
	| "camera"
	/** image plane on a PixelBasis */
	| "image"
	/** azimuth (clockwise from TRUE north) / elevation (up +), degrees */
	| "azel"
	/** web-mercator slippy tile z/x/y */
	| "tile";

declare const frame: unique symbol;
/** A point in a named frame. The frame is a phantom tag so ENU-engine and ENU-eye don't mix. */
export type FramePoint<F extends FrameId> = Vec3 & { readonly [frame]?: F };
export type EnuEnginePoint = FramePoint<"enu-engine">;
export type EnuEyePoint = FramePoint<"enu-eye">;
export type EcefPoint = FramePoint<"ecef">;

/** Direction from an eye: azimuth clockwise from true north, elevation up +, degrees. */
export type Direction = { az: Deg; el: Deg };

/** A point on the image. Normalised (u,v ∈ 0..1, v down) unless `basis` says pixels. */
export type ImagePoint<B extends PixelBasis = "norm"> = B extends "norm"
	? { u: Norm; v: Norm }
	: { x: Px<B>; y: Px<B>; basis: B };

/** Canonical bbox: named fields, so order can't be confused. */
export type BBox = { west: Deg; south: Deg; east: Deg; north: Deg };

/** [west, south, east, north] (GeoJSON / licences attribution order). */
export type WSEN = [number, number, number, number];
/** [south, west, north, east] (Overpass order; upload/region bboxAround). */
export type SWNE = [number, number, number, number];

export const bboxFromWSEN = ([west, south, east, north]: WSEN): BBox => ({
	west,
	south,
	east,
	north,
});
export const bboxFromSWNE = ([south, west, north, east]: SWNE): BBox => ({
	west,
	south,
	east,
	north,
});
export const bboxToWSEN = (b: BBox): WSEN => [b.west, b.south, b.east, b.north];
export const bboxToSWNE = (b: BBox): SWNE => [b.south, b.west, b.north, b.east];
export const bboxContains = (b: BBox, p: LatLon) =>
	p.lat >= b.south && p.lat <= b.north && p.lon >= b.west && p.lon <= b.east;

declare const order: unique symbol;
/** Lon-first pair ([lon, lat]: GeoJSON coordinates, lonLatToTile, RegionTrail.coords). Never mixes with LatLonPair. */
export type LonLatPair = [lon: number, lat: number] & {
	readonly [order]?: "lonlat";
};
/** Lat-first pair ([lat, lon]: RegionData.center). NB RegionTrail.coords are LON-first (ingest.mjs). */
export type LatLonPair = [lat: number, lon: number] & {
	readonly [order]?: "latlon";
};

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import exifr from "exifr";
import type { Vec3 } from "#/lib/ontology/core/geometry";
import { appleGravity } from "#/lib/upload/exif";

export type { Vec3 };

export interface ExifPhotoMeta {
	/**
	 * Actual stored pixel size (before EXIF orientation) when the caller passed it to
	 * readPhotoMeta; otherwise the EXIF size (ExifImageWidth/Height). Geometry uses this.
	 */
	width: number;
	height: number;
	/**
	 * EXIF ExifImageWidth/Height: the full sensor frame the 35 mm focal refers to. A photo
	 * cropped in iOS Photos keeps these at the sensor size while its pixels shrink.
	 */
	sensorWidth?: number;
	sensorHeight?: number;
	/** EXIF Orientation tag; 6 = portrait (sensor rotated 90° CW for display). */
	orientation: number;
	takenAt?: string;
	model?: string;
	lat?: number;
	lon?: number;
	/** Metres above MSL (EGM2008 on iOS). */
	altitude?: number;
	/** GPS horizontal error, metres. */
	gpsError?: number;
	/** Camera heading, degrees clockwise from true north. */
	heading?: number;
	headingRef?: string;
	focal35?: number;
	digitalZoom?: number;
	/** Apple MakerNote AccelerationVector (units of g, phone frame). */
	gravity?: Vec3;
}

/**
 * Apple MakerNote tag 0x0008, AccelerationVector (units of g, phone frame), through the upload
 * path's parser (src/lib/upload/exif.ts appleGravity: either byte order, bounds-checked offsets, and
 * undefined for a non-finite or implausible vector, |g| outside 0.5–2 g).
 */
export function parseAppleGravity(makerNote: Uint8Array): Vec3 | undefined {
	const g = appleGravity(makerNote);
	return g ? [g[0], g[1], g[2]] : undefined;
}

/**
 * EXIF prior of a photo. `pixels` is the file's actual full-resolution pixel size (e.g. sips
 * pixelWidth/Height, or a decoded image; either orientation, it is matched to the EXIF frame).
 * Without it width/height fall back to the EXIF size, which is wrong for a cropped photo.
 */
export async function readPhotoMeta(
	input: string | ArrayBuffer | Uint8Array | Blob,
	pixels?: { width: number; height: number },
): Promise<ExifPhotoMeta> {
	const d = await exifr.parse(input, {
		gps: true,
		makerNote: true,
		mergeOutput: true,
		translateValues: false,
	});
	if (!d) throw new Error("No EXIF metadata");
	const sw: number | undefined = d.ExifImageWidth;
	const sh: number | undefined = d.ExifImageHeight;
	let size = { width: sw as number, height: sh as number };
	if (pixels) {
		// same frame orientation as the EXIF size (both are stored, pre-rotation sizes)
		const flip =
			sw !== undefined &&
			sh !== undefined &&
			sw > sh !== pixels.width > pixels.height;
		size = flip
			? { width: pixels.height, height: pixels.width }
			: { width: pixels.width, height: pixels.height };
	}
	return {
		...size,
		sensorWidth: sw,
		sensorHeight: sh,
		orientation: d.Orientation ?? 1,
		takenAt: d.DateTimeOriginal?.toISOString?.(),
		model: d.Model,
		lat: d.latitude,
		lon: d.longitude,
		altitude:
			d.GPSAltitude === undefined
				? undefined
				: d.GPSAltitudeRef?.[0] === 1
					? -d.GPSAltitude
					: d.GPSAltitude,
		gpsError: d.GPSHPositioningError,
		heading: d.GPSImgDirection,
		headingRef: d.GPSImgDirectionRef,
		focal35: d.FocalLengthIn35mmFormat,
		digitalZoom: d.DigitalZoomRatio,
		gravity:
			d.makerNote instanceof Uint8Array
				? parseAppleGravity(d.makerNote)
				: undefined,
	};
}

/**
 * `meta` with width/height set from a full-resolution *displayed* (EXIF-oriented) size, e.g. an
 * <img> naturalWidth/Height of the original file. Lets cameraFromMeta see a crop.
 */
export function withDisplayPixels(
	meta: ExifPhotoMeta,
	width: number,
	height: number,
): ExifPhotoMeta {
	const swap = meta.orientation >= 5;
	return swap
		? { ...meta, width: height, height: width }
		: { ...meta, width, height };
}

// EXIF → camera prior, ported from scripts/ingest.mjs so browser uploads get exactly the same
// PhotoMeta as ingested photos. Pure functions (no DOM), so this runs in node for the tests too.
//
// Pose convention (src/lib/pose.ts): yaw = true heading clockwise from north, pitch up +,
// roll right-side-down +, vfov = vertical FOV of the displayed (upright) image, degrees.
import exifr from "exifr";
import { focalPxFromF35, type PixelSize } from "../camera/focal";
import type { PhotoMeta } from "../photos";

/** Long-side cap for stored JPEGs, as in ingest.mjs (sips -Z 2048). */
export const MAX_PX = 2048;
/** Default 35 mm-equivalent focal length when EXIF lacks it (iPhone main camera). */
export const DEFAULT_F35 = 26;

export type Holding =
	| "landscape-left"
	| "landscape-right"
	| "portrait"
	| "portrait-upside";

/** Extra fields local uploads carry on top of PhotoMeta. */
export type LocalPhotoExtras = {
	/** Heading missing from EXIF: the solver should run a full 360° yaw search. */
	yawUnknown: boolean;
	/** No Apple gravity vector: pitch/roll are 0 placeholders and the solver must free them (wide pitch search). */
	pitchRollUnknown: boolean;
	/** No 35 mm-equivalent focal in EXIF: f35/vfov are the iPhone-main-camera default and the solver should free focal. */
	focalUnknown: boolean;
	/** Where lat/lon came from: EXIF GPS, or a pin the user placed on the map. */
	positionSource: "exif" | "pin";
	/**
	 * Where the capture time came from. 'exif-local': DateTimeOriginal with no OffsetTime and no
	 * GPS time, i.e. camera-local wall-clock time in an unknown zone. takenAt then uses a zone
	 * guessed from the longitude (tzEstimated), so it can be off by an hour or more.
	 */
	timeSource: "gps" | "exif" | "exif-local" | "file";
	/** tzOffset is a guess (round(lon / 15) h), not from the file. */
	tzEstimated?: boolean;
	/** GPSImgDirectionRef: 'T' true north (iPhone default), 'M' magnetic, or null. */
	headingRef: string | null;
	/** Original file name and MIME type, for display. */
	fileName: string;
	fileType: string;
	/** Size of the original upload in bytes. */
	fileBytes: number;
	/** Unix ms when the upload was stored. */
	addedAt: number;
};

export type LocalPhotoMeta = PhotoMeta & { local: LocalPhotoExtras };

/** EXIF fields we read (a subset of exifr's merged output with translateValues: false). */
export type ExifTags = {
	latitude?: number;
	longitude?: number;
	GPSAltitude?: number;
	GPSAltitudeRef?: number | Uint8Array | number[];
	GPSHPositioningError?: number;
	GPSImgDirection?: number;
	GPSImgDirectionRef?: string;
	FocalLengthIn35mmFormat?: number;
	Orientation?: number;
	ExifImageWidth?: number;
	ExifImageHeight?: number;
	Make?: string;
	Model?: string;
	makerNote?: Uint8Array;
};

/** Raw (reviveValues: false) EXIF strings for the capture instant. */
export type RawTimeTags = {
	GPSDateStamp?: string;
	GPSTimeStamp?: number[];
	DateTimeOriginal?: string;
	OffsetTimeOriginal?: string;
	OffsetTime?: string;
};

type Input = ArrayBuffer | Uint8Array | Blob | string;

/** Read both EXIF views ingest.mjs uses: translated values + makerNote, and raw time strings. */
export async function readExif(
	input: Input,
): Promise<{ tags: ExifTags; raw: RawTimeTags }> {
	const [tags, raw] = await Promise.all([
		exifr
			.parse(input as never, {
				makerNote: true,
				gps: true,
				exif: true,
				tiff: true,
				translateValues: false,
			})
			.catch(() => undefined),
		exifr
			.parse(input as never, { reviveValues: false, gps: true, exif: true })
			.catch(() => undefined),
	]);
	return { tags: (tags ?? {}) as ExifTags, raw: (raw ?? {}) as RawTimeTags };
}

/**
 * Parse the "Apple iOS" MakerNote IFD and return { tag: values } for its (S)RATIONAL tags.
 * Faithful port of ingest.mjs parseAppleMakerNote (DataView instead of Buffer).
 */
export function parseAppleMakerNote(buf: Uint8Array): Record<number, number[]> {
	const latin = (a: number, b: number) =>
		String.fromCharCode(...buf.subarray(a, b));
	if (buf.length < 16 || latin(0, 9) !== "Apple iOS") return {};
	const le = latin(12, 14) === "II";
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const u16 = (o: number) => dv.getUint16(o, le);
	const u32 = (o: number) => dv.getUint32(o, le);
	const i32 = (o: number) => dv.getInt32(o, le);
	const n = u16(14);
	const out: Record<number, number[]> = {};
	for (let i = 0; i < n; i++) {
		const e = 16 + i * 12;
		if (e + 12 > buf.length) break;
		const tag = u16(e);
		const type = u16(e + 2);
		const count = u32(e + 4);
		const valOff = u32(e + 8);
		if (type === 10 || type === 5) {
			// (S)RATIONAL: always stored at an offset relative to the MakerNote start
			if (valOff + count * 8 > buf.length) continue;
			const vals: number[] = [];
			for (let k = 0; k < count; k++) {
				const o = valOff + k * 8;
				const num = type === 10 ? i32(o) : u32(o);
				const den = type === 10 ? i32(o + 4) : u32(o + 4);
				vals.push(den ? num / den : 0);
			}
			out[tag] = vals;
		}
	}
	return out;
}

/** Apple MakerNote tag 0x0008 AccelerationVector (units of g, CoreMotion device frame). */
export function appleGravity(
	makerNote: Uint8Array | undefined | null,
): number[] | null {
	if (!makerNote) return null;
	const g = parseAppleMakerNote(makerNote)[0x0008];
	return g && g.length === 3 ? g : null;
}

type V3 = [number, number, number];
const CANDIDATES: { name: Holding; right: V3; up: V3 }[] = [
	{ name: "landscape-left", right: [0, 1, 0], up: [-1, 0, 0] },
	{ name: "landscape-right", right: [0, -1, 0], up: [1, 0, 0] },
	{ name: "portrait", right: [1, 0, 0], up: [0, 1, 0] },
	{ name: "portrait-upside", right: [-1, 0, 0], up: [0, -1, 0] },
];

/**
 * Camera rotation prior from the device gravity vector (port of ingest.mjs).
 * CoreMotion device frame: +x right (portrait), +y up (portrait top), +z out of screen; the
 * rear camera looks along -z. The holding orientation is chosen among those matching the
 * displayed aspect as the one whose image-down best matches gravity.
 */
export function orientationFromGravity(
	g: number[] | null,
	width: number,
	height: number,
) {
	if (!g) return null;
	const [gx, gy, gz] = g;
	const norm = Math.hypot(gx, gy, gz) || 1;
	const d: V3 = [gx / norm, gy / norm, gz / norm];
	const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const displayLandscape = width >= height;
	let best: (typeof CANDIDATES)[number] | null = null;
	let bestDown = Number.NEGATIVE_INFINITY;
	for (const c of CANDIDATES) {
		if (c.name.startsWith("landscape") !== displayLandscape) continue;
		const downDot = -dot(c.up, d);
		if (downDot > bestDown) {
			best = c;
			bestDown = downDot;
		}
	}
	if (!best) return null;
	const fwd: V3 = [0, 0, -1];
	const pitch =
		(Math.asin(Math.max(-1, Math.min(1, -dot(fwd, d)))) * 180) / Math.PI;
	const roll =
		(Math.atan2(dot(best.right, d), -dot(best.up, d)) * 180) / Math.PI;
	return { pitch, roll, holding: best.name };
}

/**
 * Vertical FOV from the 35 mm-equivalent focal length on the diagonal (ingest.mjs). `sensor`
 * (ExifImageWidth/Height) and `source` (full-resolution decoded size, any orientation) make it
 * crop-aware: see camera/focal.ts focalPxFromF35. Without them it is the historical formula.
 */
export function vfovFromF35(
	f35: number,
	width: number,
	height: number,
	sensor?: Partial<PixelSize> | null,
	source?: PixelSize,
) {
	const fPx = focalPxFromF35(f35, { width, height }, sensor, source);
	return (2 * Math.atan(height / 2 / fPx) * 180) / Math.PI;
}

/** Displayed (upright) size after applying EXIF orientation and the MAX_PX cap. */
export function outputSize(
	width: number,
	height: number,
	exifOrientation = 1,
	maxPx = MAX_PX,
) {
	const swap = exifOrientation >= 5 && exifOrientation <= 8;
	const w = swap ? height : width;
	const h = swap ? width : height;
	const s = Math.min(1, maxPx / Math.max(w, h));
	return { width: Math.round(w * s), height: Math.round(h * s) };
}

/**
 * Capture instant as a UTC ISO string: GPS date+time (UTC) first, else DateTimeOriginal +
 * OffsetTimeOriginal (port of ingest.mjs captureTime; raw strings avoid local-zone revival).
 */
export function captureTime(raw: RawTimeTags): {
	utc: string | null;
	offset: string | null;
	source: "gps" | "exif" | "exif-local" | null;
} {
	const offset = raw.OffsetTimeOriginal ?? raw.OffsetTime ?? null;
	if (raw.GPSDateStamp && Array.isArray(raw.GPSTimeStamp)) {
		const [Y, M, D] = raw.GPSDateStamp.split(":").map(Number);
		const [h, m, sec] = raw.GPSTimeStamp;
		const ms = Date.UTC(
			Y,
			M - 1,
			D,
			h,
			m,
			Math.floor(sec),
			Math.round((sec % 1) * 1000),
		);
		if (Number.isFinite(ms))
			return { utc: new Date(ms).toISOString(), offset, source: "gps" };
	}
	if (raw.DateTimeOriginal) {
		const [d, t] = raw.DateTimeOriginal.split(" ");
		const date = new Date(`${d.replaceAll(":", "-")}T${t}${offset ?? "Z"}`);
		// no offset: ingest.mjs reads it as UTC; flag it so callers can correct / warn
		if (!Number.isNaN(date.getTime()))
			return {
				utc: date.toISOString(),
				offset,
				source: offset ? "exif" : "exif-local",
			};
	}
	return { utc: null, offset, source: null };
}

/** Rough zone for a longitude: round(lon / 15) hours, as '+01:00'. Ignores political zones and DST. */
export function offsetFromLongitude(lon: number) {
	const h = Math.max(-12, Math.min(14, Math.round(lon / 15)));
	return `${h < 0 ? "-" : "+"}${String(Math.abs(h)).padStart(2, "0")}:00`;
}

function altitudeOf(t: ExifTags): number | null {
	if (typeof t.GPSAltitude !== "number" || !Number.isFinite(t.GPSAltitude))
		return null;
	const ref = t.GPSAltitudeRef;
	const r = typeof ref === "number" ? ref : ref ? ref[0] : 0;
	return r === 1 ? -t.GPSAltitude : t.GPSAltitude;
}

const finite = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);

export type BuildOptions = {
	id: string;
	/** Displayed pixel size of the stored JPEG (after orientation and resize). */
	width: number;
	height: number;
	/**
	 * Full-resolution decoded size before the MAX_PX resize (any orientation). Compared with
	 * ExifImageWidth/Height to detect a crop (e.g. iOS Photos); defaults to width × height.
	 */
	sourceWidth?: number;
	sourceHeight?: number;
	src?: string;
	region?: string;
	/** Fallback capture time (e.g. File.lastModified) when EXIF has none. */
	fallbackTime?: number;
	/** Position override (map pin). Used when EXIF GPS is missing or the user moved the pin. */
	position?: { lat: number; lon: number } | null;
	file?: { name: string; type: string; bytes: number };
};

/** Assemble a PhotoMeta exactly as ingest.mjs would, plus the `local` extras. */
export function buildPhotoMeta(
	tags: ExifTags,
	raw: RawTimeTags,
	o: BuildOptions,
): LocalPhotoMeta {
	const { width: w, height: h } = o;
	const gravity = appleGravity(tags.makerNote);
	const f35 =
		finite(tags.FocalLengthIn35mmFormat) && tags.FocalLengthIn35mmFormat > 0
			? tags.FocalLengthIn35mmFormat
			: DEFAULT_F35;
	const sensor = { width: tags.ExifImageWidth, height: tags.ExifImageHeight };
	const source =
		finite(o.sourceWidth) && finite(o.sourceHeight)
			? { width: o.sourceWidth, height: o.sourceHeight }
			: undefined;
	const vfov = vfovFromF35(f35, w, h, sensor, source);
	const orient = orientationFromGravity(gravity, w, h);
	const time = captureTime(raw);
	const hasGps = finite(tags.latitude) && finite(tags.longitude);
	const pos =
		o.position ??
		(hasGps
			? { lat: tags.latitude as number, lon: tags.longitude as number }
			: null);
	const fromPin = !!o.position || !hasGps;
	const heading = finite(tags.GPSImgDirection) ? tags.GPSImgDirection : null;
	let takenAt =
		time.utc ?? new Date(o.fallbackTime ?? Date.now()).toISOString();
	let tzOffset = time.offset;
	let tzEstimated = false;
	// zone-less wall-clock time: shift from "read as UTC" by a longitude-based zone guess
	if (
		time.source === "exif-local" &&
		time.utc &&
		pos &&
		Number.isFinite(pos.lon)
	) {
		tzOffset = offsetFromLongitude(pos.lon);
		const h = Number(tzOffset.slice(0, 3));
		takenAt = new Date(Date.parse(time.utc) - h * 3600_000).toISOString();
		tzEstimated = true;
	}
	return {
		id: o.id,
		src: o.src ?? "",
		width: w,
		height: h,
		takenAt,
		takenAtUtc: takenAt,
		tzOffset,
		lat: pos?.lat ?? Number.NaN,
		lon: pos?.lon ?? Number.NaN,
		// a pinned position has no trustworthy altitude/accuracy: let the engine snap to the DEM
		alt: fromPin ? null : altitudeOf(tags),
		hAccuracy: fromPin
			? null
			: finite(tags.GPSHPositioningError)
				? tags.GPSHPositioningError
				: null,
		heading,
		f35,
		vfov,
		gravity,
		pitch: orient?.pitch ?? 0,
		roll: orient?.roll ?? 0,
		holding: orient?.holding ?? null,
		region: o.region ?? "",
		local: {
			yawUnknown: heading == null,
			pitchRollUnknown: gravity == null,
			focalUnknown: !(
				finite(tags.FocalLengthIn35mmFormat) && tags.FocalLengthIn35mmFormat > 0
			),
			positionSource: fromPin ? "pin" : "exif",
			timeSource: time.source ?? "file",
			...(tzEstimated ? { tzEstimated } : {}),
			headingRef: tags.GPSImgDirectionRef ?? null,
			fileName: o.file?.name ?? "",
			fileType: o.file?.type ?? "",
			fileBytes: o.file?.bytes ?? 0,
			addedAt: Date.now(),
		},
	};
}

/** Quick diagnostics for the UI: what the file told us and what is missing. */
export function exifDiagnostics(tags: ExifTags, raw?: RawTimeTags) {
	const gravity = appleGravity(tags.makerNote);
	return {
		hasExif: Object.keys(tags).length > 0,
		hasGps: finite(tags.latitude) && finite(tags.longitude),
		hasHeading: finite(tags.GPSImgDirection),
		hasGravity: !!gravity,
		hasF35: finite(tags.FocalLengthIn35mmFormat),
		isApple: /apple/i.test(tags.Make ?? ""),
		model: tags.Model ?? null,
		headingMagnetic: tags.GPSImgDirectionRef === "M",
		/** DateTimeOriginal without OffsetTime* and without GPS time: zone unknown. */
		zonelessTime: raw ? captureTime(raw).source === "exif-local" : false,
		gpsAccuracy: finite(tags.GPSHPositioningError)
			? tags.GPSHPositioningError
			: null,
	};
}

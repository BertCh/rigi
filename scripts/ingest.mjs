#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Ingest iPhone HEIC photos from img/ into public/photos/:
//   - converts to JPEG (macOS `sips`, max 2048px)
//   - extracts the camera prior: GPS, true-north heading, focal length, and the
//     Apple MakerNote gravity vector (tag 0x0008 AccelerationVector) → pitch/roll
//   - fetches OSM peaks + hiking paths around each photo region (Overpass)
// Usage: npm run ingest  (tsx: imports src/lib/overpass.ts)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import exifr from "exifr";
import { focalPxFromF35, isCropped } from "../src/lib/camera/index.ts";
import { overpass as overpassApi } from "../src/lib/overpass.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const IMG_DIR = path.join(ROOT, "img");
const OUT_DIR = path.join(ROOT, "public", "photos");
const MAX_PX = 2048;
const PEAK_RADIUS_KM = 60;
const TRAIL_RADIUS_KM = 12;

fs.mkdirSync(OUT_DIR, { recursive: true });

/** Set EXIF Orientation (0x0112) to 1 in a JPEG in place — pixels are already rotated upright. */
function resetJpegOrientation(file) {
	const b = fs.readFileSync(file);
	let o = 2;
	while (o < b.length - 4 && b[o] === 0xff) {
		const marker = b[o + 1];
		const len = b.readUInt16BE(o + 2);
		if (marker === 0xe1 && b.toString("latin1", o + 4, o + 8) === "Exif") {
			const t = o + 10;
			const le = b.toString("latin1", t, t + 2) === "II";
			const u16 = (x) => (le ? b.readUInt16LE(x) : b.readUInt16BE(x));
			const u32 = (x) => (le ? b.readUInt32LE(x) : b.readUInt32BE(x));
			const ifd = t + u32(t + 4);
			const n = u16(ifd);
			for (let i = 0; i < n; i++) {
				const e = ifd + 2 + i * 12;
				if (u16(e) === 0x0112) {
					if (le) b.writeUInt16LE(1, e + 8);
					else b.writeUInt16BE(1, e + 8);
					fs.writeFileSync(file, b);
					return true;
				}
			}
			return false;
		}
		o += 2 + len;
	}
	return false;
}

/** Parse the "Apple iOS" MakerNote IFD and return { tag: value } for the tags we care about. */
function parseAppleMakerNote(buf) {
	const b = Buffer.from(buf);
	if (b.toString("latin1", 0, 9) !== "Apple iOS") return {};
	const le = b.toString("latin1", 12, 14) === "II";
	const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
	const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
	const i32 = (o) => (le ? b.readInt32LE(o) : b.readInt32BE(o));
	const n = u16(14);
	const out = {};
	for (let i = 0; i < n; i++) {
		const e = 16 + i * 12;
		const tag = u16(e);
		const type = u16(e + 2);
		const count = u32(e + 4);
		const valOff = u32(e + 8);
		if (type === 10 || type === 5) {
			// (S)RATIONAL — always stored at an offset relative to the MakerNote start
			const vals = [];
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

/**
 * Camera rotation prior from the device gravity vector.
 * CoreMotion device frame: +x right (portrait), +y up (portrait top), +z out of screen.
 * The rear camera looks along -z. Image axes depend on how the phone was held; we pick
 * the image "right" and "up" device axes from pixel aspect + EXIF orientation.
 */
function orientationFromGravity(g, width, height, exifOrientation) {
	if (!g) return null;
	const [gx, gy, gz] = g;
	const norm = Math.hypot(gx, gy, gz) || 1;
	const d = [gx / norm, gy / norm, gz / norm]; // gravity (points down) in device frame
	// Stored pixels for iPhone are always landscape sensor-native; EXIF orientation rotates for display.
	// Sensor-native (Orientation=1): image right = device -y, image up = device -x (home button right).
	// Rather than trust the tag, choose the holding orientation whose "down" best matches gravity.
	const candidates = [
		{ name: "landscape-left", right: [0, 1, 0], up: [-1, 0, 0] },
		{ name: "landscape-right", right: [0, -1, 0], up: [1, 0, 0] },
		{ name: "portrait", right: [1, 0, 0], up: [0, 1, 0] },
		{ name: "portrait-upside", right: [-1, 0, 0], up: [0, -1, 0] },
	];
	const displayLandscape = width >= height;
	let best = null;
	for (const c of candidates) {
		const isLandscape = c.name.startsWith("landscape");
		if (isLandscape !== displayLandscape) continue;
		const downDot = -(c.up[0] * d[0] + c.up[1] * d[1] + c.up[2] * d[2]);
		if (!best || downDot > best.downDot) best = { ...c, downDot };
	}
	const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const fwd = [0, 0, -1];
	// Pitch: elevation of the optical axis above horizon = angle between fwd and -gravity, minus 90°
	const pitch =
		(Math.asin(Math.max(-1, Math.min(1, -dot(fwd, d)))) * 180) / Math.PI;
	// Roll: rotation of image-right relative to the horizontal plane, about the optical axis
	const gRight = dot(best.right, d);
	const gUp = dot(best.up, d);
	const roll = (Math.atan2(gRight, -gUp) * 180) / Math.PI;
	return { pitch, roll, holding: best.name, exifOrientation };
}

/**
 * Capture time as a UTC ISO string. exifr's revived DateTimeOriginal is interpreted in the
 * *ingesting machine's* zone, so read the raw strings: GPS date+time (UTC) first, else
 * DateTimeOriginal + OffsetTimeOriginal.
 */
async function captureTime(src) {
	const raw = await exifr.parse(src, {
		reviveValues: false,
		gps: true,
		exif: true,
	});
	const offset = raw?.OffsetTimeOriginal ?? raw?.OffsetTime ?? null;
	if (raw?.GPSDateStamp && Array.isArray(raw.GPSTimeStamp)) {
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
		return { utc: new Date(ms).toISOString(), offset };
	}
	if (raw?.DateTimeOriginal) {
		const [d, t] = raw.DateTimeOriginal.split(" ");
		const iso = `${d.replaceAll(":", "-")}T${t}${offset ?? "Z"}`;
		return { utc: new Date(iso).toISOString(), offset };
	}
	return { utc: null, offset };
}

/** Stored pixel size of an image file (sips; HEIC/JPEG, before EXIF orientation). */
function pixelSize(file) {
	const info = execFileSync("sips", [
		"-g",
		"pixelWidth",
		"-g",
		"pixelHeight",
		file,
	]).toString();
	return {
		width: Number(info.match(/pixelWidth: (\d+)/)[1]),
		height: Number(info.match(/pixelHeight: (\d+)/)[1]),
	};
}

const overpass = (query) =>
	overpassApi(query, {
		endpoints: process.env.OVERPASS_URL
			? [process.env.OVERPASS_URL]
			: undefined,
		userAgent: "rigi-ingest/0.1 (+https://github.com/BertCh/rigi)",
		backoffMs: 5000,
	});

function bboxAround(lat, lon, km) {
	const dLat = km / 111.32;
	const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
	return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

async function main() {
	const files = fs
		.readdirSync(IMG_DIR)
		.filter((f) => /\.(heic|jpe?g)$/i.test(f))
		.sort();
	const photos = [];
	for (const f of files) {
		const id = path.parse(f).name;
		const src = path.join(IMG_DIR, f);
		const jpg = path.join(OUT_DIR, `${id}.jpg`);
		const ex = await exifr.parse(src, {
			makerNote: true,
			gps: true,
			exif: true,
			tiff: true,
			translateValues: false,
		});
		if (!fs.existsSync(jpg)) {
			// sips keeps sensor-native pixels and drops the Orientation tag, so bake the rotation in.
			const rot =
				{ 3: ["-r", "180"], 6: ["-r", "90"], 8: ["-r", "270"] }[
					ex.Orientation
				] ?? [];
			execFileSync(
				"sips",
				[
					"-s",
					"format",
					"jpeg",
					"-s",
					"formatOptions",
					"82",
					"-Z",
					String(MAX_PX),
					...rot,
					src,
					"--out",
					jpg,
				],
				{
					stdio: "ignore",
				},
			);
			resetJpegOrientation(jpg);
		}
		const { width: w, height: h } = pixelSize(jpg);
		// Photos-app crops keep ExifImageWidth/Height at the sensor size: compare with the source's
		// real pixels (orientation-agnostic) so the focal is taken at native pixel pitch.
		const native = pixelSize(src);
		const sensor = { width: ex.ExifImageWidth, height: ex.ExifImageHeight };
		const sameSize = (a, b) =>
			Math.max(a.width, a.height) === Math.max(b.width, b.height) &&
			Math.min(a.width, a.height) === Math.min(b.width, b.height);
		if (
			Number.isFinite(sensor.width) &&
			Number.isFinite(sensor.height) &&
			!sameSize(sensor, native)
		)
			console.log(
				`cropped: ${id} exif ${sensor.width}x${sensor.height} native ${native.width}x${native.height}${isCropped(sensor, native) ? "" : " (same aspect: read as a resample)"}`,
			);
		const time = await captureTime(src);
		const mn = ex.makerNote ? parseAppleMakerNote(ex.makerNote) : {};
		const gravity = mn[0x0008] ?? null;
		const f35 = ex.FocalLengthIn35mmFormat ?? 26;
		// diagonal-based conversion: f_px = f35 * diag_px / FF35_DIAGONAL_MM (camera/focal.ts), on the sensor diagonal for a crop
		const fPx = focalPxFromF35(f35, { width: w, height: h }, sensor, native);
		const vfov = (2 * Math.atan(h / 2 / fPx) * 180) / Math.PI;
		const orient = orientationFromGravity(gravity, w, h, ex.Orientation);
		photos.push({
			id,
			src: `/photos/${id}.jpg`,
			width: w,
			height: h,
			// UTC instant; the local wall-clock offset is kept separately for display
			takenAt: time.utc,
			takenAtUtc: time.utc,
			tzOffset: time.offset,
			lat: ex.latitude,
			lon: ex.longitude,
			alt: ex.GPSAltitude ?? null,
			hAccuracy: ex.GPSHPositioningError ?? null,
			heading: ex.GPSImgDirection ?? null,
			f35,
			vfov,
			model: ex.Model ?? null,
			lensModel: ex.LensModel ?? null,
			gravity,
			pitch: orient?.pitch ?? 0,
			roll: orient?.roll ?? 0,
			holding: orient?.holding ?? null,
		});
		console.log(
			`${id}  ${ex.latitude?.toFixed(5)},${ex.longitude?.toFixed(5)} alt=${ex.GPSAltitude?.toFixed(0)} hdg=${ex.GPSImgDirection?.toFixed(1)} f35=${f35} vfov=${vfov.toFixed(1)} pitch=${orient?.pitch.toFixed(1)} roll=${orient?.roll.toFixed(1)} ${orient?.holding}`,
		);
	}

	// Cluster photos into regions (~20 km) so we fetch OSM once per region.
	// Seed with the existing region files so their ids stay stable when new photos are added.
	const regions = [];
	for (let i = 0; fs.existsSync(path.join(OUT_DIR, `region-${i}.json`)); i++) {
		const { center } = JSON.parse(
			fs.readFileSync(path.join(OUT_DIR, `region-${i}.json`), "utf8"),
		);
		regions.push({ lat: center[0], lon: center[1], photos: [] });
	}
	for (const p of photos) {
		let r = regions.find(
			(r) => Math.hypot(r.lat - p.lat, (r.lon - p.lon) * 0.69) < 0.2,
		);
		if (!r) {
			r = { lat: p.lat, lon: p.lon, photos: [] };
			regions.push(r);
		}
		r.photos.push(p.id);
	}
	for (const [i, r] of regions.entries()) {
		if (
			process.env.SKIP_OSM &&
			fs.existsSync(path.join(OUT_DIR, `region-${i}.json`))
		) {
			for (const id of r.photos)
				photos.find((p) => p.id === id).region = `region-${i}`;
			continue;
		}
		const regionId = `region-${i}`;
		const [s, w, n, e] = bboxAround(r.lat, r.lon, PEAK_RADIUS_KM);
		const [ts, tw, tn, te] = bboxAround(r.lat, r.lon, TRAIL_RADIUS_KM);
		console.log(
			`${regionId}: fetching peaks + trails for ${r.photos.join(", ")}`,
		);
		const peaks = await overpass(
			`[out:json][timeout:90];node["natural"~"peak|volcano"]["name"](${s},${w},${n},${e});out;`,
		);
		const trails = await overpass(
			`[out:json][timeout:120];(way["highway"~"path|footway|track"]["sac_scale"](${ts},${tw},${tn},${te});way["highway"="path"](${ts},${tw},${tn},${te}););out geom;`,
		);
		const water = await overpass(
			`[out:json][timeout:120];(way["natural"="water"]["name"](${ts},${tw},${tn},${te});relation["natural"="water"]["name"](${ts},${tw},${tn},${te}););out geom;`,
		).catch(() => ({ elements: [] }));
		const region = {
			id: regionId,
			center: [r.lat, r.lon],
			photos: r.photos,
			peaks: peaks.elements.map((el) => ({
				name: el.tags.name,
				lat: el.lat,
				lon: el.lon,
				ele: el.tags.ele ? Number.parseFloat(el.tags.ele) : null,
				prominence: el.tags.prominence
					? Number.parseFloat(el.tags.prominence)
					: null,
			})),
			trails: trails.elements
				.filter((el) => el.geometry?.length > 1)
				.map((el) => ({
					sac: el.tags?.sac_scale ?? null,
					name: el.tags?.name ?? null,
					coords: el.geometry.map((g) => [
						Number(g.lon.toFixed(6)),
						Number(g.lat.toFixed(6)),
					]),
				})),
			waterNames: [
				...new Set(water.elements.map((el) => el.tags?.name).filter(Boolean)),
			],
		};
		fs.writeFileSync(
			path.join(OUT_DIR, `${regionId}.json`),
			JSON.stringify(region),
		);
		for (const id of r.photos)
			photos.find((p) => p.id === id).region = regionId;
		console.log(
			`  ${region.peaks.length} peaks, ${region.trails.length} trails`,
		);
	}
	fs.writeFileSync(
		path.join(OUT_DIR, "photos.json"),
		JSON.stringify(photos, null, 2),
	);
	console.log(`wrote ${photos.length} photos`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

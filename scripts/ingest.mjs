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
// one EXIF → prior implementation for ingest and browser uploads (MakerNote gravity, holding, capture time)
import {
	appleGravity,
	captureTime,
	orientationFromGravity,
	readExif,
} from "../src/lib/upload/exif.ts";

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
		const time = captureTime((await readExif(src)).raw);
		const gravity = appleGravity(ex.makerNote);
		const f35 = ex.FocalLengthIn35mmFormat ?? 26;
		// diagonal-based conversion: f_px = f35 * diag_px / FF35_DIAGONAL_MM (camera/focal.ts), on the sensor diagonal for a crop
		const fPx = focalPxFromF35(f35, { width: w, height: h }, sensor, native);
		const vfov = (2 * Math.atan(h / 2 / fPx) * 180) / Math.PI;
		const orient = orientationFromGravity(gravity, w, h);
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

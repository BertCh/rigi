// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Export/interchange tests + sample outputs.  Run: npx tsx scripts/test-export.ts
 * Writes samples for IMG_7131 (prior pose from public/photos/photos.json) to out/lead/export/.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pose } from "../src/lib/camera";
import { projectPoint } from "../src/lib/camera";
import {
	type AnyCanvas,
	buildCameraModel,
	buildColmapZip,
	buildGeoJson,
	buildKmz,
	buildPhotoOverlayKml,
	buildPoseJson,
	buildXmp,
	type CameraInput,
	colmapFiles,
	colmapLines,
	composeAnnotatedPng,
	crc32,
	enuToEcef,
	fixedAzimuth,
	type GeoJsonPeak,
	kmlCameraAngles,
	lineGeometry,
	mat3Mul,
	mat3T,
	pointAlong,
	polygonGeometry,
	projectEcef,
	ringSignedArea,
	xmpGpsCoord,
} from "../src/lib/export";
import {
	bearingDeg,
	DEG as D,
	EARTH_R,
	EnuFrame,
	REFRACTION_K,
	toEcef,
} from "../src/lib/geodesy";
import { poseBasis, unprojectDir } from "../src/lib/pose";

/** Unwrap a value the check cannot continue without. Invariant: the fixture inputs always produce it, so null means a regression worth a loud failure. */
function must<T>(value: T | null | undefined, what: string): T {
	if (value == null) throw new Error(`test-export: missing ${what}`);
	return value;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "out/lead/export");
mkdirSync(OUT, { recursive: true });

let failures = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = "") {
	const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`;
	results.push(line);
	console.log(line);
	if (!ok) failures++;
}

// deterministic RNG
let seed = 12345;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
};

// ---------------------------------------------------------------- 1. projection round trip
{
	const W = 4032;
	const H = 3024;
	let worst = 0;
	let n = 0;
	let cases = 0;
	const poses: Pose[] = [
		{ yaw: 20.84, pitch: -3.41, roll: -0.73, vfov: 53.06 },
		{ yaw: 0, pitch: 0, roll: 0, vfov: 40 },
		{ yaw: 359.5, pitch: 12, roll: 7, vfov: 20 },
		{ yaw: 181, pitch: -35, roll: -12, vfov: 65 },
		{ yaw: 90, pitch: 60, roll: 30, vfov: 10 },
	];
	for (let i = 0; i < 20; i++)
		poses.push({
			yaw: rnd() * 360,
			pitch: -40 + rnd() * 80,
			roll: -20 + rnd() * 40,
			vfov: 8 + rnd() * 60,
		});
	const frames = [
		{ lat: 46.97596111111111, lon: 8.668494444444445, h: 0 },
		{ lat: -33.9, lon: 151.2, h: 12 },
		{ lat: 64.1, lon: -21.9, h: 0 },
	];
	for (const frame of frames)
		for (const pose of poses) {
			for (const eye of [
				[0, 0, 1361.3],
				[3.5, -2.1, 850],
			] as [number, number, number][]) {
				cases++;
				const m = buildCameraModel({
					photoId: "t",
					width: W,
					height: H,
					pose,
					frame,
					eye,
				});
				const { forward } = poseBasis(pose);
				for (let k = 0; k < 60; k++) {
					// random ray inside the frustum at 50 m … 120 km
					const dir = unprojectDir(
						pose,
						W / H,
						0.02 + rnd() * 0.96,
						0.02 + rnd() * 0.96,
					);
					const dist = 50 * Math.exp(rnd() * Math.log(120000 / 50));
					const p = [
						eye[0] + dir.x * dist,
						eye[1] + dir.y * dist,
						eye[2] + dir.z * dist,
					];
					const a = projectPoint(pose, W / H, [eye[0], eye[1], eye[2]], p);
					const b = projectEcef(m, enuToEcef(m, p));
					if (!a || !b) {
						worst = Number.POSITIVE_INFINITY;
						continue;
					}
					const e = Math.hypot(a.u * W - b.x, a.v * H - b.y);
					worst = Math.max(worst, e);
					n++;
					void forward;
				}
			}
		}
	check(
		"K[R|t] (world=ECEF) vs pose.ts projectPoint on 4032×3024",
		worst < 0.01,
		`${n} pts, ${cases} poses×frames×eyes, max err ${worst.toExponential(2)} px`,
	);

	// ENU-world extrinsics too
	const m = buildCameraModel({
		photoId: "t",
		width: W,
		height: H,
		pose: poses[2],
		frame: frames[0],
		eye: [0, 0, 1000],
	});
	let worstEnu = 0;
	for (let k = 0; k < 200; k++) {
		const dir = unprojectDir(poses[2], W / H, rnd(), rnd());
		const p = [dir.x * 5000, dir.y * 5000, 1000 + dir.z * 5000];
		const a = must(
			projectPoint(poses[2], W / H, [0, 0, 1000], p),
			"projectPoint",
		);
		const R = m.R_w2c_enu;
		const t = m.t_w2c_enu;
		const c = [0, 1, 2].map(
			(i) => R[i * 3] * p[0] + R[i * 3 + 1] * p[1] + R[i * 3 + 2] * p[2] + t[i],
		);
		const x = m.f * (c[0] / c[2]) + m.K[2];
		const y = m.f * (c[1] / c[2]) + m.K[5];
		worstEnu = Math.max(worstEnu, Math.hypot(a.u * W - x, a.v * H - y));
	}
	check(
		"K[R|t] (world=ENU) vs projectPoint",
		worstEnu < 0.01,
		`max err ${worstEnu.toExponential(2)} px`,
	);

	// rotations orthonormal, det +1
	const I = mat3Mul(m.R_cam2ecef, mat3T(m.R_cam2ecef));
	const orth = Math.max(
		...I.map((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0))),
	);
	const r = m.R_cam2ecef;
	const det =
		r[0] * (r[4] * r[8] - r[5] * r[7]) -
		r[1] * (r[3] * r[8] - r[5] * r[6]) +
		r[2] * (r[3] * r[7] - r[4] * r[6]);
	check(
		"R_cam2ecef orthonormal, det=+1",
		orth < 1e-12 && Math.abs(det - 1) < 1e-12,
		`|RRᵀ−I|∞=${orth.toExponential(1)} det=${det.toFixed(15)}`,
	);

	// quaternion reproduces R (COLMAP qvec)
	const [qw, qx, qy, qz] = m.q_w2c_ecef;
	const Rq = [
		1 - 2 * (qy * qy + qz * qz),
		2 * (qx * qy - qz * qw),
		2 * (qx * qz + qy * qw),
		2 * (qx * qy + qz * qw),
		1 - 2 * (qx * qx + qz * qz),
		2 * (qy * qz - qx * qw),
		2 * (qx * qz - qy * qw),
		2 * (qy * qz + qx * qw),
		1 - 2 * (qx * qx + qy * qy),
	];
	const qerr = Math.max(...Rq.map((v, i) => Math.abs(v - m.R_w2c_ecef[i])));
	check(
		"COLMAP qvec ↔ R_w2c",
		qerr < 1e-12,
		`max |ΔR| ${qerr.toExponential(1)}`,
	);

	// ENU→ECEF agrees with geodesy.ts (EnuFrame.fromGeo minus its refraction lift)
	const fr = new EnuFrame(frames[0].lat, frames[0].lon, 0);
	let geoErr = 0;
	for (let k = 0; k < 200; k++) {
		const lat = frames[0].lat + (rnd() - 0.5) * 1.2;
		const lon = frames[0].lon + (rnd() - 0.5) * 1.6;
		const h = rnd() * 4500;
		const enu = fr.fromGeo(lat, lon, h);
		enu[2] -= (REFRACTION_K * (enu[0] ** 2 + enu[1] ** 2)) / (2 * EARTH_R);
		const mm = buildCameraModel({
			photoId: "t",
			width: W,
			height: H,
			pose: poses[0],
			frame: { lat: fr.lat, lon: fr.lon, h: fr.h },
			eye: [0, 0, 0],
		});
		const X = enuToEcef(mm, enu);
		const Y = toEcef(lat, lon, h);
		geoErr = Math.max(
			geoErr,
			Math.hypot(X[0] - Y[0], X[1] - Y[1], X[2] - Y[2]),
		);
	}
	check(
		"ENU→ECEF matches geodesy.ts EnuFrame/toEcef",
		geoErr < 1e-3,
		`max ${geoErr.toExponential(2)} m over ±60 km`,
	);

	// refraction: in-app (refraction-lifted) vs geometric projection of the same geo point
	const pose0 = poses[0];
	const mm = buildCameraModel({
		photoId: "t",
		width: W,
		height: H,
		pose: pose0,
		frame: { lat: fr.lat, lon: fr.lon, h: 0 },
		eye: [0, 0, 1361.3],
	});
	const refr: string[] = [];
	for (const km of [10, 30, 60]) {
		const [lon, lat] = pointAlong(fr.lat, fr.lon, pose0.yaw, km * 1000);
		const enu = fr.fromGeo(lat, lon, 1500);
		const a = must(
			projectPoint(pose0, W / H, [0, 0, 1361.3], enu),
			"projectPoint",
		);
		const b = must(projectEcef(mm, toEcef(lat, lon, 1500)), "projectEcef");
		refr.push(`${km} km: ${(a.v * H - b.y).toFixed(2)} px`);
	}
	check(
		"refraction offset (informational: in-app vs geometric, f≈3028 px)",
		true,
		refr.join(", "),
	);
}

// ---------------------------------------------------------------- 2. KML conventions
{
	// CONSISTENCY test, not verification: this rebuilds the KML camera from the builder's own reading
	// of the reference, so it catches algebra/composition slips but cannot catch a wrong roll SIGN.
	// The roll sign still needs a manual Google Earth check (open item in API.md).
	// KML camera construction per the KML reference: start looking straight down with
	// X=east, Y=north, Z=up (Z points from the screen toward the eye); heading = compass rotation
	// (clockwise seen from above) about Z, then tilt about the camera X axis, then roll about the
	// camera Z axis (right-handed: +roll swings X toward Y = camera rolls LEFT, as in the
	// "roll 45 rolls the camera to the left" example at developers.google.com/kml/documentation/cameras).
	type V = [number, number, number];
	const rotZ = (a: number) =>
		[
			Math.cos(a),
			-Math.sin(a),
			0,
			Math.sin(a),
			Math.cos(a),
			0,
			0,
			0,
			1,
		] as Parameters<typeof mat3Mul>[0];
	const rotX = (a: number) =>
		[
			1,
			0,
			0,
			0,
			Math.cos(a),
			-Math.sin(a),
			0,
			Math.sin(a),
			Math.cos(a),
		] as Parameters<typeof mat3Mul>[0];
	let worst = 0;
	for (let i = 0; i < 200; i++) {
		const pose: Pose = {
			yaw: rnd() * 360,
			pitch: -60 + rnd() * 120,
			roll: -45 + rnd() * 90,
			vfov: 40,
		};
		const { heading, tilt, roll } = kmlCameraAngles(pose);
		const R = mat3Mul(
			mat3Mul(rotZ(-heading * D), rotX(tilt * D)),
			rotZ(roll * D),
		);
		const col = (j: number): V => [R[j], R[3 + j], R[6 + j]];
		const b = poseBasis(pose);
		const X = col(0);
		const Y = col(1);
		const Z = col(2);
		const e = Math.max(
			Math.hypot(X[0] - b.right.x, X[1] - b.right.y, X[2] - b.right.z),
			Math.hypot(Y[0] - b.up.x, Y[1] - b.up.y, Y[2] - b.up.z),
			Math.hypot(-Z[0] - b.forward.x, -Z[1] - b.forward.y, -Z[2] - b.forward.z),
		);
		worst = Math.max(worst, e);
	}
	check(
		"[consistency] KML heading/tilt/roll rebuilds poseBasis under our reading of the KML spec (roll sign unverified in GE)",
		worst < 1e-12,
		`max basis err ${worst.toExponential(1)}`,
	);
	const k0 = kmlCameraAngles({ yaw: 0, pitch: -90, roll: 0, vfov: 40 });
	const k1 = kmlCameraAngles({ yaw: -10, pitch: 0, roll: 5, vfov: 40 });
	// azimuth wrap: values that round to 360 print as 0 (EXIF 0..359.99, KML heading)
	check(
		'azimuth wrap: 359.9999999 → "0", 359.998 hundredths → 0, −0.0000001 → "0", 359.5 kept',
		fixedAzimuth(359.9999999, 6) === "0" &&
			fixedAzimuth(-1e-7, 6) === "0" &&
			fixedAzimuth(359.5, 6) === "359.5" &&
			fixedAzimuth(720.25, 2) === "0.25" &&
			/<heading>0<\/heading>/.test(
				buildPhotoOverlayKml(
					buildCameraModel({
						photoId: "w",
						width: 40,
						height: 30,
						pose: { yaw: 359.9999999, pitch: 0, roll: 0, vfov: 40 },
						frame: { lat: 46, lon: 8, h: 0 },
						eye: [0, 0, 1000],
					}),
				),
			) &&
			/GPSImgDirection="0\/100"/.test(
				buildXmp(
					buildCameraModel({
						photoId: "w",
						width: 40,
						height: 30,
						pose: { yaw: 359.998, pitch: 0, roll: 0, vfov: 40 },
						frame: { lat: 46, lon: 8, h: 0 },
						eye: [0, 0, 1000],
					}),
				),
			),
	);
	check(
		"KML: pitch −90 → tilt 0 (straight down); pitch 0 → tilt 90; yaw −10 → heading 350",
		k0.tilt === 0 &&
			k1.tilt === 90 &&
			Math.abs(k1.heading - 350) < 1e-9 &&
			k1.roll === -5,
	);
}

// minimal XML well-formedness checker (tags balanced, attributes quoted, entities valid)
function xmlWellFormed(s: string): string | null {
	const body = s.replace(/^﻿/, "");
	const stack: string[] = [];
	const re =
		/<(\?[\s\S]*?\?|!--[\s\S]*?--|!\[CDATA\[[\s\S]*?\]\]|\/?[A-Za-z_][\w:.-]*(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?)>/g;
	let last = 0;
	let roots = 0;
	for (let m = re.exec(body); m; m = re.exec(body)) {
		const text = body.slice(last, m.index);
		if (/[<>]/.test(text))
			return `stray < or > near ${m.index}: ${JSON.stringify(text.slice(0, 40))}`;
		if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(text))
			return `bad entity near ${m.index}`;
		if (stack.length === 0 && text.trim() && last > 0 && roots > 0)
			return "text outside root";
		last = re.lastIndex;
		const tag = m[1];
		if (tag.startsWith("?") || tag.startsWith("!")) continue;
		const name = tag.replace(/^\//, "").split(/[\s/]/)[0];
		if (tag.startsWith("/")) {
			const top = stack.pop();
			if (top !== name) return `mismatched </${name}> (open: ${top})`;
		} else if (!tag.endsWith("/")) {
			if (stack.length === 0) roots++;
			stack.push(name);
		} else if (stack.length === 0) roots++;
	}
	if (/[<>]/.test(body.slice(last).trim())) return "trailing markup";
	if (stack.length) return `unclosed: ${stack.join(",")}`;
	if (roots !== 1) return `expected 1 root element, got ${roots}`;
	return null;
}
function xmllint(path: string) {
	try {
		execFileSync("xmllint", ["--noout", path], { stdio: "pipe" });
		return "xmllint ok";
	} catch (e) {
		return `xmllint: ${(e as { stderr?: Buffer }).stderr?.toString() ?? e}`;
	}
}
const tag = (xml: string, t: string) =>
	xml.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];

// ---------------------------------------------------------------- 3. IMG_7131 samples
const photos = JSON.parse(
	readFileSync(join(ROOT, "public/photos/photos.json"), "utf8"),
) as {
	id: string;
	width: number;
	height: number;
	lat: number;
	lon: number;
	alt: number | null;
	heading: number;
	pitch: number;
	roll: number;
	vfov: number;
	takenAt: string;
	region: string;
}[];
const ph = must(
	photos.find((p) => p.id === "IMG_7131"),
	"photo IMG_7131",
);
const DEM_AT_CAMERA = 1345; // out/gt/IMG_7131.txt: "eye 1361 (gps 1361, dem 1345)"
const eyeAlt =
	ph.alt != null && Math.abs(ph.alt - DEM_AT_CAMERA) < 30
		? Math.max(ph.alt, DEM_AT_CAMERA + 1.5)
		: DEM_AT_CAMERA + 1.8; // engine.ts rule
const pose: Pose = {
	yaw: ph.heading,
	pitch: ph.pitch,
	roll: ph.roll,
	vfov: ph.vfov,
};
const input: CameraInput = {
	photoId: ph.id,
	width: ph.width,
	height: ph.height,
	pose,
	frame: { lat: ph.lat, lon: ph.lon, h: 0 }, // engine: new EnuFrame(photo.lat, photo.lon, 0)
	eye: [0, 0, eyeAlt], // engine.eye
	demAtCamera: DEM_AT_CAMERA,
	takenAt: ph.takenAt,
};
const model = buildCameraModel(input);
const jpeg = new Uint8Array(
	readFileSync(join(ROOT, "public/photos/IMG_7131.jpg")),
);

// pose JSON
const poseJson = buildPoseJson(model, {
	exportedAt: "2026-09-24T00:00:00.000Z",
});
writeFileSync(
	join(OUT, "IMG_7131.pose.json"),
	`${JSON.stringify(poseJson, null, 2)}\n`,
);
rmSync(join(OUT, "IMG_7131.colmap.txt"), { force: true }); // old combined (non-loadable) sample
writeFileSync(join(OUT, "IMG_7131.colmap.zip"), buildColmapZip(model));
for (const world of ["ecef", "enu"] as const) {
	const dir = join(OUT, `IMG_7131.colmap-${world}`);
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(colmapFiles(model, { world })))
		writeFileSync(join(dir, name), text);
}
// Parse images.txt exactly like COLMAP's ReadImagesText: skip empty/# lines, read the pose line,
// then REQUIRE a second (POINTS2D) line before the image is added.
function colmapReadImages(text: string) {
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop(); // std::getline: a final '\n' terminates the last line, no extra empty line
	const images: {
		id: number;
		q: number[];
		t: number[];
		camId: number;
		name: string;
	}[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i++].trim();
		if (!line || line.startsWith("#")) continue;
		const tok = line.split(/\s+/);
		if (i >= lines.length) break; // std::getline fails → image dropped
		i++; // POINTS2D line
		images.push({
			id: Number(tok[0]),
			q: tok.slice(1, 5).map(Number),
			t: tok.slice(5, 8).map(Number),
			camId: Number(tok[8]),
			name: tok.slice(9).join(" "),
		});
	}
	return images;
}
{
	const files = colmapFiles(model);
	const imgs = colmapReadImages(files["images.txt"]);
	const camLine = must(
		files["cameras.txt"].split("\n").find((l) => l && !l.startsWith("#")),
		"cameras.txt line",
	).split(" ");
	const im = imgs[0];
	const qok =
		im &&
		Math.max(...im.q.map((v, k) => Math.abs(v - model.q_w2c_ecef[k]))) <
			1e-12 &&
		Math.max(
			...im.t.map(
				(v, k) =>
					Math.abs(v - model.t_w2c_ecef[k]) /
					Math.max(1, Math.abs(model.t_w2c_ecef[k])),
			),
		) < 1e-12;
	const bare = colmapReadImages(`${colmapLines(model).image}\n`); // the old single-line output
	let zt = "";
	try {
		zt = execFileSync("unzip", ["-t", join(OUT, "IMG_7131.colmap.zip")], {
			encoding: "utf8",
		});
	} catch (e) {
		zt = String((e as { stdout?: string }).stdout ?? e);
	}
	const zl = execFileSync("unzip", ["-Z1", join(OUT, "IMG_7131.colmap.zip")], {
		encoding: "utf8",
	})
		.trim()
		.split("\n");
	check(
		"COLMAP text model parses like ReadImagesText (1 image, 2 lines/image) + zip has cameras/images/points3D",
		imgs.length === 1 &&
			im.name === "IMG_7131.jpg" &&
			im.camId === Number(camLine[0]) &&
			camLine[1] === "PINHOLE" &&
			qok &&
			bare.length === 0 &&
			/No errors detected/.test(zt) &&
			zl.join(",") ===
				"sparse/0/cameras.txt,sparse/0/images.txt,sparse/0/points3D.txt",
		`images=${imgs.length} (bare line alone → ${bare.length}), entries ${zl.join(", ")}`,
	);
}
check(
	"pose JSON fields",
	poseJson.schema === "rigi/pose" &&
		poseJson.version === 1 &&
		poseJson.intrinsics.K.length === 9 &&
		poseJson.extrinsics.R_cam2ecef.length === 9 &&
		poseJson.extrinsics.C_ecef.length === 3 &&
		Math.abs(poseJson.position.altMsl - eyeAlt) < 1e-3 &&
		Math.abs(poseJson.position.lat - ph.lat) < 1e-9,
	`f=${poseJson.intrinsics.fx}px hfov=${poseJson.orientation.hfov}° f35=${poseJson.intrinsics.f35mm} eyeOffset=${poseJson.position.eyeOffset}m`,
);
// JSON round trip: rebuild the projection from the serialised numbers only
{
	const j = JSON.parse(
		readFileSync(join(OUT, "IMG_7131.pose.json"), "utf8"),
	) as typeof poseJson;
	const fr = new EnuFrame(ph.lat, ph.lon, 0);
	let worst = 0;
	for (let k = 0; k < 100; k++) {
		const dir = unprojectDir(pose, ph.width / ph.height, rnd(), rnd());
		const d = 200 + rnd() * 40000;
		const p = [dir.x * d, dir.y * d, eyeAlt + dir.z * d];
		const a = must(
			projectPoint(pose, ph.width / ph.height, [0, 0, eyeAlt], p),
			"projectPoint",
		);
		// ENU→ECEF from JSON: X = originEcef + R_cam2ecef·R_cam2enuᵀ·p
		const Rce = j.extrinsics.R_cam2ecef;
		const Rcn = j.extrinsics.R_cam2enu;
		const pc = [0, 1, 2].map(
			(i) => Rcn[i] * p[0] + Rcn[3 + i] * p[1] + Rcn[6 + i] * p[2],
		); // cam coords of p (from ENU origin)
		const o = j.extrinsics.enuFrame.originEcef;
		const X = [0, 1, 2].map(
			(i) =>
				o[i] +
				Rce[i * 3] * pc[0] +
				Rce[i * 3 + 1] * pc[1] +
				Rce[i * 3 + 2] * pc[2],
		);
		const R = j.extrinsics.opencv_ecef.R;
		const t = j.extrinsics.opencv_ecef.t;
		const c = [0, 1, 2].map(
			(i) => R[i * 3] * X[0] + R[i * 3 + 1] * X[1] + R[i * 3 + 2] * X[2] + t[i],
		);
		const x = j.intrinsics.K[0] * (c[0] / c[2]) + j.intrinsics.K[2];
		const y = j.intrinsics.K[4] * (c[1] / c[2]) + j.intrinsics.K[5];
		worst = Math.max(
			worst,
			Math.hypot(a.u * ph.width - x, a.v * ph.height - y),
		);
		void fr;
	}
	check(
		"pose JSON (serialised, rounded) reprojects vs projectPoint",
		worst < 0.01,
		`max err ${worst.toExponential(2)} px on ${ph.width}px`,
	);
}

// KML
const kml = buildPhotoOverlayKml(model);
writeFileSync(
	join(OUT, "IMG_7131.kml"),
	buildPhotoOverlayKml(model, { href: "IMG_7131.jpg" }),
);
writeFileSync(join(OUT, "IMG_7131.jpg"), jpeg);
{
	const err = xmlWellFormed(kml);
	check("KML well-formed (own checker)", err == null, err ?? "");
	check(
		"KML well-formed (xmllint)",
		xmllint(join(OUT, "IMG_7131.kml")) === "xmllint ok",
	);
	const heading = Number(tag(kml, "heading"));
	const tilt = Number(tag(kml, "tilt"));
	const roll = Number(tag(kml, "roll"));
	check(
		"KML Camera values for IMG_7131 prior",
		Math.abs(heading - 20.844269) < 1e-6 &&
			Math.abs(tilt - (90 + ph.pitch)) < 1e-6 &&
			Math.abs(roll + ph.roll) < 1e-6 &&
			tag(kml, "altitudeMode") === "absolute" &&
			tag(kml, "shape") === "rectangle",
		`heading ${heading} tilt ${tilt} roll ${roll} alt ${tag(kml, "altitude")}`,
	);
	const lf = Number(tag(kml, "leftFov"));
	const tf = Number(tag(kml, "topFov"));
	check(
		"KML ViewVolume",
		Math.abs(-lf * 2 - model.hfov) < 1e-5 &&
			Math.abs(tf * 2 - model.vfov) < 1e-5 &&
			Number(tag(kml, "near")) > 0,
		`leftFov ${lf} topFov ${tf}`,
	);
}

// KMZ
{
	const kmz = buildKmz(model, jpeg);
	const path = join(OUT, "IMG_7131.kmz");
	writeFileSync(path, kmz);
	check(
		'crc32("123456789") = cbf43926',
		crc32(new TextEncoder().encode("123456789")).toString(16) === "cbf43926",
	);
	let out = "";
	try {
		out = execFileSync("unzip", ["-t", path], { encoding: "utf8" });
	} catch (e) {
		out = String((e as { stdout?: string }).stdout ?? e);
	}
	check(
		"KMZ passes 'unzip -t'",
		/No errors detected/.test(out),
		out.trim().split("\n").pop(),
	);
	const listing = execFileSync("unzip", ["-l", path], { encoding: "utf8" });
	const first = listing
		.split("\n")
		.find((l) => /\d\s+\S+$/.test(l) && /doc\.kml|files\//.test(l));
	check(
		"KMZ first entry is doc.kml; image extracts byte-identical",
		/doc\.kml/.test(first ?? "") &&
			Buffer.compare(
				execFileSync("unzip", ["-p", path, "files/IMG_7131.jpg"]),
				Buffer.from(jpeg),
			) === 0,
	);
	// multi-entry + UTF-8 name + empty file
	const z = (await import("../src/lib/export/zip")).zipStore([
		{ name: "a.txt", data: "hello" },
		{ name: "dir/ü-é.txt", data: "ünïcødé" },
		{ name: "empty.bin", data: new Uint8Array(0) },
	]);
	const zp = join(OUT, "selftest.zip");
	writeFileSync(zp, z);
	const zt = execFileSync("unzip", ["-t", zp], { encoding: "utf8" });
	check(
		"store-zip (3 entries, UTF-8, empty) passes 'unzip -t'",
		/No errors detected/.test(zt),
	);
}

// GeoJSON — peaks from the region file projected with the prior (visibility = in frame; no occlusion)
{
	const region = JSON.parse(
		readFileSync(join(ROOT, `public/photos/${ph.region}.json`), "utf8"),
	) as {
		peaks: { name: string; lat: number; lon: number; ele: number | null }[];
	};
	const fr = new EnuFrame(ph.lat, ph.lon, 0);
	const eye: [number, number, number] = [0, 0, eyeAlt];
	const peaks: GeoJsonPeak[] = [];
	for (const p of region.peaks) {
		if (p.ele == null) continue;
		const w = fr.fromGeo(p.lat, p.lon, p.ele);
		const d = Math.hypot(w[0], w[1]);
		if (d > 30000 || d < 500) continue;
		const pr = projectPoint(pose, ph.width / ph.height, eye, w);
		if (!pr || pr.u < 0 || pr.u > 1 || pr.v < 0 || pr.v > 1) continue;
		peaks.push({
			name: p.name,
			ele: p.ele,
			lat: p.lat,
			lon: p.lon,
			u: pr.u,
			v: pr.v,
			visible: true,
			distKm: d / 1000,
		});
	}
	peaks.sort((a, b) => (b.ele ?? 0) - (a.ele ?? 0));
	const top = peaks.slice(0, 25);
	// synthetic monoplotting: flat ground plane at DEM_AT_CAMERA (stands in for engine.sampleAt)
	const pixelToLatLon = (u: number, v: number) => {
		const dir = unprojectDir(pose, ph.width / ph.height, u, v);
		if (dir.z >= -1e-4) return null;
		const t = (DEM_AT_CAMERA - eyeAlt) / dir.z;
		if (t > 40000) return null;
		return fr.toGeo(dir.x * t, dir.y * t, DEM_AT_CAMERA);
	};
	const gj = buildGeoJson(model, {
		maxRange: 30000,
		peaks: top,
		pixelToLatLon,
	});
	writeFileSync(
		join(OUT, "IMG_7131.geojson"),
		`${JSON.stringify(gj, null, 2)}\n`,
	);
	const errs: string[] = [];
	const pos = (c: unknown) =>
		Array.isArray(c) &&
		(c.length === 2 || c.length === 3) &&
		c.every((x) => typeof x === "number" && Number.isFinite(x)) &&
		Math.abs(c[0]) <= 180 &&
		Math.abs(c[1]) <= 90;
	if (gj.type !== "FeatureCollection") errs.push("type");
	for (const f of gj.features) {
		if (f.type !== "Feature" || typeof f.properties !== "object")
			errs.push("feature");
		const g = f.geometry;
		if (g.type === "Point" && !pos(g.coordinates))
			errs.push(`point ${f.properties.kind}`);
		if (
			g.type === "LineString" &&
			!(
				(g.coordinates as unknown[]).length >= 2 &&
				(g.coordinates as unknown[]).every(pos)
			)
		)
			errs.push("line");
		if (g.type === "Polygon") {
			for (const ring of g.coordinates as [number, number][][]) {
				if (ring.length < 4 || !ring.every(pos)) errs.push("ring");
				const a = ring[0];
				const z = ring[ring.length - 1];
				if (a[0] !== z[0] || a[1] !== z[1]) errs.push("ring not closed");
				if (ringSignedArea(ring) <= 0)
					errs.push(`ring not CCW (${f.properties.kind})`);
			}
		}
	}
	const kinds = gj.features.map((f) => f.properties.kind);
	check(
		"GeoJSON valid (RFC 7946 structure, closed CCW rings, ranges)",
		errs.length === 0,
		errs.join("; ") ||
			`${gj.features.length} features: ${[...new Set(kinds)].join(", ")}`,
	);
	const line = must(
		gj.features.find((f) => f.properties.kind === "view-direction"),
		"view-direction",
	).geometry.coordinates as [number, number][];
	const brg = bearingDeg(
		{ lat: line[0][1], lon: line[0][0] },
		{ lat: line[1][1], lon: line[1][0] },
	);
	check(
		"GeoJSON view line: pointAlong() agrees with geodesy.ts bearingDeg (inverse) at yaw",
		Math.abs(brg - ph.heading) < 0.1,
		`bearing ${brg.toFixed(3)} vs yaw ${ph.heading.toFixed(3)}`,
	);
	check(
		"GeoJSON peaks + footprint present",
		kinds.filter((k) => k === "peak").length === top.length &&
			kinds.includes("footprint"),
		`${top.length} peaks: ${top
			.slice(0, 5)
			.map((p) => p.name)
			.join(", ")}…`,
	);
	writeFileSync(
		join(OUT, "IMG_7131.peaks.json"),
		`${JSON.stringify(top, null, 1)}\n`,
	);

	// annotated image via @napi-rs/canvas
	try {
		const napi = await import("@napi-rs/canvas");
		const img = await napi.loadImage(join(ROOT, "public/photos/IMG_7131.jpg"));
		const overlay = napi.createCanvas(ph.width, ph.height);
		const ctx = overlay.getContext("2d");
		ctx.textAlign = "center";
		const s = ph.width / 1400;
		for (const p of top.slice(0, 14)) {
			const x = p.u * ph.width;
			const y = p.v * ph.height;
			ctx.fillStyle = "rgba(255,255,255,0.9)";
			ctx.fillRect(x - 0.75 * s, y - 34 * s, 1.5 * s, 34 * s);
			ctx.beginPath();
			ctx.arc(x, y, 3.5 * s, 0, Math.PI * 2);
			ctx.fill();
			ctx.font = `600 ${13 * s}px sans-serif`;
			ctx.fillText(`${p.name} ${p.ele}`, x, y - 40 * s);
		}
		const factory = (w: number, h: number): AnyCanvas => {
			const c = napi.createCanvas(w, h);
			return Object.assign(c, {
				convertToBlob: async (o?: { type?: string }) =>
					new Blob(
						[
							new Uint8Array(
								o?.type === "image/jpeg"
									? await c.encode("jpeg")
									: await c.encode("png"),
							),
						],
						{ type: o?.type ?? "image/png" },
					),
			}) as unknown as AnyCanvas;
		};
		const blob = await composeAnnotatedPng(img as never, [overlay as never], {
			createCanvas: factory,
			title: `IMG_7131 · prior pose · ${ph.takenAt.slice(0, 10)}`,
		});
		const buf = Buffer.from(await blob.arrayBuffer());
		writeFileSync(join(OUT, "IMG_7131.annotated.png"), buf);
		const pngW = buf.readUInt32BE(16);
		const pngH = buf.readUInt32BE(20);
		check(
			"composeAnnotatedPng → PNG with footer",
			buf.subarray(1, 4).toString() === "PNG" &&
				pngW === ph.width &&
				pngH > ph.height,
			`${pngW}×${pngH}, ${(buf.length / 1e6).toFixed(1)} MB`,
		);
	} catch (e) {
		check("composeAnnotatedPng", false, String(e));
	}
}

// XMP
{
	const xmp = buildXmp(model);
	const p = join(OUT, "IMG_7131.xmp");
	writeFileSync(p, xmp);
	const err = xmlWellFormed(xmp);
	check(
		"XMP well-formed (own checker + xmllint)",
		err == null && xmllint(p) === "xmllint ok",
		err ?? "",
	);
	const back = (re: RegExp) => {
		const g = must(xmp.match(re), "xmp match");
		return (
			(Number(g[1]) + Number(g[2]) / 60) *
			(g[3] === "S" || g[3] === "W" ? -1 : 1)
		);
	};
	const latBack = back(/GPSLatitude="(\d+),([\d.]+)([NS])"/);
	const lonBack = back(/GPSLongitude="(\d+),([\d.]+)([EW])"/);
	const altG = must(xmp.match(/GPSAltitude="(\d+)\/1000"/), "GPSAltitude");
	const altRef = must(xmp.match(/GPSAltitudeRef="(\d)"/), "GPSAltitudeRef");
	const altBack = (Number(altG[1]) / 1000) * (altRef[1] === "1" ? -1 : 1);
	check(
		"XMP GPS round trip (lat, lon, alt, heading)",
		Math.abs(latBack - ph.lat) < 1e-7 &&
			Math.abs(lonBack - ph.lon) < 1e-7 &&
			Math.abs(altBack - model.altMsl) < 1e-3 &&
			/GPano:PoseHeadingDegrees="20\.844/.test(xmp),
		`lat ${latBack.toFixed(8)} lon ${lonBack.toFixed(8)} alt ${altBack}`,
	);
	// DDD,MM.mmmmmm edge cases: minutes must never print as 60, and must carry into the degrees
	const parse = (s: string) => {
		const g = must(s.match(/^(\d+),(\d+\.\d{6})([NSEW])$/), "DDD,MM.mmmmmm");
		return {
			d: Number(g[1]),
			min: Number(g[2]),
			v: (Number(g[1]) + Number(g[2]) / 60) * (/[SW]/.test(g[3]) ? -1 : 1),
		};
	};
	const edge = [
		46.99999999999, -8.99999999999, 45.9999999, 0, -0.000000001,
		179.99999999999, 12.5, -33.12345678,
	];
	const bad = edge.filter((v) => {
		const r = parse(xmpGpsCoord(v, "N", "S"));
		return r.min >= 60 || Math.abs(r.v - v) > 1e-8 * 60;
	});
	check(
		"xmpGpsCoord: no 60.000000 minutes, carries into degrees, round trips",
		bad.length === 0 &&
			xmpGpsCoord(46.99999999999, "N", "S") === "47,0.000000N",
		`${xmpGpsCoord(46.99999999999, "N", "S")}; ${xmpGpsCoord(-8.99999999999, "E", "W")}; bad=${bad.join(",")}`,
	);
}

// GeoJSON antimeridian split + height datum
{
	const mk = (lon: number, yaw: number, geoidUndulation?: number) =>
		buildCameraModel({
			photoId: "am",
			width: 4000,
			height: 3000,
			pose: { yaw, pitch: 0, roll: 0, vfov: 50 },
			frame: { lat: -17, lon, h: 0 },
			eye: [0, 0, 500],
			geoidUndulation,
		});
	const errs: string[] = [];
	const inRange = (c: number[]) =>
		Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90;
	for (const [lon, yaw] of [
		[179.9, 90],
		[-179.9, 270],
		[179.99, 45],
		[-179.95, 300],
	] as const) {
		const gj = buildGeoJson(mk(lon, yaw), { maxRange: 30000 });
		const wedge = must(
			gj.features.find((f) => f.properties.kind === "fov-wedge"),
			"fov-wedge",
		).geometry;
		const line = must(
			gj.features.find((f) => f.properties.kind === "view-direction"),
			"view-direction",
		).geometry;
		if (wedge.type !== "MultiPolygon")
			errs.push(`${lon}/${yaw}: wedge ${wedge.type}`);
		if (line.type !== "MultiLineString")
			errs.push(`${lon}/${yaw}: line ${line.type}`);
		for (const poly of wedge.coordinates as number[][][][]) {
			for (const ring of poly) {
				const w =
					Math.max(...ring.map((c) => c[0])) -
					Math.min(...ring.map((c) => c[0]));
				if (
					!ring.every(inRange) ||
					w > 1 ||
					ringSignedArea(ring as [number, number][]) <= 0
				)
					errs.push(`${lon}/${yaw}: bad ring (width ${w.toFixed(2)}°)`);
			}
		}
		for (const l of line.coordinates as number[][][])
			if (!l.every(inRange)) errs.push("line range");
	}
	// no crossing → plain Polygon, unchanged
	const plain = must(
		buildGeoJson(mk(8.6, 20), {}).features.find(
			(f) => f.properties.kind === "fov-wedge",
		),
		"fov-wedge",
	).geometry.type;
	const p1 = polygonGeometry([
		[179, 0],
		[181, 0],
		[181, 1],
		[179, 1],
		[179, 0],
	]);
	const l1 = lineGeometry([
		[179.5, 0],
		[180.5, 1],
	]);
	check(
		"GeoJSON antimeridian: wedge/line split into Multi* with lon ∈ [−180,180], CCW, no globe-spanning ring",
		errs.length === 0 &&
			plain === "Polygon" &&
			p1.type === "MultiPolygon" &&
			l1.type === "MultiLineString",
		errs.join("; ") ||
			`plain=${plain}, square→${p1.type}, ${JSON.stringify(l1.coordinates)}`,
	);
	const noZ = buildGeoJson(mk(8.6, 20), {}).features[0];
	const withZ = buildGeoJson(mk(8.6, 20, 48.5), {
		peaks: [
			{
				name: "P",
				ele: 3000,
				lat: -17,
				lon: 8.7,
				u: 0.5,
				v: 0.4,
				visible: true,
			},
		],
	});
	const camZ = (withZ.features[0].geometry.coordinates as number[])[2];
	const peakZ = (
		must(
			withZ.features.find((f) => f.properties.kind === "peak"),
			"peak",
		).geometry.coordinates as number[]
	)[2];
	check(
		"GeoJSON z = ellipsoidal height only when geoidUndulation given (RFC 7946 §4); MSL in properties",
		(noZ.geometry.coordinates as number[]).length === 2 &&
			noZ.properties.altMsl === 500 &&
			Math.abs(camZ - 548.5) < 1e-9 &&
			Math.abs(peakZ - 3048.5) < 1e-9,
		`camZ ${camZ} peakZ ${peakZ}`,
	);
}

writeFileSync(join(OUT, "test-results.txt"), `${results.join("\n")}\n`);
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Versioned, self-describing pose JSON for a solved photo, and its validating reader.
// v1 is additive: `estimate` (how the pose is known) was added on 2026-10-02 and is absent from older
// files; readPoseJson treats a missing block as unknown provenance.
import { focalFromVfov, isPose, poseToOpenCV } from "../camera";
import {
	AGENTS,
	METHODS,
	OUTCOMES,
	type ProvenanceClass,
	ROLES,
	STATUSES,
} from "../ontology/core/provenance";
import {
	buildCameraModel,
	type CameraInput,
	type CameraModel,
	colmapLines,
	isTrustedEstimate,
	type PoseEstimateNote,
} from "./camera";

export const POSE_SCHEMA = "summit-lens/pose" as const;
export const POSE_SCHEMA_VERSION = 1 as const;

export type PoseJson = {
	schema: typeof POSE_SCHEMA;
	version: typeof POSE_SCHEMA_VERSION;
	generator: string;
	exportedAt: string;
	photo: {
		id: string;
		imageName: string;
		width: number;
		height: number;
		takenAt: string | null;
	};
	position: {
		lat: number;
		lon: number;
		/** Height above mean sea level (Mapterhorn DEM datum, ≈ EGM2008 orthometric). */
		altMsl: number;
		/** WGS84 ellipsoidal height = altMsl + geoidUndulation. */
		altEllipsoid: number;
		geoidUndulation: number;
		/** Camera height above the DEM surface (m), if known. */
		eyeOffset: number | null;
		demAtCamera: number | null;
		datumNote: string;
	};
	orientation: {
		/** Degrees; yaw = true heading clockwise from north, pitch up +, roll right-side-down +. */
		yaw: number;
		pitch: number;
		roll: number;
		vfov: number;
		hfov: number;
		dfov: number;
		convention: string;
	};
	/**
	 * How the pose is known, null when the exporter did not say (files before 2026-10-02 lack the key).
	 * `trusted` = a person's own pose, or an automatic one a strict rule accepted (isTrustedEstimate).
	 */
	estimate: {
		trusted: boolean;
		label: string | null;
		status: string | null;
		agent: string | null;
		method: string | null;
		role: string | null;
		outcome: string | null;
		level: string | null;
		corroborated: boolean | null;
		confidence: number | null;
		sigmaDeg: Partial<Record<"yaw" | "pitch" | "roll" | "vfov", number>> | null;
	} | null;
	intrinsics: {
		model: "PINHOLE";
		fx: number;
		fy: number;
		cx: number;
		cy: number;
		/** Row-major 3×3, corner-origin pixel convention (COLMAP). */
		K: number[];
		/** Row-major 3×3, OpenCV pixel-centre convention (cx,cy − 0.5). */
		K_opencv: number[];
		f35mm: number;
		pixelConvention: string;
	};
	extrinsics: {
		cameraAxes: string;
		/** Row-major 3×3 camera→ENU (ENU anchored at `enuFrame`). */
		R_cam2enu: number[];
		/** Row-major 3×3 camera→ECEF. */
		R_cam2ecef: number[];
		/** Camera centre in ECEF (m). */
		C_ecef: number[];
		enuFrame: {
			lat: number;
			lon: number;
			h: number;
			eye: number[];
			originEcef: number[];
		};
		/** OpenCV world→camera, world = ECEF: x_cam = R·X + t. */
		opencv_ecef: { R: number[]; t: number[]; rvecNote: string };
		/** OpenCV world→camera, world = ENU frame. */
		opencv_enu: { R: number[]; t: number[] };
		colmap: {
			world: "ECEF";
			camerasTxt: string;
			imagesTxt: string;
			qvec: number[];
			tvec: number[];
		};
		refractionNote: string;
	};
};

const r = (v: number, d = 9) => Number(v.toFixed(d));
const arr = (a: ArrayLike<number>, d = 12) => Array.from(a, (v) => r(v, d));

export function buildPoseJson(
	input: CameraInput | CameraModel,
	opts: { exportedAt?: string } = {},
): PoseJson {
	const m = "K" in input ? input : buildCameraModel(input);
	const inp = m.input;
	const col = colmapLines(m);
	return {
		schema: POSE_SCHEMA,
		version: POSE_SCHEMA_VERSION,
		generator: "Rigi export",
		exportedAt: opts.exportedAt ?? new Date().toISOString(),
		photo: {
			id: inp.photoId,
			imageName: m.imageName,
			width: m.width,
			height: m.height,
			takenAt: inp.takenAt ?? null,
		},
		position: {
			lat: r(m.lat, 10),
			lon: r(m.lon, 10),
			altMsl: r(m.altMsl, 3),
			altEllipsoid: r(m.altEllipsoid, 3),
			geoidUndulation: m.geoidUndulation,
			eyeOffset: m.eyeOffset == null ? null : r(m.eyeOffset, 3),
			demAtCamera: inp.demAtCamera ?? null,
			datumNote:
				"lat/lon WGS84. altMsl is in the DEM datum (Mapterhorn, orthometric ≈ EGM2008 MSL). altEllipsoid = altMsl + geoidUndulation; when geoidUndulation is 0 the ECEF values treat MSL heights as ellipsoidal (≈50 m low in the Alps).",
		},
		orientation: {
			yaw: r(inp.pose.yaw, 6),
			pitch: r(inp.pose.pitch, 6),
			roll: r(inp.pose.roll, 6),
			vfov: r(m.vfov, 6),
			hfov: r(m.hfov, 6),
			dfov: r(m.dfov, 6),
			convention:
				"degrees; yaw = true heading clockwise from north; pitch up +; roll right-side-down + (applied about the view axis after yaw/pitch)",
		},
		estimate: estimateJson(inp.estimate),
		intrinsics: {
			model: "PINHOLE",
			fx: r(m.f, 6),
			fy: r(m.f, 6),
			cx: m.K[2],
			cy: m.K[5],
			K: arr(m.K, 6),
			K_opencv: arr(m.Kopencv, 6),
			f35mm: r(m.f35, 3),
			pixelConvention:
				"K: (0,0) = top-left image corner, pixel centres at i+0.5 (COLMAP). K_opencv: pixel centres at integers.",
		},
		extrinsics: {
			cameraAxes: "OpenCV: x right, y down, z forward",
			R_cam2enu: arr(m.R_cam2enu),
			R_cam2ecef: arr(m.R_cam2ecef),
			C_ecef: arr(m.C_ecef, 4),
			enuFrame: {
				lat: inp.frame.lat,
				lon: inp.frame.lon,
				h: inp.frame.h,
				eye: arr(inp.eye, 4),
				originEcef: arr(m.frameOriginEcef, 4),
			},
			opencv_ecef: {
				R: arr(m.R_w2c_ecef),
				t: arr(m.t_w2c_ecef, 4),
				rvecNote:
					"Rodrigues(R) gives rvec for cv::projectPoints; use K_opencv with integer pixel centres",
			},
			opencv_enu: { R: arr(m.R_w2c_enu), t: arr(m.t_w2c_enu, 4) },
			colmap: {
				world: "ECEF",
				camerasTxt: col.camera,
				imagesTxt: col.image,
				qvec: arr(m.q_w2c_ecef, 15),
				tvec: arr(m.t_w2c_ecef, 6),
			},
			refractionNote:
				"Geometric pinhole model. The app lifts distant terrain for atmospheric refraction (k=0.13) before projecting, so geo points projected with these matrices differ from the in-app overlay by ≈ k·d/(2R) rad (≈0.3 px per 10 km at f≈3000 px).",
		},
	};
}

function estimateJson(
	e: PoseEstimateNote | null | undefined,
): PoseJson["estimate"] {
	if (!e) return null;
	const p = e.provenance;
	const sigma = e.sigmaDeg
		? Object.fromEntries(
				Object.entries(e.sigmaDeg)
					.filter(([, v]) => Number.isFinite(v) && (v as number) >= 0)
					.map(([k, v]) => [k, r(v as number, 6)]),
			)
		: null;
	return {
		trusted: isTrustedEstimate(e),
		label: e.label ?? null,
		status: p.status ?? null,
		agent: p.agent ?? null,
		method: p.method ?? null,
		role: p.role ?? null,
		outcome: p.outcome ?? null,
		level: p.level ?? null,
		corroborated: p.corroborated ?? null,
		confidence:
			e.confidence != null && Number.isFinite(e.confidence)
				? r(e.confidence, 6)
				: null,
		sigmaDeg: sigma && Object.keys(sigma).length ? sigma : null,
	};
}

export type PoseJsonRead =
	| {
			ok: true;
			/**
			 * The file re-derived from `input` (buildPoseJson), so every matrix and number in it is
			 * consistent; `exportedAt`/`generator` are the file's. Its `estimate.trusted` is always false.
			 */
			json: PoseJson;
			/** The CameraInput that rebuilds this file's camera (buildCameraModel(input)); no estimate. */
			input: CameraInput;
			/**
			 * The provenance the file CLAIMS (validated words, unverifiable). Never trust it on read: an
			 * importer records the pose as its own (e.g. a person's endorsed pose), not as this claim.
			 */
			claimed: PoseEstimateNote | null;
	  }
	| { ok: false; error: string };

/** Largest |Δ| allowed between the file's R_cam2enu and the one its angles imply (12-decimal file). */
const ROTATION_TOL = 1e-6;

const finite = (v: unknown): v is number => Number.isFinite(v);
const finiteArray = (v: unknown, n: number): v is number[] =>
	Array.isArray(v) && v.length === n && v.every(finite);
const obj = (v: unknown): Record<string, unknown> | null =>
	v != null && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;

/**
 * Reads a `summit-lens/pose` v1 file (text or parsed JSON). Fails closed: a wrong schema or version,
 * a missing or non-finite field, or angles that disagree with the file's own R_cam2enu or fx (a hand
 * edit of one but not the other) is an error, never a best guess. Only the camera is read as fact;
 * the file's provenance comes back as `claimed` and is never trusted.
 */
export function readPoseJson(data: unknown): PoseJsonRead {
	let raw: unknown = data;
	if (typeof data === "string") {
		try {
			raw = JSON.parse(data);
		} catch {
			return { ok: false, error: "not JSON" };
		}
	}
	const j = obj(raw);
	if (!j) return { ok: false, error: "not a JSON object" };
	if (j.schema !== POSE_SCHEMA)
		return { ok: false, error: `schema is not ${POSE_SCHEMA}` };
	if (j.version !== POSE_SCHEMA_VERSION)
		return { ok: false, error: `unsupported version ${String(j.version)}` };
	const photo = obj(j.photo);
	const position = obj(j.position);
	const o = obj(j.orientation);
	const ext = obj(j.extrinsics);
	const frame = obj(ext?.enuFrame);
	if (!photo || !position || !o || !ext || !frame)
		return {
			ok: false,
			error: "missing photo, position, orientation or extrinsics",
		};
	const { width, height } = photo;
	if (
		typeof photo.id !== "string" ||
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		(width as number) <= 0 ||
		(height as number) <= 0
	)
		return { ok: false, error: "photo id or size is invalid" };
	const pose = { yaw: o.yaw, pitch: o.pitch, roll: o.roll, vfov: o.vfov };
	if (!isPose(pose))
		return { ok: false, error: "orientation is not a valid pose" };
	if (
		!finite(frame.lat) ||
		!finite(frame.lon) ||
		Math.abs(frame.lat) > 90 ||
		Math.abs(frame.lon) > 180 ||
		!finite(frame.h) ||
		!finiteArray(frame.eye, 3) ||
		!finite(position.geoidUndulation)
	)
		return {
			ok: false,
			error: "ENU frame, eye or geoid undulation is invalid",
		};
	const R = ext.R_cam2enu;
	if (!finiteArray(R, 9)) return { ok: false, error: "R_cam2enu is invalid" };
	const implied = poseToOpenCV(
		pose,
		width as number,
		height as number,
	).R_cam2enu;
	if (implied.some((v, i) => Math.abs(v - R[i]) > ROTATION_TOL))
		return { ok: false, error: "orientation angles disagree with R_cam2enu" };
	const fx = obj(j.intrinsics)?.fx;
	const f = focalFromVfov(pose.vfov, height as number);
	if (!finite(fx) || Math.abs(fx - f) > 1e-6 * f)
		return { ok: false, error: "intrinsics fx disagrees with vfov" };
	const dem = position.demAtCamera;
	const takenAt = photo.takenAt;
	const input: CameraInput = {
		photoId: photo.id,
		imageName:
			typeof photo.imageName === "string" ? photo.imageName : undefined,
		width: width as number,
		height: height as number,
		pose,
		frame: { lat: frame.lat, lon: frame.lon, h: frame.h },
		eye: [frame.eye[0], frame.eye[1], frame.eye[2]],
		demAtCamera: finite(dem) ? dem : null,
		geoidUndulation: position.geoidUndulation,
		takenAt: typeof takenAt === "string" ? takenAt : null,
	};
	const claimed = readEstimate(j.estimate);
	if (claimed === "invalid")
		return { ok: false, error: "estimate block is invalid" };
	const json = buildPoseJson(input, {
		exportedAt: typeof j.exportedAt === "string" ? j.exportedAt : undefined,
	});
	if (typeof j.generator === "string") json.generator = j.generator;
	const e = estimateJson(claimed);
	json.estimate = e && { ...e, trusted: false };
	return { ok: true, json, input, claimed };
}

/** The provenance words a file may carry, per field (the ontology's own tables). */
const PROVENANCE_WORDS = {
	agent: Object.keys(AGENTS),
	method: Object.keys(METHODS),
	role: Object.keys(ROLES),
	status: Object.keys(STATUSES),
	outcome: Object.keys(OUTCOMES),
	level: ["high", "medium", "low", "unknown"],
} as const satisfies Record<
	Exclude<keyof ProvenanceClass, "corroborated">,
	readonly string[]
>;
const SIGMA_KEYS: readonly string[] = ["yaw", "pitch", "roll", "vfov"];

/** null/absent → null (unknown); a block with any unknown word or bad number → "invalid". */
function readEstimate(v: unknown): PoseEstimateNote | null | "invalid" {
	if (v == null) return null;
	const e = obj(v);
	if (!e) return "invalid";
	const provenance: Record<string, unknown> = {};
	for (const [key, words] of Object.entries(PROVENANCE_WORDS)) {
		const x = e[key];
		if (x == null) continue;
		if (!(words as readonly unknown[]).includes(x)) return "invalid";
		provenance[key] = x;
	}
	if (e.corroborated != null) {
		if (typeof e.corroborated !== "boolean") return "invalid";
		provenance.corroborated = e.corroborated;
	}
	// every key was checked against the ontology tables above
	const note: PoseEstimateNote = { provenance: provenance as ProvenanceClass };
	if (e.label != null) {
		if (typeof e.label !== "string") return "invalid";
		note.label = e.label;
	}
	if (e.confidence != null) {
		if (!finite(e.confidence)) return "invalid";
		note.confidence = e.confidence;
	}
	if (e.sigmaDeg != null) {
		const sigma = obj(e.sigmaDeg);
		if (!sigma) return "invalid";
		for (const [k, x] of Object.entries(sigma))
			if (!SIGMA_KEYS.includes(k) || !finite(x) || x < 0) return "invalid";
		// keys and values were checked just above
		note.sigmaDeg = sigma as PoseEstimateNote["sigmaDeg"];
	}
	return note;
}

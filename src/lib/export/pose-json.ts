// Versioned, self-describing pose JSON for a solved photo.
import {
	type CameraInput,
	type CameraModel,
	buildCameraModel,
	colmapLines,
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

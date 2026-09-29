// COLMAP text model of a roll spot (several photos, one camera each) + the fused cloud as the initial
// splats, for offline optimisation (tools/nearfield/roll/brush_loo.py trains Brush on it). Reuses the
// single-photo exporter's conventions (src/lib/export/camera.ts colmapLines: PINHOLE, world→camera
// quaternion + translation, OpenCV camera) with world = the spot's ENU frame shifted by `origin`.
import { buildCameraModel, colmapLines } from "../../export/camera";
import { encodeGaussianPly } from "../../export/splat";
import { filterForExport } from "../provenance";
import type { GaussianCloud } from "../types";
import type { SpotView } from "./spot";

export type SpotColmapView = Pick<SpotView, "id" | "pose" | "eye"> & {
	/** Size (px) of the image file written next to the model. */
	width: number;
	height: number;
	/** File name in images/. Default `${id}.png`. */
	imageName?: string;
};

export type SpotColmap = {
	"cameras.txt": string;
	"images.txt": string;
	"points3D.txt": string;
	/** The fused cloud shifted by −origin (3DGS .ply), or null when there is none. */
	initPly: ArrayBuffer | null;
	origin: [number, number, number];
};

/**
 * Text model for Brush / gsplat. `frame` is the WGS84 anchor of the shared ENU frame (for the header
 * comment only); every position (eyes, splats) is shifted by −origin. Generated splats never enter it.
 */
export function spotColmap(
	views: SpotColmapView[],
	cloud: GaussianCloud | null,
	origin: [number, number, number],
	frame: { lat: number; lon: number; h: number },
): SpotColmap {
	const cams: string[] = [];
	const imgs: string[] = [];
	views.forEach((v, k) => {
		const m = buildCameraModel({
			photoId: v.id,
			imageName: v.imageName ?? `${v.id}.png`,
			width: v.width,
			height: v.height,
			pose: v.pose,
			frame,
			eye: [v.eye[0] - origin[0], v.eye[1] - origin[1], v.eye[2] - origin[2]],
		});
		const l = colmapLines(m, { cameraId: k + 1, imageId: k + 1, world: "enu" });
		cams.push(l.camera);
		imgs.push(l.image, "");
	});
	const world = `ENU frame at lat ${frame.lat} lon ${frame.lon} h ${frame.h}, shifted by -[${origin.map((x) => x.toFixed(3)).join(", ")}] m (x=E, y=N, z=Up)`;
	let initPly: ArrayBuffer | null = null;
	if (cloud && cloud.count > 0) {
		const c = filterForExport(cloud);
		const p = c.positions.slice();
		for (let i = 0; i < c.count; i++)
			for (let a = 0; a < 3; a++) p[3 * i + a] -= origin[a];
		initPly = encodeGaussianPly({ ...c, positions: p }, [
			`Rigi roll spot init; world = ${world}`,
		]);
	}
	return {
		"cameras.txt": `# Camera list with one line of data per camera:\n#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n# Number of cameras: ${views.length}\n${cams.join("\n")}\n`,
		"images.txt": `# Image list with two lines of data per image:\n#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n#   POINTS2D[] as (X, Y, POINT3D_ID)\n# Number of images: ${views.length}, mean observations per image: 0\n# Rigi roll spot; world = ${world}\n${imgs.join("\n")}\n`,
		"points3D.txt":
			"# 3D point list with one line of data per point:\n#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)\n# Number of points: 0, mean track length: 0\n",
		initPly,
		origin,
	};
}

// COLMAP text-model export (cameras.txt / images.txt / points3D.txt), packaged as a store-only zip.
// Format: https://colmap.github.io/format.html#text-format
// images.txt has TWO lines per image: the pose line and the POINTS2D line. COLMAP's
// ReadImagesText drops an image (silently) if the second line is missing, so we always emit an
// empty POINTS2D line after each image line.
import {
	type CameraInput,
	type CameraModel,
	buildCameraModel,
	colmapLines,
} from "./camera";
import { zipStore } from "./zip";

export type ColmapOptions = {
	cameraId?: number;
	imageId?: number;
	world?: "ecef" | "enu";
};
export type ColmapFiles = {
	"cameras.txt": string;
	"images.txt": string;
	"points3D.txt": string;
};

/** Full COLMAP text-model file contents for one solved photo (world = ECEF unless `world: 'enu'`). */
export function colmapFiles(
	input: CameraInput | CameraModel,
	opts: ColmapOptions = {},
): ColmapFiles {
	const m = "K" in input ? input : buildCameraModel(input);
	const { camera, image } = colmapLines(m, opts);
	const world =
		opts.world === "enu"
			? `ENU frame at lat ${m.input.frame.lat} lon ${m.input.frame.lon} h ${m.input.frame.h} (x=E, y=N, z=Up, metres)`
			: "WGS84 ECEF (metres)";
	return {
		"cameras.txt": `# Camera list with one line of data per camera:\n#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n# Number of cameras: 1\n${camera}\n`,
		"images.txt": `# Image list with two lines of data per image:\n#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n#   POINTS2D[] as (X, Y, POINT3D_ID)\n# Number of images: 1, mean observations per image: 0\n# Rigi export; world = ${world}\n${image}\n\n`,
		"points3D.txt":
			"# 3D point list with one line of data per point:\n#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)\n# Number of points: 0, mean track length: 0\n",
	};
}

/** Zip of `<dir>/cameras.txt`, `<dir>/images.txt`, `<dir>/points3D.txt` (dir default `sparse/0`). */
export function buildColmapZip(
	input: CameraInput | CameraModel,
	opts: ColmapOptions & { dir?: string } = {},
): Uint8Array {
	const files = colmapFiles(input, opts);
	const dir = (opts.dir ?? "sparse/0").replace(/\/+$/, "");
	const p = (n: string) => (dir ? `${dir}/${n}` : n);
	return zipStore([
		{ name: p("cameras.txt"), data: files["cameras.txt"] },
		{ name: p("images.txt"), data: files["images.txt"] },
		{ name: p("points3D.txt"), data: files["points3D.txt"] },
	]);
}

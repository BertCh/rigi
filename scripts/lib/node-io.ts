// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** Node-only IO for the baseline scripts: tile cache, HEIC→JPEG, image pixels. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
	type DemSource,
	decodeTerrarium,
	TERRARIUM_AWS,
	type TileKey,
	tileId,
} from "../../src/lib/dem";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const IMG_DIR = path.join(ROOT, "img");
export const CACHE = path.join(ROOT, ".cache");

/** Heights of a Terrarium tile file (napi canvas decode); throws if it is not `size` px square. */
export async function fileHeights(file: string, size?: number) {
	const img = await loadImage(file);
	if (size && (img.width !== size || img.height !== size))
		throw new Error(`${file}: ${img.width}×${img.height}, expected ${size}²`);
	const c = createCanvas(img.width, img.height);
	const ctx = c.getContext("2d");
	ctx.drawImage(img, 0, 0);
	return decodeTerrarium(ctx.getImageData(0, 0, img.width, img.height).data);
}

/** Node tile loader for a DEM source, with a disk cache in .cache/<source>/. */
export function demTileLoaderNode(source: DemSource) {
	// AWS Terrarium keeps its original cache path.
	const dir = source.name === "terrarium" ? "terrarium" : `dem-${source.name}`;
	const ext = new URL(source.url({ z: 0, x: 0, y: 0 })).pathname
		.split(".")
		.pop();
	return async (k: TileKey): Promise<Float32Array | undefined> => {
		const file = path.join(CACHE, dir, `${tileId(k)}.${ext}`);
		if (!fs.existsSync(file)) {
			const res = await fetch(source.url(k));
			if (!res.ok) return undefined; // e.g. no high-zoom coverage here
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
		}
		return fileHeights(file);
	};
}

export const loadTerrariumTileNode = demTileLoaderNode(TERRARIUM_AWS);

/** HEIC → display-oriented JPEG (cached), max side `size`. */
export function heicToJpeg(heic: string, size = 1600) {
	const name = path.parse(heic).name;
	const file = path.join(CACHE, "jpg", `${size}`, `${name}.jpg`);
	if (!fs.existsSync(file)) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		execFileSync("sips", [
			"-s",
			"format",
			"jpeg",
			"-Z",
			`${size}`,
			heic,
			"--out",
			file,
		]);
	}
	return file;
}

/** Stored full-resolution pixel size of an image file (sips; before EXIF orientation). */
export function imagePixelSize(file: string) {
	const info = execFileSync("sips", [
		"-g",
		"pixelWidth",
		"-g",
		"pixelHeight",
		file,
	]).toString();
	const n = (k: string) => Number(info.match(new RegExp(`${k}: (\\d+)`))?.[1]);
	return { width: n("pixelWidth"), height: n("pixelHeight") };
}

export interface RGBAImage {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

/** Decodes a JPEG (EXIF orientation applied) to RGBA at `width` px wide. */
export async function loadRGBA(
	file: string,
	width?: number,
): Promise<RGBAImage> {
	const img = await loadImage(file);
	const w = width ?? img.width;
	const h = Math.round((img.height * w) / img.width);
	const c = createCanvas(w, h);
	const ctx = c.getContext("2d");
	ctx.drawImage(img, 0, 0, w, h);
	return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

export function listPhotos(only: string[] = []) {
	return fs
		.readdirSync(IMG_DIR)
		.filter((f) => /\.heic$/i.test(f))
		.filter((f) => only.length === 0 || only.some((o) => f.startsWith(o)))
		.sort()
		.map((f) => ({ name: path.parse(f).name, heic: path.join(IMG_DIR, f) }));
}

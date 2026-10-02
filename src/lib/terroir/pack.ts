// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Loads terroir packs (public/terroir/index.json → <path>/pack.json, cover.png). Packs are found by
// location, not by region id, so every photo inside a pack's bbox gets it (demo, bundled and local).
// Missing packs resolve to null: every terroir layer then draws nothing.
import { publicUrl } from "#/lib/public-url";
import type {
	BBox,
	CoverClassId,
	TerroirPack,
	TerroirPackIndex,
} from "./types";

const BASE = publicUrl("/terroir");

let indexP: Promise<TerroirPackIndex | null> | null = null;
const packCache = new Map<string, Promise<TerroirPack | null>>();
const coverCache = new Map<string, Promise<CoverGrid | null>>();

export const inBBox = (b: BBox, lat: number, lon: number) =>
	lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

export function loadPackIndex(): Promise<TerroirPackIndex | null> {
	indexP ??= fetch(`${BASE}/index.json`)
		.then((r) => (r.ok ? (r.json() as Promise<TerroirPackIndex>) : null))
		.catch(() => null);
	return indexP;
}

/** The pack covering (lat, lon), or null. The smallest bbox wins when packs overlap. */
export async function findPack(
	lat: number,
	lon: number,
): Promise<TerroirPack | null> {
	const idx = await loadPackIndex();
	if (!idx) return null;
	const hits = idx.packs
		.filter((p) => inBBox(p.bbox, lat, lon))
		.sort(
			(a, b) =>
				(a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) -
				(b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]),
		);
	const hit = hits[0];
	return hit ? loadPack(hit.path) : null;
}

export function loadPack(path: string): Promise<TerroirPack | null> {
	let p = packCache.get(path);
	if (!p) {
		p = fetch(`${BASE}/${path}/pack.json`)
			.then((r) => (r.ok ? (r.json() as Promise<TerroirPack>) : null))
			.then((pk) => (pk && pk.v === 1 ? { ...pk, _path: path } : null))
			.catch(() => null) as Promise<TerroirPack | null>;
		packCache.set(path, p);
	}
	return p;
}

/** Decoded land-cover classes over the pack bbox, row 0 = north. */
export type CoverGrid = {
	width: number;
	height: number;
	bbox: BBox;
	classes: Uint8Array;
	/** class at (lat, lon), 0 outside or no data */
	at(lat: number, lon: number): CoverClassId;
	/** the source image (for uploading as a texture) */
	image: ImageBitmap | null;
};

/** Absolute URL of a pack-relative asset. */
export function packUrl(pack: TerroirPack, rel: string) {
	const path = (pack as TerroirPack & { _path?: string })._path ?? pack.id;
	return `${BASE}/${path}/${rel}`;
}

export function loadCover(pack: TerroirPack): Promise<CoverGrid | null> {
	const meta = pack.cover;
	if (!meta) return Promise.resolve(null);
	const url = packUrl(pack, meta.url);
	let p = coverCache.get(url);
	if (!p) {
		p = (async () => {
			try {
				const blob = await (await fetch(url)).blob();
				const bmp = await createImageBitmap(blob, {
					premultiplyAlpha: "none",
					colorSpaceConversion: "none",
				});
				const { width, height } = bmp;
				const cv =
					typeof OffscreenCanvas !== "undefined"
						? new OffscreenCanvas(width, height)
						: Object.assign(document.createElement("canvas"), {
								width,
								height,
							});
				const ctx = cv.getContext("2d") as
					| CanvasRenderingContext2D
					| OffscreenCanvasRenderingContext2D
					| null;
				if (!ctx) return null;
				ctx.drawImage(bmp, 0, 0);
				const rgba = ctx.getImageData(0, 0, width, height).data;
				const classes = new Uint8Array(width * height);
				for (let i = 0; i < classes.length; i++) classes[i] = rgba[i * 4];
				return makeGrid(meta.bbox, width, height, classes, bmp);
			} catch {
				return null;
			}
		})();
		coverCache.set(url, p);
	}
	return p;
}

export function makeGrid(
	bbox: BBox,
	width: number,
	height: number,
	classes: Uint8Array,
	image: ImageBitmap | null = null,
): CoverGrid {
	const [w, s, e, n] = bbox;
	return {
		width,
		height,
		bbox,
		classes,
		image,
		at(lat, lon) {
			if (lon < w || lon > e || lat < s || lat > n) return 0;
			const x = Math.min(width - 1, Math.floor(((lon - w) / (e - w)) * width));
			const y = Math.min(
				height - 1,
				Math.floor(((n - lat) / (n - s)) * height),
			);
			return classes[y * width + x] as CoverClassId;
		},
	};
}

/** Credit line for the pack's sources (licence requirement: swisstopo OGD, Copernicus, OSM). */
export const packCredit = (pack: TerroirPack) =>
	pack.sources.map((s) => s.credit).join(" · ");

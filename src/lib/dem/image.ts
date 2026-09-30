// Terrarium image → heights with createImageBitmap + a 2D canvas: the page (load.ts), the decode pool
// (decode.worker.ts) and the horizon workers all decode through here.
import { decodeTerrarium } from "./decode";

function context2d(w: number, h: number) {
	if (typeof OffscreenCanvas !== "undefined")
		return new OffscreenCanvas(w, h).getContext("2d", {
			willReadFrequently: true,
		}) as OffscreenCanvasRenderingContext2D | null;
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	return c.getContext("2d", { willReadFrequently: true });
}

/** Heights of a decoded Terrarium image (OffscreenCanvas, or a <canvas> where there is none). */
export function bitmapHeights(bmp: ImageBitmap) {
	const ctx = context2d(bmp.width, bmp.height);
	if (!ctx) throw new Error("2D canvas unavailable for DEM decode");
	ctx.drawImage(bmp, 0, 0);
	return decodeTerrarium(ctx.getImageData(0, 0, bmp.width, bmp.height).data);
}

/** Heights of an encoded Terrarium tile (PNG / WebP bytes). */
export async function blobHeights(blob: Blob) {
	const bmp = await createImageBitmap(blob, {
		colorSpaceConversion: "none",
		premultiplyAlpha: "none",
	});
	try {
		return bitmapHeights(bmp);
	} finally {
		bmp.close();
	}
}

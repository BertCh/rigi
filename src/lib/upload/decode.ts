// Browser image decode → upright JPEG capped at MAX_PX on the long side (like ingest.mjs).
// JPEG/PNG/WebP (and HEIC on Safari) decode natively; HEIC elsewhere goes through libheif in a
// worker, with a main-thread fallback if workers are unavailable.
import libheifUrl from "libheif-js/libheif-wasm/libheif-bundle.mjs?url";
import { MAX_PX } from "./exif";

/**
 * URL of the unmodified libheif-js bundle (LGPL-3.0). `?url` makes Vite emit it as its own
 * file (not inlined, not minified), shared by the worker and the main-thread fallback, and
 * replaceable by the user as the LGPL requires. Loaded only when a HEIC needs it.
 */
export const LIBHEIF_URL = libheifUrl;

export type Decoded = {
	/** Upright JPEG (or the untouched original when it is already an upright JPEG ≤ MAX_PX). */
	blob: Blob;
	thumb: Blob;
	width: number;
	height: number;
	/** Upright full-resolution decoded size, before the MAX_PX cap (crop detection vs EXIF size). */
	sourceWidth: number;
	sourceHeight: number;
	decoder: "native" | "libheif" | "passthrough";
};

export class HeicUnsupportedError extends Error {}

const HEIF_BRANDS = new Set([
	"heic",
	"heix",
	"hevc",
	"hevx",
	"heim",
	"heis",
	"hevm",
	"hevs",
	"mif1",
	"msf1",
	"avif",
]);

/** ISO-BMFF 'ftyp' sniff: is this an HEIF container (by content, not by name)? */
export function isHeif(bytes: Uint8Array) {
	if (bytes.length < 16) return false;
	const s = (a: number, b: number) =>
		String.fromCharCode(...bytes.subarray(a, b));
	if (s(4, 8) !== "ftyp") return false;
	const size = Math.min(
		bytes.length,
		new DataView(bytes.buffer, bytes.byteOffset).getUint32(0),
	);
	for (let o = 8; o + 4 <= size; o += 4)
		if (HEIF_BRANDS.has(s(o, o + 4))) return true;
	return false;
}

export const isJpeg = (b: Uint8Array) =>
	b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

type Source = ImageBitmap | HTMLImageElement;
type Drawable = Source | HTMLCanvasElement;

async function nativeDecode(file: Blob): Promise<Source> {
	try {
		return await createImageBitmap(file, { imageOrientation: "from-image" });
	} catch {
		// some engines only decode via <img> (e.g. older Safari with HEIC)
		const url = URL.createObjectURL(file);
		try {
			const img = new Image();
			img.src = url;
			await img.decode();
			return img;
		} finally {
			URL.revokeObjectURL(url);
		}
	}
}

let worker: Worker | null = null;
let seq = 0;
type WorkerReply = {
	id: number;
	width: number;
	height: number;
	data: Uint8ClampedArray;
	error?: string;
};

function heicInWorker(buf: ArrayBuffer): Promise<ImageData> {
	worker ??= new Worker(new URL("./heic.worker.ts", import.meta.url), {
		type: "module",
	});
	const w = worker;
	const id = ++seq;
	return new Promise((resolve, reject) => {
		const onMsg = (ev: MessageEvent<WorkerReply>) => {
			if (ev.data.id !== id) return;
			w.removeEventListener("message", onMsg);
			w.removeEventListener("error", onErr);
			if (ev.data.error) reject(new Error(ev.data.error));
			else
				resolve(
					new ImageData(
						ev.data.data as Uint8ClampedArray<ArrayBuffer>,
						ev.data.width,
						ev.data.height,
					),
				);
		};
		const onErr = (e: ErrorEvent) => {
			w.removeEventListener("message", onMsg);
			w.removeEventListener("error", onErr);
			worker?.terminate();
			worker = null;
			reject(
				new Error(`HEIC worker failed: ${e.message || "could not start"}`),
			);
		};
		w.addEventListener("message", onMsg);
		w.addEventListener("error", onErr);
		w.postMessage(
			{ id, buf, libUrl: new URL(LIBHEIF_URL, location.href).href },
			[buf],
		);
	});
}

async function heicOnMainThread(bytes: Uint8Array): Promise<ImageData> {
	type Img = {
		get_width(): number;
		get_height(): number;
		display(t: ImageData, cb: (r: unknown) => void): void;
	};
	const mod = await import(/* @vite-ignore */ LIBHEIF_URL);
	const lib = (
		mod.default as () => {
			HeifDecoder: new () => { decode(b: Uint8Array): Img[] };
		}
	)();
	const im = new lib.HeifDecoder().decode(bytes)[0];
	if (!im) throw new Error("no image in HEIC container");
	const out = new ImageData(im.get_width(), im.get_height());
	const ok = await new Promise<boolean>((res) =>
		im.display(out, (r) => res(!!r)),
	);
	if (!ok) throw new Error("libheif could not decode this image");
	return out;
}

async function heicDecode(bytes: Uint8Array): Promise<ImageData> {
	try {
		return await heicInWorker(bytes.slice().buffer);
	} catch (e) {
		console.warn(
			"[upload] HEIC worker path failed, decoding on main thread",
			e,
		);
		return heicOnMainThread(bytes);
	}
}

function sizeOf(src: Source | ImageData) {
	if (src instanceof HTMLImageElement)
		return { w: src.naturalWidth, h: src.naturalHeight };
	return { w: src.width, h: src.height };
}

function makeCanvas(w: number, h: number) {
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	return c;
}

function toBlob(c: HTMLCanvasElement, quality: number) {
	return new Promise<Blob>((res, rej) =>
		c.toBlob(
			(b) => (b ? res(b) : rej(new Error("JPEG encode failed"))),
			"image/jpeg",
			quality,
		),
	);
}

async function draw(src: Drawable | ImageData, w: number, h: number) {
	const c = makeCanvas(w, h);
	const ctx = c.getContext("2d");
	if (!ctx) throw new Error("2D canvas unavailable");
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	if (src instanceof ImageData) {
		const bmp = await createImageBitmap(src).catch(() => null);
		if (bmp) {
			ctx.drawImage(bmp, 0, 0, w, h);
			bmp.close();
		} else {
			const full = makeCanvas(src.width, src.height);
			full.getContext("2d")?.putImageData(src, 0, 0);
			ctx.drawImage(full, 0, 0, w, h);
		}
	} else ctx.drawImage(src, 0, 0, w, h);
	return c;
}

/**
 * Decode `file` upright, cap the long side at MAX_PX, and return a JPEG plus a thumbnail.
 * `exifOrientation` lets an upright, small JPEG pass through byte-for-byte.
 */
export async function decodeImage(
	file: Blob,
	bytes: Uint8Array,
	exifOrientation = 1,
): Promise<Decoded> {
	const heif = isHeif(bytes);
	let src: Source | ImageData;
	let decoder: Decoded["decoder"] = "native";
	try {
		src = await nativeDecode(file);
	} catch (e) {
		if (!heif) {
			const raw = /\.(dng|cr[23]|nef|arw|orf|rw2|raf|tiff?)$/i.test(
				(file as File).name ?? "",
			);
			throw new Error(
				raw
					? "RAW and TIFF files can't be decoded in the browser. Export the photo as JPEG (keep location metadata) and upload that."
					: `This browser could not decode the image (${(e as Error).message}). Supported: JPEG, HEIC, PNG, WebP, AVIF.`,
			);
		}
		try {
			src = await heicDecode(bytes);
			decoder = "libheif";
		} catch (e2) {
			throw new HeicUnsupportedError(
				`HEIC decoding failed: ${(e2 as Error).message}`,
			);
		}
	}
	const { w: sw, h: sh } = sizeOf(src);
	if (!sw || !sh) throw new Error("decoded image is empty");
	const s = Math.min(1, MAX_PX / Math.max(sw, sh));
	const width = Math.round(sw * s);
	const height = Math.round(sh * s);
	const full = await draw(src, width, height);
	const ts = Math.min(1, 360 / Math.max(width, height));
	const thumbCanvas = await draw(
		full,
		Math.round(width * ts),
		Math.round(height * ts),
	);
	const thumb = await toBlob(thumbCanvas, 0.8);
	if (src instanceof ImageBitmap) src.close();
	if (!heif && isJpeg(bytes) && s === 1 && exifOrientation === 1)
		return {
			blob: file.slice(0, file.size, "image/jpeg"),
			thumb,
			width,
			height,
			sourceWidth: sw,
			sourceHeight: sh,
			decoder: "passthrough",
		};
	return {
		blob: await toBlob(full, 0.86),
		thumb,
		width,
		height,
		sourceWidth: sw,
		sourceHeight: sh,
		decoder,
	};
}

/**
 * Short content hash (hex) used for ids: first 10 hex chars of SHA-256. crypto.subtle only
 * exists in secure contexts, so plain-http LAN access (a phone hitting the dev server) falls
 * back to a 64-bit FNV-1a of the bytes, prefixed so the two id spaces can't collide.
 */
export async function contentHash(bytes: Uint8Array) {
	if (globalThis.crypto?.subtle) {
		const d = await crypto.subtle.digest(
			"SHA-256",
			bytes as Uint8Array<ArrayBuffer>,
		);
		return [...new Uint8Array(d)]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")
			.slice(0, 10);
	}
	let h = 0xcbf29ce484222325n;
	const P = 0x100000001b3n;
	const M = (1n << 64n) - 1n;
	// BigInt per byte is slow on 5 MB; hash a strided sample plus the length and the edges
	const step = Math.max(1, Math.floor(bytes.length / 262144));
	for (let i = 0; i < bytes.length; i += step)
		h = ((h ^ BigInt(bytes[i])) * P) & M;
	h = ((h ^ BigInt(bytes.length)) * P) & M;
	return `f${h.toString(16).padStart(16, "0").slice(0, 9)}`;
}

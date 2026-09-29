// Compose the photo + overlay layers + an attribution footer into one image Blob.
// Works with OffscreenCanvas (workers, modern browsers) or HTMLCanvasElement, and with any
// canvas factory (e.g. @napi-rs/canvas in Node tests).

export const DEFAULT_ATTRIBUTION =
	"Terrain © Mapterhorn · Imagery © swisstopo / Esri · © OpenStreetMap contributors";

type Drawable = CanvasImageSource & {
	width: number | SVGAnimatedLength;
	height: number | SVGAnimatedLength;
};

/** Minimal canvas shape we need; OffscreenCanvas and HTMLCanvasElement both satisfy it. */
export type AnyCanvas = {
	width: number;
	height: number;
	getContext(id: "2d"): unknown;
	convertToBlob?: (o?: { type?: string; quality?: number }) => Promise<Blob>;
	toBlob?: (
		cb: (b: Blob | null) => void,
		type?: string,
		quality?: number,
	) => void;
};

export type ComposeOptions = {
	/** Output size; default = photo size. Overlays are stretched to fill the photo area. */
	width?: number;
	height?: number;
	/** Footer text; false to omit. Default DEFAULT_ATTRIBUTION. */
	attribution?: string | false;
	/** Optional left-aligned footer title (e.g. place/date); attribution goes right-aligned. */
	title?: string;
	/** Footer height in px; default ≈ 2.6 % of the image height (min 22). */
	footerHeight?: number;
	type?: "image/png" | "image/jpeg" | "image/webp";
	quality?: number;
	/** Canvas factory override (tests / Node). */
	createCanvas?: (w: number, h: number) => AnyCanvas;
};

function dim(v: number | SVGAnimatedLength) {
	return typeof v === "number" ? v : v.baseVal.value;
}

function defaultCanvas(w: number, h: number): AnyCanvas {
	if (typeof OffscreenCanvas !== "undefined")
		return new OffscreenCanvas(w, h) as unknown as AnyCanvas;
	if (typeof document !== "undefined") {
		const c = document.createElement("canvas");
		c.width = w;
		c.height = h;
		return c as unknown as AnyCanvas;
	}
	throw new Error(
		"composeAnnotatedPng: no canvas available; pass opts.createCanvas",
	);
}

async function toBlob(
	c: AnyCanvas,
	type: string,
	quality?: number,
): Promise<Blob> {
	if (c.convertToBlob) return c.convertToBlob({ type, quality });
	if (c.toBlob) {
		const tb = c.toBlob.bind(c);
		return new Promise((res, rej) =>
			tb(
				(b) => (b ? res(b) : rej(new Error("toBlob returned null"))),
				type,
				quality,
			),
		);
	}
	throw new Error("canvas cannot encode to Blob");
}

/**
 * Photo + overlay canvases (drawn in order, stretched to the photo rect) + attribution footer.
 * The footer is added below the photo, so the output is (height + footerHeight) tall.
 */
export async function composeAnnotatedPng(
	photo: Drawable,
	overlays: Drawable[],
	opts: ComposeOptions = {},
): Promise<Blob> {
	const W = Math.round(opts.width ?? dim(photo.width));
	const H = Math.round(opts.height ?? dim(photo.height));
	const text =
		opts.attribution === false
			? null
			: (opts.attribution ?? DEFAULT_ATTRIBUTION);
	const fh =
		text || opts.title
			? Math.round(opts.footerHeight ?? Math.max(22, H * 0.026))
			: 0;
	const canvas = (opts.createCanvas ?? defaultCanvas)(W, H + fh);
	const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
	if (!ctx) throw new Error("2d context unavailable");
	ctx.drawImage(photo, 0, 0, W, H);
	for (const o of overlays) ctx.drawImage(o, 0, 0, W, H);
	if (fh) {
		ctx.fillStyle = "#111418";
		ctx.fillRect(0, H, W, fh);
		const fs = Math.round(fh * 0.5);
		ctx.font = `500 ${fs}px Manrope, system-ui, -apple-system, Segoe UI, sans-serif`;
		ctx.textBaseline = "middle";
		const pad = Math.round(fh * 0.5);
		if (opts.title) {
			ctx.fillStyle = "#f2f4f7";
			ctx.textAlign = "left";
			ctx.fillText(opts.title, pad, H + fh / 2);
		}
		if (text) {
			ctx.fillStyle = "rgba(242,244,247,0.78)";
			ctx.textAlign = "right";
			ctx.fillText(text, W - pad, H + fh / 2);
		}
	}
	return toBlob(canvas, opts.type ?? "image/png", opts.quality);
}

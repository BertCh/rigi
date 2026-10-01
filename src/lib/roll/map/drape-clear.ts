// Per-photo clear air + exposure for the roll drape (./multi-drape-layer.ts): the data side.
//
// Every draped photo carries its own aerial perspective (far ground veiled toward the photo's
// airlight) and its own exposure / white balance, so overlaps seam and far ground washes out. Here
// each photo gets (1) its own haze fit and (2) an exposure gain, both handed to the drape shader
// in one small RGBA32F texture, 4 texels per photo (row = its atlas slot):
//   texel 0  airlight.rgb (linear), amount
//   texel 1  betaR.rgb × strength (1/m), betaM × strength
//   texel 2  hR, hM (scale heights, m), floor, 0
//   texel 3  exposure.rgb (linear gain), 0
// The shader inverts the photo's haze along ITS camera ray, J = (I - A)/max(T, floor) + A with
// T = exp(-∫β ds) (look/clear-air.ts, the same altitude-aware Rayleigh + Mie optical depth), blends
// J back with weight `amount`, then multiplies by the exposure gain.
//
// The fit (look/haze-fit.ts fitHaze, or hazeFitAsync = the luma command-graph kernels when the
// look GPU path is on, mirroring HazeController) needs the photo's pixels at 2× a decimated range
// map (≤ FIT_LONG on the long side), that range map with the pixel ray of the photo's pose, and the
// eye's altitude ASL. The roll frame is the ENU frame at the roll centre with the curvature drop
// baked into z (EnuFrame), so altitude = z + (x² + y²)·ATM_CURV, the same formula the shader and
// the fit use, and the fit's photo-local frame (eye at (0, 0, eyeAlt)) gives the same altitudes.
// A fit with quality ≥ FIT_MIN_QUALITY becomes ClearAirValues (strength-scaled betas, fitted
// airlight, amount CLEAR_AMOUNT, floor CLEAR_FLOOR); anything else is CLEAR_AIR_OFF for that photo
// (the roll map has no classic haze model to round-trip with, so no "consistent" fallback).
// Where the data comes from: roll-map.ts hands over the photo's working copy (setPixels), its
// people mask (setForeground) and its range map (setRange, row 0 = top, 0 = sky: a readback of the
// geometry target's draw, kept ONLY for the clear-air path; the atlas itself is filled on the GPU).
//
// Exposure gains (./drape-gains.ts) are re-solved, debounced, whenever the set of fitted photos
// settles: they compare the clear-air-corrected overlaps, so they follow the fits.
import type { Device, Texture } from "@luma.gl/core";
import type { Pose } from "#/lib/camera";
import { lookGpuOn } from "#/lib/gpu/look/opt-in";
import { ATM_CURV, FIT_MIN_QUALITY, type Vec3 } from "#/lib/look/atmosphere";
import { CLEAR_AIR_OFF, type ClearAirValues } from "#/lib/look/clear-air";
import { rangeGeo } from "#/lib/look/haze-controller";
import { fitHaze, type HazeFit, type HazeFitInput } from "#/lib/look/haze-fit";
import type { ForegroundMask } from "#/lib/segment";
import {
	type GainPhoto,
	type GainSamples,
	type RangeGrid,
	sampleGrid,
	solveGains,
} from "./drape-gains";

/** Blend of the corrected colour (look/clear-air.ts amount). */
export const CLEAR_AMOUNT = 0.85;
/** Lowest transmittance divided by (caps the gain at 1/floor on far, noisy ridges). */
export const CLEAR_FLOOR = 0.3;
/** Long side (px) of the range grid the fit runs on; the photo goes in at 2×. */
const FIT_LONG = 256;
/** Long side (px) of the photo copy kept for fits and gains (= 2 × FIT_LONG). */
const PIXELS_LONG = FIT_LONG * 2;
/** Gains are re-solved this long after the last change (ms). */
const GAIN_DEBOUNCE_MS = 700;
/** Texels per photo in the params texture. */
const TEXELS = 4;

type Cam = {
	pose: Pose;
	eye: [number, number, number];
	aspect: number;
};

type Entry = {
	cam?: Cam;
	/** Decimated range map for `cam` (row 0 = top, 0 = sky). */
	range?: RangeGrid;
	pixels?: ImageData;
	fg?: ForegroundMask | null;
	/** Bumped on every setRange: a fit / samples for an older range are dropped. */
	rev: number;
	/** The fit for `rev` has finished (values may be CLEAR_AIR_OFF). */
	fitted: boolean;
	values: ClearAirValues;
	samples?: GainSamples;
	exposure: Vec3;
};

const flat = (v: ClearAirValues, e: Vec3) => [
	...v.airlight,
	v.amount,
	...v.betaR,
	v.betaM,
	v.h[0],
	v.h[1],
	v.floor,
	0,
	...e,
	0,
];

/** A fit as the drape's clear-air values, or CLEAR_AIR_OFF when it isn't trustworthy. */
export function clearValuesOf(fit: HazeFit | null): ClearAirValues {
	if (!fit || fit.quality < FIT_MIN_QUALITY) return CLEAR_AIR_OFF;
	const k = fit.strength;
	return {
		airlight: [...fit.airlight],
		betaR: [fit.betaR[0] * k, fit.betaR[1] * k, fit.betaR[2] * k],
		h: [fit.hR, fit.hM],
		betaM: fit.betaM * k,
		amount: CLEAR_AMOUNT,
		floor: CLEAR_FLOOR,
	};
}

export class DrapeClear {
	/** The shader's params texture (null until init). */
	texture: Texture | null = null;
	/** Bumped whenever the texture's contents change. */
	version = 0;
	private ids: string[] = [];
	private index = new Map<string, number>();
	private entries = new Map<string, Entry>();
	private on = true;
	private queue: string[] = [];
	private pumping = false;
	private gainTimer = 0;
	private gainSeq = 0;
	private disposed = false;

	/** onChange: the texture changed (the host redraws). */
	constructor(private onChange: () => void) {}

	/** The atlas is allocated: one row of the params texture per slot, all photos unfitted. */
	init(device: Device, ids: string[]) {
		if (this.texture || this.disposed) return;
		this.ids = ids;
		ids.forEach((id, k) => {
			this.index.set(id, k);
		});
		this.texture = device.createTexture({
			width: TEXELS,
			height: Math.max(1, ids.length),
			format: "rgba32float",
			data: this.pack(),
			sampler: {
				minFilter: "nearest",
				magFilter: "nearest",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			},
		});
		for (const id of this.entries.keys()) this.schedule(id);
	}

	get enabled() {
		return this.on;
	}

	/** Turn the fits and gains on / off (data already read back is kept). */
	setEnabled(on: boolean) {
		if (on === this.on) return;
		this.on = on;
		if (on) {
			for (const id of this.entries.keys()) this.schedule(id);
			this.scheduleGains();
		}
	}

	/** Does `id` have a range map for the fit? (roll-map skips the readback otherwise.) */
	hasRange(id: string) {
		return !!this.entries.get(id)?.range;
	}

	private entry(id: string) {
		let e = this.entries.get(id);
		if (!e) {
			e = {
				rev: 0,
				fitted: false,
				values: CLEAR_AIR_OFF,
				exposure: [1, 1, 1],
			};
			this.entries.set(id, e);
		}
		return e;
	}

	/** The photo's working copy, kept at ≤ PIXELS_LONG for the fit and the gain samples. */
	setPixels(id: string, img: ImageBitmap) {
		const s = Math.min(1, PIXELS_LONG / Math.max(img.width, img.height));
		const w = Math.max(1, Math.round(img.width * s));
		const h = Math.max(1, Math.round(img.height * s));
		const cv =
			typeof OffscreenCanvas !== "undefined"
				? new OffscreenCanvas(w, h)
				: Object.assign(document.createElement("canvas"), {
						width: w,
						height: h,
					});
		const ctx = cv.getContext("2d", { willReadFrequently: true }) as
			| CanvasRenderingContext2D
			| OffscreenCanvasRenderingContext2D
			| null;
		if (!ctx) return;
		ctx.drawImage(img, 0, 0, w, h);
		const e = this.entry(id);
		e.pixels = ctx.getImageData(0, 0, w, h);
		e.samples = undefined;
		this.schedule(id);
	}

	/** The people mask: those pixels are not the ground, the fit leaves them out. */
	setForeground(id: string, fg: ForegroundMask | null) {
		this.entry(id).fg = fg;
	}

	/**
	 * The photo's range map for `cam` (full size, row 0 = top, 0 = sky). Decimated here; replaces
	 * an older one (updateRoll moved the camera) and invalidates its fit.
	 */
	setRange(id: string, cam: Cam, data: Float32Array, w: number, h: number) {
		const step = Math.max(1, Math.ceil(Math.max(w, h) / FIT_LONG));
		const W = Math.floor(w / step);
		const H = Math.floor(h / step);
		const out = new Float32Array(W * H);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const r = data[y * step * w + x * step];
				out[y * W + x] = Number.isFinite(r) ? r : 0;
			}
		const e = this.entry(id);
		e.cam = cam;
		e.range = { w: W, h: H, data: out };
		e.rev++;
		e.fitted = false;
		e.samples = undefined;
		this.schedule(id);
	}

	private schedule(id: string) {
		const e = this.entries.get(id);
		if (!this.on || !this.texture || !e?.pixels || !e.range || e.fitted) return;
		if (!this.queue.includes(id)) this.queue.push(id);
		void this.pump();
	}

	private async pump() {
		if (this.pumping) return;
		this.pumping = true;
		try {
			for (
				let id = this.queue.shift();
				id !== undefined && !this.disposed;
				id = this.queue.shift()
			) {
				const e = this.entries.get(id);
				if (!e || e.fitted || !e.pixels || !e.range || !e.cam) continue;
				const rev = e.rev;
				let fit: HazeFit | null = null;
				try {
					fit = await this.fit(e);
				} catch (err) {
					console.warn("[roll-clear] fit failed", err);
				}
				if (e.rev !== rev || this.disposed) continue; // moved meanwhile: queued again
				e.values = clearValuesOf(fit);
				e.fitted = true;
				this.upload();
				this.scheduleGains();
				// let the frame breathe between photos
				await new Promise((r) => setTimeout(r, 0));
			}
		} finally {
			this.pumping = false;
		}
	}

	/** The haze fit of one photo (GPU graph path when the look GPU path is on, else the CPU fit). */
	private async fit(e: Entry): Promise<HazeFit | null> {
		const { range, cam, pixels } = e;
		if (!range || !cam || !pixels) return null;
		const { w: W, h: H } = range;
		const input: HazeFitInput = {
			photo: resample(pixels, W * 2, H * 2),
			geo: rangeGeo(range.data, W, H, cam.pose),
			geoW: W,
			geoH: H,
			sky: null,
			foreground: e.fg ?? null,
			eyeAlt: cam.eye[2] + (cam.eye[0] ** 2 + cam.eye[1] ** 2) * ATM_CURV,
		};
		if (lookGpuOn()) {
			const m = await import("#/lib/gpu/look/hooks");
			return m.hazeFitAsync(input);
		}
		return fitHaze(input);
	}

	/** Re-solve the exposure gains once things have been quiet for GAIN_DEBOUNCE_MS. */
	private scheduleGains() {
		if (!this.on || this.disposed) return;
		window.clearTimeout(this.gainTimer);
		this.gainSeq++;
		this.gainTimer = window.setTimeout(
			() => void this.solve(),
			GAIN_DEBOUNCE_MS,
		);
	}

	private async solve() {
		if (this.queue.length || this.pumping) return; // the last fit reschedules
		const seq = this.gainSeq;
		const ids: string[] = [];
		const photos: GainPhoto[] = [];
		for (const [id, e] of this.entries) {
			if (!e.cam || !e.range || !e.pixels) continue;
			e.samples ??= sampleGrid(e.cam, e.range, e.pixels);
			ids.push(id);
			photos.push({
				cam: e.cam,
				range: e.range,
				samples: e.samples,
				values: e.values,
			});
		}
		if (photos.length < 2) return;
		const g = await solveGains(
			photos,
			() => seq !== this.gainSeq || this.disposed,
		);
		if (!g || seq !== this.gainSeq || this.disposed) return;
		for (const [i, id] of ids.entries()) {
			const e = this.entries.get(id);
			if (e) e.exposure = g[i];
		}
		this.upload();
	}

	private pack() {
		const out = new Float32Array(Math.max(1, this.ids.length) * TEXELS * 4);
		for (const [k, id] of this.ids.entries()) {
			const e = this.entries.get(id);
			out.set(
				flat(e?.values ?? CLEAR_AIR_OFF, e?.exposure ?? [1, 1, 1]),
				k * 16,
			);
		}
		return out;
	}

	private upload() {
		const t = this.texture;
		if (!t || this.disposed) return;
		t.writeData(this.pack(), {
			width: TEXELS,
			height: Math.max(1, this.ids.length),
		});
		this.version++;
		this.onChange();
	}

	dispose() {
		this.disposed = true;
		window.clearTimeout(this.gainTimer);
		this.texture?.destroy();
		this.texture = null;
		this.entries.clear();
		this.queue = [];
	}
}

/** Nearest-neighbour resample of an ImageData to w × h (the fit wants exactly 2× its range grid). */
function resample(src: ImageData, w: number, h: number) {
	if (src.width === w && src.height === h) return src;
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) {
		const sy = Math.min(
			src.height - 1,
			Math.floor(((y + 0.5) / h) * src.height),
		);
		for (let x = 0; x < w; x++) {
			const sx = Math.min(
				src.width - 1,
				Math.floor(((x + 0.5) / w) * src.width),
			);
			const o = (sy * src.width + sx) * 4;
			data.set(src.data.subarray(o, o + 4), (y * w + x) * 4);
		}
	}
	return { width: w, height: h, data };
}

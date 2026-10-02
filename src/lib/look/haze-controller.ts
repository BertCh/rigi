// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Fits the photo's aerial perspective (look/haze-fit) for styles whose atmosphere airlight is
// 'fitted': once per (pose, eye, sky mask), after a fresh geometry readback. Engine-neutral: each
// engine hands in its own geometry buffer (three: xyz + range; deck: range + pixel ray), which is
// decimated ×2 (≈512 px) here, so both fit the same samples. The fit then feeds atmosphereValues().
import { type Pose, unprojectDir } from "../camera";
import { lookGpuOn, trackLook, warmLookGpu } from "../gpu/look/opt-in";
import type { ViewStyle } from "../style/types";
import type { Vec3 } from "./atmosphere";
import { fitHaze, type HazeFit, type HazeGeo, type SkyMask } from "./haze-fit";

const STEP = 2;

export const wantsHazeFit = (s: ViewStyle) =>
	s.terrain.atmosphere.mode === "physical" &&
	s.terrain.atmosphere.airlight === "fitted";

/** deck's geometry buffer (row 0 = top, Infinity = sky) as haze-fit's range input (row 0 = bottom, 0 = sky). */
export function rangeGeo(
	range: Float32Array,
	w: number,
	h: number,
	pose: Pose,
): HazeGeo {
	const data = new Float32Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const r = range[(h - 1 - y) * w + x];
			data[y * w + x] = Number.isFinite(r) ? r : 0;
		}
	return {
		kind: "range",
		data,
		ray: (x, y) => unprojectDir(pose, w / h, (x + 0.5) / w, 1 - (y + 0.5) / h),
	};
}

/** A GPU-resident haze fit of HazeController's ×2 grid (null = take the readback path). */
export type BridgedHazeFit = (o: {
	geo: HazeGeo;
	sky: SkyMask | null;
	fg: SkyMask | null;
	eyeAlt: number;
	sunDir: Vec3;
}) => Promise<HazeFit | null>;

export class HazeController {
	fit: HazeFit | null = null;
	sky: SkyMask | null = null;
	private key = "";
	/** The fg mask the cached fit used: a mask landing later must refit. */
	private fgRef: SkyMask | null = null;
	/** Opt-in GPU path (gpu/look, the GPU look): update returns false and this fires when the fit lands. */
	onAsync?: (fit: HazeFit | null) => void;
	private seq = 0;
	private photo?: {
		img: HTMLImageElement;
		w: number;
		h: number;
		data: ImageData;
	};

	constructor() {
		// both engines make one per view: compile the opt-in GPU look kernels early (no-op when off)
		warmLookGpu();
	}

	/** True when update() would fit now: the style wants it and (pose, eye, foreground mask) changed since the last fit. */
	isDue(o: {
		style: ViewStyle;
		pose: Pose;
		img: HTMLImageElement | undefined;
		eyeAlt: number;
		fg: SkyMask | null;
		/** Fit even when the style's atmosphere doesn't ask for it (world-view clear air: look/clear-air). */
		want?: boolean;
	}): boolean {
		if (!(wantsHazeFit(o.style) || o.want) || !o.img) return false;
		const p = o.pose;
		return (
			`${p.yaw},${p.pitch},${p.roll},${p.vfov},${o.eyeAlt}` !== this.key ||
			o.fg !== this.fgRef
		);
	}

	/**
	 * Fit if the style wants it and (pose, eye, sky) changed; true when a new fit arrived. `geo` is
	 * only called when a fit is due: the full-size buffer (row 0 = bottom, sky = 0) and its size.
	 */
	update(o: {
		style: ViewStyle;
		pose: Pose;
		img: HTMLImageElement | undefined;
		eyeAlt: number;
		sunDir: Vec3;
		fg: SkyMask | null;
		geo: () => { geo: HazeGeo; w: number; h: number };
		/**
		 * A GPU-resident fit of the same input (deck-webgpu compute-bridge.ts: prep + fit on the
		 * geometry render target), given the ×2 grid. Used instead of the GPU readback path when set;
		 * null / a rejection falls back to it. Async like the GPU path (onAsync).
		 */
		bridged?: BridgedHazeFit;
		/** Fit even when the style's atmosphere doesn't ask for it (world-view clear air: look/clear-air). */
		want?: boolean;
	}): boolean {
		if (!(wantsHazeFit(o.style) || o.want) || !o.img) return false;
		const p = o.pose;
		const key = `${p.yaw},${p.pitch},${p.roll},${p.vfov},${o.eyeAlt}`;
		if (key === this.key && o.fg === this.fgRef) return false;
		this.key = key;
		this.fgRef = o.fg;
		const { geo, w, h } = o.geo();
		const W = Math.floor(w / STEP);
		const H = Math.floor(h / STEP);
		const k = geo.kind === "xyzr" ? 4 : 1;
		const data = new Float32Array(W * H * k);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++)
				for (let c = 0; c < k; c++)
					data[(y * W + x) * k + c] =
						geo.data[(y * STEP * w + x * STEP) * k + c];
		const small: HazeGeo =
			geo.kind === "xyzr"
				? { kind: "xyzr", data }
				: { kind: "range", data, ray: (x, y) => geo.ray(x * STEP, y * STEP) };
		const seq = ++this.seq;
		// GPU off: neither the bridge nor the GPU readback runs; the CPU fit below does
		const bridged = lookGpuOn() ? o.bridged : undefined;
		if (lookGpuOn()) {
			const img = o.img;
			const sky = this.sky;
			const readback = () =>
				import("../gpu/look/hooks").then((m) =>
					m.hazeFitAsync({
						photo: this.pixels(img, W * 2, H * 2),
						geo: small,
						geoW: W,
						geoH: H,
						sky,
						foreground: o.fg,
						eyeAlt: o.eyeAlt,
						sunDir: o.sunDir,
					}),
				);
			const fitted = bridged
				? bridged({
						geo: small,
						sky,
						fg: o.fg,
						eyeAlt: o.eyeAlt,
						sunDir: o.sunDir,
					})
						.catch((e) => {
							console.warn("[haze] bridged fit failed, reading back", e);
							return null;
						})
						.then((fit) => fit ?? (seq === this.seq ? readback() : null))
				: readback();
			trackLook(
				fitted
					.catch((e) => {
						console.warn("[haze] fit failed", e);
						return null;
					})
					.then((fit) => {
						if (seq !== this.seq) return;
						this.fit = fit;
						this.onAsync?.(fit);
					}),
			);
			return false;
		}
		try {
			this.fit = fitHaze({
				photo: this.pixels(o.img, W * 2, H * 2),
				geo: small,
				geoW: W,
				geoH: H,
				sky: this.sky,
				foreground: o.fg,
				eyeAlt: o.eyeAlt,
				sunDir: o.sunDir,
			});
		} catch (e) {
			console.warn("[haze] fit failed", e);
			this.fit = null;
		}
		// dev tools read the fit through window.__engine.hazeFit
		if (import.meta.env?.DEV && this.fit)
			console.info(
				`[haze] fit q ${this.fit.quality.toFixed(2)} V ${(this.fit.visibility / 1000).toFixed(0)} km sky ${this.sky ? "photo" : "dem"}`,
			);
		return true;
	}

	setSky(m: SkyMask | null) {
		this.sky = m;
		this.key = "";
		this.seq++;
	}

	/** The photo at w×h (cached). */
	private pixels(img: HTMLImageElement, w: number, h: number) {
		const c = this.photo;
		if (c?.img === img && c.w === w && c.h === h) return c.data;
		const cv = document.createElement("canvas");
		cv.width = w;
		cv.height = h;
		const ctx = cv.getContext("2d", {
			willReadFrequently: true,
		}) as CanvasRenderingContext2D;
		ctx.drawImage(img, 0, 0, w, h);
		const data = ctx.getImageData(0, 0, w, h);
		this.photo = { img, w, h, data };
		return data;
	}
}

// Real look-pass inputs read back from a live deck engine (DeckEngine or WebGpuEngine; window.__engine on
// /photo/<id> in dev), for the W5 parity bench (bench.ts, scripts/gpu/look-bench.mjs). It pokes
// engine internals (the private geometry source, haze controller, photo and masks), so it is dev-only.
// Ported from the three.js PhotoEngine (removed 2026-10-01): relief, haze and masks are built from deck's
// geometry buffer exactly as the engine's own passes build them; the band-stats input is not captured
// (deck renders the stats layer inside its compositor, with no CPU hook), so `stats` is null.
import type { Pose } from "../../camera";
import type { EnuFrame } from "../../geodesy";
import type { Vec3 } from "../../look/atmosphere";
import { gridSize, MASK_LONG_SIDE, photoPixels } from "../../look/composite";
import { rangeGeo } from "../../look/haze-controller";
import type { HazeFitInput, SkyMask } from "../../look/haze-fit";
import type { HeightTile } from "../../look/relief/heights";

export type ReliefIn = {
	tiles: readonly HeightTile[];
	frame: EnuFrame;
	sunDir: Vec3;
	yaw: number | null;
};
export type MasksIn = {
	I: Float32Array;
	cov: Float32Array;
	fg: Float32Array | null;
	w: number;
	h: number;
};
export type StatsIn = {
	photo: Uint8ClampedArray;
	/** linear RGBA, row 0 = top (already flipped, as CompositeLook.setStats does). */
	layer: Float32Array;
	w: number;
	h: number;
	/** metres, row 0 = top, 0 = sky. */
	range: Float32Array;
	fg: Float32Array | null;
	minRange: number;
};
export type LookInputs = {
	source: string;
	relief: ReliefIn | null;
	haze: HazeFitInput | null;
	masks: MasksIn | null;
	stats: StatsIn | null;
};

type Engine = {
	kind?: string;
	pose: { yaw: number };
	frame: EnuFrame;
	eyeAlt: number;
	photo: { hAccuracy?: number | null };
	terrain?: { tiles: HeightTile[] };
	geometryReady(): boolean;
	// internals (private in DeckEngine / WebGpuEngine; same names in both)
	geoSrc?: {
		width: number;
		height: number;
		/** metres, row 0 = top, Infinity = sky */
		range: Float32Array;
		pose?: Pose | null;
	};
	photoImg?: HTMLImageElement;
	fgMask: SkyMask | null;
	haze: { sky: SkyMask | null };
	look(mode: "overlay"): { sunDir: Vec3 };
};

const maskAt = (m: SkyMask, u: number, v: number) =>
	m.data[
		Math.min(m.height - 1, Math.floor(v * m.height)) * m.width +
			Math.min(m.width - 1, Math.floor(u * m.width))
	] / 255;

/** Inputs of the look passes as the deck engine builds them at this pose (stats: null, see above). */
export function captureLookInputs(engine: unknown, label = "live"): LookInputs {
	const e = engine as Engine;
	if (e.kind !== "deck") throw new Error("capture needs a deck engine");
	if (!e.geometryReady()) throw new Error("geometry not ready");
	const src = e.geoSrc;
	if (!src?.pose) throw new Error("no geometry buffer");
	const img = e.photoImg;
	if (!img) throw new Error("no photo");
	const sunDir = [...e.look("overlay").sunDir] as Vec3;
	const gw = src.width;
	const gh = src.height;
	// range grid, row 0 = top, 0 = sky (deck: Infinity = sky)
	const at = (x: number, y: number) => {
		const r = src.range[y * gw + x];
		return Number.isFinite(r) ? r : 0;
	};

	const relief: ReliefIn | null = e.terrain?.tiles.length
		? {
				tiles: e.terrain.tiles,
				frame: e.frame,
				sunDir,
				yaw: (Math.round(e.pose.yaw / 30) * 30 + 360) % 360,
			}
		: null;

	// haze-controller.ts: rangeGeo of the buffer (row 0 = bottom), decimated ×2, the photo at twice that
	const STEP = 2;
	const W = Math.floor(gw / STEP);
	const H = Math.floor(gh / STEP);
	const full = rangeGeo(src.range, gw, gh, src.pose);
	if (full.kind !== "range") throw new Error("unexpected haze geo");
	const small = new Float32Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			small[y * W + x] = full.data[y * STEP * gw + x * STEP];
	const haze: HazeFitInput = {
		photo: photoPixels(img, W * 2, H * 2),
		geo: {
			kind: "range",
			data: small,
			ray: (x, y) => full.ray(x * STEP, y * STEP),
		},
		geoW: W,
		geoH: H,
		sky: e.haze.sky,
		foreground: e.fgMask,
		eyeAlt: e.eyeAlt,
		sunDir,
	};

	// composite.ts updateMasks (no cut: overlay mode)
	const [w, h] = gridSize(gw / gh, MASK_LONG_SIDE);
	const px = photoPixels(img, w, h).data;
	const n = w * h;
	const I = new Float32Array(n);
	const cov = new Float32Array(n);
	const fgm = e.fgMask;
	const fg = fgm ? new Float32Array(n) : null;
	const sky = e.haze.sky;
	const sx = gw / w;
	const sy = gh / h;
	const ss = Math.max(1, Math.round(sx));
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			I[i] =
				(0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) /
				255;
			let t = 0;
			for (let dy = 0; dy < ss; dy++)
				for (let dx = 0; dx < ss; dx++) {
					const r = at(
						Math.min(gw - 1, Math.floor(x * sx) + dx),
						Math.min(gh - 1, Math.floor(y * sy) + dy),
					);
					t += r > 0 ? 1 : 0;
				}
			const u = (x + 0.5) / w;
			const v = (y + 0.5) / h;
			cov[i] = (t / (ss * ss)) * (sky ? 1 - maskAt(sky, u, v) : 1);
			if (fg && fgm) fg[i] = maskAt(fgm, u, v);
		}

	return {
		source: label,
		relief,
		haze,
		masks: { I, cov, fg, w, h },
		stats: null,
	};
}

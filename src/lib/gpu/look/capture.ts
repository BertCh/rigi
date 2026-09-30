// Real look-pass inputs read back from a live three.js PhotoEngine (window.__engine on
// /photo/<id> in dev), for the W5 parity bench (bench.ts, scripts/gpu/look-bench.mjs). It pokes
// engine internals, so it is dev-only and three-only (the deck engine keeps other buffers).
import type { EnuFrame } from "../../geodesy";
import type { Vec3 } from "../../look/atmosphere";
import {
	gridSize,
	MASK_LONG_SIDE,
	photoPixels,
	trustedRange,
} from "../../look/composite";
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
	// internals
	geoBuf: Float32Array;
	geoRT: { width: number; height: number };
	photoImg?: HTMLImageElement;
	fgMask: SkyMask | null;
	haze: { sky: SkyMask | null };
	shared: { uSunDir: { value: { toArray(): number[] } } };
	look: { setStats: (o: unknown) => void; statsKey: string };
	layerStats(amount: number): void;
	/** engine: read the stats layer synchronously (layerStats is otherwise fenced / async) */
	syncReads: boolean;
};

const maskAt = (m: SkyMask, u: number, v: number) =>
	m.data[
		Math.min(m.height - 1, Math.floor(v * m.height)) * m.width +
			Math.min(m.width - 1, Math.floor(u * m.width))
	] / 255;

/** Inputs of the four look passes as the three engine would build them at this pose. */
export function captureLookInputs(engine: unknown, label = "live"): LookInputs {
	const e = engine as Engine;
	if (e.kind === "deck") throw new Error("capture needs the three.js engine");
	if (!e.geometryReady()) throw new Error("geometry not ready");
	const img = e.photoImg;
	if (!img) throw new Error("no photo");
	const sunDir = e.shared.uSunDir.value.toArray() as Vec3;
	const gw = e.geoRT.width;
	const gh = e.geoRT.height;
	const geo = e.geoBuf;
	// range grid, row 0 = top (engine.ts rangeGrid)
	const at = (x: number, y: number) => geo[((gh - 1 - y) * gw + x) * 4 + 3];

	const relief: ReliefIn | null = e.terrain?.tiles.length
		? {
				tiles: e.terrain.tiles,
				frame: e.frame,
				sunDir,
				yaw: (Math.round(e.pose.yaw / 30) * 30 + 360) % 360,
			}
		: null;

	// haze-controller.ts: the buffer decimated ×2, the photo at twice that
	const STEP = 2;
	const W = Math.floor(gw / STEP);
	const H = Math.floor(gh / STEP);
	const small = new Float32Array(W * H * 4);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			for (let c = 0; c < 4; c++)
				small[(y * W + x) * 4 + c] = geo[(y * STEP * gw + x * STEP) * 4 + c];
	const haze: HazeFitInput = {
		photo: photoPixels(img, W * 2, H * 2),
		geo: { kind: "xyzr", data: small },
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
					t += r > 0 && Number.isFinite(r) ? 1 : 0;
				}
			const u = (x + 0.5) / w;
			const v = (y + 0.5) / h;
			cov[i] = (t / (ss * ss)) * (sky ? 1 - maskAt(sky, u, v) : 1);
			if (fg && fgm) fg[i] = maskAt(fgm, u, v);
		}

	// the layer the engine renders for band stats: intercept CompositeLook.setStats around layerStats
	let stats: StatsIn | null = null;
	const look = e.look;
	const orig = look.setStats;
	try {
		look.setStats = (o: unknown) => {
			const s = o as {
				img: HTMLImageElement;
				layer: Float32Array;
				w: number;
				h: number;
				minRange: number;
			};
			const { w: lw, h: lh } = s;
			const layer = new Float32Array(s.layer.length);
			for (let y = 0; y < lh; y++)
				layer.set(
					s.layer.subarray((lh - 1 - y) * lw * 4, (lh - y) * lw * 4),
					y * lw * 4,
				);
			const range = new Float32Array(lw * lh);
			const fl = fgm ? new Float32Array(lw * lh) : null;
			for (let y = 0; y < lh; y++)
				for (let x = 0; x < lw; x++) {
					const r = at(
						Math.floor(((x + 0.5) * gw) / lw),
						Math.floor(((y + 0.5) * gh) / lh),
					);
					range[y * lw + x] = r > 0 && Number.isFinite(r) ? r : 0;
					if (fl && fgm)
						fl[y * lw + x] = maskAt(fgm, (x + 0.5) / lw, (y + 0.5) / lh);
				}
			stats = {
				photo: photoPixels(s.img, lw, lh).data,
				layer,
				w: lw,
				h: lh,
				range,
				fg: fl,
				minRange: s.minRange ?? trustedRange(e.photo.hAccuracy),
			};
		};
		// force the render even if these stats were already taken
		look.statsKey = "";
		e.syncReads = true;
		e.layerStats(1);
	} catch (err) {
		console.warn("[lookgpu] stats capture failed", err);
	} finally {
		e.syncReads = false;
		look.setStats = orig;
	}
	return {
		source: label,
		relief,
		haze,
		masks: { I, cov, fg, w, h },
		stats,
	};
}

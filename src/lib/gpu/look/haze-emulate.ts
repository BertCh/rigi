// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node-only helpers for the haze checks (haze-tail.check.ts, haze-band.check.ts): synthetic haze
// scenes and a CPU emulation of submit 1's outputs (./haze-graph.ts prepGraph) built with
// look/haze-fit.ts's own per-pixel code, so that hazeFitTail on the emulated prep can be compared
// bit for bit with fitHaze. Not imported by app code.
import {
	ATM_CURV,
	atmPath,
	BETA_R0,
	H_R,
	type Vec3,
} from "../../look/atmosphere";
import type { HazeFitInput, SkyMask } from "../../look/haze-fit";
import { srgbToLinear } from "../../style/color";
import {
	airlightBand,
	type HazeTailContext,
	NBINS,
	type Prep,
	pointAtOf,
} from "./haze";

export type HazeSceneOptions = {
	width: number;
	height: number;
	seed: number;
	rayleighScale: number;
	mieBeta: number;
	mieHeight: number;
	skyRows: number;
	eyeAlt: number;
	/** an unmodelled saturated sign at 1–5 km (haze-fit.test.ts) */
	occluder: boolean;
	/** uniform noise amplitude on the linear colour */
	noise: number;
	/** a soft P(sky) mask (else sky = range 0) */
	skyMask: boolean;
	/** a "person" in the foreground mask */
	foreground: boolean;
	/** deck's r32f range buffer + ray function instead of xyzr */
	rangeOnly: boolean;
};

/** A deterministic PRNG (LCG), as haze-fit.test.ts. */
export function lcg(seed: number) {
	let state = seed >>> 0 || 1;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

const encodeSrgb = (c: number) => {
	const v = Math.max(0, Math.min(1, c));
	return Math.round(
		255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055),
	);
};

/** A hazy synthetic scene: sky above a wavy skyline, terrain whose range falls log-linearly downwards. */
export function makeHazeScene(o: HazeSceneOptions): HazeFitInput {
	const { width: W, height: H, eyeAlt } = o;
	const rnd = lcg(o.seed);
	const airlight: Vec3 = [
		0.55 + rnd() * 0.15,
		0.65 + rnd() * 0.1,
		0.78 + rnd() * 0.1,
	];
	const xyzr = new Float32Array(W * H * 4);
	const photoW = W * 2;
	const photoH = H * 2;
	const photo = {
		width: photoW,
		height: photoH,
		data: new Uint8ClampedArray(photoW * photoH * 4),
	};
	const far = 40000 + rnd() * 110000;
	const near = 150 + rnd() * 400;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			let colour: Vec3;
			const gi = ((H - 1 - y) * W + x) * 4;
			const skyline = o.skyRows + Math.round(8 * Math.sin(x * 0.03 + o.seed));
			if (y < skyline) {
				colour = [0, 1, 2].map(
					(c) => airlight[c] * (1 + (rnd() - 0.5) * 0.02),
				) as Vec3;
			} else {
				const f = (y - skyline) / Math.max(1, H - 1 - skyline);
				const d =
					Math.exp(Math.log(far) + f * (Math.log(near) - Math.log(far))) *
					(1 + (rnd() - 0.5) * 0.05);
				const az = ((x / W - 0.5) * 60 * Math.PI) / 180;
				const h =
					1400 + 400 * Math.sin(x * 0.05) * Math.cos(y * 0.07) - 500 * f;
				const px = d * Math.sin(az);
				const py = d * Math.cos(az);
				xyzr[gi] = px;
				xyzr[gi + 1] = py;
				xyzr[gi + 2] = h - (px * px + py * py) * ATM_CURV;
				xyzr[gi + 3] = d;
				const g = 0.03 + rnd() * 0.37;
				const albedo: Vec3 = [
					g * (0.95 + rnd() * 0.1),
					g,
					g * (0.9 + rnd() * 0.1),
				];
				const pathR = atmPath(eyeAlt, h, d, H_R);
				const pathM = atmPath(eyeAlt, h, d, o.mieHeight);
				colour = [0, 1, 2].map((c) => {
					const t = Math.exp(
						-o.rayleighScale * BETA_R0[c] * pathR - o.mieBeta * pathM,
					);
					return (
						albedo[c] * t + airlight[c] * (1 - t) + (rnd() - 0.5) * o.noise
					);
				}) as Vec3;
				if (o.occluder && x > W / 10 && x < W / 2 && d > 1000 && d < 5000)
					colour = [0.01, 0.2, 0.9];
			}
			for (let yy = 0; yy < 2; yy++)
				for (let xx = 0; xx < 2; xx++) {
					const k = ((y * 2 + yy) * photoW + x * 2 + xx) * 4;
					photo.data[k] = encodeSrgb(colour[0]);
					photo.data[k + 1] = encodeSrgb(colour[1]);
					photo.data[k + 2] = encodeSrgb(colour[2]);
					photo.data[k + 3] = 255;
				}
		}
	let sky: SkyMask | null = null;
	if (o.skyMask) {
		// a soft mask at half resolution: P(sky) ramps over a few rows around the skyline
		const mw = Math.ceil(W / 2);
		const mh = Math.ceil(H / 2);
		const data = new Uint8Array(mw * mh);
		for (let my = 0; my < mh; my++)
			for (let mx = 0; mx < mw; mx++) {
				const x = mx * 2;
				const skyline = o.skyRows + Math.round(8 * Math.sin(x * 0.03 + o.seed));
				const p = Math.max(0, Math.min(1, 0.5 - (my * 2 - skyline) / 6));
				data[my * mw + mx] = Math.round(p * 255);
			}
		sky = { width: mw, height: mh, data };
	}
	let foreground: SkyMask | null = null;
	if (o.foreground) {
		const data = new Uint8Array(W * H);
		for (let y = Math.floor(H * 0.6); y < H; y++)
			for (let x = Math.floor(W * 0.7); x < Math.floor(W * 0.8); x++)
				data[y * W + x] = 200;
		foreground = { width: W, height: H, data };
	}
	const base = { photo, geoW: W, geoH: H, eyeAlt, sky, foreground };
	if (!o.rangeOnly) return { ...base, geo: { kind: "xyzr", data: xyzr } };
	const range = new Float32Array(W * H);
	for (let i = 0; i < W * H; i++) range[i] = xyzr[i * 4 + 3];
	const ray = (x: number, y: number): Vec3 => {
		const g = (y * W + x) * 4;
		const r = xyzr[g + 3] || 1;
		return [xyzr[g] / r, xyzr[g + 1] / r, (xyzr[g + 2] - eyeAlt) / r];
	};
	return { ...base, geo: { kind: "range", data: range, ray } };
}

/** Random scene options (one per seed), spanning sizes, haze, masks and geometry kinds. */
export function sceneOptions(seed: number): HazeSceneOptions {
	const rnd = lcg(0x9e3779b9 ^ (seed * 2654435761));
	const sizes: [number, number][] = [
		[256, 192],
		[400, 300],
		[512, 384],
		[320, 240],
	];
	const [width, height] = sizes[Math.floor(rnd() * sizes.length)];
	return {
		width,
		height,
		seed: 1000 + seed,
		rayleighScale: 0.5 + rnd() * 4,
		mieBeta: 10 ** (-5 + rnd() * 2),
		mieHeight: [600, 900, 1200, 1800, 2700, 4000][Math.floor(rnd() * 6)],
		skyRows: Math.floor(height * (0.05 + rnd() * 0.35)),
		eyeAlt: 800 + rnd() * 2500,
		occluder: rnd() < 0.3,
		noise: rnd() * 0.04,
		skyMask: rnd() < 0.5,
		foreground: rnd() < 0.3,
		rangeOnly: rnd() < 0.3,
	};
}

const SRGB_LUT = (() => {
	const t = new Float32Array(256);
	for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
	return t;
})();

function dilate(m: Uint8Array, W: number, H: number, r: number) {
	const tmp = new Uint8Array(m.length);
	const out = new Uint8Array(m.length);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			let v = 0;
			for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r) && !v; k++)
				v = m[y * W + k];
			tmp[y * W + x] = v;
		}
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			let v = 0;
			for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r) && !v; k++)
				v = tmp[k * W + x];
			out[y * W + x] = v;
		}
	return out;
}

/** The per-pixel stage of look/haze-fit.ts fitHaze (keep in sync): lin, range, P(sky), bins. */
export function hazePixels(input: HazeFitInput) {
	const { photo, geo, geoW: W, geoH: H, sky, foreground: fg } = input;
	const N = W * H;
	const lin = new Float32Array(N * 3);
	const sx = photo.width / W;
	const sy = photo.height / H;
	for (let y = 0; y < H; y++) {
		const y0 = Math.floor(y * sy);
		const y1 = Math.max(
			y0 + 1,
			Math.min(photo.height, Math.floor((y + 1) * sy)),
		);
		for (let x = 0; x < W; x++) {
			const x0 = Math.floor(x * sx);
			const x1 = Math.max(
				x0 + 1,
				Math.min(photo.width, Math.floor((x + 1) * sx)),
			);
			let r = 0;
			let g = 0;
			let b = 0;
			for (let yy = y0; yy < y1; yy++)
				for (let xx = x0; xx < x1; xx++) {
					const k = (yy * photo.width + xx) * 4;
					r += SRGB_LUT[photo.data[k]];
					g += SRGB_LUT[photo.data[k + 1]];
					b += SRGB_LUT[photo.data[k + 2]];
				}
			const w = 1 / ((y1 - y0) * (x1 - x0));
			const o = (y * W + x) * 3;
			lin[o] = r * w;
			lin[o + 1] = g * w;
			lin[o + 2] = b * w;
		}
	}
	const range = new Float32Array(N);
	const pSky = new Float32Array(N);
	for (let y = 0; y < H; y++) {
		const gy = H - 1 - y;
		for (let x = 0; x < W; x++)
			range[y * W + x] =
				geo.kind === "xyzr"
					? geo.data[(gy * W + x) * 4 + 3]
					: geo.data[gy * W + x];
	}
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			if (sky) {
				const mx = Math.min(
					sky.width - 1,
					Math.floor(((x + 0.5) * sky.width) / W),
				);
				const my = Math.min(
					sky.height - 1,
					Math.floor(((y + 0.5) * sky.height) / H),
				);
				pSky[i] = sky.data[my * sky.width + mx] / 255;
			} else pSky[i] = range[i] > 0 ? 0 : 1;
		}
	const pxScale = W / 1024;
	const edge = new Uint8Array(N);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			const r = range[i];
			if (r <= 0) {
				edge[i] = 1;
				continue;
			}
			const nb = [
				x > 0 ? range[i - 1] : r,
				x < W - 1 ? range[i + 1] : r,
				y > 0 ? range[i - W] : r,
				y < H - 1 ? range[i + W] : r,
			];
			for (const q of nb)
				if (q <= 0 || Math.abs(Math.log(q / r)) > 0.12) edge[i] = 1;
		}
	const near = dilate(edge, W, H, Math.max(1, Math.round(3 * pxScale)));
	if (fg) {
		const m = new Uint8Array(N);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const mx = Math.min(
					fg.width - 1,
					Math.floor(((x + 0.5) * fg.width) / W),
				);
				const my = Math.min(
					fg.height - 1,
					Math.floor(((y + 0.5) * fg.height) / H),
				);
				m[y * W + x] = fg.data[my * fg.width + mx] > 64 ? 1 : 0;
			}
		const d = dilate(m, W, H, Math.max(2, Math.round(8 * pxScale)));
		for (let i = 0; i < N; i++) near[i] |= d[i];
	}
	const lo = Math.log(200);
	const span = Math.log(150000) - lo;
	const counts = new Uint32Array(NBINS);
	const bins = new Int32Array(N).fill(-1);
	for (let i = 0; i < N; i++) {
		const r = range[i];
		if (r < 200 || r >= 150000 || near[i] || pSky[i] > 0.3) continue;
		const b = Math.floor(((Math.log(r) - lo) / span) * NBINS);
		bins[i] = b;
		counts[b]++;
	}
	return { lin, range, pSky, counts, bins };
}

/**
 * Submit 1's outputs as the GPU produces them: the radix-selected order statistics (ranks
 * ⌊0.01(n−1)⌋, +1, ⌊0.09(n−1)⌋, +1 of each bin and channel) and the 72 lists (the bin's pixels
 * whose channel lies between slots 0 and 3, in pixel order), plus the airlight band's lin.
 */
export function emulatePrep(input: HazeFitInput): {
	prep: Prep;
	ctx: HazeTailContext;
	pixels: ReturnType<typeof hazePixels>;
} {
	const pixels = hazePixels(input);
	const { lin, range, pSky, counts, bins } = pixels;
	const skyIdx = airlightBand(range, pSky, input.geoW, input.geoH);
	const N = input.geoW * input.geoH;
	const stat = new Float32Array(NBINS * 3 * 4);
	const lists: { idx: Uint32Array; val: Float32Array }[] = [];
	const members: number[][] = Array.from({ length: NBINS }, () => []);
	for (let i = 0; i < N; i++) if (bins[i] >= 0) members[bins[i]].push(i);
	for (let b = 0; b < NBINS; b++) {
		const px = members[b];
		const n = px.length;
		for (let c = 0; c < 3; c++) {
			const all = Float32Array.from(px, (i) => lin[i * 3 + c]);
			const sorted = all.slice().sort();
			const s0 = (b * 3 + c) * 4;
			const g1 = Math.floor((n - 1) / 100);
			const g9 = Math.floor((9 * (n - 1)) / 100);
			stat[s0] = sorted[g1] ?? 0;
			stat[s0 + 1] = sorted[g1 + 1] ?? 0;
			stat[s0 + 2] = sorted[g9] ?? 0;
			stat[s0 + 3] = sorted[g9 + 1] ?? 0;
			const keep = px.filter(
				(_, k) => all[k] >= stat[s0] && all[k] <= stat[s0 + 3],
			);
			lists.push({
				idx: Uint32Array.from(keep),
				val: Float32Array.from(keep, (i) => lin[i * 3 + c]),
			});
		}
	}
	const sky = new Float32Array(3 * skyIdx.length);
	for (let k = 0; k < skyIdx.length; k++)
		for (let c = 0; c < 3; c++) sky[3 * k + c] = lin[skyIdx[k] * 3 + c];
	const prep: Prep = {
		counts,
		stat,
		sky,
		list: (L) => lists[L],
		bytes: 0,
		tail: false,
	};
	const ctx: HazeTailContext = {
		range,
		skyIdx,
		pointAt: pointAtOf(input.geo, input.geoW, input.geoH, input.eyeAlt),
		eyeAlt: input.eyeAlt,
		sunDir: input.sunDir,
		T0: 0,
		t1: 0,
		t2: 0,
	};
	return { prep, ctx, pixels };
}

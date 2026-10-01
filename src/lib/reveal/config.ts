// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Reveal animation config: the presets, the user's persisted choice and the per-frame uniform state
// both engines take through Renderer.setReveal (src/lib/renderer.ts). Engine-agnostic, no three/deck.
//
// A reveal is a per-pixel "arrival field" f ∈ [0, 1] built from the pixel's distance (log range),
// its terrain elevation and its screen position. A front sweeps f from 0 to 1; terrain with f behind
// the front shows its overlay, a band of light rides the front, and ridgelines run slightly ahead.

import { useCallback, useSyncExternalStore } from "react";
import { getFlag } from "#/lib/flags";
import { storageKey } from "#/lib/ontology/core/storage";

export type RevealPresetId =
	| "bloom"
	| "alpenglow"
	| "tide"
	| "shockwave"
	| "terraces"
	| "sunsweep"
	| "stardust";

/** Numeric mode in the shader (reveal/glsl.ts revealAt) and in fieldAt below. */
export const REVEAL_MODE: Record<RevealPresetId, number> = {
	bloom: 0,
	alpenglow: 1,
	tide: 2,
	shockwave: 3,
	terraces: 4,
	sunsweep: 5,
	stardust: 6,
};

export type Easing = "outCubic" | "inOutCubic" | "outQuart" | "outExpo";

export type RevealPreset = {
	id: RevealPresetId;
	label: string;
	blurb: string;
	/** default glow colour (sRGB hex) */
	color: `#${string}`;
	duration: number;
	/** width of the front's alpha ramp, in field units */
	soft: number;
	/** width of the light band */
	glowWidth: number;
	/** organic wobble of the front */
	grain: number;
	easing: Easing;
};

export const REVEAL_PRESETS: RevealPreset[] = [
	{
		id: "bloom",
		label: "Bloom",
		blurb: "Blooms outward from your feet to the far horizon",
		color: "#ffd58a",
		duration: 2.8,
		soft: 0.1,
		glowWidth: 0.06,
		grain: 0.08,
		easing: "outCubic",
	},
	{
		id: "alpenglow",
		label: "Alpenglow",
		blurb: "Summits catch the light first, then it pours down into the valleys",
		color: "#ff8a5c",
		duration: 3.4,
		soft: 0.12,
		glowWidth: 0.07,
		grain: 0.05,
		easing: "outCubic",
	},
	{
		id: "tide",
		label: "Rising tide",
		blurb: "Floods up from the valley floors to the peaks",
		color: "#5ee7ff",
		duration: 3.0,
		soft: 0.05,
		glowWidth: 0.035,
		grain: 0.03,
		easing: "outCubic",
	},
	{
		id: "shockwave",
		label: "Shockwave",
		blurb: "A ripple from the top peak, spreading through screen and depth",
		color: "#bfe9ff",
		duration: 2.2,
		soft: 0.05,
		glowWidth: 0.04,
		grain: 0.04,
		easing: "outQuart",
	},
	{
		id: "terraces",
		label: "Terraces",
		blurb: "Elevation bands pop in step by step, low to high",
		color: "#c9a7ff",
		duration: 3.0,
		soft: 0.02,
		glowWidth: 0.03,
		grain: 0.0,
		easing: "outCubic",
	},
	{
		id: "sunsweep",
		label: "Sunsweep",
		blurb: "Sweeps across the frame, peaks leading the way",
		color: "#ffe7a3",
		duration: 2.4,
		soft: 0.08,
		glowWidth: 0.05,
		grain: 0.06,
		easing: "outCubic",
	},
	{
		id: "stardust",
		label: "Stardust",
		blurb: "A glittering dissolve drifting from near to far",
		color: "#ffffff",
		duration: 3.0,
		soft: 0.06,
		glowWidth: 0.05,
		grain: 0.0,
		easing: "outCubic",
	},
];

export const presetById = (id: RevealPresetId) =>
	REVEAL_PRESETS.find((p) => p.id === id) ?? REVEAL_PRESETS[0];

export type RevealConfig = {
	/** play when the terrain first appears */
	onLoad: boolean;
	preset: RevealPresetId;
	/** seconds; null = the preset's */
	duration: number | null;
	/** glow strength, 0 = none */
	glow: number;
	/** multiplies the preset's front softness */
	soft: number;
	/** multiplies the preset's grain */
	grain: number;
	/** null = the preset's colour */
	color: `#${string}` | null;
	/** run the field backwards (far → near, valleys → summits, ...) */
	reverse: boolean;
	/** how much unrevealed terrain dims in the photo before the front arrives, 0..1 */
	dim: number;
	/** peak labels pop in as the front reaches them */
	labels: boolean;
};

export const DEFAULT_REVEAL: RevealConfig = {
	onLoad: true,
	preset: "bloom",
	duration: null,
	glow: 1,
	soft: 1,
	grain: 1,
	color: null,
	reverse: false,
	dim: 0.2,
	labels: true,
};

/** Per-frame values the composite shaders read (see reveal/glsl.ts for the packing). */
export type RevealUniforms = {
	/** x = eased progress 0..1, y = mode, z = eye altitude (m), w = 1 active, 2 active + reversed field */
	a: [number, number, number, number];
	/** log-range lo/hi, elevation lo/hi (m) */
	win: [number, number, number, number];
	/** log-range at the 20/40/60/80 % area quantiles (the front is area-equalised between them) */
	qD: [number, number, number, number];
	/** elevation at the 20/40/60/80 % area quantiles */
	qE: [number, number, number, number];
	/** soft, glow width, grain, dim */
	shape: [number, number, number, number];
	/** focus u, v (GL, up), its distance t, its elevation t */
	focus: [number, number, number, number];
	/** linear rgb, strength */
	glow: [number, number, number, number];
	/** camera ray basis in ENU: dir = F + R·(2u−1) + U·(2v−1), v up */
	F: [number, number, number];
	R: [number, number, number];
	U: [number, number, number];
};

export const EASE: Record<Easing, (t: number) => number> = {
	outCubic: (t) => 1 - (1 - t) ** 3,
	inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
	outQuart: (t) => 1 - (1 - t) ** 4,
	outExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
};

/**
 * JS mirror of the shader's field (without its grain), for things drawn outside the composite: peak
 * labels. u right, vUp up, tD / tE as in the shader.
 */
export function fieldAt(
	mode: number,
	u: number,
	vUp: number,
	tD: number,
	tE: number,
	focus: RevealUniforms["focus"],
	aspect: number,
	reverse: boolean,
) {
	let f: number;
	switch (mode) {
		case 1:
			f = (1 - tE) * 0.8 + tD * 0.2;
			break;
		case 2:
			f = tE * 0.85 + tD * 0.15;
			break;
		case 3: {
			const dx = (u - focus[0]) * aspect;
			const dy = vUp - focus[1];
			const ds = Math.hypot(dx, dy) / Math.max(aspect, 1);
			const dd = tD - focus[2];
			const de = tE - focus[3];
			f = Math.min(1, Math.sqrt(ds * ds + 0.5 * dd * dd + 0.3 * de * de) / 0.9);
			break;
		}
		case 4:
			f = (Math.floor(tE * 8) + tD * 0.7) / 8.7;
			break;
		case 5:
			f = u * 0.8 + (1 - tE) * 0.2;
			break;
		default:
			f = tD;
	}
	return reverse ? 1 - f : f;
}

const seg = (x: number, a: number, b: number) =>
	Math.min(1, Math.max(0, (x - a) / Math.max(b - a, 1e-4)));

/** Shader rvEq: 65 % area-equalised (piecewise through the quantiles), 35 % linear in the window. */
export function equalise(
	x: number,
	lo: number,
	q: readonly number[],
	hi: number,
) {
	const k = [lo, q[0], q[1], q[2], q[3], hi];
	let t = 1;
	for (let i = 0; i < 5; i++)
		if (x < k[i + 1] || i === 4) {
			t = 0.2 * i + 0.2 * seg(x, k[i], k[i + 1]);
			break;
		}
	return 0.35 * seg(x, lo, hi) + 0.65 * t;
}

/** The front position for eased progress t (matches the shader). */
export function frontAt(t: number, soft: number, grain: number) {
	return -(soft + grain * 0.5) + t * (1 + 2 * soft + grain);
}

export function hexToLinear(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1, 7), 16);
	const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
		const s = v / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return c as [number, number, number];
}

// ---- persistence: localStorage `rigi.reveal.v1`, try/catch'd, same-tab subscribers ----

const KEY = storageKey("reveal");
const subs = new Set<() => void>();
let cache: RevealConfig | null = null;

function parse(raw: string | null): RevealConfig {
	if (!raw) return DEFAULT_REVEAL;
	try {
		const o = JSON.parse(raw) as Partial<RevealConfig>;
		const c = { ...DEFAULT_REVEAL, ...o };
		if (!(c.preset in REVEAL_MODE)) c.preset = DEFAULT_REVEAL.preset;
		return c;
	} catch {
		return DEFAULT_REVEAL;
	}
}

/** ?reveal=off / ?reveal=<preset>, applied on top of storage but never saved. Automation (playwright:
 * eval-app, style-baseline, the matcher's render workers) screenshots at [data-ready], so it gets
 * no animation unless it asks for one. */
function urlOverride(): Partial<RevealConfig> {
	try {
		const q = getFlag("reveal");
		if (q === "off" || (!q && navigator.webdriver)) return { onLoad: false };
		if (q && q in REVEAL_MODE)
			return { onLoad: true, preset: q as RevealPresetId };
	} catch {}
	return {};
}

let stored: RevealConfig | null = null;

export function getRevealConfig(): RevealConfig {
	if (cache) return cache;
	let raw: string | null = null;
	try {
		raw = localStorage.getItem(KEY);
	} catch {}
	stored = parse(raw);
	cache = { ...stored, ...urlOverride() };
	return cache;
}

export function setRevealConfig(patch: Partial<RevealConfig>) {
	cache = { ...getRevealConfig(), ...patch };
	stored = { ...(stored ?? DEFAULT_REVEAL), ...patch };
	try {
		localStorage.setItem(KEY, JSON.stringify(stored));
	} catch {}
	for (const s of subs) s();
}

export function useRevealConfig(): [
	RevealConfig,
	(p: Partial<RevealConfig>) => void,
] {
	const cfg = useSyncExternalStore(
		useCallback((cb: () => void) => {
			subs.add(cb);
			return () => subs.delete(cb);
		}, []),
		getRevealConfig,
		() => DEFAULT_REVEAL,
	);
	return [cfg, setRevealConfig];
}

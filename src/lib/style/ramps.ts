// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Named colour ramps. Stops are sRGB; the shader mixes in sRGB and then applies pow(c, 2.2),
// the same order as today's hypso()/coolRamp() (materials.ts:90–121). Adapters must keep it.
import { smoothstep } from "../math";
import { hexToRgb01 } from "./color";
import type { Ramp, RampName, RampRef } from "./types";

export const MAX_RAMP_STOPS = 8;

export const RAMPS: Record<RampName, Ramp> = {
	/** materials.ts:92–105 hypso(): linear to .72, then smoothstep(0.72, 0.85, t), constant above .85 */
	"hypso-classic": {
		kind: "stops",
		stops: [
			{ t: 0, c: [0.36, 0.52, 0.3] }, // materials.ts:94
			{ t: 0.25, c: [0.62, 0.66, 0.4] }, // materials.ts:95
			{ t: 0.5, c: [0.6, 0.5, 0.38] }, // materials.ts:96
			{ t: 0.72, c: [0.62, 0.6, 0.6] }, // materials.ts:97
			{ t: 0.85, c: [0.97, 0.98, 1.0], ease: "smooth" }, // materials.ts:98, :103
		],
	},
	/** materials.ts:108–121 coolRamp(): teal → blue → violet → magenta → cream, evenly spaced, linear */
	cool: {
		kind: "stops",
		stops: [
			{ t: 0, c: [0.1, 0.85, 0.8] }, // materials.ts:110
			{ t: 0.25, c: [0.3, 0.55, 1.0] }, // materials.ts:111
			{ t: 0.5, c: [0.75, 0.35, 1.0] }, // materials.ts:112
			{ t: 0.75, c: [1.0, 0.35, 0.7] }, // materials.ts:113
			{ t: 1, c: [1.0, 0.95, 0.85] }, // materials.ts:114
		],
	},
	/** engine.ts:107–118 turbo(), analytic */
	turbo: { kind: "turbo" },
	/** Paper-map hypsometry: green → ochre → rock → white (the former studio bandsRamp palette 0; GLSL side: look/glsl/ramps.ts) */
	swiss: {
		kind: "stops",
		stops: [
			{ t: 0, c: [0.47, 0.66, 0.44] },
			{ t: 0.25, c: [0.84, 0.86, 0.55] },
			{ t: 0.5, c: [0.87, 0.72, 0.47] },
			{ t: 0.75, c: [0.66, 0.52, 0.42] },
			{ t: 1, c: [0.97, 0.97, 0.98] },
		],
	},
	grey: {
		kind: "stops",
		stops: [
			{ t: 0, c: [0.3, 0.3, 0.3] },
			{ t: 1, c: [0.95, 0.95, 0.95] },
		],
	},
	/** matplotlib viridis at 0, .25, .5, .75, 1 */
	viridis: {
		kind: "stops",
		stops: [
			{ t: 0, c: "#440154" },
			{ t: 0.25, c: "#3b528b" },
			{ t: 0.5, c: "#21918c" },
			{ t: 0.75, c: "#5ec962" },
			{ t: 1, c: "#fde725" },
		],
	},
	/** deep blue → cyan → white */
	night: {
		kind: "stops",
		stops: [
			{ t: 0, c: "#0b1d51" },
			{ t: 0.45, c: "#1f6fd1" },
			{ t: 0.75, c: "#4fe3ff" },
			{ t: 1, c: "#f2fdff" },
		],
	},
	/** near-black ink, for solid-looking lines on light imagery */
	"mono-ink": {
		kind: "stops",
		stops: [
			{ t: 0, c: "#1d1d1d" },
			{ t: 1, c: "#3a3a3a" },
		],
	},
	// ---- absolute-elevation palettes (ABSOLUTE_RAMP_RANGE: t = (h − 400) / 3100) ----
	/** Berann panorama: deeper greens, warm rock, bright snow (the former studio berannRamp) */
	berann: {
		kind: "stops",
		stops: [
			{ t: 0, c: [0.33, 0.5, 0.33] }, // 400 m
			{ t: 0.1935, c: [0.42, 0.58, 0.32], ease: "smooth" }, // 1000 m
			{ t: 0.4516, c: [0.66, 0.66, 0.42] }, // 1800 m
			{ t: 0.6452, c: [0.72, 0.6, 0.46] }, // 2400 m
			{ t: 0.8387, c: [0.74, 0.72, 0.76] }, // 3000 m
			{ t: 1, c: [0.99, 0.98, 0.97], ease: "smooth" }, // 3500 m
		],
	},
	/** The Swiss school-atlas palette interpolated in OKLab (the former studio bandsRamp palette 1), sampled at 8 stops */
	"swiss-ok": {
		kind: "stops",
		stops: [
			{ t: 0, c: [0.47, 0.66, 0.44] },
			{ t: 0.1429, c: [0.68, 0.773, 0.503] },
			{ t: 0.2857, c: [0.846, 0.84, 0.538] },
			{ t: 0.4286, c: [0.864, 0.76, 0.493] },
			{ t: 0.5714, c: [0.808, 0.661, 0.457] },
			{ t: 0.7143, c: [0.689, 0.548, 0.428] },
			{ t: 0.8571, c: [0.792, 0.705, 0.649] },
			{ t: 1, c: [0.97, 0.97, 0.98] },
		],
	},
	/** Patterson natural tint: valley green, forest, alpine meadow, scree, rock (look/glsl/ramps.ts alpineBase) */
	patterson: {
		kind: "stops",
		stops: [
			{ t: 0, c: [0.56, 0.66, 0.45] }, // 400 m
			{ t: 0.1613, c: [0.4, 0.53, 0.34], ease: "smooth" }, // 900 m
			{ t: 0.3548, c: [0.35, 0.47, 0.31], ease: "smooth" }, // 1500 m
			{ t: 0.4032, c: [0.35, 0.47, 0.31] }, // 1650 m
			{ t: 0.5323, c: [0.6, 0.65, 0.42], ease: "smooth" }, // 2050 m
			{ t: 0.6613, c: [0.64, 0.62, 0.52], ease: "smooth" }, // 2450 m
			{ t: 0.8226, c: [0.64, 0.64, 0.63], ease: "smooth" }, // 2950 m
		],
	},
};

/** Palettes keyed to absolute Alpine elevations: pick them with rampRange absolute 400..3500. */
export const ABSOLUTE_RAMPS: readonly RampName[] = [
	"berann",
	"swiss-ok",
	"patterson",
];
export const ABSOLUTE_RAMP_RANGE = {
	mode: "absolute",
	lo: 400,
	hi: 3500,
} as const;

export function isRampName(v: unknown): v is RampName {
	return typeof v === "string" && v in RAMPS;
}

export function resolveRamp(r: RampRef): Ramp {
	return typeof r === "string" ? RAMPS[r] : r;
}

/** engine.ts:107–118, the same polynomial on the CPU. */
export function turbo(x: number): [number, number, number] {
	x = Math.min(1, Math.max(0, x));
	const v4 = [1, x, x * x, x * x * x];
	const v2 = [v4[2] * v4[2], v4[3] * v4[2]];
	const d = (k: number[], k2: number[]) =>
		v4[0] * k[0] +
		v4[1] * k[1] +
		v4[2] * k[2] +
		v4[3] * k[3] +
		v2[0] * k2[0] +
		v2[1] * k2[1];
	return [
		d(
			[0.13572138, 4.6153926, -42.66032258, 132.13108234],
			[-152.94239396, 59.28637943],
		),
		d(
			[0.09140261, 2.19418839, 4.84296658, -14.18503333],
			[4.27729857, 2.82956604],
		),
		d(
			[0.1066733, 12.64194608, -60.58204836, 110.36276771],
			[-89.90310912, 27.34824973],
		),
	];
}

/**
 * Evaluate a ramp in sRGB (before the shader's pow 2.2), as the uniform-driven shader will:
 * clamped outside the first/last stop, per-segment linear or smoothstep. For swatches and tests.
 */
export function sampleRamp(r: RampRef, t: number): [number, number, number] {
	const ramp = resolveRamp(r);
	if (ramp.kind === "turbo") return turbo(t);
	const s = ramp.stops;
	if (t <= s[0].t) return hexToRgb01(s[0].c);
	for (let i = 1; i < s.length; i++) {
		if (t < s[i].t) {
			const a = hexToRgb01(s[i - 1].c);
			const b = hexToRgb01(s[i].c);
			const f =
				s[i].ease === "smooth"
					? smoothstep(s[i - 1].t, s[i].t, t)
					: (t - s[i - 1].t) / (s[i].t - s[i - 1].t);
			return [
				a[0] + (b[0] - a[0]) * f,
				a[1] + (b[1] - a[1]) * f,
				a[2] + (b[2] - a[2]) * f,
			];
		}
	}
	return hexToRgb01(s[s.length - 1].c);
}

/** CSS linear-gradient for a ramp (preset chips / swatches). */
export function rampCss(r: RampRef, steps = 8): string {
	const cols: string[] = [];
	for (let i = 0; i <= steps; i++) {
		const [R, G, B] = sampleRamp(r, i / steps).map((x) =>
			Math.round(Math.min(1, Math.max(0, x)) * 255),
		);
		cols.push(`rgb(${R},${G},${B}) ${((i / steps) * 100).toFixed(1)}%`);
	}
	return `linear-gradient(90deg, ${cols.join(", ")})`;
}

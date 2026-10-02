// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Colour-vision-deficiency simulation (Machado, Oliveira & Fernandes 2009, severity 1.0) and the
// CIEDE2000 colour difference, for checking that categorical palettes stay separable. Pure TS.
import { srgbToLinear } from "../../style/color";

export type Rgb255 = readonly [number, number, number];
export type Lab = readonly [number, number, number];
export type CvdKind = "none" | "protanopia" | "deuteranopia" | "tritanopia";

type Matrix3 = readonly [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

/** Machado 2009 matrices at severity 1.0, applied to linear sRGB. */
export const CVD_MATRICES: Record<Exclude<CvdKind, "none">, Matrix3> = {
	protanopia: [
		0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882,
		-0.048116, 1.051998,
	],
	deuteranopia: [
		0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182,
		0.04294, 0.968881,
	],
	tritanopia: [
		1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733,
		0.691367, 0.3039,
	],
};

export function hexToRgb255(hex: string): Rgb255 {
	const n = Number.parseInt(hex.slice(1, 7), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toLinear = (c: number) => srgbToLinear(c / 255);
const toGamma = (x: number) => {
	const c = Math.min(1, Math.max(0, x));
	return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
};

export function simulateCvd(rgb: Rgb255, kind: CvdKind): Rgb255 {
	if (kind === "none") return rgb;
	const m = CVD_MATRICES[kind];
	const [r, g, b] = rgb.map(toLinear);
	return [
		toGamma(m[0] * r + m[1] * g + m[2] * b),
		toGamma(m[3] * r + m[4] * g + m[5] * b),
		toGamma(m[6] * r + m[7] * g + m[8] * b),
	];
}

export function rgbToLab(rgb: Rgb255): Lab {
	const [r, g, b] = rgb.map(toLinear);
	const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
	const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
	const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
	const f = (t: number) =>
		t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
	const fx = f(x);
	const fy = f(y);
	const fz = f(z);
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** CIEDE2000 (Sharma, Wu & Dalal 2005), kL = kC = kH = 1. */
export function deltaE2000(a: Lab, b: Lab): number {
	const [L1, a1, b1] = a;
	const [L2, a2, b2] = b;
	const C1 = Math.hypot(a1, b1);
	const C2 = Math.hypot(a2, b2);
	const Cm7 = ((C1 + C2) / 2) ** 7;
	const G = 0.5 * (1 - Math.sqrt(Cm7 / (Cm7 + 25 ** 7)));
	const a1p = (1 + G) * a1;
	const a2p = (1 + G) * a2;
	const C1p = Math.hypot(a1p, b1);
	const C2p = Math.hypot(a2p, b2);
	const hueOf = (y: number, x: number) => {
		if (x === 0 && y === 0) return 0;
		const h = toDeg(Math.atan2(y, x));
		return h < 0 ? h + 360 : h;
	};
	const h1p = hueOf(b1, a1p);
	const h2p = hueOf(b2, a2p);
	const dLp = L2 - L1;
	const dCp = C2p - C1p;
	let dhp = 0;
	if (C1p * C2p !== 0) {
		dhp = h2p - h1p;
		if (dhp > 180) dhp -= 360;
		else if (dhp < -180) dhp += 360;
	}
	const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(toRad(dhp / 2));
	const Lbp = (L1 + L2) / 2;
	const Cbp = (C1p + C2p) / 2;
	let hbp = h1p + h2p;
	if (C1p * C2p !== 0) {
		if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360;
		hbp /= 2;
	}
	const T =
		1 -
		0.17 * Math.cos(toRad(hbp - 30)) +
		0.24 * Math.cos(toRad(2 * hbp)) +
		0.32 * Math.cos(toRad(3 * hbp + 6)) -
		0.2 * Math.cos(toRad(4 * hbp - 63));
	const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
	const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
	const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
	const Sc = 1 + 0.045 * Cbp;
	const Sh = 1 + 0.015 * Cbp * T;
	const Rt = -Math.sin(toRad(2 * dTheta)) * Rc;
	return Math.sqrt(
		(dLp / Sl) ** 2 +
			(dCp / Sc) ** 2 +
			(dHp / Sh) ** 2 +
			Rt * (dCp / Sc) * (dHp / Sh),
	);
}

export const CVD_KINDS: CvdKind[] = [
	"none",
	"protanopia",
	"deuteranopia",
	"tritanopia",
];

/** Smallest pairwise CIEDE2000 over `hexes` under one vision type, and the pair that sets it. */
export function minPairwiseDeltaE(hexes: readonly string[], kind: CvdKind) {
	const labs = hexes.map((h) => rgbToLab(simulateCvd(hexToRgb255(h), kind)));
	let min = Number.POSITIVE_INFINITY;
	let pair: [number, number] = [0, 0];
	for (let i = 0; i < labs.length; i++)
		for (let j = i + 1; j < labs.length; j++) {
			const d = deltaE2000(labs[i], labs[j]);
			if (d < min) {
				min = d;
				pair = [i, j];
			}
		}
	return { min, pair };
}

/** Colour difference of two hex colours as seen under one vision type. */
export function deltaEUnder(a: string, b: string, kind: CvdKind) {
	return deltaE2000(
		rgbToLab(simulateCvd(hexToRgb255(a), kind)),
		rgbToLab(simulateCvd(hexToRgb255(b), kind)),
	);
}
